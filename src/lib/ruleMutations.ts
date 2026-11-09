import { assetsApi, getCompleteObject } from "@/api/assets";
import { ApiError, connectionApi } from "@/api/client";
import { AttrType, type AssetObject, type ConnectionInfo, type ObjectIn, type ObjectTypeAttribute, type StatusType } from "@/api/types";
import type { ScanPlan } from "@/lib/quickScan";
import { applicableRules, parseRules, planRules, validateRule, type Rule, type RuleOperation, type RulePlan, type RuleValue } from "@/lib/rules";
import { useUi } from "@/store/ui";

export interface PreparedRuleMutation {
  objectTypeId: string;
  baseline?: AssetObject;
  attributes: ObjectTypeAttribute[];
  manual: ScanPlan;
  plan: RulePlan;
  hasApplicableRules: boolean;
  connection?: ConnectionInfo;
  isCurrent?: () => boolean;
}

export interface RuleMutationResult {
  object?: AssetObject;
  objectId: string;
  didWrite: boolean;
  authoritative?: boolean;
  refreshWarning?: string;
  publicationWarning?: string;
  connection?: ConnectionInfo;
  isCurrent?: () => boolean;
}

type BuildChanges = (baseline: AssetObject, attributes: ObjectTypeAttribute[]) => ScanPlan;

const activeMutations = new Set<string>();

function lockAsset(objectId: string): () => void {
  if (activeMutations.has(objectId)) throw new Error("This asset is already being updated. Wait for that update to finish.");
  activeMutations.add(objectId);
  let released = false;
  return () => {
    if (!released) activeMutations.delete(objectId);
    released = true;
  };
}

export function beginAssetMutation(objectId: string): () => void {
  if (useUi.getState().staleAssets[objectId]) throw new Error("Refresh this asset before updating it again.");
  return lockAsset(objectId);
}

export function beginAssetRefresh(objectId: string): () => void {
  return lockAsset(objectId);
}

export function sameConnection(left: ConnectionInfo | null | undefined, right: ConnectionInfo) {
  return left?.cloudId === right.cloudId && left.workspaceId === right.workspaceId &&
    left.siteUrl === right.siteUrl && left.email === right.email;
}

export async function assertConnection(expected: ConnectionInfo) {
  if (!sameConnection(await connectionApi.get(), expected)) {
    throw new Error("The connection changed while the operation was running. Try again on the current workspace.");
  }
}

function assertCurrent(isCurrent?: () => boolean) {
  if (isCurrent && !isCurrent()) {
    throw new Error("The connection changed while the operation was running. Try again on the current workspace.");
  }
}

async function assertPreparedConnection(prepared: PreparedRuleMutation) {
  assertCurrent(prepared.isCurrent);
  if (prepared.connection) await assertConnection(prepared.connection);
  assertCurrent(prepared.isCurrent);
}

async function statusTypes(schemaId: string): Promise<StatusType[]> {
  const permitted = async (id?: string) => {
    try {
      return await assetsApi.listStatusTypes(id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) return [];
      throw error;
    }
  };
  const [global, scoped] = await Promise.all([permitted(), permitted(schemaId)]);
  return [...new Map([...global, ...scoped].map((status) => [status.id, status])).values()];
}

async function metadata(typeId: string, rules: Rule[]) {
  const schemaId = rules[0]?.schemaId;
  if (!schemaId || rules.some((rule) => rule.schemaId !== schemaId)) {
    throw new Error("Rules for this object type refer to different schemas. Review the rules before saving.");
  }
  const [attributes, statuses] = await Promise.all([assetsApi.getObjectTypeAttributes(typeId), statusTypes(schemaId)]);
  return { attributes, statuses };
}

function validateCandidates(rules: Rule[], attrs: ObjectTypeAttribute[], statuses: StatusType[], baseline?: AssetObject) {
  for (const rule of rules) {
    if (baseline?.objectType.objectSchemaId && baseline.objectType.objectSchemaId !== rule.schemaId) {
      throw new Error(`Rule "${rule.name}": The object type no longer belongs to the rule's schema.`);
    }
    const problem = validateRule(rule, attrs, statuses);
    if (problem) throw new Error(`Rule "${rule.name}": ${problem}`);
  }
}

async function verifyReferences(rules: Rule[], attributes: ObjectTypeAttribute[]) {
  const verified = new Map<string, AssetObject>();
  for (const rule of rules) {
    const conditionValues = rule.conditions.flatMap((condition): { attributeId: string; value: RuleValue }[] =>
      (condition.operator === "equals" || condition.operator === "notEquals") && condition.value
        ? [{ attributeId: condition.attributeId, value: condition.value }] : [],
    );
    for (const item of [...conditionValues, ...rule.actions]) {
      const attr = attributes.find((candidate) => candidate.id === item.attributeId);
      if (attr?.type !== AttrType.ObjectReference || !item.value.referenceId) continue;
      let reference = verified.get(item.value.referenceId);
      if (!reference) {
        try {
          reference = await assetsApi.getObject(item.value.referenceId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Rule "${rule.name}": Could not verify the object chosen for "${attr.name}". ${message}`);
        }
        verified.set(item.value.referenceId, reference);
      }
      if (reference.id !== item.value.referenceId || reference.objectKey !== item.value.raw) {
        throw new Error(`Rule "${rule.name}": Choose the object for "${attr.name}" again.`);
      }
    }
  }
}

async function candidatesFor(rules: Rule[], typeId: string, operation: RuleOperation, expected?: ConnectionInfo) {
  if (!rules.length) return { candidates: [], connection: expected };
  const connection = expected ?? await connectionApi.get();
  if (!connection) throw new Error("Connect to Jira Assets before saving.");
  const scoped = rules.filter((rule) =>
    rule && rule.enabled !== false && rule.cloudId === connection.cloudId && rule.workspaceId === connection.workspaceId &&
    rule.objectTypeId === typeId && (!Array.isArray(rule.operations) || rule.operations.includes(operation)),
  );
  if (!scoped.length) return { candidates: [], connection };
  const checked = parseRules(scoped);
  await assertConnection(connection);
  return {
    candidates: applicableRules(checked, { cloudId: connection.cloudId, workspaceId: connection.workspaceId, objectTypeId: typeId }, operation),
    connection,
  };
}

export async function prepareUpdate(input: {
  object: AssetObject;
  operation: Exclude<RuleOperation, "create">;
  rules: Rule[];
  attributes: ObjectTypeAttribute[];
  buildChanges: BuildChanges;
  connection?: ConnectionInfo;
  isCurrent?: () => boolean;
}): Promise<PreparedRuleMutation> {
  assertCurrent(input.isCurrent);
  const { candidates, connection } = await candidatesFor(input.rules, input.object.objectType.id, input.operation, input.connection);
  if (!candidates.length) {
    const manual = input.buildChanges(input.object, input.attributes);
    return {
      objectTypeId: input.object.objectType.id, baseline: input.object, attributes: input.attributes,
      manual, plan: { payload: manual.payload, applied: [] }, hasApplicableRules: false, connection, isCurrent: input.isCurrent,
    };
  }
  if (!connection) throw new Error("Connect to Jira Assets before saving.");
  const [baseline, loaded] = await Promise.all([getCompleteObject(input.object.id), metadata(input.object.objectType.id, candidates)]);
  if (baseline.objectType.id !== input.object.objectType.id) throw new Error("The asset's object type changed. Refresh it before trying again.");
  validateCandidates(candidates, loaded.attributes, loaded.statuses, baseline);
  await verifyReferences(candidates, loaded.attributes);
  const manual = input.buildChanges(baseline, loaded.attributes);
  const plan = planRules({
    rules: candidates,
    scope: { cloudId: connection.cloudId, workspaceId: connection.workspaceId, objectTypeId: baseline.objectType.id },
    operation: input.operation,
    baseline,
    changes: manual.payload,
    attributes: loaded.attributes,
    statuses: loaded.statuses,
  });
  return {
    objectTypeId: baseline.objectType.id, baseline, attributes: loaded.attributes, manual, plan,
    hasApplicableRules: true, connection, isCurrent: input.isCurrent,
  };
}

export async function prepareCreate(input: {
  body: ObjectIn;
  rules: Rule[];
  attributes: ObjectTypeAttribute[];
  connection?: ConnectionInfo;
  isCurrent?: () => boolean;
}): Promise<PreparedRuleMutation> {
  assertCurrent(input.isCurrent);
  const { candidates, connection } = await candidatesFor(input.rules, input.body.objectTypeId, "create", input.connection);
  const manual = { payload: input.body.attributes, changes: [] };
  if (!candidates.length) {
    return {
      objectTypeId: input.body.objectTypeId, attributes: input.attributes, manual,
      plan: { payload: input.body.attributes, applied: [] }, hasApplicableRules: false, connection, isCurrent: input.isCurrent,
    };
  }
  if (!connection) throw new Error("Connect to Jira Assets before saving.");
  const [loaded, objectType] = await Promise.all([
    metadata(input.body.objectTypeId, candidates),
    assetsApi.getObjectType(input.body.objectTypeId),
  ]);
  if (objectType.id !== input.body.objectTypeId || objectType.objectSchemaId !== candidates[0].schemaId) {
    throw new Error(`Rule "${candidates[0].name}": The object type no longer belongs to the rule's schema.`);
  }
  validateCandidates(candidates, loaded.attributes, loaded.statuses);
  await verifyReferences(candidates, loaded.attributes);
  const plan = planRules({
    rules: candidates,
    scope: { cloudId: connection.cloudId, workspaceId: connection.workspaceId, objectTypeId: input.body.objectTypeId },
    operation: "create",
    changes: input.body.attributes,
    attributes: loaded.attributes,
    statuses: loaded.statuses,
  });
  return {
    objectTypeId: input.body.objectTypeId, attributes: loaded.attributes, manual, plan,
    hasApplicableRules: true, connection, isCurrent: input.isCurrent,
  };
}

async function confirmed(prepared: PreparedRuleMutation, object: AssetObject): Promise<RuleMutationResult> {
  const context = { connection: prepared.connection, isCurrent: prepared.isCurrent };
  if (!prepared.hasApplicableRules) return { object, objectId: object.id, didWrite: true, ...context };
  try {
    await assertPreparedConnection(prepared);
    const refreshed = await getCompleteObject(object.id);
    assertCurrent(prepared.isCurrent);
    return { object: refreshed, objectId: object.id, didWrite: true, authoritative: true, ...context };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      objectId: object.id,
      didWrite: true,
      ...context,
      refreshWarning: `The save succeeded, but the asset could not be refreshed. Displayed values may be out of date. ${reason}`,
    };
  }
}

export async function updatePrepared(prepared: PreparedRuleMutation): Promise<RuleMutationResult> {
  if (!prepared.baseline) throw new Error("An existing asset is required for an update.");
  assertCurrent(prepared.isCurrent);
  if (!prepared.plan.payload.length) {
    return {
      object: prepared.baseline, objectId: prepared.baseline.id, didWrite: false,
      authoritative: prepared.hasApplicableRules, connection: prepared.connection, isCurrent: prepared.isCurrent,
    };
  }
  await assertPreparedConnection(prepared);
  const updated = await assetsApi.updateObject(prepared.baseline.id, { objectTypeId: prepared.objectTypeId, attributes: prepared.plan.payload });
  return confirmed(prepared, { ...updated, id: prepared.baseline.id });
}

export async function createPrepared(prepared: PreparedRuleMutation): Promise<RuleMutationResult> {
  await assertPreparedConnection(prepared);
  const created = await assetsApi.createObject({ objectTypeId: prepared.objectTypeId, attributes: prepared.plan.payload });
  return confirmed(prepared, created);
}

export function plannedChangeDescriptions(prepared: PreparedRuleMutation): string[] {
  const manual = new Map(prepared.manual.payload.map((item, index) => [item.objectTypeAttributeId, prepared.manual.changes[index]]));
  return prepared.plan.payload.map((item) => {
    const action = prepared.plan.applied.find((candidate) => candidate.attributeId === item.objectTypeAttributeId);
    const name = prepared.attributes.find((attribute) => attribute.id === item.objectTypeAttributeId)?.name ?? item.objectTypeAttributeId;
    return action ? `${name} → ${action.value.display || action.value.raw} (rule: ${action.ruleName})` : manual.get(item.objectTypeAttributeId) ?? name;
  });
}
