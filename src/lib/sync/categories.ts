import type { Adapter, ApplyResult, Change } from "./engine";

export const SYNC_CATEGORIES = [
  { id: "connection", label: "Jira connection details" },
  { id: "selection", label: "Schema and object-type selection" },
  { id: "theme", label: "Theme" },
  { id: "filters", label: "Saved filters and order" },
  { id: "columns", label: "Columns (visibility, order and desktop widths)" },
  { id: "assetTags", label: "Asset tags" },
  { id: "referenceDisplay", label: "Reference-display fields" },
  { id: "statusColors", label: "Status colours" },
  { id: "rules", label: "Automation rules and order" },
  { id: "deletions", label: "Deletion settings" },
  { id: "quickScan", label: "Quick Scan settings, presets and sound" },
  { id: "labels", label: "Label templates and defaults (desktop only)" },
  { id: "updater", label: "Updater settings (desktop only)" },
  { id: "reports", label: "Report templates and data sources (desktop only)" },
] as const;

export type SyncCategory = (typeof SYNC_CATEGORIES)[number]["id"];
export const ALL_CATEGORIES: SyncCategory[] = SYNC_CATEGORIES.map((c) => c.id);
/** Proposed when choosing for the first time. Reports are opt-in because their sources may describe sensitive scopes. */
export const DEFAULT_CATEGORIES: SyncCategory[] = ALL_CATEGORIES.filter((c) => c !== "reports");
export const CATEGORY_RECORDS: Record<string, Record<string, SyncCategory>> = {
  shared: {
    connection: "connection", selection: "selection", theme: "theme", filter: "filters", filterOrder: "filters", columns: "columns",
    assetTag: "assetTags", referenceDisplay: "referenceDisplay", statusColor: "statusColors",
    rule: "rules", ruleOrder: "rules", deletion: "deletions",
    scanConfig: "quickScan", scanPreset: "quickScan", scanSound: "quickScan",
  },
  desktop: {
    columnSizes: "columns", template: "labels", defaultTemplate: "labels", labelDefaults: "labels", updater: "updater",
    reportSource: "reports", report: "reports",
  },
};

export function categoryOf(rid: string): SyncCategory | undefined {
  const [scope, key] = rid.split("|");
  return CATEGORY_RECORDS[scope]?.[key?.split(":")[0]];
}

export function validateCategories(value: unknown): SyncCategory[] {
  if (!Array.isArray(value) || !value.every((id): id is SyncCategory => ALL_CATEGORIES.includes(id))) {
    throw new Error("The device's sync categories are invalid. Choose which settings to sync again.");
  }
  return ALL_CATEGORIES.filter((id) => value.includes(id));
}

export function selectedAdapter(base: Adapter, selected: () => readonly SyncCategory[]): Adapter {
  const enabled = (rid: string) => {
    const category = categoryOf(rid);
    return category !== undefined && selected().includes(category) && base.isManaged(rid);
  };
  return {
    scopes: base.scopes,
    project: () => new Map([...base.project()].filter(([rid]) => enabled(rid))),
    isManaged: enabled,
    apply(changes: Change[]) {
      const eligible = changes.filter((c) => enabled(c.rid));
      const results = base.apply(eligible);
      let i = 0;
      return changes.map((c): ApplyResult => enabled(c.rid) ? results[i++] : { status: "deferred" });
    },
    flush: () => base.flush(),
    autoResolveLocal: (rid) => enabled(rid) && !!base.autoResolveLocal?.(rid),
    batchGroup: (rid) => categoryOf(rid) ?? "unknown",
  };
}
