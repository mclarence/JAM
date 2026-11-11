import { Channel } from "@tauri-apps/api/core";
import { ApiError, call } from "./client";
import type {
  ChartData,
  CollectSettings,
  Dataset,
  Entity,
  Estimate,
  FieldDef,
  FieldValue,
  Page,
  Progress,
  QuerySpec,
  RefreshSummary,
  RunResult,
  Sort,
  Status,
  Unresolved,
} from "@/lib/reports/types";

/** Typed wrappers for the native report engine. Only `refresh` and `estimate` contact Jira. */
export const reportsApi = {
  status: (dataset: Dataset) => call<Status>("reports_status", { dataset }),
  fields: (dataset: Dataset, entity: Entity) => call<FieldDef[]>("reports_fields", { dataset, entity }),
  estimate: (dataset: Dataset, settings: CollectSettings) => call<Estimate>("reports_estimate", { dataset, settings }),
  refresh: (dataset: Dataset, full: boolean, settings: CollectSettings, onProgress: (p: Progress) => void) => {
    const channel = new Channel<Progress>();
    channel.onmessage = onProgress;
    return call<RefreshSummary>("reports_refresh", { dataset, full, settings, onProgress: channel });
  },
  cancel: () => call<void>("reports_cancel"),
  run: (dataset: Dataset, spec: QuerySpec, pageSize: number, sort?: Sort) =>
    call<RunResult>("reports_run", { dataset, spec, pageSize, sort: sort ?? null }),
  page: (runId: string, offset: number, limit: number, sort?: Sort) =>
    call<Page>("reports_page", { runId, offset, limit, sort: sort ?? null }),
  chart: (runId: string, measure: number, top: number) => call<ChartData>("reports_chart", { runId, measure, top }),
  export: (runId: string, path: string, format: "csv" | "json", name: string, sort?: Sort) =>
    call<number>("reports_export", { runId, path, format, name, sort: sort ?? null }),
  fieldValues: (dataset: Dataset, entity: Entity, field: string, search: string, limit = 50) =>
    call<FieldValue[]>("reports_field_values", { dataset, entity, field, search, limit }),
  unresolved: (dataset: Dataset) => call<Unresolved>("reports_unresolved", { dataset }),
  clear: (datasetId?: string) => call<void>("reports_clear", { datasetId: datasetId ?? null }),
};

export const isStale = (e: unknown) => e instanceof ApiError && e.kind === "stale";
