import { forwardRef, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell as PieCell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { isStale, reportsApi } from "@/api/reports";
import { Card } from "@/components/ui/primitives";
import { formatCell, formatNumber } from "@/lib/reports/format";
import type { VisualKind } from "@/lib/reports/model";
import type { AggRow, Cell, ChartData, Column, RunResult } from "@/lib/reports/types";
import { reportKeys } from "./state";

/** Fixed hex colours: theme variables use oklch, which does not survive the SVG → PDF print path. */
export const PALETTE = ["#2563eb", "#16a34a", "#ea580c", "#9333ea", "#0891b2", "#dc2626", "#ca8a04", "#db2777", "#4f46e5", "#65a30d"];
const OTHER_COLOR = "#a1a1aa";
const AXIS = { fontSize: 11, fill: "#71717a" };

export function KpiCards({ result }: { result: RunResult }) {
  const agg = result.aggregate;
  if (!agg) {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-3">
        <Kpi label="Records" value={formatNumber(result.total)} />
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-3">
      {agg.measures.map((m, i) => (
        <Kpi key={m.id} label={m.label} value={formatCell(agg.totals[i] ?? null, { type: "number" }, "UTC")} hint="Across all matching records" />
      ))}
      {agg.dimensions.length > 0 && <Kpi label="Groups" value={formatNumber(result.total)} hint={agg.truncated ? "Limit reached; narrow the filters" : undefined} />}
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <div className="truncate text-xs text-muted-foreground" title={label}>{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </Card>
  );
}

interface Series {
  key: string;
  name: string;
  color: string;
}
interface Shaped {
  data: Record<string, string | number | null>[];
  series: Series[];
  hiddenSeries: number;
  note: string | null;
}

const text = (v: Cell, col: Column | undefined, tz: string) => (col ? formatCell(v, col, tz) : String(v ?? "—"));
const num = (v: Cell) => (typeof v === "number" ? v : v == null ? null : Number(v));

/** Turns aggregate rows into Recharts data. A second grouping becomes series; only the top `top` series are drawn. */
export function shapeChart(chart: ChartData, result: RunResult, measure: number, top: number): Shaped {
  const agg = result.aggregate!;
  const [d0, d1] = agg.dimensions;
  // Grouped dates are always calendar buckets, which carry no time zone.
  const tz = "UTC";
  const mLabel = agg.measures[measure]?.label ?? "Value";
  let note = chart.truncated ? "Only part of the data is charted. Narrow the filters or use a coarser interval." : null;

  if (!d1) {
    const data = chart.rows.map((r) => ({ name: text(r.labels[0], d0, tz), value: num(r.values[measure]) }));
    if (chart.other) data.push({ name: `Other (${chart.otherGroups.toLocaleString()} groups)`, value: num(chart.other[measure]) });
    return { data, series: [{ key: "value", name: mLabel, color: PALETTE[0] }], hiddenSeries: 0, note };
  }

  const totals = new Map<string, { name: string; total: number }>();
  for (const r of chart.rows) {
    const k = JSON.stringify(r.keys[1]);
    const t = totals.get(k) ?? { name: text(r.labels[1], d1, tz), total: 0 };
    t.total += Math.abs(num(r.values[measure]) ?? 0);
    totals.set(k, t);
  }
  const ranked = [...totals].sort((a, b) => b[1].total - a[1].total);
  const shown = ranked.slice(0, top);
  const index = new Map(shown.map(([k], i) => [k, `s${i}`]));
  const series = shown.map(([, t], i) => ({ key: `s${i}`, name: t.name, color: PALETTE[i % PALETTE.length] }));
  const rows = new Map<string, Record<string, string | number | null>>();
  for (const r of chart.rows as AggRow[]) {
    const s = index.get(JSON.stringify(r.keys[1]));
    if (!s) continue;
    const x = JSON.stringify(r.keys[0]);
    const row = rows.get(x) ?? { name: text(r.labels[0], d0, tz) };
    row[s] = num(r.values[measure]);
    rows.set(x, row);
  }
  const hidden = ranked.length - shown.length;
  if (hidden > 0) note = [note, `${hidden.toLocaleString()} more "${d1.label}" series not shown. See the table for every group.`].filter(Boolean).join(" ");
  return { data: [...rows.values()], series, hiddenSeries: hidden, note };
}

export function useChartData(result: RunResult, measure: number, top: number, enabled: boolean) {
  return useQuery({
    queryKey: reportKeys.chart(result.runId, measure, top),
    queryFn: () => reportsApi.chart(result.runId, measure, top),
    enabled,
    staleTime: Infinity,
    retry: false,
  });
}

export const ReportChart = forwardRef<HTMLDivElement, { result: RunResult; visual: Exclude<VisualKind, "table" | "kpi">; measure: number; top: number; onStale: (e: unknown) => void }>(
  function ReportChart({ result, visual, measure, top, onStale }, ref) {
    const chart = useChartData(result, measure, top, true);
    const shaped = useMemo(() => (chart.data ? shapeChart(chart.data, result, measure, top) : null), [chart.data, result, measure, top]);

    useEffect(() => {
      if (chart.isError) onStale(chart.error);
    }, [chart.isError, chart.error, onStale]);

    if (chart.isError) {
      if (isStale(chart.error)) return null;
      return <p className="p-4 text-sm text-destructive">{chart.error.message}</p>;
    }
    if (!shaped) {
      return (
        <div className="flex h-80 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> Preparing chart…
        </div>
      );
    }
    if (shaped.data.length === 0) return <p className="p-8 text-center text-sm text-muted-foreground">No records match the filters.</p>;

    return (
      <div className="grid gap-2">
        <div ref={ref} className="h-[26rem] w-full">
          <ResponsiveContainer width="100%" height="100%">
            {renderChart(visual, shaped)}
          </ResponsiveContainer>
        </div>
        {shaped.note && <p className="text-xs text-muted-foreground">{shaped.note}</p>}
      </div>
    );
  },
);

/** Renders one of the chart visuals. Add a case here (and a rule in lib/reports/visuals.ts) for a new chart type. */
export function renderChart(visual: "bar" | "line" | "pie", { data, series }: Shaped, animate = true) {
  const many = data.length > 12;
  const xAxis = (
    <XAxis
      dataKey="name"
      tick={AXIS}
      interval={many ? "preserveStartEnd" : 0}
      angle={many ? -35 : 0}
      textAnchor={many ? "end" : "middle"}
      height={many ? 70 : 30}
      stroke="#d4d4d8"
    />
  );
  const yAxis = <YAxis tick={AXIS} stroke="#d4d4d8" tickFormatter={(v: number) => formatNumber(v)} width={56} />;
  const tooltip = <Tooltip formatter={(v) => (typeof v === "number" ? formatNumber(v) : String(v))} />;
  const legend = series.length > 1 ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null;

  if (visual === "pie") {
    return (
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" outerRadius="75%" isAnimationActive={animate} label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}>
          {data.map((d, i) => (
            <PieCell key={i} fill={String(d.name).startsWith("Other (") ? OTHER_COLOR : PALETTE[i % PALETTE.length]} />
          ))}
        </Pie>
        {tooltip}
      </PieChart>
    );
  }
  if (visual === "line") {
    return (
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
        {xAxis}
        {yAxis}
        {tooltip}
        {legend}
        {series.map((s) => (
          <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} dot={data.length <= 60} connectNulls={false} isAnimationActive={animate} />
        ))}
      </LineChart>
    );
  }
  return (
    <BarChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
      <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" vertical={false} />
      {xAxis}
      {yAxis}
      {tooltip}
      {legend}
      {series.map((s) => (
        <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color} isAnimationActive={animate} radius={[3, 3, 0, 0]}>
          {series.length === 1 && data.map((d, i) => <PieCell key={i} fill={String(d.name).startsWith("Other (") ? OTHER_COLOR : s.color} />)}
        </Bar>
      ))}
    </BarChart>
  );
}
