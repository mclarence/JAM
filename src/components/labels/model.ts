export type Unit = "mm" | "in" | "px";

export const MM_PER_IN = 25.4;
/** CSS reference pixel: 96 px per inch. */
export const PX_PER_MM = 96 / MM_PER_IN;
export const MM_PER_PT = MM_PER_IN / 72;

export function fromMm(mm: number, unit: Unit) {
  if (unit === "in") return mm / MM_PER_IN;
  if (unit === "px") return mm * PX_PER_MM;
  return mm;
}

export function toMm(value: number, unit: Unit) {
  if (unit === "in") return value * MM_PER_IN;
  if (unit === "px") return value / PX_PER_MM;
  return value;
}

export function formatUnit(mm: number, unit: Unit) {
  const v = fromMm(mm, unit);
  const digits = unit === "in" ? 3 : unit === "px" ? 0 : 1;
  return Number(v.toFixed(digits));
}

export type PaperSize = "A3" | "A4" | "A5";

export const PAPER_MM: Record<PaperSize, { width: number; height: number }> = {
  A3: { width: 297, height: 420 },
  A4: { width: 210, height: 297 },
  A5: { width: 148, height: 210 },
};

export type LabelElement = TextElement | BarcodeElement;

interface ElementBase {
  id: string;
  /** All geometry is stored in millimetres. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextElement extends ElementBase {
  kind: "text";
  content: string;
  fontSize: number; // pt
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
  lineHeight: number;
}

export interface BarcodeElement extends ElementBase {
  kind: "barcode";
  symbology: "qrcode" | "code128";
  /** Placeholder template, e.g. "${Key}". */
  value: string;
  showText: boolean;
}

export type SheetLayout =
  | { mode: "single" }
  | {
      mode: "sheet";
      paper: PaperSize;
      orientation: "portrait" | "landscape";
      columns: number;
      rows: number;
      marginTop: number;
      marginLeft: number;
      gapX: number;
      gapY: number;
    };

export interface LabelTemplate {
  id: string;
  name: string;
  unit: Unit;
  width: number;
  height: number;
  layout: SheetLayout;
  elements: LabelElement[];
  updatedAt: number;
}

export function paperDims(layout: Extract<SheetLayout, { mode: "sheet" }>) {
  const p = PAPER_MM[layout.paper];
  return layout.orientation === "landscape" ? { width: p.height, height: p.width } : p;
}

/** Largest grid that fits the paper with current margins and gaps. */
export function autoFitGrid(t: LabelTemplate, layout: Extract<SheetLayout, { mode: "sheet" }>) {
  const { width, height } = paperDims(layout);
  const columns = Math.max(1, Math.floor((width - 2 * layout.marginLeft + layout.gapX) / (t.width + layout.gapX)));
  const rows = Math.max(1, Math.floor((height - 2 * layout.marginTop + layout.gapY) / (t.height + layout.gapY)));
  return { columns, rows };
}

export function newTextElement(partial: Partial<TextElement> = {}): TextElement {
  return {
    id: crypto.randomUUID(),
    kind: "text",
    x: 2,
    y: 2,
    w: 30,
    h: 6,
    content: "${Name}",
    fontSize: 10,
    bold: false,
    italic: false,
    align: "left",
    lineHeight: 1.2,
    ...partial,
  };
}

export function newBarcodeElement(symbology: BarcodeElement["symbology"], partial: Partial<BarcodeElement> = {}): BarcodeElement {
  const square = symbology === "qrcode";
  return {
    id: crypto.randomUUID(),
    kind: "barcode",
    symbology,
    x: 2,
    y: 2,
    w: square ? 18 : 40,
    h: square ? 18 : 12,
    value: "${Key}",
    showText: !square,
    ...partial,
  };
}

export function newTemplate(name: string, defaults: { unit: Unit; width: number; height: number }): LabelTemplate {
  return {
    id: crypto.randomUUID(),
    name,
    unit: defaults.unit,
    width: defaults.width,
    height: defaults.height,
    layout: { mode: "single" },
    elements: [
      newTextElement({ x: 2, y: 2, w: defaults.width - 24, h: 7, content: "**${Name}**", fontSize: 11 }),
      newTextElement({ x: 2, y: 10, w: defaults.width - 24, h: 5, content: "${Key}", fontSize: 8 }),
      newBarcodeElement("qrcode", { x: defaults.width - 20, y: 2, w: 18, h: 18 }),
    ],
    updatedAt: Date.now(),
  };
}
