import { describe, expect, it } from "vitest";
import type { ConnectionInfo } from "@/api/types";
import { shapeChart } from "@/components/reports/visuals";
import { deletionScope, type DeletionConfigs } from "@/lib/deletion";
import { conditionProblem, defaultCondition, describeCondition, valueKind } from "./filters";
import { formatAgo, formatBucket, formatCell } from "./format";
import { countConditions, executableSpec, newSpec, parseReport, parseSource, parseSpec, ReportInvalid, type SavedSpec } from "./model";
import type { ChartData, Column, ConditionNode, FieldDef, FilterNode, RunResult } from "./types";
import { visualRule, type VisualContext } from "./visuals";

const cond = (field = "event.operation", op = "in", value: unknown = ["assigned"]): ConditionNode => ({ kind: "condition", field, op, value });
const spec = (over: Partial<SavedSpec> = {}): SavedSpec => ({ ...newSpec("events"), timezone: "UTC", ...over });
const nest = (depth: number): FilterNode => (depth === 1 ? cond() : { kind: "group", join: "and", children: [nest(depth - 1)] });

describe("report query validation", () => {
  it("normalises a saved query and keeps nested AND/OR groups", () => {
    const filter: FilterNode = { kind: "group", join: "and", children: [cond(), { kind: "group", join: "or", children: [cond("event.actor", "eq", "u1")] }] };
    const parsed = parseSpec({ ...spec({ filter }), groupBy: [{ field: "event.created", bucket: "week" }, { field: "event.actor", bucket: null }] });
    expect(parsed.filter).toEqual(filter);
    expect(parsed.groupBy).toEqual([{ field: "event.created", bucket: "week" }, { field: "event.actor" }]);
    expect(parsed.includeUnavailable).toBe(true);
    expect(parsed.includeSoftDeleted).toBe(false);
    expect(countConditions(parsed.filter)).toBe(2);
  });

  it.each([
    ["a newer version", { v: 2 }],
    ["an unknown entity", { entity: "payroll" }],
    ["an invalid time zone", { timezone: "Mars/Olympus" }],
    ["too many groupings", { groupBy: [{ field: "a" }, { field: "b" }, { field: "c" }] }],
    ["duplicate measure IDs", { measures: [{ id: "x", fn: "count" }, { id: "x", fn: "count" }] }],
    ["an unknown measure", { measures: [{ id: "x", fn: "median" }] }],
    ["an internal operator", { filter: cond("x", "__sql", "1") }],
    ["filters nested too deeply", { filter: nest(7) }],
    ["too many conditions", { filter: { kind: "group", join: "and", children: Array.from({ length: 101 }, () => cond()) } }],
    ["too many listed values", { filter: cond("x", "in", Array.from({ length: 1001 }, (_, i) => `K-${i}`)) }],
  ])("rejects %s", (_, over) => {
    expect(() => parseSpec({ ...spec(), ...over })).toThrow(ReportInvalid);
  });

  it("validates sources and reports", () => {
    const source = { id: "s1", name: " Laptops ", cloudId: "c", workspaceId: "w", objectTypeIds: ["42", "42"], scopeAql: "", attributeAliases: { "7": [" Old "] }, updatedAt: 1 };
    expect(parseSource(source)).toMatchObject({ name: "Laptops", objectTypeIds: ["42"], attributeAliases: { "7": ["Old"] } });
    expect(() => parseSource({ ...source, objectTypeIds: [] })).toThrow(ReportInvalid);
    expect(() => parseSource({ ...source, objectTypeIds: ["abc"] })).toThrow(ReportInvalid);
    expect(() => parseSource({ ...source, scopeAql: "x".repeat(2001) })).toThrow(ReportInvalid);
    const report = parseReport({ id: "r1", name: "R", sourceId: "s1", cloudId: "c", workspaceId: "w", spec: spec(), view: { visual: "bar", top: 999 }, updatedAt: 1 });
    expect(report.view).toEqual({ visual: "bar", measure: 0, top: 10 });
  });

  it("adds soft-delete markers only when a run is prepared", () => {
    const conn = { siteUrl: "", email: "", cloudId: "c", workspaceId: "w" } as ConnectionInfo;
    const marker = { attributeId: "9", attributeName: "Status", value: { raw: "Deleted", display: "Deleted" } };
    const deletions = {
      [deletionScope(conn, "42")]: { method: "soft", marker },
      [deletionScope({ cloudId: "c", workspaceId: "other" }, "43")]: { method: "soft", marker },
    } as unknown as DeletionConfigs;
    const saved = spec();
    const run = executableSpec(saved, deletions, conn);
    expect(run.softDelete).toEqual([{ typeId: "42", attributeId: "9", value: "Deleted" }]);
    expect(saved).not.toHaveProperty("softDelete");
    expect(executableSpec(saved, deletions, null).softDelete).toEqual([]);
    expect(parseSpec(run)).not.toHaveProperty("softDelete");
  });
});

const field = (over: Partial<FieldDef> = {}): FieldDef => ({
  id: "event.created", label: "Changed at", category: "History", type: "datetime", multi: false,
  operators: ["last", "between", "on", "before", "after", "empty", "notEmpty"], measures: ["countValues", "distinct"], picker: false, ...over,
});

describe("report filters", () => {
  it("chooses editors by field type and operator", () => {
    expect(valueKind("datetime", "last")).toBe("relative");
    expect(valueKind("number", "between")).toBe("numberRange");
    expect(valueKind("date", "between")).toBe("dateRange");
    expect(valueKind("ref", "in")).toBe("list");
    expect(valueKind("text", "empty")).toBe("none");
  });

  it("defaults dates to the last 30 days and explains incomplete conditions", () => {
    const f = field();
    const c = defaultCondition(f);
    expect(c).toEqual({ kind: "condition", field: "event.created", op: "last", value: { amount: 30, unit: "day" } });
    expect(conditionProblem(c, f)).toBeNull();
    expect(describeCondition(c, f)).toBe("Changed at in the last 30 days");
    expect(conditionProblem({ ...c, value: { amount: 0, unit: "day" } }, f)).toMatch(/1 to 3650/);
    expect(conditionProblem({ ...c, op: "between", value: { from: "2024-02-01", to: "2024-01-01" } }, f)).toMatch(/start date/);
    expect(conditionProblem({ ...c, op: "contains" }, f)).toMatch(/does not support/);
    expect(conditionProblem(c, undefined)).toMatch(/not available/);
  });

  it("describes lists with display labels", () => {
    const f = field({ id: "event.newObject", label: "Borrower", type: "ref", operators: ["in"] });
    const labels = new Map([["STU-1", "Jane"], ["STU-2", "Sam"]]);
    expect(describeCondition(cond("event.newObject", "in", ["STU-1", "STU-2", "STU-3"]), f, labels)).toBe("Borrower is any of Jane, Sam, +1");
    expect(conditionProblem(cond("event.newObject", "in", []), f)).toMatch(/at least one/);
    expect(describeCondition(cond("event.newObject", "in", ["label:11:Doe, Jane"]), f)).toBe("Borrower is any of Doe, Jane");
  });
});

const col = (over: Partial<Column>): Column => ({ id: "d0", label: "Group", type: "text", ...over });
const ctx = (over: Partial<VisualContext> = {}): VisualContext => ({
  mode: "aggregate", dimensions: [col({ id: "d0", type: "enum", field: "event.actor" })], measures: [col({ id: "m:count", type: "number", fn: "count" })],
  fields: new Map(), measure: 0, ...over,
});

describe("visual rules", () => {
  it("always allows tables and KPI cards", () => {
    expect(visualRule("table").unsupported(ctx({ mode: "detail" }))).toBeNull();
    expect(visualRule("kpi").unsupported(ctx({ mode: "detail" }))).toBeNull();
  });

  it("explains why a chart cannot show a result instead of rewriting the report", () => {
    expect(visualRule("bar").unsupported(ctx({ mode: "detail" }))).toMatch(/summary/);
    expect(visualRule("bar").unsupported(ctx({ dimensions: [] }))).toMatch(/grouping/);
    expect(visualRule("line").unsupported(ctx())).toMatch(/date/);
    expect(visualRule("line").unsupported(ctx({ dimensions: [col({ type: "bucket", bucket: "week" })] }))).toBeNull();
    expect(visualRule("pie").unsupported(ctx())).toBeNull();
    expect(visualRule("pie").unsupported(ctx({ measures: [col({ type: "number", fn: "avg" })] }))).toMatch(/averages/);
    const multi = new Map([["event.actor", field({ id: "event.actor", multi: true })]]);
    expect(visualRule("pie").unsupported(ctx({ fields: multi }))).toMatch(/100%/);
  });
});

describe("report formatting", () => {
  it("formats calendar buckets without shifting them across time zones", () => {
    expect(formatBucket("2024-01-01", "day")).toContain("2024");
    expect(formatBucket("2024-01-01", "week")).toMatch(/^Week of /);
    expect(formatBucket("2024-12", "month")).toMatch(/Dec/);
    expect(formatCell("2024-03-01", { type: "date" }, "Pacific/Kiritimati")).toMatch(/1/);
  });

  it("formats empty, boolean and numeric cells", () => {
    expect(formatCell(null, { type: "text" }, "UTC")).toBe("—");
    expect(formatCell(1, { type: "boolean" }, "UTC")).toBe("Yes");
    expect(formatCell(1234.567, { type: "number" }, "UTC")).toMatch(/1.?234.57/);
    expect(formatAgo(null)).toBe("never");
    expect(formatAgo(1_000_000 - 5 * 60_000, 1_000_000)).toBe("5 min ago");
  });
});

describe("chart shaping", () => {
  const result = (dimensions: Column[]): RunResult => ({
    runId: "r", mode: "aggregate", dataVersion: 1, generatedMs: 0, lastRefreshMs: null, columns: [], total: 0, rows: [], warnings: [],
    aggregate: { dimensions, measures: [col({ id: "m:count", label: "Borrowings", type: "number", fn: "count" })], totals: [], truncated: false },
  });

  it("adds the re-measured remainder for a single grouping", () => {
    const chart: ChartData = { rows: [{ keys: ["a"], labels: ["Jane"], values: [5] }], other: [7], otherGroups: 3, truncated: false };
    const shaped = shapeChart(chart, result([col({ type: "enum" })]), 0, 10);
    expect(shaped.data).toEqual([{ name: "Jane", value: 5 }, { name: "Other (3 groups)", value: 7 }]);
    expect(shaped.series).toHaveLength(1);
  });

  it("pivots a second grouping into the largest series without inventing an Other total", () => {
    const rows = [
      ["2024-01-01", "a", "Jane", 3], ["2024-01-01", "b", "Sam", 1], ["2024-01-08", "a", "Jane", 2], ["2024-01-08", "c", "Lee", 9],
    ].map(([w, k, l, v]) => ({ keys: [w, k], labels: [w, l], values: [v] }));
    const shaped = shapeChart({ rows, otherGroups: 0, truncated: false }, result([col({ type: "bucket", bucket: "week" }), col({ id: "d1", label: "Borrower", type: "enum" })]), 0, 2);
    expect(shaped.series.map((s) => s.name)).toEqual(["Lee", "Jane"]);
    expect(shaped.hiddenSeries).toBe(1);
    expect(shaped.data).toHaveLength(2);
    expect(shaped.data[0]).toMatchObject({ s1: 3 });
    expect(shaped.data[0]).not.toHaveProperty("s0");
    expect(shaped.data[1]).toMatchObject({ s0: 9, s1: 2 });
    expect(shaped.note).toMatch(/1 more "Borrower"/);
  });
});
