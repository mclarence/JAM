import { AttrType, type AssetObject, type ObjectAttributeIn, type ObjectAttributeValue, type ObjectTypeAttribute, type StatusType } from "@/api/types";
import { editorKind, selectOptions, type EditorKind } from "@/lib/attributes";

export type RuleOperation = "edit" | "batch" | "scan" | "create";
export type RuleOperator = "isSet" | "isEmpty" | "equals" | "notEquals";
export type RuleMatch = "any" | "all";

export interface RuleValue {
  raw: string;
  display: string;
  referenceId?: string;
}

export interface RuleCondition {
  id: string;
  attributeId: string;
  operator: RuleOperator;
  value?: RuleValue;
}

type RuleActionEffect =
  | { mode?: "set"; value: RuleValue }
  | { mode: "clear"; value?: never };

export type RuleAction = {
  id: string;
  attributeId: string;
} & RuleActionEffect;

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  cloudId: string;
  workspaceId: string;
  schemaId: string;
  objectTypeId: string;
  operations: RuleOperation[];
  watchedAttributeIds: string[];
  match: RuleMatch;
  conditions: RuleCondition[];
  actions: RuleAction[];
}

export interface RuleScope {
  cloudId: string;
  workspaceId: string;
  objectTypeId: string;
}

export type AppliedRuleAction = {
  ruleId: string;
  ruleName: string;
  attributeId: string;
} & RuleActionEffect;

export interface RulePlan {
  payload: ObjectAttributeIn[];
  applied: AppliedRuleAction[];
}

const OPERATIONS: readonly RuleOperation[] = ["edit", "batch", "scan", "create"];
const OPERATORS: readonly RuleOperator[] = ["isSet", "isEmpty", "equals", "notEquals"];
const MATCHES: readonly RuleMatch[] = ["any", "all"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMember<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === "string" && choices.some((choice) => choice === value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readValue(value: unknown): RuleValue {
  if (!isRecord(value) || !nonempty(value.raw) || typeof value.display !== "string") {
    throw new Error("A rule value is malformed.");
  }
  if (value.referenceId !== undefined && !nonempty(value.referenceId)) {
    throw new Error("A rule reference ID is malformed.");
  }
  return { raw: value.raw, display: value.display, ...(value.referenceId === undefined ? {} : { referenceId: value.referenceId }) };
}

/** Reject malformed rules rather than importing a partially functioning automation. */
export function parseRules(value: unknown): Rule[] {
  if (!Array.isArray(value)) throw new Error("Rules must be an array.");
  const ids = new Set<string>();
  return value.map((item, index) => {
    if (
      !isRecord(item) || !nonempty(item.id) || !nonempty(item.name) || typeof item.enabled !== "boolean" ||
      !nonempty(item.cloudId) || !nonempty(item.workspaceId) || !nonempty(item.schemaId) || !nonempty(item.objectTypeId) ||
      !Array.isArray(item.operations) || !item.operations.every((op) => isMember(op, OPERATIONS)) ||
      !Array.isArray(item.watchedAttributeIds) || !item.watchedAttributeIds.every(nonempty) ||
      !isMember(item.match, MATCHES) || !Array.isArray(item.conditions) || !Array.isArray(item.actions)
    ) {
      throw new Error(`Rule ${index + 1} is malformed.`);
    }
    if (ids.has(item.id)) throw new Error(`Rule ${index + 1} has a duplicate ID.`);
    ids.add(item.id);
    const conditions = item.conditions.map((condition) => {
      if (!isRecord(condition) || !nonempty(condition.id) || !nonempty(condition.attributeId) || !isMember(condition.operator, OPERATORS)) {
        throw new Error(`Rule "${item.name}" has a malformed condition.`);
      }
      const needsValue = condition.operator === "equals" || condition.operator === "notEquals";
      if (needsValue && condition.value === undefined) throw new Error(`Rule "${item.name}" has a condition without a value.`);
      return {
        id: condition.id,
        attributeId: condition.attributeId,
        operator: condition.operator,
        ...(condition.value === undefined ? {} : { value: readValue(condition.value) }),
      };
    });
    const actions = item.actions.map((action): RuleAction => {
      if (!isRecord(action) || !nonempty(action.id) || !nonempty(action.attributeId)) {
        throw new Error(`Rule "${item.name}" has a malformed action.`);
      }
      const mode = action.mode === undefined ? "set" : action.mode;
      if (mode === "clear") {
        if (action.value !== undefined) throw new Error(`Rule "${item.name}" has a clear action with a value.`);
        return { id: action.id, attributeId: action.attributeId, mode };
      }
      if (mode !== "set") throw new Error(`Rule "${item.name}" has an invalid action mode.`);
      return { id: action.id, attributeId: action.attributeId, mode, value: readValue(action.value) };
    });
    const rule: Rule = {
      id: item.id,
      name: item.name,
      enabled: item.enabled,
      cloudId: item.cloudId,
      workspaceId: item.workspaceId,
      schemaId: item.schemaId,
      objectTypeId: item.objectTypeId,
      operations: item.operations,
      watchedAttributeIds: item.watchedAttributeIds,
      match: item.match,
      conditions,
      actions,
    };
    const shapeError = validateRuleShape(rule);
    if (shapeError) throw new Error(`Rule "${rule.name}": ${shapeError}`);
    return rule;
  });
}

function hasDuplicates(values: string[]) {
  return new Set(values).size !== values.length;
}

function validateRuleShape(rule: Rule): string | null {
  if (!rule.operations.length || hasDuplicates(rule.operations)) return "Choose at least one distinct operation.";
  if (!rule.watchedAttributeIds.length || hasDuplicates(rule.watchedAttributeIds)) return "Choose at least one distinct watched attribute.";
  if (!rule.conditions.length || hasDuplicates(rule.conditions.map((condition) => condition.id))) return "Add at least one valid condition.";
  if (!rule.actions.length || hasDuplicates(rule.actions.map((action) => action.id))) return "Add at least one valid action.";
  if (hasDuplicates(rule.actions.map((action) => action.attributeId))) return "Each action must target a different attribute.";
  return null;
}

/** Equality is available for typed fields even when their editor is read-only or multi-valued. */
export function ruleValueKind(attribute: ObjectTypeAttribute): EditorKind {
  if (attribute.type !== AttrType.Default && attribute.type !== AttrType.ObjectReference && attribute.type !== AttrType.Status) return "readonly";
  return editorKind({ ...attribute, editable: true, system: false, maximumCardinality: 1 });
}

export function ruleActionAttributes(attributes: ObjectTypeAttribute[]): ObjectTypeAttribute[] {
  return attributes.filter((attribute) => !attribute.hidden && editorKind(attribute) !== "readonly" && ruleValueKind(attribute) !== "readonly");
}

function validDay(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validDateTime(value: string) {
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.exec(value);
  return !!parts && validDay(parts[1]) && Number(parts[2]) < 24 && Number(parts[3]) < 60 && Number(parts[4]) < 60 &&
    Number.isFinite(Date.parse(value));
}

function validateValue(attribute: ObjectTypeAttribute, value: RuleValue, statuses: StatusType[]): string | null {
  if (!nonempty(value.raw)) return `Choose a value for "${attribute.name}".`;
  switch (ruleValueKind(attribute)) {
    case "readonly":
      return `"${attribute.name}" does not support a fixed value.`;
    case "integer":
      return /^[-+]?\d+$/.test(value.raw.trim()) && Number.isSafeInteger(Number(value.raw)) ? null : `"${attribute.name}" requires an integer.`;
    case "double":
      return Number.isFinite(Number(value.raw)) ? null : `"${attribute.name}" requires a number.`;
    case "boolean":
      return ["true", "false"].includes(value.raw.toLowerCase()) ? null : `"${attribute.name}" requires true or false.`;
    case "date":
      return validDay(value.raw) ? null : `"${attribute.name}" requires a valid date.`;
    case "datetime":
      return validDateTime(value.raw) ? null : `"${attribute.name}" requires a valid date and time.`;
    case "select":
      return selectOptions(attribute).includes(value.raw) ? null : `"${attribute.name}" no longer accepts that option.`;
    case "status":
      return statuses.some((status) => status.id === value.raw && (!attribute.typeValueMulti?.length || attribute.typeValueMulti.includes(status.id)))
        ? null : `"${attribute.name}" no longer accepts that status, or statuses could not be loaded.`;
    case "reference":
      return nonempty(value.referenceId) ? null : `Choose an object again for "${attribute.name}".`;
    default:
      return null;
  }
}

/** Returns the first actionable problem, suitable for both the editor and save pipeline. */
export function validateRule(rule: Rule, attributes: ObjectTypeAttribute[], statuses: StatusType[]): string | null {
  if (!nonempty(rule.name)) return "Enter a rule name.";
  const shapeError = validateRuleShape(rule);
  if (shapeError) return shapeError;
  for (const id of rule.watchedAttributeIds) {
    if (!attributes.some((attribute) => attribute.id === id)) return `Watched attribute ${id} no longer exists.`;
  }
  for (const condition of rule.conditions) {
    const attribute = attributes.find((candidate) => candidate.id === condition.attributeId);
    if (!attribute) return `Condition attribute ${condition.attributeId} no longer exists.`;
    if (condition.operator === "equals" || condition.operator === "notEquals") {
      if (!condition.value) return `Choose a value for "${attribute.name}".`;
      const error = validateValue(attribute, condition.value, statuses);
      if (error) return error;
    }
  }
  for (const action of rule.actions) {
    const attribute = attributes.find((candidate) => candidate.id === action.attributeId);
    if (!attribute) return `Action attribute ${action.attributeId} no longer exists.`;
    if (!ruleActionAttributes([attribute]).length) return `"${attribute.name}" is no longer an editable single-valued attribute.`;
    if (action.mode === "clear") {
      if (action.value !== undefined) return `The clear action for "${attribute.name}" must not contain a value.`;
      if ((attribute.minimumCardinality ?? 0) > 0) return `"${attribute.name}" is required and cannot be cleared.`;
    } else {
      if (action.mode !== undefined && action.mode !== "set") return `The action for "${attribute.name}" has an invalid mode.`;
      if (!action.value) return `Choose a value for "${attribute.name}".`;
      const error = validateValue(attribute, action.value, statuses);
      if (error) return error;
    }
  }
  return null;
}

export function applicableRules(rules: Rule[], scope: RuleScope, operation: RuleOperation): Rule[] {
  return rules.filter((rule) =>
    rule.enabled && rule.cloudId === scope.cloudId && rule.workspaceId === scope.workspaceId &&
    rule.objectTypeId === scope.objectTypeId && rule.operations.includes(operation),
  );
}

interface ComparableValue {
  raw: string;
  aliases: string[];
}

function currentValue(attribute: ObjectTypeAttribute, value: ObjectAttributeValue): ComparableValue | null {
  let raw: string | undefined;
  const aliases: string[] = [];
  if (attribute.type === AttrType.ObjectReference) {
    raw = value.referencedObject?.id ?? value.referencedObject?.objectKey ?? value.value;
    aliases.push(...[value.referencedObject?.id, value.referencedObject?.objectKey, value.value].filter(nonempty));
  } else if (attribute.type === AttrType.Status) {
    raw = value.status?.id ?? value.value;
  } else {
    raw = value.value ?? value.user?.key ?? value.user?.name ?? value.group?.name ?? value.displayValue;
  }
  if (raw === undefined || raw === "") return null;
  return { raw, aliases: aliases.length ? aliases : [raw] };
}

function proposedValue(value: string): ComparableValue {
  return { raw: value, aliases: [value] };
}

function sameValue(attribute: ObjectTypeAttribute, a: ComparableValue, b: ComparableValue): boolean {
  if (attribute.type === AttrType.ObjectReference) return a.aliases.some((alias) => b.aliases.includes(alias));
  switch (ruleValueKind(attribute)) {
    case "integer":
    case "double": {
      const x = Number(a.raw);
      const y = Number(b.raw);
      return nonempty(a.raw) && nonempty(b.raw) && Number.isFinite(x) && Number.isFinite(y) ? x === y : a.raw === b.raw;
    }
    case "boolean":
      return a.raw.toLowerCase() === b.raw.toLowerCase();
    case "date":
      return a.raw.slice(0, 10) === b.raw.slice(0, 10);
    case "datetime": {
      const x = Date.parse(a.raw);
      const y = Date.parse(b.raw);
      return Number.isFinite(x) && Number.isFinite(y) ? x === y : a.raw === b.raw;
    }
    default:
      return a.raw === b.raw;
  }
}

function sameValues(attribute: ObjectTypeAttribute, left: ComparableValue[], right: ComparableValue[]): boolean {
  if (left.length !== right.length) return false;
  const remaining = [...right];
  return left.every((value) => {
    const index = remaining.findIndex((other) => sameValue(attribute, value, other));
    if (index < 0) return false;
    remaining.splice(index, 1);
    return true;
  });
}

export function planRules(input: {
  rules: Rule[];
  scope: RuleScope;
  operation: RuleOperation;
  baseline?: AssetObject;
  changes: ObjectAttributeIn[];
  attributes: ObjectTypeAttribute[];
  statuses: StatusType[];
}): RulePlan {
  const candidates = applicableRules(input.rules, input.scope, input.operation);
  if (!candidates.length) return { payload: input.changes, applied: [] };
  const attrs = new Map(input.attributes.map((attribute) => [attribute.id, attribute]));
  for (const rule of candidates) {
    const problem = validateRule(rule, input.attributes, input.statuses);
    if (problem) throw new Error(`Rule "${rule.name}": ${problem}`);
  }

  const original = new Map<string, ComparableValue[]>();
  for (const attribute of input.attributes) {
    const values = input.baseline?.attributes.find((item) => item.objectTypeAttributeId === attribute.id)?.objectAttributeValues ?? [];
    original.set(attribute.id, values.flatMap((value) => currentValue(attribute, value) ?? []));
  }
  const payload = new Map(input.changes.map((change) => [change.objectTypeAttributeId, change]));
  const proposed = new Map(original);
  for (const change of payload.values()) proposed.set(change.objectTypeAttributeId, change.objectAttributeValues.map((value) => proposedValue(value.value)));
  const changed = new Set(
    [...payload.keys()].filter((id) => {
      const attribute = attrs.get(id);
      if (!attribute) throw new Error(`Updated attribute ${id} no longer exists.`);
      return !sameValues(attribute, original.get(id) ?? [], proposed.get(id) ?? []);
    }),
  );

  const applied = new Map<string, AppliedRuleAction>();
  for (const rule of candidates) {
    if (!rule.watchedAttributeIds.some((id) => changed.has(id))) continue;
    const results = rule.conditions.map((condition) => {
      const attribute = attrs.get(condition.attributeId)!;
      const values = proposed.get(condition.attributeId) ?? [];
      if (condition.operator === "isSet") return values.length > 0;
      if (condition.operator === "isEmpty") return values.length === 0;
      const value = condition.value!;
      const target = { raw: value.raw, aliases: [value.raw, ...(value.referenceId ? [value.referenceId] : [])] };
      const equal = values.some((current) => sameValue(attribute, current, target));
      return condition.operator === "equals" ? equal : !equal;
    });
    if (!(rule.match === "any" ? results.some(Boolean) : results.every(Boolean))) continue;
    for (const action of rule.actions) {
      payload.set(action.attributeId, {
        objectTypeAttributeId: action.attributeId,
        objectAttributeValues: action.mode === "clear" ? [] : [{ value: action.value.raw }],
      });
      const source = { ruleId: rule.id, ruleName: rule.name, attributeId: action.attributeId };
      applied.set(action.attributeId, action.mode === "clear"
        ? { ...source, mode: "clear" }
        : { ...source, mode: "set", value: action.value });
    }
  }

  const finalPayload = [...payload.values()].filter((change) => {
    const attribute = attrs.get(change.objectTypeAttributeId)!;
    if (input.operation === "create" && applied.get(change.objectTypeAttributeId)?.mode === "clear") return true;
    return !sameValues(
      attribute,
      original.get(change.objectTypeAttributeId) ?? [],
      change.objectAttributeValues.map((value) => {
        const action = applied.get(change.objectTypeAttributeId);
        const referenceId = action?.value?.referenceId;
        return action ? { raw: value.value, aliases: [value.value, ...(referenceId ? [referenceId] : [])] } : proposedValue(value.value);
      }),
    );
  });
  const finalIds = new Set(finalPayload.map((change) => change.objectTypeAttributeId));
  return { payload: finalPayload, applied: [...applied.values()].filter((action) => finalIds.has(action.attributeId)) };
}
