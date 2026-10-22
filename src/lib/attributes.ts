import {
  AttrType,
  DefaultType,
  type AssetObject,
  type ObjectAttributeValue,
  type ObjectTypeAttribute,
} from "@/api/types";

export function displayValue(v: ObjectAttributeValue): string {
  return (
    v.referencedObject?.label ??
    v.status?.name ??
    v.user?.displayName ??
    v.group?.name ??
    v.displayValue ??
    v.value ??
    ""
  );
}

export function getAttrValues(obj: AssetObject, attrId: string): ObjectAttributeValue[] {
  return obj.attributes.find((a) => a.objectTypeAttributeId === attrId)?.objectAttributeValues ?? [];
}

export function getAttrText(obj: AssetObject, attrId: string): string {
  return getAttrValues(obj, attrId).map(displayValue).join(", ");
}

export type EditorKind =
  | "text"
  | "textarea"
  | "integer"
  | "double"
  | "boolean"
  | "date"
  | "datetime"
  | "select"
  | "status"
  | "reference"
  | "readonly";

export function isMultiValue(attr: ObjectTypeAttribute) {
  return attr.maximumCardinality !== undefined && attr.maximumCardinality !== 1;
}

export function editorKind(attr: ObjectTypeAttribute): EditorKind {
  if (attr.editable === false || attr.system || isMultiValue(attr)) return "readonly";
  switch (attr.type) {
    case AttrType.Status:
      return "status";
    case AttrType.ObjectReference:
      return "reference";
    case AttrType.User:
    case AttrType.Group:
      return "readonly";
  }
  switch (attr.defaultType?.id) {
    case DefaultType.Textarea:
      return "textarea";
    case DefaultType.Integer:
      return "integer";
    case DefaultType.Double:
      return "double";
    case DefaultType.Boolean:
      return "boolean";
    case DefaultType.Date:
      return "date";
    case DefaultType.DateTime:
      return "datetime";
    case DefaultType.Select:
      return "select";
    case DefaultType.Time:
      return "text";
    default:
      return "text";
  }
}

export function selectOptions(attr: ObjectTypeAttribute): string[] {
  return (attr.options ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Raw value used to seed an editor (status id, object key, ISO date, etc.). */
export function editorInitialValue(attr: ObjectTypeAttribute, values: ObjectAttributeValue[]): string {
  const v = values[0];
  if (!v) return "";
  if (attr.type === AttrType.Status) return v.status?.id ?? v.value ?? "";
  if (attr.type === AttrType.ObjectReference) return v.referencedObject?.objectKey ?? v.value ?? "";
  return v.value ?? "";
}

export function sortAttributes(attrs: ObjectTypeAttribute[]) {
  return [...attrs].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}
