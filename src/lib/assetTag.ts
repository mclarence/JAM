import { assetsApi } from "@/api/assets";
import type { AssetObject, ObjectTypeAttribute } from "@/api/types";
import { aqlAttr, aqlString } from "./aql";

export interface AssetTagConfig {
  attributeId: string;
  template: string;
}

export interface ParsedTemplate {
  prefix: string;
  suffix: string;
  /** Minimum digits; the counter is zero-padded to this width. */
  width: number;
}

/** The last run of `X` characters is the counter; everything else is literal. */
export function parseTemplate(template: string): ParsedTemplate | null {
  const m = [...template.matchAll(/X+/g)].at(-1);
  if (!m) return null;
  return {
    prefix: template.slice(0, m.index),
    suffix: template.slice(m.index + m[0].length),
    width: m[0].length,
  };
}

export function formatTag(p: ParsedTemplate, n: number) {
  return `${p.prefix}${String(n).padStart(p.width, "0")}${p.suffix}`;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Counter value of a tag that fits the template, else null. AQL equality is case-insensitive, so this is too. */
export function tagNumber(p: ParsedTemplate, tag: string): number | null {
  const m = new RegExp(`^${escapeRegExp(p.prefix)}(\\d+)${escapeRegExp(p.suffix)}$`, "i").exec(tag.trim());
  return m ? Number(m[1]) : null;
}

const WINDOW = 25;
const MAX_WINDOWS = 20;

function allValues(o: AssetObject) {
  return o.attributes.flatMap((a) => a.objectAttributeValues.map((v) => v.value ?? "")).filter(Boolean);
}

/**
 * Next unused tag in the schema: one past the highest existing counter (and `minNumber`),
 * then verified against the schema so gaps or a lagging search never yield a duplicate.
 */
export async function findNextAssetTag(opts: {
  schemaId: string;
  attr: ObjectTypeAttribute;
  template: string;
  minNumber?: number;
}): Promise<string | null> {
  const p = parseTemplate(opts.template);
  if (!p) return null;
  const attr = aqlAttr(opts.attr.name);
  const scope = `objectSchemaId = ${Number(opts.schemaId)}`;

  const filter = p.prefix ? `${attr} startsWith ${aqlString(p.prefix)}` : `${attr} is not EMPTY`;
  const top = await assetsApi.searchObjects(`${scope} AND ${filter} ORDER BY ${attr} DESC`, 0, 100);
  let n = opts.minNumber ?? 1;
  for (const o of top.values) {
    for (const v of allValues(o)) {
      const num = tagNumber(p, v);
      if (num !== null && num + 1 > n) n = num + 1;
    }
  }

  for (let i = 0; i < MAX_WINDOWS; i++, n += WINDOW) {
    const candidates = Array.from({ length: WINDOW }, (_, k) => formatTag(p, n + k));
    const found = await assetsApi.searchObjects(
      `${scope} AND ${attr} in (${candidates.map(aqlString).join(", ")})`,
      0,
      100,
    );
    const used = new Set(found.values.flatMap(allValues).map((v) => v.toLowerCase()));
    const free = candidates.find((c) => !used.has(c.toLowerCase()));
    if (free) return free;
  }
  throw new Error("Could not find an unused asset tag");
}
