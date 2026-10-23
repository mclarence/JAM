import { toSVG } from "bwip-js/browser";
import type { BarcodeElement } from "./model";

export interface BarcodeSvg {
  viewBox: string;
  body: string;
}

const cache = new Map<string, BarcodeSvg | Error>();

/** Renders a barcode to vector SVG markup (paths only). Code 128 is bars only; its caption is drawn by the caller. */
export function renderBarcode(el: Pick<BarcodeElement, "symbology">, text: string): BarcodeSvg | Error {
  const key = `${el.symbology}|${text}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let result: BarcodeSvg | Error;
  try {
    if (!text) throw new Error("No value");
    const svg =
      el.symbology === "qrcode"
        ? toSVG({ bcid: "qrcode", text, eclevel: "M", scale: 1 } as Parameters<typeof toSVG>[0])
        : toSVG({ bcid: "code128", text, scale: 1, height: 10, includetext: false });
    const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1];
    const body = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
    if (!viewBox) throw new Error("Invalid barcode output");
    result = { viewBox, body };
  } catch (e) {
    result = e instanceof Error ? e : new Error(String(e));
  }
  if (cache.size > 2000) cache.clear();
  cache.set(key, result);
  return result;
}
