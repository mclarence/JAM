import { useCallback, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, Download, FileJson, FileSpreadsheet, Loader2, Printer } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { reportsApi } from "@/api/reports";
import { outputPdf } from "@/components/labels/print";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip } from "@/components/ui/overlays";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { describeCondition } from "@/lib/reports/filters";
import { formatAgo } from "@/lib/reports/format";
import { MEASURE_LABELS, type SavedSpec, type ViewConfig, type VisualKind } from "@/lib/reports/model";
import type { FieldDef, FilterNode, RunResult, Sort } from "@/lib/reports/types";
import { VISUAL_RULES } from "@/lib/reports/visuals";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { valueLabels } from "./FieldPicker";
import { reportSummaryPdf } from "./print";
import { ResultTable } from "./ResultTable";
import { reportKeys } from "./state";
import { KpiCards, ReportChart, shapeChart } from "./visuals";

/** Flattened, readable filter lines for summaries and print. */
export function describeFilter(node: FilterNode, fields: Map<string, FieldDef>): string[] {
  if (node.kind === "condition") return [describeCondition(node, fields.get(node.field), valueLabels)];
  const parts = node.children.flatMap((c) => {
    const lines = describeFilter(c, fields);
    return c.kind === "group" && lines.length > 1 ? [`(${lines.join(` ${c.join.toUpperCase()} `)})`] : lines;
  });
  return node.join === "or" && parts.length > 1 ? [parts.join(" OR ")] : parts;
}

export function describeShape(spec: SavedSpec, fields: Map<string, FieldDef>) {
  if (spec.mode === "detail") return "Detail rows";
  const groups = (spec.groupBy ?? []).map((g) => `${fields.get(g.field)?.label ?? g.field}${g.bucket ? ` by ${g.bucket}` : ""}`);
  const measures = (spec.measures ?? []).map((m) => m.label || (m.field ? `${MEASURE_LABELS[m.fn]} of ${fields.get(m.field)?.label ?? m.field}` : MEASURE_LABELS[m.fn]));
  return `${groups.length ? `Grouped by ${groups.join(", ")}` : "Totals"} · ${measures.join(", ")}`;
}

export function Results({
  name,
  sourceName,
  result,
  spec,
  view,
  fields,
  outdated,
  runSort,
  onView,
  onSort,
  onStale,
}: {
  name: string;
  sourceName: string;
  result: RunResult;
  spec: SavedSpec;
  view: ViewConfig;
  fields: Map<string, FieldDef>;
  /** The builder changed since this result was produced. */
  outdated: boolean;
  runSort: Sort | undefined;
  onView: (v: ViewConfig) => void;
  onSort: (s: Sort | undefined) => void;
  onStale: (e: unknown) => void;
}) {
  const qc = useQueryClient();
  const chartRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const agg = result.aggregate;
  const measures = agg?.measures ?? [];
  const measure = Math.min(view.measure, Math.max(0, measures.length - 1));
  const ctx = useMemo(
    () => ({ mode: result.mode, dimensions: agg?.dimensions ?? [], measures, fields, measure }),
    [result.mode, agg, measures, fields, measure],
  );
  const reasons = useMemo(() => new Map(VISUAL_RULES.map((r) => [r.id, r.unsupported(ctx)])), [ctx]);
  const visual: VisualKind = reasons.get(view.visual) ? "table" : view.visual;
  const isChart = visual === "bar" || visual === "line" || visual === "pie";
  const stale = useCallback((e: unknown) => onStale(e), [onStale]);

  const exportAs = async (format: "csv" | "json") => {
    const base = name.replace(/[^\w-]+/g, "_") || "report";
    const path = await save({ defaultPath: `${base}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
    if (!path) return;
    setBusy(format);
    try {
      const n = await reportsApi.export(result.runId, path, format, name, spec.sort);
      notify.success(`Exported ${n.toLocaleString()} ${agg ? "groups" : "records"}`);
    } catch (e) {
      onStale(e);
      notify.error(e, "Export failed");
    } finally {
      setBusy(null);
    }
  };

  const print = async (mode: "open" | "save") => {
    setBusy("print");
    try {
      let chart;
      if (isChart) {
        const svg = chartRef.current?.querySelector("svg.recharts-surface") as SVGSVGElement | null;
        const data = qc.getQueryData(reportKeys.chart(result.runId, measure, view.top)) as Parameters<typeof shapeChart>[0] | undefined;
        if (svg) chart = { svg, legend: data ? shapeChart(data, result, measure, view.top).series.map((s) => ({ name: s.name, color: s.color })) : [] };
      }
      const pdf = await reportSummaryPdf({
        title: name,
        sourceName,
        result,
        timezone: spec.timezone,
        filters: describeFilter(spec.filter, fields),
        shape: describeShape(spec, fields),
        chart,
      });
      await outputPdf(pdf, name || "report", mode);
    } catch (e) {
      notify.error(e, "Could not create the summary");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border p-0.5" role="tablist" aria-label="Visualization">
          {VISUAL_RULES.map((r) => {
            const reason = reasons.get(r.id);
            const button = (
              <button
                key={r.id}
                type="button"
                role="tab"
                aria-selected={visual === r.id}
                aria-disabled={!!reason}
                onClick={() => !reason && onView({ ...view, visual: r.id })}
                className={cn(
                  "rounded px-2.5 py-1 text-xs font-medium",
                  visual === r.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                  reason && "cursor-not-allowed opacity-40 hover:text-muted-foreground",
                )}
              >
                {r.label}
              </button>
            );
            return reason ? (
              <Tooltip key={r.id} content={<span className="block max-w-64">{reason}</span>}>
                {button}
              </Tooltip>
            ) : (
              button
            );
          })}
        </div>
        {isChart && measures.length > 1 && (
          <Select value={String(measure)} onValueChange={(v) => onView({ ...view, measure: Number(v) })}>
            <SelectTrigger className="h-8 w-48" aria-label="Measure to chart">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {measures.map((m, i) => (
                <SelectItem key={m.id} value={String(i)}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {isChart && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Top
            <NumberInput className="h-8 w-16" min={1} max={50} step={1} value={view.top} onCommit={(n) => onView({ ...view, top: Math.round(n) })} aria-label="Groups to show" />
          </label>
        )}
        <div className="ml-auto flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={!!busy}>
                {busy ? <Loader2 className="animate-spin" /> : <Download />} Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>All {result.total.toLocaleString()} {agg ? "groups" : "records"}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => void exportAs("csv")}>
                <FileSpreadsheet /> CSV
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportAs("json")}>
                <FileJson /> JSON
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void print("open")}>
                <Printer /> Open printable summary
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void print("save")}>
                <Printer /> Save summary as PDF
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {result.total.toLocaleString()} {agg ? (agg.dimensions.length ? "groups" : "summary row") : "records"} · data refreshed {formatAgo(result.lastRefreshMs, result.generatedMs)}
        </span>
        {outdated && <Badge variant="outline">Builder changed — run again to update</Badge>}
        {agg?.truncated && (
          <Badge variant="destructive">
            <AlertTriangle className="mr-1 size-3" /> Too many groups; showing the largest
          </Badge>
        )}
        {result.warnings.map((w) => (
          <Badge key={w.code} variant="outline" className="max-w-full gap-1 whitespace-normal border-amber-500/50 text-amber-700 dark:text-amber-400">
            <AlertTriangle className="size-3 shrink-0" /> {w.message}
          </Badge>
        ))}
      </div>

      {visual === "table" && <ResultTable key={result.runId} result={result} sort={spec.sort} runSort={runSort} onSort={onSort} timezone={spec.timezone} onStale={stale} />}
      {visual === "kpi" && <KpiCards result={result} />}
      {isChart && <ReportChart ref={chartRef} result={result} visual={visual} measure={measure} top={view.top} onStale={stale} />}
    </div>
  );
}
