import { useId } from "react";
import { renderBarcode } from "./barcode";
import { MM_PER_PT, type BarcodeElement, type LabelTemplate, type TextElement } from "./model";
import type { Resolver } from "./placeholders";
import { NO_STYLE, parseMarkup, type Style } from "./richText";

export const LABEL_FONT = "Helvetica, Arial, sans-serif";

let measureCtx: CanvasRenderingContext2D | null = null;

/** Text width in mm for the given font size (mm). */
function measure(text: string, sizeMm: number, bold: boolean, italic: boolean) {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * sizeMm * 0.55;
  measureCtx.font = `${italic ? "italic " : ""}${bold ? "bold " : ""}100px ${LABEL_FONT}`;
  return (measureCtx.measureText(text).width / 100) * sizeMm;
}

interface Piece {
  text: string;
  style: Style;
}

/** A run of non-space text; `gap` is the style of the space before it (null at the start of a line). */
interface Word {
  parts: Piece[];
  gap: Style | null;
}

interface PlacedRun extends Piece {
  x: number;
  w: number;
}

const sameStyle = (a: Style, b: Style) =>
  a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.strike === b.strike;

function pieceWidth(p: Piece, sizeMm: number) {
  return measure(p.text, sizeMm, p.style.bold, p.style.italic);
}

/** Splits styled, placeholder-resolved text into words and explicit line breaks. */
function toWords(el: TextElement, resolve: Resolver): (Word | null)[] {
  const items: (Word | null)[] = [];
  let word: Word | null = null;
  let pendingGap: Style | null = null;
  let atLineStart = true;
  const flush = () => {
    if (word) items.push(word);
    word = null;
  };

  for (const run of parseMarkup(el.content)) {
    const style: Style = {
      bold: run.bold || el.bold,
      italic: run.italic || el.italic,
      underline: run.underline,
      strike: run.strike,
    };
    for (const ch of resolve(run.text)) {
      if (ch === "\n") {
        flush();
        items.push(null);
        pendingGap = null;
        atLineStart = true;
      } else if (/\s/.test(ch)) {
        flush();
        if (!atLineStart) pendingGap ??= style;
      } else {
        word ??= { parts: [], gap: atLineStart ? null : pendingGap };
        const last = word.parts.at(-1);
        if (last && sameStyle(last.style, style)) last.text += ch;
        else word.parts.push({ text: ch, style });
        pendingGap = null;
        atLineStart = false;
      }
    }
  }
  flush();
  return items;
}

/** Breaks a word that is wider than a line into fragments that each fit (at least one character each). */
function splitWord(word: Word, maxWidth: number, sizeMm: number): Word[] {
  const out: Word[] = [];
  let cur: Piece[] = [];
  let curW = 0;
  for (const part of word.parts) {
    for (const ch of part.text) {
      const w = pieceWidth({ text: ch, style: part.style }, sizeMm);
      if (cur.length && curW + w > maxWidth) {
        out.push({ parts: cur, gap: null });
        cur = [];
        curW = 0;
      }
      const last = cur.at(-1);
      if (last && sameStyle(last.style, part.style)) last.text += ch;
      else cur.push({ text: ch, style: part.style });
      curW += w;
    }
  }
  if (cur.length) out.push({ parts: cur, gap: null });
  return out;
}

/** Greedy word wrap; width is the sum of every run's own measured width. Words wider than a line are broken by character. */
function wrapWords(items: (Word | null)[], maxWidth: number, sizeMm: number) {
  const lines: Word[][] = [[]];
  let lineW = 0;
  const spaceW = (s: Style) => measure(" ", sizeMm, s.bold, s.italic);
  const wordWidth = (w: Word) => w.parts.reduce((sum, p) => sum + pieceWidth(p, sizeMm), 0);
  for (const item of items) {
    if (item === null) {
      lines.push([]);
      lineW = 0;
      continue;
    }
    const line = lines[lines.length - 1];
    const wordW = wordWidth(item);
    const gapW = line.length ? spaceW(item.gap ?? NO_STYLE) : 0;
    if (wordW > maxWidth) {
      const frags = splitWord(item, maxWidth, sizeMm);
      frags.forEach((f, i) => {
        if (i === 0 && line.length === 0) line.push(f);
        else lines.push([f]);
      });
      lineW = wordWidth(frags[frags.length - 1]);
    } else if (line.length === 0 || lineW + gapW + wordW <= maxWidth) {
      line.push(item);
      lineW += gapW + wordW;
    } else {
      lines.push([item]);
      lineW = wordW;
    }
  }
  return lines;
}

/** Turns a wrapped line into runs with absolute x positions for the element's alignment. */
function placeLine(line: Word[], el: TextElement, sizeMm: number): PlacedRun[] {
  const pieces: Piece[] = [];
  const add = (text: string, style: Style) => {
    const last = pieces.at(-1);
    if (last && sameStyle(last.style, style)) last.text += text;
    else pieces.push({ text, style });
  };
  line.forEach((w, i) => {
    if (i > 0) add(" ", w.gap ?? NO_STYLE);
    w.parts.forEach((p) => add(p.text, p.style));
  });
  const widths = pieces.map((p) => pieceWidth(p, sizeMm));
  const total = widths.reduce((a, b) => a + b, 0);
  let x = el.align === "center" ? el.x + (el.w - total) / 2 : el.align === "right" ? el.x + el.w - total : el.x;
  return pieces.map((p, i) => {
    const run = { ...p, x, w: widths[i] };
    x += widths[i];
    return run;
  });
}

function TextNode({ el, resolve, clipId }: { el: TextElement; resolve: Resolver; clipId: string }) {
  const words = toWords(el, resolve);
  let sizeMm = el.fontSize * MM_PER_PT;
  let lines: Word[][];
  if (el.fit === "shrink") {
    // Text width and height scale linearly with font size, so one measurement gives the fitting scale.
    lines = wrapWords(words, Infinity, sizeMm);
    const widest = Math.max(
      0,
      ...lines.map((l) => {
        const runs = placeLine(l, { ...el, align: "left" }, sizeMm);
        return runs.length ? runs[runs.length - 1].x + runs[runs.length - 1].w - el.x : 0;
      }),
    );
    const scale = Math.min(1, widest > 0 ? el.w / widest : 1, el.h / (lines.length * sizeMm * el.lineHeight));
    sizeMm = Math.max(sizeMm * scale, MM_PER_PT);
  } else {
    const maxLines = Math.max(1, Math.floor((el.h + 0.01) / (sizeMm * el.lineHeight)));
    lines = wrapWords(words, el.w, sizeMm).slice(0, maxLines);
  }
  const lh = sizeMm * el.lineHeight;
  const placed = lines.map((l) => placeLine(l, el, sizeMm));
  const ascent = sizeMm * 0.78 + (lh - sizeMm) / 2;

  return (
    <g clipPath={`url(#${clipId})`}>
      <clipPath id={clipId}>
        <rect x={el.x} y={el.y} width={el.w} height={el.h} />
      </clipPath>
      {placed.map((runs, i) => {
        const y = el.y + ascent + i * lh;
        return runs.map((r, j) => {
          const body = r.text.trim();
          const lead = r.text.length - r.text.trimStart().length;
          // Leading spaces are skipped by position so no renderer has to preserve them.
          const bodyX = r.x + (lead ? measure(" ".repeat(lead), sizeMm, r.style.bold, r.style.italic) : 0);
          return (
            <g key={`${i}-${j}`}>
              {body && (
                <text
                  x={bodyX}
                  y={y}
                  fontSize={sizeMm}
                  fontFamily={LABEL_FONT}
                  fontWeight={r.style.bold ? "bold" : "normal"}
                  fontStyle={r.style.italic ? "italic" : "normal"}
                  fill="#000000"
                >
                  {body}
                </text>
              )}
              {r.style.underline && (
                <line x1={r.x} x2={r.x + r.w} y1={y + sizeMm * 0.12} y2={y + sizeMm * 0.12} stroke="#000000" strokeWidth={sizeMm * 0.06} />
              )}
              {r.style.strike && (
                <line x1={r.x} x2={r.x + r.w} y1={y - sizeMm * 0.28} y2={y - sizeMm * 0.28} stroke="#000000" strokeWidth={sizeMm * 0.06} />
              )}
            </g>
          );
        });
      })}
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
  const isLinear = el.symbology === "code128";
  const captionH = isLinear && el.showText ? Math.min(el.h * 0.3, 4) : 0;
  const barsH = el.h - captionH;
  const capSize = captionH * 0.85;
  // Shrink the caption if it would be wider than the barcode.
  const capFit = capSize > 0 ? Math.min(capSize, (el.w * 0.98) / measure(value, 1, false, false)) : 0;
  return (
    <g>
      <svg
        x={el.x}
        y={el.y}
        width={el.w}
        height={barsH}
        viewBox={result.viewBox}
        // Linear barcodes are stretched to the full box; only the bar width ratios matter for scanning.
        preserveAspectRatio={isLinear ? "none" : "xMidYMid meet"}
        dangerouslySetInnerHTML={{ __html: result.body }}
      />
      {captionH > 0 && (
        <text
          x={el.x + el.w / 2}
          y={el.y + barsH + captionH * 0.8}
          fontSize={capFit}
          fontFamily={LABEL_FONT}
          textAnchor="middle"
          fill="#000000"
        >
          {value}
        </text>
      )}
    </g>
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
