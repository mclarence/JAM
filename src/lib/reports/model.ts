import type { ConnectionInfo } from "@/api/types";
import { workspaceDeletions, type DeletionConfigs } from "@/lib/deletion";
import {
  LIMITS,
  type Bucket,
  type Dataset,
  type Entity,
  type FilterNode,
  type GroupBy,
  type Measure,
  type MeasureFn,
  type QuerySpec,
  type Sort,
} from "./types";

/**
 * A saved data source. Synced and backed up, so it holds only IDs, AQL and attribute names; never results, display
 * names or emails. Value mappings (raw history text → object key) can contain people's names, so they stay on this
 * device in `useReports.mappings`.
 */
export interface ReportSource {
  id: string;
  name: string;
  cloudId: string;
  workspaceId: string;
  objectTypeIds: string[];
  scopeAql: string;
  /** attrId → earlier names of the attribute, for history entries recorded before a rename. */
  attributeAliases: Record<string, string[]>;
  updatedAt: number;
}

export const VISUALS = ["table", "kpi", "bar", "line", "pie"] as const;
export type VisualKind = (typeof VISUALS)[number];

export interface ViewConfig {
  visual: VisualKind;
  /** Index into the measures charted by bar/line/pie. */
  measure: number;
  /** Groups shown before the rest are combined into "Other". */
  top: number;
}

/** The stored query omits `softDelete`, which is derived from the deletion settings on each run. */
export type SavedSpec = Omit<QuerySpec, "softDelete">;

export interface SavedReport {
  id: string;
  name: string;
  sourceId: string;
  cloudId: string;
  workspaceId: string;
  spec: SavedSpec;
  view: ViewConfig;
  updatedAt: number;
}

export const DEFAULT_VIEW: ViewConfig = { visual: "table", measure: 0, top: 10 };
export const MEASURE_LABELS: Record<MeasureFn, string> = {
  count: "Count of records",
  countValues: "Count with a value",
  distinct: "Distinct count",
  sum: "Sum",
  avg: "Average",
};
export const BUCKET_LABELS: Record<Bucket, string> = { day: "Day", week: "Week (Mon)", month: "Month" };
export const ENTITY_LABELS: Record<Entity, string> = { assets: "Asset inventory", events: "Change history" };

export function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function emptyFilter(): FilterNode {
  return { kind: "group", join: "and", children: [] };
}

export function newSpec(entity: Entity = "events"): SavedSpec {
  return {
    v: 1,
    entity,
    filter: emptyFilter(),
    mode: "aggregate",
    groupBy: [],
    measures: [{ id: "count", fn: "count" }],
    timezone: localTimezone(),
    includeUnavailable: true,
    includeSoftDeleted: false,
  };
}

export const newId = () => crypto.randomUUID();

/** The engine's view of a source, with this device's identity mappings. */
export function toDataset(source: ReportSource, mappings?: Record<string, Record<string, string>>): Dataset {
  return {
    id: source.id,
    cloudId: source.cloudId,
    workspaceId: source.workspaceId,
    objectTypeIds: source.objectTypeIds,
    scopeAql: source.scopeAql,
    attributeAliases: source.attributeAliases,
    valueMappings: mappings ?? {},
  };
}

/** Adds this workspace's soft-delete markers so deleted assets are excluded the same way as in the Assets grid. */
export function executableSpec(spec: SavedSpec, deletions: DeletionConfigs, connection: ConnectionInfo | null): QuerySpec {
  const softDelete = workspaceDeletions(deletions, connection).flatMap(({ typeId, config }) =>
    config.method === "soft" && config.marker?.value.raw
      ? [{ typeId, attributeId: config.marker.attributeId, value: config.marker.value.raw }]
      : []);
  return { ...structuredClone(spec), softDelete };
}

export const sameWorkspace = (x: { cloudId: string; workspaceId: string }, conn: ConnectionInfo | null) =>
  !!conn && x.cloudId === conn.cloudId && x.workspaceId === conn.workspaceId;

// ---------------------------------------------------------------------------------------------------------------
// Validation for synced and imported records. Structural only; the engine re-validates fields and operators.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isDigits = (v: unknown): v is string => isStr(v) && /^\d{1,18}$/.test(v);
const isId = (v: unknown): v is string => isStr(v) && /^[A-Za-z0-9-]{1,64}$/.test(v);
const isName = (v: unknown): v is string => isStr(v) && v.trim().length > 0 && v.length <= 200;
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const MEASURE_FNS: readonly string[] = ["count", "countValues", "distinct", "sum", "avg"];
const BUCKETS: readonly string[] = ["day", "week", "month"];

export class ReportInvalid extends Error {}
const check = (ok: boolean, message: string) => {
  if (!ok) throw new ReportInvalid(message);
};

function validTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseFilter(v: unknown, depth: number, count: { n: number }): FilterNode {
  check(isObj(v), "A report filter is malformed.");
  const node = v as Obj;
  check(++count.n <= LIMITS.nodes, `A report can have at most ${LIMITS.nodes} filter conditions.`);
  check(depth <= LIMITS.depth, `Filter groups can be nested at most ${LIMITS.depth} levels deep.`);
  if (node.kind === "group") {
    check((node.join === "and" || node.join === "or") && Array.isArray(node.children), "A report filter group is malformed.");
    return { kind: "group", join: node.join as "and" | "or", children: (node.children as unknown[]).map((c) => parseFilter(c, depth + 1, count)) };
  }
  check(node.kind === "condition" && isStr(node.field) && node.field.length <= 200 && isStr(node.op) && node.op.length <= 40, "A report filter condition is malformed.");
  check(!(node.op as string).startsWith("__"), "A report filter uses an unsupported operator.");
  const value = node.value === undefined ? undefined : JSON.parse(JSON.stringify(node.value));
  check(JSON.stringify(value ?? null).length <= 100_000, "A report filter value is too large.");
  check(!Array.isArray(value) || value.length <= LIMITS.list, `A report filter can list at most ${LIMITS.list} values.`);
  return { kind: "condition", field: node.field as string, op: node.op as string, ...(value === undefined ? {} : { value }) };
}

function parseSort(v: unknown): Sort | undefined {
  if (v === undefined || v === null) return undefined;
  check(isObj(v) && isStr(v.column) && typeof v.desc === "boolean", "A report sort is malformed.");
  return { column: (v as Obj).column as string, desc: (v as Obj).desc as boolean };
}

export function parseSpec(v: unknown): SavedSpec {
  check(isObj(v), "The report query is malformed.");
  const s = v as Obj;
  check(s.v === 1, "This report was created by a newer version of JAM. Update the app to use it.");
  check(s.entity === "assets" || s.entity === "events", "The report's data type is not supported.");
  check(s.mode === "detail" || s.mode === "aggregate", "The report's mode is not supported.");
  check(isStr(s.timezone) && validTimezone(s.timezone), "The report's time zone is not valid.");
  const columns = s.columns === undefined ? undefined : s.columns;
  check(columns === undefined || (Array.isArray(columns) && columns.length <= LIMITS.columns && columns.every(isStr)), "The report columns are malformed.");
  const groupBy = (s.groupBy ?? []) as unknown;
  check(Array.isArray(groupBy) && groupBy.length <= LIMITS.groupBy, `A report can group by at most ${LIMITS.groupBy} fields.`);
  const groups: GroupBy[] = (groupBy as unknown[]).map((g) => {
    check(isObj(g) && isStr(g.field) && (g.bucket === undefined || g.bucket === null || BUCKETS.includes(g.bucket as string)), "A report grouping is malformed.");
    const x = g as Obj;
    return { field: x.field as string, ...(x.bucket ? { bucket: x.bucket as Bucket } : {}) };
  });
  const measures = (s.measures ?? []) as unknown;
  check(Array.isArray(measures) && measures.length <= LIMITS.measures, `A report can have at most ${LIMITS.measures} measures.`);
  const ms: Measure[] = (measures as unknown[]).map((m) => {
    check(isObj(m) && isStr(m.id) && m.id.length <= 64 && MEASURE_FNS.includes(m.fn as string), "A report measure is malformed.");
    const x = m as Obj;
    check(x.field === undefined || x.field === null || isStr(x.field), "A report measure is malformed.");
    check(x.label === undefined || x.label === null || (isStr(x.label) && x.label.length <= 200), "A report measure is malformed.");
    return { id: x.id as string, fn: x.fn as MeasureFn, ...(x.field ? { field: x.field as string } : {}), ...(x.label ? { label: x.label as string } : {}) };
  });
  check(new Set(ms.map((m) => m.id)).size === ms.length, "Report measures must have unique IDs.");
  const sort = parseSort(s.sort);
  check(s.includeUnavailable === undefined || typeof s.includeUnavailable === "boolean", "The report options are malformed.");
  check(s.includeSoftDeleted === undefined || typeof s.includeSoftDeleted === "boolean", "The report options are malformed.");
  return {
    v: 1,
    entity: s.entity as Entity,
    filter: parseFilter(s.filter, 1, { n: 0 }),
    mode: s.mode as QuerySpec["mode"],
    ...(columns ? { columns: [...(columns as string[])] } : {}),
    groupBy: groups,
    measures: ms,
    ...(sort ? { sort } : {}),
    timezone: s.timezone as string,
    includeUnavailable: s.includeUnavailable !== false,
    includeSoftDeleted: s.includeSoftDeleted === true,
  };
}

function parseView(v: unknown): ViewConfig {
  if (v === undefined) return { ...DEFAULT_VIEW };
  check(isObj(v) && (VISUALS as readonly string[]).includes(v.visual as string), "The report view is malformed.");
  const x = v as Obj;
  const int = (n: unknown, min: number, max: number, fallback: number) =>
    typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  return { visual: x.visual as VisualKind, measure: int(x.measure, 0, LIMITS.measures - 1, 0), top: int(x.top, 1, 50, DEFAULT_VIEW.top) };
}

export function parseSource(v: unknown): ReportSource {
  check(isObj(v), "The data source is malformed.");
  const s = v as Obj;
  check(isId(s.id) && isName(s.name) && isStr(s.cloudId) && isStr(s.workspaceId), "The data source is malformed.");
  check(Array.isArray(s.objectTypeIds) && s.objectTypeIds.length > 0 && s.objectTypeIds.length <= LIMITS.types && s.objectTypeIds.every(isDigits),
    `A data source needs between 1 and ${LIMITS.types} object types.`);
  const scopeAql = s.scopeAql ?? "";
  check(isStr(scopeAql) && scopeAql.length <= LIMITS.scopeAql, "The data source scope filter is too long.");
  const aliases = s.attributeAliases ?? {};
  check(isObj(aliases) && Object.entries(aliases).every(([k, list]) => isDigits(k) && Array.isArray(list) && list.length <= 50 && list.every(isName)),
    "The data source attribute aliases are malformed.");
  check(isTime(s.updatedAt), "The data source is malformed.");
  return {
    id: s.id as string,
    name: (s.name as string).trim(),
    cloudId: s.cloudId as string,
    workspaceId: s.workspaceId as string,
    objectTypeIds: [...new Set(s.objectTypeIds as string[])],
    scopeAql: scopeAql as string,
    attributeAliases: Object.fromEntries(Object.entries(aliases as Record<string, string[]>).map(([k, l]) => [k, l.map((n) => n.trim())])),
    updatedAt: s.updatedAt as number,
  };
}

export function parseReport(v: unknown): SavedReport {
  check(isObj(v), "The report is malformed.");
  const r = v as Obj;
  check(isId(r.id) && isName(r.name) && isId(r.sourceId) && isStr(r.cloudId) && isStr(r.workspaceId) && isTime(r.updatedAt), "The report is malformed.");
  return {
    id: r.id as string,
    name: (r.name as string).trim(),
    sourceId: r.sourceId as string,
    cloudId: r.cloudId as string,
    workspaceId: r.workspaceId as string,
    spec: parseSpec(r.spec),
    view: parseView(r.view),
    updatedAt: r.updatedAt as number,
  };
}

/** Device-local identity mappings: attrId → raw history text → object key. */
export function parseMappings(v: unknown): Record<string, Record<string, string>> {
  if (!isObj(v)) return {};
  const out: Record<string, Record<string, string>> = {};
  for (const [attr, map] of Object.entries(v)) {
    if (!isDigits(attr) || !isObj(map)) continue;
    const entries = Object.entries(map).filter(([raw, key]) => raw.length <= 1000 && isStr(key) && key.length > 0 && key.length <= 255);
    if (entries.length) out[attr] = Object.fromEntries(entries) as Record<string, string>;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Filter helpers used by the builder.

export function countConditions(node: FilterNode): number {
  return node.kind === "condition" ? 1 : node.children.reduce((n, c) => n + countConditions(c), 0);
}

export function fieldsUsed(spec: SavedSpec): Set<string> {
  const out = new Set<string>();
  const walk = (n: FilterNode) => (n.kind === "condition" ? out.add(n.field) : n.children.forEach(walk));
  walk(spec.filter);
  for (const g of spec.groupBy ?? []) out.add(g.field);
  for (const m of spec.measures ?? []) if (m.field) out.add(m.field);
  for (const c of spec.columns ?? []) out.add(c);
  return out;
}
