import { jsPDF } from "jspdf";
import { svg2pdf } from "svg2pdf.js";
import { toBase64 } from "@/components/labels/print";
import { formatAgo, formatCell } from "@/lib/reports/format";
import type { RunResult } from "@/lib/reports/types";
import { flatRows, tableColumns } from "./ResultTable";

export interface PrintInput {
  title: string;
  sourceName: string;
  result: RunResult;
  timezone: string;
  /** One line per filter condition, already human-readable. */
  filters: string[];
  /** e.g. "Grouped by Borrower · Count of records". */
  shape: string;
  chart?: { svg: SVGSVGElement; legend: { name: string; color: string }[] };
  /** Rows to list after the chart (the current table page). */
  maxRows?: number;
}

const MARGIN = 15;

/** A one-document A4 summary: header, freshness, filters, totals, the chart and the leading rows. */
export async function reportSummaryPdf(input: PrintInput) {
  const { result } = input;
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();
  const inner = width - MARGIN * 2;
  let y = MARGIN;

  const ensure = (needed: number) => {
    if (y + needed > height - MARGIN) {
      doc.addPage();
      y = MARGIN;
    }
  };
  const para = (text: string, size = 9, color = 90) => {
    doc.setFontSize(size);
    doc.setTextColor(color);
    for (const line of doc.splitTextToSize(text, inner) as string[]) {
      ensure(size * 0.45);
      doc.text(line, MARGIN, y);
      y += size * 0.45;
    }
  };

  doc.setFont("helvetica", "bold");
  para(input.title, 16, 20);
  doc.setFont("helvetica", "normal");
  y += 1;
  para(`${input.sourceName} · ${input.shape}`);
  para(
    `Generated ${new Date(result.generatedMs).toLocaleString()} · Data refreshed ${formatAgo(result.lastRefreshMs, result.generatedMs)} · Time zone ${input.timezone}`,
  );
  y += 2;
  para(input.filters.length ? `Filters: ${input.filters.join("; ")}` : "Filters: none (all records)");
  for (const w of result.warnings) para(`Note: ${w.message}`, 8, 140);
  y += 3;

  const agg = result.aggregate;
  const kpis = agg ? agg.measures.map((m, i) => [m.label, formatCell(agg.totals[i] ?? null, { type: "number" }, "UTC")]) : [["Records", result.total.toLocaleString()]];
  if (agg && agg.dimensions.length) kpis.push(["Groups", result.total.toLocaleString()]);
  const boxW = Math.min(45, (inner - 3 * (Math.min(kpis.length, 4) - 1)) / Math.min(kpis.length, 4));
  kpis.forEach(([label, value], i) => {
    const col = i % 4;
    if (col === 0 && i > 0) y += 20;
    if (col === 0) ensure(18);
    const x = MARGIN + col * (boxW + 3);
    doc.setDrawColor(220);
    doc.roundedRect(x, y, boxW, 17, 1.5, 1.5);
    doc.setFontSize(7.5);
    doc.setTextColor(110);
    doc.text(doc.splitTextToSize(label, boxW - 4)[0] as string, x + 2, y + 5);
    doc.setFontSize(14);
    doc.setTextColor(20);
    doc.text(value, x + 2, y + 13);
  });
  y += 23;

  if (input.chart) {
    const { svg, legend } = input.chart;
    const box = svg.getBoundingClientRect();
    const ratio = box.width > 0 ? box.height / box.width : 0.5;
    const chartH = Math.min(120, inner * ratio);
    ensure(chartH + 4);
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("width", String(box.width || 800));
    clone.setAttribute("height", String(box.height || 400));
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-10000px;top:0;";
    host.appendChild(clone);
    document.body.appendChild(host);
    try {
      await svg2pdf(clone, doc, { x: MARGIN, y, width: inner, height: chartH });
    } finally {
      host.remove();
    }
    y += chartH + 3;
    if (legend.length > 1) {
      doc.setFontSize(8);
      let x = MARGIN;
      for (const l of legend) {
        const w = doc.getTextWidth(l.name) + 8;
        if (x + w > width - MARGIN) {
          x = MARGIN;
          y += 5;
        }
        ensure(5);
        doc.setFillColor(l.color);
        doc.rect(x, y - 2.5, 3, 3, "F");
        doc.setTextColor(60);
        doc.text(l.name, x + 4, y);
        x += w;
      }
      y += 6;
    }
  }

  const cols = tableColumns(result).slice(0, 6);
  const rows = flatRows(result, result.rows).slice(0, input.maxRows ?? 40);
  if (rows.length) {
    ensure(12);
    doc.setFont("helvetica", "bold");
    para(result.aggregate ? "Top groups" : "First records", 10, 30);
    doc.setFont("helvetica", "normal");
    y += 1;
    const colW = inner / cols.length;
    const row = (cells: string[], bold = false) => {
      ensure(5);
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setFontSize(8);
      doc.setTextColor(bold ? 60 : 30);
      cells.forEach((c, i) => {
        const text = doc.splitTextToSize(c, colW - 2)[0] as string;
        const numeric = cols[i].numeric;
        doc.text(text ?? "", numeric ? MARGIN + colW * (i + 1) - 1 : MARGIN + colW * i, y, numeric ? { align: "right" } : undefined);
      });
      y += 4.5;
    };
    row(cols.map((c) => c.col.label), true);
    doc.setDrawColor(220);
    doc.line(MARGIN, y - 3, width - MARGIN, y - 3);
    for (const r of rows) row(cols.map((c) => formatCell(c.get(r), c.col, input.timezone)));
    doc.setFont("helvetica", "normal");
    const more = result.total - rows.length;
    if (more > 0 || tableColumns(result).length > cols.length) {
      y += 1;
      para(
        `${more > 0 ? `${more.toLocaleString()} more ${result.aggregate ? "groups" : "records"}` : "Some columns"} not shown. Export to CSV or JSON for the complete data.`,
        8,
        120,
      );
    }
  }

  return toBase64(doc.output("arraybuffer"));
}
