import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../../../src/api/queryClient";
import { connectionApi } from "../../../src/api/client";
import type { ConnectionInfo } from "../../../src/api/types";
import { TooltipProvider } from "../../../src/components/ui/overlays";
import { Toaster } from "../../../src/components/ui/sonner";
import type { AggRow, Cell, Column, FieldDef, FilterNode, Progress, QuerySpec, RunResult, Sort } from "../../../src/lib/reports/types";
import { ReportsPage } from "../../../src/pages/ReportsPage";
import { useReports } from "../../../src/store/reports";
import "../../../src/index.css";

/** A tiny in-memory stand-in for the native report engine, so the real page can be driven in a browser. */
const connection: ConnectionInfo = { cloudId: "c", workspaceId: "w", siteUrl: "https://example.invalid", email: "admin@example.invalid" };
const students: Record<string, string> = { "STU-1": "Jane Student", "STU-2": "Sam Learner", "STU-3": "Lee Pupil" };
const withRecordedLabel = new URLSearchParams(location.search).has("labels");
if (withRecordedLabel) students["label:11:Unmatched Student"] = "Unmatched Student";
const day = (iso: string) => Date.parse(`${iso}T09:00:00Z`);
const events = [
  ["2026-01-05", "assigned", "STU-1"], ["2026-01-06", "reassigned", "STU-1"], ["2026-01-07", "assigned", "STU-2"],
  ["2026-01-13", "assigned", "STU-1"], ["2026-01-14", "removed", "STU-1"], ["2026-01-20", "assigned", "STU-3"],
  ["2026-01-21", "assigned", "STU-1"], ["2026-01-22", "reassigned", "STU-2"],
  ...(withRecordedLabel ? [["2026-01-23", "assigned", "label:11:Unmatched Student"]] : []),
].map(([d, operation, student], i) => ({ id: i, created: day(d), operation, student, asset: `LAP-${(i % 3) + 1}` }));

const enumField = (id: string, label: string, options: [string, string][]): FieldDef => ({
  id, label, category: "History", type: "enum", multi: false, operators: ["in", "notIn", "empty", "notEmpty"],
  measures: ["countValues", "distinct"], picker: false, options: options.map(([value, l]) => ({ value, label: l })),
});
const fields: FieldDef[] = [
  { id: "event.created", label: "Changed at", category: "History", type: "datetime", multi: false, operators: ["last", "between", "on", "before", "after"], measures: ["countValues", "distinct"], picker: false },
  enumField("event.operation", "Change type", [["assigned", "Assigned"], ["reassigned", "Reassigned"], ["removed", "Removed"]]),
  { id: "event.newObject", label: "New objects", category: "History", type: "ref", multi: true, operators: ["in", "notIn", "empty", "notEmpty"], measures: ["countValues", "distinct"], picker: true },
  { id: "event.attr:11:added", label: "Assigned to student (added)", category: "Historical attributes", type: "ref", multi: true, operators: ["in", "notIn", "empty", "notEmpty"], measures: ["countValues", "distinct"], picker: true },
  { id: "attr:11", label: "Assigned to student (current)", category: "Current attributes", type: "ref", multi: true, operators: ["in", "notIn", "empty", "notEmpty"], measures: ["countValues", "distinct"], picker: true },
  { id: "asset.key", label: "Asset key", category: "Asset", type: "text", multi: false, operators: ["eq", "contains", "in"], measures: ["countValues", "distinct"], picker: true },
];
const byId = new Map(fields.map((f) => [f.id, f]));

type Event = (typeof events)[number];
const valueOf = (e: Event, field: string): string | number => {
  switch (field) {
    case "event.created": return e.created;
    case "event.operation": return e.operation;
    case "event.newObject": return e.student;
    case "event.attr:11:added": return e.operation === "removed" ? "" : e.student;
    case "attr:11": return "STU-1";
    default: return e.asset;
  }
};
const labelOf = (field: string, v: string | number) =>
  field === "event.newObject" || field === "event.attr:11:added" || field === "attr:11"
    ? students[v as string] ?? v
    : byId.get(field)?.options?.find((o) => o.value === v)?.label ?? v;
const matches = (e: Event, node: FilterNode): boolean => {
  if (node.kind === "group") return node.join === "and" ? node.children.every((c) => matches(e, c)) : node.children.length === 0 || node.children.some((c) => matches(e, c));
  if (node.op === "in") return (node.value as string[]).includes(String(valueOf(e, node.field)));
  if (node.op === "notIn") return !(node.value as string[]).includes(String(valueOf(e, node.field)));
  if (node.op === "notEmpty") return valueOf(e, node.field) !== "";
  if (node.op === "empty") return valueOf(e, node.field) === "";
  return true;
};
const bucket = (ms: number, b: string) => {
  const d = new Date(ms);
  if (b === "month") return d.toISOString().slice(0, 7);
  if (b === "week") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

interface Run { result: RunResult; rows: AggRow[] | Cell[][]; columns: Column[] }
const runs = new Map<string, Run>();
const sortRows = (run: Run, sort: Sort | null | undefined) => {
  const agg = run.result.aggregate;
  const s = sort ?? (agg ? (agg.dimensions[0]?.type === "bucket" ? { column: "d0", desc: false } : { column: agg.measures[0]?.id ?? "", desc: true }) : { column: "event.created", desc: true });
  const at = (r: AggRow | Cell[]) => {
    if (!agg) return (r as Cell[])[run.columns.findIndex((c) => c.id === s.column)];
    const row = r as AggRow;
    return s.column.startsWith("d") ? row.keys[Number(s.column.slice(1))] : row.values[agg.measures.findIndex((m) => m.id === s.column)];
  };
  return [...run.rows].sort((a, b) => {
    const x = at(a) as string | number, y = at(b) as string | number;
    return (x < y ? -1 : x > y ? 1 : 0) * (s.desc ? -1 : 1);
  });
};

function execute(spec: QuerySpec, pageSize: number, sort: Sort | null): RunResult {
  const runId = `run-${runs.size + 1}`;
  const rows = events.filter((e) => matches(e, spec.filter));
  let run: Run;
  if (spec.mode === "aggregate") {
    const dims: Column[] = (spec.groupBy ?? []).map((g, i) => ({
      id: `d${i}`, label: byId.get(g.field)!.label, field: g.field, ...(g.bucket ? { type: "bucket" as const, bucket: g.bucket } : { type: byId.get(g.field)!.type }),
    }));
    const measures: Column[] = (spec.measures ?? []).map((m) => ({ id: `m:${m.id}`, label: m.label ?? (m.fn === "count" ? "Records" : `Distinct ${byId.get(m.field!)?.label}`), type: "number", fn: m.fn }));
    const measure = (list: Event[]) => (spec.measures ?? []).map((m) => (m.fn === "count" ? list.length : new Set(list.map((e) => valueOf(e, m.field!))).size));
    const groups = new Map<string, { keys: Cell[]; labels: Cell[]; list: Event[] }>();
    for (const e of rows) {
      const keys = (spec.groupBy ?? []).map((g) => (g.bucket ? bucket(e.created, g.bucket) : valueOf(e, g.field)));
      const k = JSON.stringify(keys);
      const g = groups.get(k) ?? { keys, labels: keys.map((v, i) => (spec.groupBy![i].bucket ? v : labelOf(spec.groupBy![i].field, v))), list: [] };
      g.list.push(e);
      groups.set(k, g);
    }
    const aggRows: AggRow[] = [...groups.values()].map((g) => ({ keys: g.keys, labels: g.labels, values: measure(g.list) }));
    run = {
      rows: aggRows, columns: [...dims, ...measures],
      result: { runId, mode: "aggregate", dataVersion: 1, generatedMs: Date.now(), lastRefreshMs: Date.now() - 120_000, columns: [...dims, ...measures], total: aggRows.length, rows: [], warnings: [],
        aggregate: { dimensions: dims, measures, totals: measure(rows), truncated: false } },
    };
  } else {
    const ids = spec.columns?.length ? spec.columns : ["event.created", "asset.key", "event.operation", "event.newObject"];
    const columns: Column[] = ids.map((id) => ({ id, label: byId.get(id)!.label, type: byId.get(id)!.type, field: id }));
    const detail = rows.map((e) => ids.map((id) => (id === "event.created" ? e.created : labelOf(id, valueOf(e, id)))));
    run = { rows: detail, columns, result: { runId, mode: "detail", dataVersion: 1, generatedMs: Date.now(), lastRefreshMs: Date.now() - 120_000, columns, total: detail.length, rows: [], warnings: [] } };
  }
  runs.set(runId, run);
  return { ...run.result, rows: sortRows(run, sort).slice(0, pageSize) as RunResult["rows"] };
}

const fixture = {
  calls: [] as { command: string; payload: Record<string, unknown> }[],
  specs: [] as QuerySpec[],
  refreshes: [] as { full: boolean; settings: unknown }[],
  savePath: "/fixture/report.csv" as string | null,
  reports: () => useReports.getState().reports,
  sources: () => useReports.getState().sources,
};
declare global {
  interface Window { reportsFixture: typeof fixture }
}
window.reportsFixture = fixture;

const status = (collected: boolean) => ({
  collected, lastRefreshMs: collected ? Date.now() - 120_000 : null, lastFullMs: collected ? Date.now() - 120_000 : null, lastError: null,
  assets: collected ? 3 : 0, unavailableAssets: 0, events: collected ? events.length : 0, historiesFailed: 0, historiesDenied: 0, historiesMissing: 0,
  unresolvedEvents: 0, scopeChanged: false, resumable: 0, refreshing: false, dataVersion: collected ? 1 : 0, fullCooldownMs: 0,
});
let collected = new URLSearchParams(location.search).get("collected") !== "no";

// Persisted stores were created with browser storage during import; IPC-backed calls are enabled afterwards.
(globalThis as { isTauri?: boolean }).isTauri = true;
connectionApi.get = async () => connection;
mockIPC(async (command, raw) => {
  const payload = (raw ?? {}) as Record<string, unknown>;
  fixture.calls.push({ command, payload: JSON.parse(JSON.stringify(payload, (_, v) => (v && typeof v === "object" && "onmessage" in v ? "[channel]" : v))) });
  switch (command) {
    case "reports_status": return status(collected);
    case "reports_fields": return fields;
    case "reports_unresolved": return { values: [], attributes: [] };
    case "reports_field_values": {
      const search = String(payload.search ?? "").toLowerCase();
      return Object.entries(students).filter(([, l]) => l.toLowerCase().includes(search))
        .map(([value, label]) => ({ value, label, count: events.filter((e) => e.student === value).length }));
    }
    case "reports_run":
      fixture.specs.push(payload.spec as QuerySpec);
      return execute(payload.spec as QuerySpec, payload.pageSize as number, payload.sort as Sort | null);
    case "reports_page": {
      const run = runs.get(payload.runId as string)!;
      const offset = payload.offset as number;
      return { total: run.rows.length, rows: sortRows(run, payload.sort as Sort | null).slice(offset, offset + (payload.limit as number)) };
    }
    case "reports_chart": {
      const run = runs.get(payload.runId as string)!;
      const rows = sortRows(run, null) as AggRow[];
      const time = run.result.aggregate!.dimensions[0]?.type === "bucket";
      const top = payload.top as number;
      if (time || run.result.aggregate!.dimensions.length > 1) return { rows, otherGroups: 0, truncated: false };
      const rest = rows.slice(top);
      return { rows: rows.slice(0, top), otherGroups: rest.length, truncated: false, ...(rest.length ? { other: rest[0].values.map((_, i) => rest.reduce((n, r) => n + (r.values[i] as number), 0)) } : {}) };
    }
    case "reports_export": return runs.get(payload.runId as string)!.rows.length;
    case "reports_estimate":
      return { assets: 3, inventoryRequests: 1, metadataRequests: 2, historyRequests: 3, historyRequestsMax: 3, firstCollection: !collected, fullCooldownMs: 0, concurrency: 4, requestsPerSecond: 5, resumable: 0 };
    case "reports_refresh": {
      fixture.refreshes.push({ full: payload.full as boolean, settings: payload.settings });
      const channel = payload.onProgress as Channel<Progress> & { onmessage: (p: Progress) => void };
      for (const phase of ["metadata", "inventory", "history", "publishing"] as const) {
        channel.onmessage({ phase, done: 1, total: 1, requests: 2, throttled: 0 });
        await new Promise((r) => setTimeout(r, 30));
      }
      collected = true;
      return { assets: 3, historiesFetched: 3, historiesReused: 0, historiesFailed: 0, historiesMissing: 0, historiesDenied: 0, requests: 6, throttled: 0, events: events.length, dataVersion: 2 };
    }
    case "reports_cancel":
    case "reports_clear":
      return null;
    case "plugin:dialog|save": return fixture.savePath;
    case "open_pdf":
    case "save_pdf": return null;
    default: throw new Error(`Unexpected fixture command: ${command}`);
  }
});

useReports.setState({
  sources: [{ id: "src-1", name: "Student laptops", cloudId: "c", workspaceId: "w", objectTypeIds: ["42"], scopeAql: "", attributeAliases: {}, updatedAt: 1 }],
  reports: [], mappings: {}, lastReportId: null,
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <div className="flex h-screen flex-col"><ReportsPage /></div>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
