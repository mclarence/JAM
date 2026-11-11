/**
 * Report contracts shared with the native engine (src-tauri/src/reports/model.rs). Keep both sides in step.
 * See docs/reports.md for how to add sources, fields, filter types and visualizations.
 */

export type Entity = "assets" | "events";
export type Mode = "detail" | "aggregate";
export type FieldType = "text" | "number" | "date" | "datetime" | "boolean" | "ref" | "enum";
export type Bucket = "day" | "week" | "month";
export type MeasureFn = "count" | "countValues" | "distinct" | "sum" | "avg";
export type Join = "and" | "or";

export interface ConditionNode {
  kind: "condition";
  field: string;
  op: string;
  value?: unknown;
}
export interface GroupNode {
  kind: "group";
  join: Join;
  children: FilterNode[];
}
export type FilterNode = ConditionNode | GroupNode;

export interface GroupBy {
  field: string;
  bucket?: Bucket;
}
export interface Measure {
  id: string;
  fn: MeasureFn;
  field?: string;
  label?: string;
}
export interface Sort {
  column: string;
  desc: boolean;
}
export interface SoftDeleteMarker {
  typeId: string;
  attributeId: string;
  value: string;
}

/** The executable query. Saved reports store it without `softDelete`, which is derived from deletion settings at run time. */
export interface QuerySpec {
  v: 1;
  entity: Entity;
  filter: FilterNode;
  mode: Mode;
  columns?: string[];
  groupBy?: GroupBy[];
  measures?: Measure[];
  sort?: Sort;
  timezone: string;
  includeUnavailable?: boolean;
  includeSoftDeleted?: boolean;
  softDelete?: SoftDeleteMarker[];
}

/** What the native engine needs to collect and query a data source. */
export interface Dataset {
  id: string;
  cloudId: string;
  workspaceId: string;
  objectTypeIds: string[];
  scopeAql?: string;
  attributeAliases?: Record<string, string[]>;
  valueMappings?: Record<string, Record<string, string>>;
}

export interface FieldOption {
  value: string;
  label: string;
}
export interface FieldDef {
  id: string;
  label: string;
  category: string;
  type: FieldType;
  multi: boolean;
  operators: string[];
  measures: MeasureFn[];
  picker: boolean;
  options?: FieldOption[];
}

export interface Column {
  id: string;
  label: string;
  type: FieldType | "bucket";
  field?: string;
  bucket?: Bucket;
  fn?: MeasureFn;
}
export type Cell = string | number | boolean | null;

export interface AggRow {
  keys: Cell[];
  labels: Cell[];
  values: Cell[];
}
export interface Warning {
  code: string;
  message: string;
}
export interface Aggregate {
  dimensions: Column[];
  measures: Column[];
  totals: Cell[];
  truncated: boolean;
}
export interface RunResult {
  runId: string;
  mode: Mode;
  dataVersion: number;
  generatedMs: number;
  lastRefreshMs: number | null;
  columns: Column[];
  total: number;
  /** Detail: arrays aligned with `columns`. Aggregate: `AggRow`s. */
  rows: Cell[][] | AggRow[];
  aggregate?: Aggregate;
  warnings: Warning[];
}
export interface Page {
  total: number;
  rows: Cell[][] | AggRow[];
}
export interface ChartData {
  rows: AggRow[];
  other?: Cell[];
  otherGroups: number;
  truncated: boolean;
}

export interface Status {
  collected: boolean;
  lastRefreshMs: number | null;
  lastFullMs: number | null;
  lastError: string | null;
  assets: number;
  unavailableAssets: number;
  events: number;
  historiesFailed: number;
  historiesDenied: number;
  historiesMissing: number;
  unresolvedEvents: number;
  scopeChanged: boolean;
  resumable: number;
  refreshing: boolean;
  dataVersion: number;
  fullCooldownMs: number;
}
export interface CollectSettings {
  concurrency: number;
  requestsPerSecond: number;
}
export interface Estimate {
  assets: number;
  inventoryRequests: number;
  metadataRequests: number;
  historyRequests: number;
  historyRequestsMax: number;
  firstCollection: boolean;
  fullCooldownMs: number;
  concurrency: number;
  requestsPerSecond: number;
  resumable: number;
}
export interface Progress {
  phase: string;
  done: number;
  total: number;
  requests: number;
  throttled: number;
  message?: string;
}
export interface RefreshSummary {
  assets: number;
  historiesFetched: number;
  historiesReused: number;
  historiesFailed: number;
  historiesMissing: number;
  historiesDenied: number;
  requests: number;
  throttled: number;
  events: number;
  dataVersion: number;
}
export interface FieldValue {
  value: string;
  label: string;
  count: number;
}
export interface Unresolved {
  values: { attributeId: string; attributeName: string; raw: string; count: number; suggestion?: FieldOption | null }[];
  attributes: { name: string; count: number }[];
}

export const LIMITS = { groupBy: 2, measures: 8, columns: 50, list: 1000, nodes: 100, depth: 5, types: 20, scopeAql: 2000 } as const;
