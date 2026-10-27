import { AttrType, type AssetObject, type ObjectAttributeIn, type ObjectTypeAttribute } from "@/api/types";
import { aqlAttr, aqlString, isTextarea, SEARCH_KEY } from "@/lib/aql";
import { editorInitialValue, editorKind, getAttrValues } from "@/lib/attributes";
import type { ScanAction } from "@/store/quickScan";

/** Scanners often append CR/LF or a tab; drop control characters and surrounding spaces. */
export function sanitizeScan(raw: string) {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

/** Attributes a scan can be matched against besides the built-in Key option. */
export function lookupAttributes(attrs: ObjectTypeAttribute[]) {
  return attrs.filter(
    (a) => a.type === AttrType.Default && !a.hidden && !isTextarea(a) && a.name.trim().toLowerCase() !== "key",
  );
}

/** Attributes that can be changed on scan: anything editable, since clearing works even for read-only editors. */
export function actionAttributes(attrs: ObjectTypeAttribute[]) {
  return attrs.filter(
    (a) =>
      a.editable !== false &&
      !a.system &&
      !a.hidden &&
      // A required attribute that can't be set in the app has no valid action.
      !(editorKind(a) === "readonly" && (a.minimumCardinality ?? 0) > 0),
  );
}

/** Selected lookups that still exist on the object type; Key when none remain. */
export function validLookups(lookups: string[], attrs: ObjectTypeAttribute[]) {
  const valid = lookups.filter((l) => l === SEARCH_KEY || attrs.some((a) => a.id === l));
  return valid.length ? valid : [SEARCH_KEY];
}

export function lookupLabel(lookups: string[], attrs: ObjectTypeAttribute[]) {
  return lookups.map((l) => (l === SEARCH_KEY ? "Key" : (attrs.find((a) => a.id === l)?.name ?? "Key"))).join(", ");
}

export function lookupQuery(objectTypeId: string, lookups: string[], attrs: ObjectTypeAttribute[], text: string) {
  const value = aqlString(text);
  const terms = validLookups(lookups, attrs).map((l) => {
    const field = l === SEARCH_KEY ? "Key" : aqlAttr(attrs.find((a) => a.id === l)!.name);
    return `${field} = ${value}`;
  });
  return `objectTypeId = ${Number(objectTypeId)} AND (${terms.join(" OR ")})`;
}

function sameValue(attr: ObjectTypeAttribute, current: string, target: string) {
  switch (editorKind(attr)) {
    case "date":
      return current.slice(0, 10) === target.slice(0, 10);
    case "datetime": {
      const a = new Date(current).getTime();
      const b = new Date(target).getTime();
      return Number.isFinite(a) && Number.isFinite(b) ? a === b : current === target;
    }
    case "integer":
    case "double":
      return current !== "" && target !== "" && Number(current) === Number(target);
    default:
      return current === target;
  }
}

function nowValue(attr: ObjectTypeAttribute) {
  const d = new Date();
  if (editorKind(attr) === "datetime") return d.toISOString();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface ScanPlan {
  payload: ObjectAttributeIn[];
  /** Log lines such as "Status → In stock". */
  changes: string[];
}

/** Works out which configured actions would actually change the object; an empty plan means nothing to send. */
export function planChanges(object: AssetObject, attrs: ObjectTypeAttribute[], actions: ScanAction[]): ScanPlan {
  const plan: ScanPlan = { payload: [], changes: [] };
  for (const action of actions) {
    const attr = attrs.find((a) => a.id === action.attrId);
    if (!attr) continue;
    const values = getAttrValues(object, attr.id);

    if (action.mode === "clear") {
      if (values.length === 0) continue;
      plan.payload.push({ objectTypeAttributeId: attr.id, objectAttributeValues: [] });
      plan.changes.push(`${attr.name} cleared`);
      continue;
    }

    const value = action.mode === "now" ? nowValue(attr) : action.value;
    if (action.mode === "set") {
      // An unfilled value or a read-only editor can't be applied.
      if (value === "" || editorKind(attr) === "readonly") continue;
      if (values.length === 1 && sameValue(attr, editorInitialValue(attr, values), value)) continue;
    }
    plan.payload.push({ objectTypeAttributeId: attr.id, objectAttributeValues: [{ value }] });
    plan.changes.push(`${attr.name} → ${action.mode === "now" ? "now" : action.display || value}`);
  }
  return plan;
}
