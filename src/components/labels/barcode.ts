import { toSVG } from "bwip-js/browser";
import type { BarcodeElement } from "./model";

export interface BarcodeSvg {
  viewBox: string;
  body: string;
}

const cache = new Map<string, BarcodeSvg | Error>();

/** Renders a barcode to vector SVG markup (paths only, including human-readable text). */
export function renderBarcode(el: Pick<BarcodeElement, "symbology" | "showText" | "h">, text: string): BarcodeSvg | Error {
  const key = `${el.symbology}|${el.showText}|${Math.round(el.h)}|${text}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let result: BarcodeSvg | Error;
  try {
    if (!text) throw new Error("No value");
    const svg =
      el.symbology === "qrcode"
        ? toSVG({ bcid: "qrcode", text, eclevel: "M", scale: 1 } as Parameters<typeof toSVG>[0])
        : toSVG({
            bcid: "code128",
            text,
            scale: 1,
            height: Math.max(3, el.showText ? el.h * 0.7 : el.h),
            includetext: el.showText,
            textxalign: "center",
            textsize: 8,
          });
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
