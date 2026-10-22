import { renderToStaticMarkup } from "react-dom/server";
import { jsPDF } from "jspdf";
import { svg2pdf } from "svg2pdf.js";
import { save } from "@tauri-apps/plugin-dialog";
import { fileApi } from "@/api/client";
import type { AssetObject, ObjectTypeAttribute } from "@/api/types";
import { LabelGroup } from "./LabelSvg";
import { paperDims, type LabelTemplate } from "./model";
import { makeResolver } from "./placeholders";

export interface PageSlot {
  x: number;
  y: number;
  object: AssetObject;
}

export interface Page {
  width: number;
  height: number;
  slots: PageSlot[];
}

/** Lays objects out onto pages (one label per page, or a grid on sheet paper). */
export function buildPages(template: LabelTemplate, objects: AssetObject[], startOffset = 0): Page[] {
  const layout = template.layout;
  if (layout.mode === "single") {
    return objects.map((object) => ({
      width: template.width,
      height: template.height,
      slots: [{ x: 0, y: 0, object }],
    }));
  }
  const { width, height } = paperDims(layout);
  const perPage = Math.max(1, layout.columns * layout.rows);
  const pages: Page[] = [];
  let slot = Math.min(Math.max(0, startOffset), perPage - 1);
  for (const object of objects) {
    if (pages.length === 0 || slot >= perPage) {
      pages.push({ width, height, slots: [] });
      if (pages.length > 1) slot = 0;
    }
    const col = slot % layout.columns;
    const row = Math.floor(slot / layout.columns);
    pages[pages.length - 1].slots.push({
      x: layout.marginLeft + col * (template.width + layout.gapX),
      y: layout.marginTop + row * (template.height + layout.gapY),
      object,
    });
    slot++;
  }
  return pages;
}

export function PageSvg({
  page,
  template,
  attributes,
}: {
  page: Page;
  template: LabelTemplate;
  attributes: ObjectTypeAttribute[];
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={`${page.width}mm`}
      height={`${page.height}mm`}
      viewBox={`0 0 ${page.width} ${page.height}`}
    >
      <rect width={page.width} height={page.height} fill="#ffffff" />
      {page.slots.map((s) => (
        <LabelGroup
          key={`${s.object.id}-${s.x}-${s.y}`}
          template={template}
          resolve={makeResolver(s.object, attributes)}
          x={s.x}
          y={s.y}
        />
      ))}
    </svg>
  );
}

function toBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Produces a vector PDF where every page has the exact physical size of the label or sheet. */
export async function generatePdf(pages: Page[], template: LabelTemplate, attributes: ObjectTypeAttribute[]) {
  if (pages.length === 0) throw new Error("Nothing to print");
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0;visibility:hidden;";
  document.body.appendChild(host);
  try {
    const first = pages[0];
    const orient = (p: Page) => (p.width > p.height ? "landscape" : "portrait");
    const doc = new jsPDF({ unit: "mm", format: [first.width, first.height], orientation: orient(first), compress: true });
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      if (i > 0) doc.addPage([page.width, page.height], orient(page));
      host.innerHTML = renderToStaticMarkup(<PageSvg page={page} template={template} attributes={attributes} />);
      const svg = host.querySelector("svg");
      if (!svg) throw new Error("Failed to render label page");
      await svg2pdf(svg, doc, { x: 0, y: 0, width: page.width, height: page.height });
    }
    return toBase64(doc.output("arraybuffer"));
  } finally {
    host.remove();
  }
}

export async function outputPdf(dataB64: string, baseName: string, mode: "open" | "save") {
  const fileName = baseName.replace(/[^\w-]+/g, "_") || "labels";
  if (mode === "open") {
    await fileApi.openPdf(fileName, dataB64);
    return true;
  }
  const path = await save({ defaultPath: `${fileName}.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (!path) return false;
  await fileApi.savePdf(path, dataB64);
  return true;
}

/** Generates and outputs labels; returns false if the user cancelled the save dialog. */
export async function printLabels(
  template: LabelTemplate,
  objects: AssetObject[],
  attributes: ObjectTypeAttribute[],
  mode: "open" | "save",
  startOffset = 0,
) {
  const pages = buildPages(template, objects, startOffset);
  const data = await generatePdf(pages, template, attributes);
  return outputPdf(data, `${template.name}-${objects.length}-labels`, mode);
}
