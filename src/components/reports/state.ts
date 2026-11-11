import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { reportsApi } from "@/api/reports";
import { useConnection } from "@/api/queries";
import type { ConnectionInfo } from "@/api/types";
import { DEFAULT_VIEW, newSpec, sameWorkspace, toDataset, type ReportSource, type SavedReport, type SavedSpec, type ViewConfig } from "@/lib/reports/model";
import type { CollectSettings, Dataset, Entity, Progress, RefreshSummary, RunResult, Sort } from "@/lib/reports/types";
import { useReports } from "@/store/reports";

export const reportKeys = {
  all: ["reports"] as const,
  status: (id: string) => ["reports", "status", id] as const,
  fields: (id: string, entity: Entity, version: number, norm: string) => ["reports", "fields", id, entity, version, norm] as const,
  values: (id: string, entity: Entity, field: string, search: string, version: number) => ["reports", "values", id, entity, field, search, version] as const,
  unresolved: (id: string, version: number, norm: string) => ["reports", "unresolved", id, version, norm] as const,
  page: (runId: string, sort: string, offset: number) => ["reports", "page", runId, sort, offset] as const,
  chart: (runId: string, measure: number, top: number) => ["reports", "chart", runId, measure, top] as const,
};

export interface Draft {
  /** The saved report this draft edits, or null for a new report. */
  savedId: string | null;
  name: string;
  sourceId: string | null;
  spec: SavedSpec;
  view: ViewConfig;
}

export const draftFrom = (r: SavedReport): Draft => ({ savedId: r.id, name: r.name, sourceId: r.sourceId, spec: structuredClone(r.spec), view: { ...r.view } });
export const blankDraft = (sourceId: string | null): Draft => ({ savedId: null, name: "Untitled report", sourceId, spec: newSpec(), view: { ...DEFAULT_VIEW } });
export const draftSignature = (d: Pick<Draft, "name" | "sourceId" | "spec" | "view">) => JSON.stringify([d.name, d.sourceId, d.spec, d.view]);

interface Workspace {
  draft: Draft;
  /** Signature of the last saved/opened version, to detect unsaved edits. */
  baseline: string;
  result: RunResult | null;
  /** Spec + dataset signature of `result`, so a visual switch never re-runs an unchanged query. */
  resultKey: string | null;
  /** The sort `result.rows` was produced with. */
  runSort: Sort | undefined;
  running: boolean;
  error: string | null;
  setDraft: (draft: Draft, saved?: boolean) => void;
  patch: (patch: Partial<Draft>) => void;
  patchSpec: (fn: (spec: SavedSpec) => SavedSpec) => void;
  markSaved: () => void;
  setRun: (state: Partial<Pick<Workspace, "result" | "resultKey" | "runSort" | "running" | "error">>) => void;
}

export const useWorkspace = create<Workspace>()((set) => ({
  draft: blankDraft(null),
  baseline: draftSignature(blankDraft(null)),
  result: null,
  resultKey: null,
  runSort: undefined,
  running: false,
  error: null,
  setDraft: (draft, saved = true) =>
    set({ draft, baseline: saved ? draftSignature(draft) : "", result: null, resultKey: null, error: null }),
  patch: (patch) => set((s) => ({ draft: { ...s.draft, ...patch } })),
  patchSpec: (fn) => set((s) => ({ draft: { ...s.draft, spec: fn(structuredClone(s.draft.spec)) } })),
  markSaved: () => set((s) => ({ baseline: draftSignature(s.draft) })),
  setRun: (state) => set(state),
}));

export const isDirty = (w: Pick<Workspace, "draft" | "baseline">) => draftSignature(w.draft) !== w.baseline;

/** Data sources usable with the current Jira connection. */
export function useWorkspaceSources(): { connection: ConnectionInfo | null; sources: ReportSource[]; reports: SavedReport[] } {
  const connection = useConnection().data ?? null;
  const allSources = useReports((s) => s.sources);
  const allReports = useReports((s) => s.reports);
  return useMemo(() => ({
    connection,
    sources: allSources.filter((s) => sameWorkspace(s, connection)),
    reports: allReports.filter((r) => sameWorkspace(r, connection)),
  }), [connection, allSources, allReports]);
}

export function useDataset(source: ReportSource | null | undefined): Dataset | null {
  const mappings = useReports((s) => (source ? s.mappings[source.id] : undefined));
  return useMemo(() => (source ? toDataset(source, mappings) : null), [source, mappings]);
}

/** Changes whenever identity mappings or aliases change, so dependent queries refetch. */
export const normKey = (d: Dataset | null) => (d ? JSON.stringify([d.attributeAliases, d.valueMappings]) : "");

export function useReportStatus(dataset: Dataset | null) {
  return useQuery({
    queryKey: reportKeys.status(dataset?.id ?? ""),
    queryFn: () => reportsApi.status(dataset!),
    enabled: !!dataset,
  });
}

export function useReportFields(dataset: Dataset | null, entity: Entity, version: number) {
  return useQuery({
    queryKey: reportKeys.fields(dataset?.id ?? "", entity, version, normKey(dataset)),
    queryFn: () => reportsApi.fields(dataset!, entity),
    enabled: !!dataset,
    staleTime: Infinity,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Refresh state lives outside components so closing the dialog does not lose progress.

interface RefreshState {
  sourceId: string | null;
  progress: Progress | null;
  summary: RefreshSummary | null;
  error: string | null;
  set: (s: Partial<Omit<RefreshState, "set">>) => void;
}
export const useRefresh = create<RefreshState>()((set) => ({
  sourceId: null,
  progress: null,
  summary: null,
  error: null,
  set: (s) => set(s),
}));

export const estimateSeconds = (requests: number, settings: CollectSettings) => Math.ceil(requests / Math.max(0.2, settings.requestsPerSecond));
