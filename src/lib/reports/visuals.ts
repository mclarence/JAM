import type { VisualKind } from "./model";
import type { Column, FieldDef, Mode } from "./types";

export interface VisualContext {
  mode: Mode;
  dimensions: Column[];
  measures: Column[];
  fields: Map<string, FieldDef>;
  /** The measure the chart plots. */
  measure: number;
}

export interface VisualRule {
  id: VisualKind;
  label: string;
  /** A reason the result cannot be shown this way, or null when it can. Reports are never rewritten to fit a chart. */
  unsupported: (ctx: VisualContext) => string | null;
}

const needsSummary = (ctx: VisualContext) =>
  ctx.mode !== "aggregate" ? "Charts need a summary report. Switch to Summary and choose how to group the records." : null;
const needsGroup = (ctx: VisualContext) =>
  needsSummary(ctx) ?? (ctx.dimensions.length === 0 ? "Add a grouping to compare groups in a chart." : null) ??
  (ctx.measures.length === 0 ? "Add a measure to chart." : null);

/** Ordered registry of visualizations. Add a rule here and a renderer in components/reports/visuals.tsx. */
export const VISUAL_RULES: VisualRule[] = [
  { id: "table", label: "Table", unsupported: () => null },
  { id: "kpi", label: "KPI cards", unsupported: () => null },
  { id: "bar", label: "Bar chart", unsupported: needsGroup },
  {
    id: "line",
    label: "Line chart",
    unsupported: (ctx) =>
      needsGroup(ctx) ?? (ctx.dimensions[0]?.type !== "bucket" ? "Line charts need the first grouping to be a date by day, week or month." : null),
  },
  {
    id: "pie",
    label: "Breakdown (pie)",
    unsupported: (ctx) => {
      const base = needsGroup(ctx);
      if (base) return base;
      if (ctx.dimensions.length !== 1) return "Breakdown charts need exactly one grouping.";
      const dim = ctx.dimensions[0];
      if (dim.type === "bucket") return "Use a line or bar chart for values over time.";
      if (dim.field && ctx.fields.get(dim.field)?.multi) {
        return `"${dim.label}" can hold several values per record, so shares would add up to more than 100%. Use a bar chart.`;
      }
      const m = ctx.measures[ctx.measure];
      if (!m || !["count", "countValues", "sum"].includes(m.fn ?? "")) {
        return "Breakdown charts need a count or sum, because averages and distinct counts do not add up to a whole.";
      }
      return null;
    },
  },
];

export function visualRule(id: VisualKind) {
  return VISUAL_RULES.find((v) => v.id === id) ?? VISUAL_RULES[0];
}
