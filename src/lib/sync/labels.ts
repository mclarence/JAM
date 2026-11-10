import { decodeKey, splitRid, type Json } from "./engine";

const KINDS: Record<string, string> = {
  connection: "Jira connection",
  selection: "Selected schema and object type",
  theme: "Theme",
  filter: "Saved filter",
  statusColor: "Status colour",
  columns: "Columns",
  assetTag: "Asset tag",
  referenceDisplay: "Reference display",
  rule: "Rule",
  ruleOrder: "Rule order",
  deletion: "Deletion settings",
  scanConfig: "Quick Scan settings",
  scanPreset: "Quick Scan preset",
  scanSound: "Quick Scan sound",
  template: "Label template",
  defaultTemplate: "Default label template",
  labelDefaults: "Label defaults",
  columnSizes: "Column widths",
  updater: "Update settings",
};

const nameOf = (v: Json | undefined) =>
  v && typeof v === "object" && !Array.isArray(v) && typeof v.name === "string" ? v.name : null;

/** A short human-readable name for a sync record. */
export function describeRecord(id: string, ...values: (Json | undefined)[]): string {
  const [, key] = splitRid(id);
  const [kind, ...rest] = decodeKey(key);
  const label = KINDS[kind] ?? kind;
  const name = values.map(nameOf).find(Boolean);
  if (name) return `${label} “${name}”`;
  if (kind === "statusColor") return `${label} for “${rest[0]}”`;
  const typeId = ["columns", "assetTag", "referenceDisplay", "ruleOrder", "deletion", "scanConfig", "columnSizes"].includes(kind) ? rest[2] : null;
  return typeId ? `${label} (object type ${typeId})` : label;
}

/** A compact rendering of a record value for conflict choices. */
export function summarizeValue(value: Json | undefined): string {
  if (value === undefined) return "Removed / default";
  if (value === null) return "Default";
  if (typeof value !== "object") return String(value);
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}
