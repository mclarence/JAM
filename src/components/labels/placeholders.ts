import type { AssetObject, ObjectTypeAttribute } from "@/api/types";
import { getAttrText } from "@/lib/attributes";

const TOKEN = /\$\{([^}]+)\}/g;

export type Resolver = (template: string) => string;

/** Replaces ${Attribute Name} tokens with the object's display values. */
export function makeResolver(obj: AssetObject, attributes: ObjectTypeAttribute[]): Resolver {
  const byName = new Map(attributes.map((a) => [a.name.toLowerCase(), a.id]));
  return (template) =>
    template.replace(TOKEN, (_, raw: string) => {
      const name = raw.trim().toLowerCase();
      const attrId = byName.get(name);
      if (attrId) return getAttrText(obj, attrId);
      if (name === "key") return obj.objectKey;
      if (name === "name" || name === "label") return obj.label;
      if (name === "objecttype" || name === "type") return obj.objectType.name;
      return "";
    });
}

/** Designer preview without a sample object: keep tokens visible. */
export const identityResolver: Resolver = (t) => t;

export function placeholderTokens(attributes: ObjectTypeAttribute[]) {
  const names = new Set(["Key", "Name", ...attributes.filter((a) => !a.hidden).map((a) => a.name)]);
  return [...names];
}
