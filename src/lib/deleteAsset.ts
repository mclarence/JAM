import { assetsApi, getCompleteObject } from "@/api/assets";
import { ApiError } from "@/api/client";
import { AttrType, type AssetObject, type ConnectionInfo } from "@/api/types";
import { deletionScope, validateDeletion, type DeletionConfig } from "@/lib/deletion";
import { assertConnection, beginAssetMutation } from "@/lib/ruleMutations";
import { useSettings } from "@/store/settings";

/** Deletion deliberately bypasses edit rules: nothing may replace the marker. */
export async function deleteAsset(input: {
  object: AssetObject;
  config: DeletionConfig;
  connection: ConnectionInfo;
  isCurrent: () => boolean;
}) {
  const release = beginAssetMutation(input.object.id);
  const check = async () => {
    if (!input.isCurrent()) throw new Error("The connection changed. Retry on the current workspace.");
    await assertConnection(input.connection);
    if (!input.isCurrent()) throw new Error("The connection changed. Retry on the current workspace.");
    const saved = useSettings.getState().deletions[deletionScope(input.connection, input.object.objectType.id)];
    if (JSON.stringify(saved) !== JSON.stringify(input.config)) throw new Error("Deletion settings changed. Review them and confirm deletion again.");
  };
  try {
    await check();
    if (input.config.method === "permanent") {
      try {
        await assetsApi.deleteObject(input.object.id);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          throw new Error(`Jira denied permanent deletion. Check your Jira object-delete permission and API token scopes. ${error.message}`);
        }
        throw error;
      }
      return;
    }
    if (input.config.method !== "soft") throw new Error("Configure a deletion method first.");
    const [baseline, attrs] = await Promise.all([
      getCompleteObject(input.object.id),
      assetsApi.getObjectTypeAttributes(input.object.objectType.id),
    ]);
    if (baseline.objectType.id !== input.object.objectType.id) throw new Error("The asset's object type changed. Refresh before deleting.");
    const additionalAttr = attrs.find((a) => a.id === input.config.additional?.attributeId);
    const statuses = additionalAttr?.type === AttrType.Status
      ? [...await assetsApi.listStatusTypes(), ...await assetsApi.listStatusTypes(baseline.objectType.objectSchemaId)]
      : [];
    const problem = validateDeletion(input.config, attrs, statuses);
    if (problem) throw new Error(problem);
    const additional = input.config.additional;
    if (additionalAttr?.type === AttrType.ObjectReference && additional) {
      const reference = await getCompleteObject(additional.value.referenceId!);
      const refTypeId = additionalAttr.referenceObjectTypeId ?? additionalAttr.referenceObjectType?.id;
      if (reference.objectKey !== additional.value.raw || (refTypeId && reference.objectType.id !== refTypeId)) {
        throw new Error("The additional reference changed. Select its value again.");
      }
    }
    await check();
    await assetsApi.updateObject(input.object.id, {
      objectTypeId: baseline.objectType.id,
      attributes: [input.config.marker!, ...(additional ? [additional] : [])].map((field) => ({
        objectTypeAttributeId: field.attributeId,
        objectAttributeValues: [{ value: field.value.raw }],
      })),
    });
  } finally {
    release();
  }
}

export interface DeleteFailure {
  object: AssetObject;
  error: string;
}

const CONCURRENCY = 4;
const RATE_LIMIT_RETRIES = 3;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Deletes each object independently with limited parallelism; one failure never stops the rest. */
export async function deleteAssets(input: {
  objects: AssetObject[];
  typeId: string;
  config: DeletionConfig;
  connection: ConnectionInfo;
  isCurrent: () => boolean;
  onProgress?: (done: number) => void;
  sleep?: (ms: number) => Promise<void>;
}) {
  const deleted: AssetObject[] = [];
  const failures: DeleteFailure[] = [];
  let next = 0;
  let done = 0;
  const one = async (object: AssetObject) => {
    if (object.objectType.id !== input.typeId) {
      throw new Error("This asset belongs to a different object type. Delete it from that type's list.");
    }
    for (let attempt = 0; ; attempt++) {
      try {
        return await deleteAsset({ object, config: input.config, connection: input.connection, isCurrent: input.isCurrent });
      } catch (error) {
        if (error instanceof ApiError && error.status === 429 && attempt < RATE_LIMIT_RETRIES) {
          await (input.sleep ?? wait)(1000 * 2 ** attempt);
          continue;
        }
        throw error;
      }
    }
  };
  const worker = async () => {
    while (next < input.objects.length) {
      const object = input.objects[next++];
      try {
        await one(object);
        deleted.push(object);
      } catch (error) {
        failures.push({ object, error: error instanceof Error ? error.message : String(error) });
      }
      input.onProgress?.(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, input.objects.length) }, worker));
  const order = new Map(input.objects.map((object, index) => [object.id, index]));
  failures.sort((a, b) => (order.get(a.object.id) ?? 0) - (order.get(b.object.id) ?? 0));
  return { deleted, failures };
}
