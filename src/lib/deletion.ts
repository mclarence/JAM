import { AttrType, DefaultType, type AssetObject, type ConnectionInfo, type ObjectTypeAttribute, type StatusType } from "@/api/types";
import { aqlAttr, aqlString } from "@/lib/aql";
import { editorKind } from "@/lib/attributes";
import { ruleActionAttributes, validateValue, type RuleValue } from "@/lib/rules";

export interface DeletionField {
  attributeId: string;
  attributeName: string;
  value: RuleValue;
}

export interface DeletionConfig {
  method: "permanent" | "soft";
  marker?: DeletionField;
  additional?: DeletionField;
}

export type DeletionConfigs = Record<string, DeletionConfig>;

export function parseDeletionConfigs(value: unknown): DeletionConfigs {
  const record = (input: unknown): input is Record<string, unknown> => !!input && typeof input === "object" && !Array.isArray(input);
  const nonempty = (input: unknown): input is string => typeof input === "string" && !!input.trim();
  const field = (input: unknown): DeletionField => {
    if (!record(input) || !nonempty(input.attributeId) || !nonempty(input.attributeName) ||
      !record(input.value) || !nonempty(input.value.raw) || typeof input.value.display !== "string" ||
      (input.value.referenceId !== undefined && !nonempty(input.value.referenceId))) {
      throw new Error("A deletion attribute or value is malformed.");
    }
    return {
      attributeId: input.attributeId, attributeName: input.attributeName,
      value: { raw: input.value.raw, display: input.value.display,
        ...(input.value.referenceId === undefined ? {} : { referenceId: input.value.referenceId }) },
    };
  };
  if (!record(value)) throw new Error("Deletion settings must be an object.");
  return Object.fromEntries(Object.entries(value).map(([key, config]) => {
    let scope: unknown;
    try { scope = JSON.parse(key); } catch { throw new Error("A deletion workspace scope is malformed."); }
    if (!Array.isArray(scope) || scope.length !== 3 || !scope.every(nonempty) || !/^\d+$/.test(scope[2]) ||
      !record(config) || (config.method !== "permanent" && config.method !== "soft")) {
      throw new Error("A deletion configuration is malformed.");
    }
    const marker = config.marker === undefined ? undefined : field(config.marker);
    const additional = config.additional === undefined ? undefined : field(config.additional);
    if (config.method === "soft" && !marker) throw new Error("Soft deletion requires a marker.");
    if (additional && additional.attributeId === marker?.attributeId) throw new Error("The additional update must not overwrite the deletion marker.");
    return [key, { method: config.method, ...(marker ? { marker } : {}), ...(additional ? { additional } : {}) }];
  }));
}

export function deletionScope(connection: Pick<ConnectionInfo, "cloudId" | "workspaceId">, typeId: string) {
  return JSON.stringify([connection.cloudId, connection.workspaceId, typeId]);
}

export function workspaceDeletions(configs: DeletionConfigs, connection: ConnectionInfo | null) {
  if (!connection) return [];
  return Object.entries(configs).flatMap(([key, config]) => {
    let scope: unknown;
    try { scope = JSON.parse(key); } catch { return []; }
    return Array.isArray(scope) && scope.length === 3 && scope[0] === connection.cloudId &&
      scope[1] === connection.workspaceId && typeof scope[2] === "string"
      ? [{ typeId: scope[2], config }] : [];
  });
}

export function isMarkerAttribute(attr: ObjectTypeAttribute) {
  return !attr.hidden && attr.type === AttrType.Default && editorKind(attr) !== "readonly" &&
    (attr.defaultType?.id === DefaultType.Text || attr.defaultType?.id === DefaultType.Select);
}

export function validateDeletion(config: DeletionConfig, attrs: ObjectTypeAttribute[], statuses: StatusType[]): string | null {
  if (config.method !== "permanent" && config.method !== "soft") return "Choose a deletion method.";
  if (config.method === "permanent") return null;
  const marker = config.marker;
  const attr = attrs.find((a) => a.id === marker?.attributeId);
  if (!marker || !attr || !isMarkerAttribute(attr)) return "Choose an editable, single-valued text or select marker attribute.";
  if (marker.attributeName !== attr.name) return "The marker attribute was renamed. Select it again before deleting.";
  const problem = validateValue(attr, marker.value, statuses);
  if (problem) return problem;
  if (config.additional) {
    if (config.additional.attributeId === marker.attributeId) return "The additional update must not overwrite the deletion marker.";
    const additional = attrs.find((a) => a.id === config.additional?.attributeId);
    if (!additional || !ruleActionAttributes([additional]).length) return "Choose an editable, single-valued additional attribute.";
    return validateValue(additional, config.additional.value, statuses);
  }
  return null;
}

export function isSoftDeleted(object: AssetObject, configs: DeletionConfigs, connection: ConnectionInfo | null) {
  const marker = connection ? configs[deletionScope(connection, object.objectType.id)]?.marker : undefined;
  return !!marker?.value.raw && object.attributes.some((attr) => attr.objectTypeAttributeId === marker.attributeId &&
    attr.objectAttributeValues.some((value) => (value.value ?? value.displayValue)?.toLocaleLowerCase() === marker.value.raw.toLocaleLowerCase()));
}

/** Find ORDER BY outside quoted literals, attribute names, and nested AQL expressions. */
function orderByIndex(query: string) {
  let quoted = false;
  let depth = 0;
  for (let i = 0; i < query.length; i++) {
    if (query[i] === "\\" && quoted) { i++; continue; }
    if (query[i] === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (query[i] === "(") depth++;
    if (query[i] === ")") depth--;
    if (!depth && (i === 0 || /\s/.test(query[i - 1])) && /^ORDER\s+BY\s/i.test(query.slice(i))) return i;
  }
  return -1;
}

/** Apply exclusions before paging/counting, including when permanent deletion is selected later. */
export function excludeDeleted(query: string, configs: DeletionConfigs, connection: ConnectionInfo | null) {
  const clauses = workspaceDeletions(configs, connection).flatMap(({ typeId, config }) => {
    if (!config.marker?.value.raw || !/^\d+$/.test(typeId)) return [];
    const attr = aqlAttr(config.marker.attributeName);
    return [`(objectTypeId != ${Number(typeId)} OR ${attr} IS EMPTY OR ${attr} != ${aqlString(config.marker.value.raw)})`];
  });
  if (!clauses.length) return query;
  const index = orderByIndex(query);
  const where = index < 0 ? query : query.slice(0, index).trim();
  const order = index < 0 ? "" : ` ${query.slice(index)}`;
  return `(${where}) AND ${clauses.join(" AND ")}${order}`;
}

export function deletionSummary(config: DeletionConfig, count = 1) {
  const subject = count === 1 ? "the object" : `${count} objects`;
  if (config.method === "permanent") {
    return `This permanently deletes ${subject} from Jira and cannot be undone. Jira delete permission is required.`;
  }
  const show = (field: DeletionField) => `${field.attributeName} = ${field.value.display || field.value.raw}`;
  return `Set ${config.marker ? show(config.marker) : "the deletion marker"} and hide ${count === 1 ? "this asset" : "these assets"} from lists.` +
    (config.additional ? ` Also set ${show(config.additional)}.` : "");
}
