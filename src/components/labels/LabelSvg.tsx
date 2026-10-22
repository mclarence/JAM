import { useId } from "react";
import { renderBarcode } from "./barcode";
import { MM_PER_PT, type BarcodeElement, type LabelTemplate, type TextElement } from "./model";
import type { Resolver } from "./placeholders";

export const LABEL_FONT = "Helvetica, Arial, sans-serif";

let measureCtx: CanvasRenderingContext2D | null = null;

/** Text width in mm for the given font size (mm). */
function measure(text: string, sizeMm: number, bold: boolean, italic: boolean) {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * sizeMm * 0.55;
  measureCtx.font = `${italic ? "italic " : ""}${bold ? "bold " : ""}100px ${LABEL_FONT}`;
  return (measureCtx.measureText(text).width / 100) * sizeMm;
}

function wrapLines(text: string, maxWidth: number, sizeMm: number, bold: boolean, italic: boolean) {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate, sizeMm, bold, italic) <= maxWidth || !line) line = candidate;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

function TextNode({ el, resolve, clipId }: { el: TextElement; resolve: Resolver; clipId: string }) {
  const sizeMm = el.fontSize * MM_PER_PT;
  const lh = sizeMm * el.lineHeight;
  const maxLines = Math.max(1, Math.floor((el.h + 0.01) / lh));
  const lines = wrapLines(resolve(el.content), el.w, sizeMm, el.bold, el.italic).slice(0, maxLines);
  const anchor = el.align === "center" ? "middle" : el.align === "right" ? "end" : "start";
  const x = el.align === "center" ? el.x + el.w / 2 : el.align === "right" ? el.x + el.w : el.x;
  const ascent = sizeMm * 0.78 + (lh - sizeMm) / 2;

  return (
    <g clipPath={`url(#${clipId})`}>
      <clipPath id={clipId}>
        <rect x={el.x} y={el.y} width={el.w} height={el.h} />
      </clipPath>
      {lines.map((line, i) => (
        <text
          key={i}
          x={x}
          y={el.y + ascent + i * lh}
          fontSize={sizeMm}
          fontFamily={LABEL_FONT}
          fontWeight={el.bold ? "bold" : "normal"}
          fontStyle={el.italic ? "italic" : "normal"}
          textAnchor={anchor}
          fill="#000000"
          xmlSpace="preserve"
        >
          {line}
        </text>
      ))}
    </g>
  );
}

function BarcodeNode({ el, resolve }: { el: BarcodeElement; resolve: Resolver }) {
  const value = resolve(el.value).trim();
  const result = renderBarcode(el, value);
  if (result instanceof Error) {
    return (
      <g>
        <rect x={el.x} y={el.y} width={el.w} height={el.h} fill="none" stroke="#999999" strokeWidth={0.2} strokeDasharray="1 1" />
        <text x={el.x + el.w / 2} y={el.y + el.h / 2} fontSize={2} fontFamily={LABEL_FONT} textAnchor="middle" fill="#999999">
          {value ? "Invalid barcode value" : "No value"}
        </text>
      </g>
    );
  }
  return (
    <svg
      x={el.x}
      y={el.y}
      width={el.w}
      height={el.h}
      viewBox={result.viewBox}
      preserveAspectRatio="xMidYMid meet"
      dangerouslySetInnerHTML={{ __html: result.body }}
    />
  );
}

/** Label content as an SVG group in millimetre coordinates. */
export function LabelGroup({
  template,
  resolve,
  x = 0,
  y = 0,
}: {
  template: LabelTemplate;
  resolve: Resolver;
  x?: number;
  y?: number;
}) {
  const uid = useId().replace(/:/g, "");
  return (
    <g transform={x || y ? `translate(${x} ${y})` : undefined}>
      {template.elements.map((el) =>
        el.kind === "text" ? (
          <TextNode key={el.id} el={el} resolve={resolve} clipId={`c${uid}${el.id.slice(0, 8)}`} />
        ) : (
          <BarcodeNode key={el.id} el={el} resolve={resolve} />
        ),
      )}
    </g>
  );
}

/** Standalone label SVG sized in physical millimetres. */
export function LabelSvg({
  template,
  resolve,
  className,
  style,
}: {
  template: LabelTemplate;
  resolve: Resolver;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={`${template.width}mm`}
      height={`${template.height}mm`}
      viewBox={`0 0 ${template.width} ${template.height}`}
      className={className}
      style={style}
    >
      <rect width={template.width} height={template.height} fill="#ffffff" />
      <LabelGroup template={template} resolve={resolve} />
    </svg>
  );
}
