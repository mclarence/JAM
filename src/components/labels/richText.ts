// Inline text markup for label text elements: **bold**, ''italic'', __underline__, ~~strike~~.
// Each marker toggles its style; a backslash escapes a literal marker character. ${...} tokens pass through untouched.

export type StyleKey = "bold" | "italic" | "underline" | "strike";
export interface Style {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
}
export interface Run extends Style {
  text: string;
}

export const NO_STYLE: Style = { bold: false, italic: false, underline: false, strike: false };
export const MARKERS: Record<StyleKey, string> = { bold: "**", italic: "''", underline: "__", strike: "~~" };

const KEYS = Object.keys(MARKERS) as StyleKey[];
const SPECIAL = new Set(["\\", "*", "'", "_", "~"]);

interface Ch {
  ch: string;
  style: Style;
  /** Index in the source string. */
  src: number;
  /** Start of the `${...}` token this char belongs to, if any. */
  tok?: number;
}

const sameStyle = (a: Style, b: Style) => KEYS.every((k) => a[k] === b[k]);

function parseChars(src: string): Ch[] {
  const out: Ch[] = [];
  const style: Style = { ...NO_STYLE };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\" && SPECIAL.has(src[i + 1] ?? "")) {
      out.push({ ch: src[i + 1], style: { ...style }, src: i });
      i += 2;
      continue;
    }
    const key = KEYS.find((k) => src.startsWith(MARKERS[k], i));
    if (key) {
      style[key] = !style[key];
      i += MARKERS[key].length;
      continue;
    }
    if (c === "$" && src[i + 1] === "{") {
      const end = src.indexOf("}", i + 2);
      if (end !== -1) {
        for (let j = i; j <= end; j++) out.push({ ch: src[j], style: { ...style }, src: j, tok: i });
        i = end + 1;
        continue;
      }
    }
    out.push({ ch: c, style: { ...style }, src: i });
    i++;
  }
  return out;
}

/** Splits markup into styled runs; placeholder tokens stay verbatim inside the run text. */
export function parseMarkup(src: string): Run[] {
  const runs: Run[] = [];
  for (const c of parseChars(src)) {
    const last = runs.at(-1);
    if (last && sameStyle(last, c.style)) last.text += c.ch;
    else runs.push({ ...c.style, text: c.ch });
  }
  return runs;
}

function serialize(chars: Ch[]) {
  // Close in reverse order of KEYS before opening, so markers nest the way they read.
  const closing = [...KEYS].reverse();
  const pre: string[] = [];
  let cur = NO_STYLE;
  chars.forEach((c, i) => {
    const off = closing.filter((k) => cur[k] && !c.style[k]);
    const on = KEYS.filter((k) => !cur[k] && c.style[k]);
    pre[i] = [...off, ...on].map((k) => MARKERS[k]).join("");
    cur = c.style;
  });
  const tail = closing
    .filter((k) => cur[k])
    .map((k) => MARKERS[k])
    .join("");

  let text = "";
  const spans: [number, number][] = [];
  chars.forEach((c, i) => {
    text += pre[i];
    const start = text.length;
    const following = i + 1 < chars.length ? (pre[i + 1] || chars[i + 1].ch)[0] : tail[0];
    // Only a doubled character can form a marker, so escape just those neighbours.
    const clash = c.ch === "\\" ? SPECIAL.has(following ?? "") : text.at(-1) === c.ch || following === c.ch;
    text += c.tok === undefined && SPECIAL.has(c.ch) && clash ? `\\${c.ch}` : c.ch;
    spans.push([start, text.length]);
  });
  return { text: text + tail, spans };
}

/** Applies a style to all of `content`, keeping any partial styling it already has. */
function styleAll(content: string, key: StyleKey) {
  const chars = parseChars(content);
  for (const c of chars) c.style[key] = true;
  return serialize(chars).text;
}

/** Converts the old whole-element bold/italic flags into markup so the buttons only ever style selected text. */
export function foldBaseStyle<T extends { content: string; bold: boolean; italic: boolean }>(el: T): T {
  if (!el.bold && !el.italic) return el;
  let content = el.content;
  if (el.bold) content = styleAll(content, "bold");
  if (el.italic) content = styleAll(content, "italic");
  return { ...el, content, bold: false, italic: false };
}

/** Toggles a style on the selected source range and returns the rewritten content and selection. */
export function toggleStyle(content: string, start: number, end: number, key: StyleKey) {
  const chars = parseChars(content);
  const selected = chars.map((c) => c.src >= start && c.src < end);
  // A selection touching part of a ${token} takes the whole token so it is never split.
  const tokens = new Set(chars.filter((c, i) => selected[i] && c.tok !== undefined).map((c) => c.tok));
  chars.forEach((c, i) => {
    if (c.tok !== undefined && tokens.has(c.tok)) selected[i] = true;
  });
  const idx = chars.flatMap((_, i) => (selected[i] ? [i] : []));
  if (idx.length === 0) return { content, start, end };

  const on = !idx.every((i) => chars[i].style[key]);
  for (const i of idx) chars[i] = { ...chars[i], style: { ...chars[i].style, [key]: on } };
  const { text, spans } = serialize(chars);
  return { content: text, start: spans[idx[0]][0], end: spans[idx[idx.length - 1]][1] };
}
