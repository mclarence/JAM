import type { Bucket, Cell, Column } from "./types";

export const recordedReferenceLabel = (value: string): string => value.replace(/^label:\d+:/, "");

const dateFmt = new Map<string, Intl.DateTimeFormat>();
function fmt(timeZone: string, options: Intl.DateTimeFormatOptions) {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let f = dateFmt.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(undefined, { ...options, timeZone });
    } catch {
      f = new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" });
    }
    dateFmt.set(key, f);
  }
  return f;
}

/** Formats a calendar day ("YYYY-MM-DD") without shifting it through a time zone. */
function formatDay(day: string, options: Intl.DateTimeFormatOptions = { dateStyle: "medium" }) {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m) return day;
  return fmt("UTC", options).format(Date.UTC(y, m - 1, d || 1));
}

export function formatBucket(value: string, bucket: Bucket | undefined) {
  if (bucket === "month") return formatDay(value, { month: "short", year: "numeric" });
  if (bucket === "week") return `Week of ${formatDay(value)}`;
  return formatDay(value);
}

export function formatNumber(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Display text for a cell. Datetimes arrive as epoch milliseconds and are shown in the report's time zone. */
export function formatCell(value: Cell, column: Pick<Column, "type" | "bucket">, timeZone: string): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (column.type) {
    case "datetime":
      return typeof value === "number" ? fmt(timeZone, { dateStyle: "medium", timeStyle: "short" }).format(value) : String(value);
    case "date":
      return typeof value === "string" ? formatDay(value) : String(value);
    case "bucket":
      return typeof value === "string" ? formatBucket(value, column.bucket) : String(value);
    case "boolean":
      return value === true || value === 1 || value === "true" ? "Yes" : "No";
    case "number":
      return typeof value === "number" ? formatNumber(value) : String(value);
    default:
      return String(value);
  }
}

/** A short "last refreshed" phrase. */
export function formatAgo(ms: number | null | undefined, now = Date.now()) {
  if (!ms) return "never";
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });
}
