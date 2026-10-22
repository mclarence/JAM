import { AttrType, DefaultType, type ObjectTypeAttribute } from "@/api/types";

/** Quotes a string literal for AQL. */
export function aqlString(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Quotes an attribute name for AQL. */
export function aqlAttr(name: string) {
  return aqlString(name);
}

const SEARCHABLE_DEFAULT_TYPES = new Set<number>([
  DefaultType.Text,
  DefaultType.Url,
  DefaultType.Email,
  DefaultType.Select,
  DefaultType.IpAddress,
]);

/** AQL rejects any clause on text area attributes. */
export function isTextarea(attr: ObjectTypeAttribute) {
  return attr.type === AttrType.Default && attr.defaultType?.id === DefaultType.Textarea;
}

export function isTextSearchable(attr: ObjectTypeAttribute) {
  return attr.type === AttrType.Default && SEARCHABLE_DEFAULT_TYPES.has(attr.defaultType?.id ?? -1);
}

export const SEARCH_ALL = "__all__";
export const SEARCH_KEY = "__key__";

const EXACT_MATCH_DEFAULT_TYPES = new Set<number>([
  DefaultType.Integer,
  DefaultType.Boolean,
  DefaultType.Double,
  DefaultType.Date,
  DefaultType.Time,
  DefaultType.DateTime,
]);

/** Numeric, date and status attributes don't support partial matching, so they use `=`. */
function searchOperator(attr: ObjectTypeAttribute) {
  if (attr.type === AttrType.Status) return "=";
  if (attr.type === AttrType.Default && EXACT_MATCH_DEFAULT_TYPES.has(attr.defaultType?.id ?? -1)) return "=";
  return "LIKE";
}

export interface BuildQueryInput {
  objectTypeId: string;
  search?: string;
  /** SEARCH_ALL, SEARCH_KEY, or an attribute id. */
  searchField?: string;
  rawAql?: string;
  attributes?: ObjectTypeAttribute[];
  sort?: { attrName: string; desc: boolean } | null;
}

/** Composes the server-side AQL for the assets grid. */
export function buildAssetsQuery({
  objectTypeId,
  search,
  searchField = SEARCH_ALL,
  rawAql,
  attributes = [],
  sort,
}: BuildQueryInput) {
  const parts = [`objectTypeId = ${Number(objectTypeId)}`];
  const term = search?.trim();
  if (term) {
    const v = aqlString(term);
    const field = attributes.find((a) => a.id === searchField);
    if (searchField === SEARCH_KEY) {
      parts.push(`Key = ${v}`);
    } else if (field) {
      parts.push(`${aqlAttr(field.name)} ${searchOperator(field)} ${v}`);
    } else {
      const clauses = new Set<string>([`Key = ${v}`]);
      attributes
        .filter((a) => !a.hidden && !isTextarea(a) && (a.label || isTextSearchable(a)))
        .slice(0, 20)
        .forEach((a) => clauses.add(`${aqlAttr(a.name)} LIKE ${v}`));
      parts.push(`(${[...clauses].join(" OR ")})`);
    }
  }
  if (rawAql?.trim()) parts.push(`(${rawAql.trim()})`);
  const where = parts.join(" AND ");
  const order = sort ? `${aqlAttr(sort.attrName)} ${sort.desc ? "DESC" : "ASC"}` : "Key ASC";
  return { where, full: `${where} ORDER BY ${order}` };
}

export const FILTER_OPERATORS = [
  { value: "=", label: "equals", needsValue: true },
  { value: "!=", label: "not equals", needsValue: true },
  { value: "LIKE", label: "contains", needsValue: true },
  { value: "NOT LIKE", label: "does not contain", needsValue: true },
  { value: ">", label: "greater than", needsValue: true },
  { value: "<", label: "less than", needsValue: true },
  { value: "IS EMPTY", label: "is empty", needsValue: false },
  { value: "IS NOT EMPTY", label: "is not empty", needsValue: false },
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number]["value"];

export interface FilterRule {
  id: string;
  attrName: string;
  operator: FilterOperator;
  value: string;
}

export function rulesToAql(rules: FilterRule[]) {
  return rules
    .filter((r) => r.attrName)
    .map((r) => {
      const op = FILTER_OPERATORS.find((o) => o.value === r.operator);
      return op?.needsValue
        ? `${aqlAttr(r.attrName)} ${r.operator} ${aqlString(r.value)}`
        : `${aqlAttr(r.attrName)} ${r.operator}`;
    })
    .join(" AND ");
}
