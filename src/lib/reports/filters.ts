import type { ConditionNode, FieldDef, FieldType } from "./types";
import { recordedReferenceLabel } from "./format";

export const OPERATOR_LABELS: Record<string, string> = {
  eq: "is",
  neq: "is not",
  contains: "contains",
  notContains: "does not contain",
  startsWith: "starts with",
  in: "is any of",
  notIn: "is none of",
  empty: "is empty",
  notEmpty: "is not empty",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  between: "between",
  last: "in the last",
  on: "on",
  before: "before",
  after: "after",
  isTrue: "is yes",
  isFalse: "is no",
};

const NO_VALUE = new Set(["empty", "notEmpty", "isTrue", "isFalse"]);
export const needsValue = (op: string) => !NO_VALUE.has(op);

export type ValueKind = "none" | "text" | "number" | "list" | "numberRange" | "dateRange" | "relative" | "date";

export function valueKind(type: FieldType, op: string): ValueKind {
  if (!needsValue(op)) return "none";
  if (op === "in" || op === "notIn") return "list";
  if (op === "last") return "relative";
  if (op === "between") return type === "number" ? "numberRange" : "dateRange";
  if (op === "on" || op === "before" || op === "after") return "date";
  return type === "number" ? "number" : "text";
}

export function defaultValue(type: FieldType, op: string): unknown {
  switch (valueKind(type, op)) {
    case "none":
      return undefined;
    case "list":
      return [];
    case "relative":
      return { amount: 30, unit: "day" };
    case "numberRange":
      return { min: null, max: null };
    case "dateRange":
      return { from: null, to: null };
    case "date":
      return new Date().toISOString().slice(0, 10);
    case "number":
      return null;
    default:
      return "";
  }
}

export function defaultCondition(field: FieldDef): ConditionNode {
  const op = field.type === "date" || field.type === "datetime" ? "last" : field.operators[0];
  return { kind: "condition", field: field.id, op, value: defaultValue(field.type, op) };
}

/** Returns a message when the condition is incomplete, so Run can point at it instead of failing natively. */
export function conditionProblem(c: ConditionNode, field: FieldDef | undefined): string | null {
  if (!field) return "This field is not available in the data source. Remove the filter or refresh the data.";
  if (!field.operators.includes(c.op)) return `"${field.label}" does not support "${OPERATOR_LABELS[c.op] ?? c.op}".`;
  const v = c.value as Record<string, unknown> | unknown[] | string | number | null | undefined;
  switch (valueKind(field.type, c.op)) {
    case "list":
      return Array.isArray(v) && v.length > 0 ? null : `Choose at least one value for "${field.label}".`;
    case "relative": {
      const amount = (v as { amount?: unknown })?.amount;
      return typeof amount === "number" && Number.isInteger(amount) && amount >= 1 && amount <= 3650 ? null : "Enter a whole number from 1 to 3650.";
    }
    case "numberRange": {
      const r = (v ?? {}) as { min?: unknown; max?: unknown };
      return typeof r.min === "number" || typeof r.max === "number" ? null : "Enter a minimum or maximum.";
    }
    case "dateRange": {
      const r = (v ?? {}) as { from?: unknown; to?: unknown };
      if (!r.from && !r.to) return "Choose a start or end date.";
      return r.from && r.to && String(r.from) > String(r.to) ? "The start date must be on or before the end date." : null;
    }
    case "date":
      return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? null : "Choose a date.";
    case "number":
      return typeof v === "number" && Number.isFinite(v) ? null : `Enter a number for "${field.label}".`;
    case "text":
      return typeof v === "string" && v.length > 0 ? null : `Enter a value for "${field.label}".`;
    default:
      return null;
  }
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** Human-readable condition, e.g. `Borrower is any of Jane Doe, +2`. `labels` maps stored keys to display names. */
export function describeCondition(c: ConditionNode, field: FieldDef | undefined, labels?: Map<string, string>): string {
  const name = field?.label ?? c.field;
  const op = OPERATOR_LABELS[c.op] ?? c.op;
  const v = c.value as never;
  const kind = field ? valueKind(field.type, c.op) : "text";
  const optionLabel = (x: string) => labels?.get(x) ?? field?.options?.find((o) => o.value === x)?.label ?? (field?.type === "ref" ? recordedReferenceLabel(x) : x);
  switch (kind) {
    case "none":
      return `${name} ${op}`;
    case "list": {
      const list = (Array.isArray(v) ? v : []) as string[];
      const shown = list.slice(0, 2).map(optionLabel).join(", ");
      return `${name} ${op} ${shown || "…"}${list.length > 2 ? `, +${list.length - 2}` : ""}`;
    }
    case "relative": {
      const r = (v ?? {}) as { amount?: number; unit?: string };
      return `${name} ${op} ${plural(r.amount ?? 0, r.unit ?? "day")}`;
    }
    case "numberRange": {
      const r = (v ?? {}) as { min?: number | null; max?: number | null };
      if (r.min != null && r.max != null) return `${name} ${r.min}–${r.max}`;
      return r.min != null ? `${name} ≥ ${r.min}` : `${name} ≤ ${r.max ?? "…"}`;
    }
    case "dateRange": {
      const r = (v ?? {}) as { from?: string | null; to?: string | null };
      if (r.from && r.to) return `${name} ${r.from} – ${r.to}`;
      return r.from ? `${name} from ${r.from}` : `${name} until ${r.to ?? "…"}`;
    }
    default:
      return `${name} ${op} ${v === null || v === undefined || v === "" ? "…" : String(v)}`;
  }
}
