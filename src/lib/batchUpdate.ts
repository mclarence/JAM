import { ApiError } from "@/api/client";
import type { AssetObject, ConnectionInfo, ObjectAttributeIn, ObjectTypeAttribute } from "@/api/types";
import { planChanges } from "@/lib/quickScan";
import { beginAssetMutation, prepareUpdate, updatePrepared, type RuleMutationResult } from "@/lib/ruleMutations";
import type { Rule } from "@/lib/rules";
import type { ScanAction } from "@/store/quickScan";

export interface BatchJob {
  object: AssetObject;
  payload: ObjectAttributeIn[];
}

export interface BatchFailure {
  job: BatchJob;
  error: string;
}

export interface BatchContext {
  rules: Rule[];
  attributes: ObjectTypeAttribute[];
  actions: ScanAction[];
  connection?: ConnectionInfo;
  isCurrent?: () => boolean;
  onResult?: (result: RuleMutationResult) => void;
  onUnconfirmed?: (objectId: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

const CONCURRENCY = 4;
const RATE_LIMIT_RETRIES = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function send({ object }: BatchJob, context: BatchContext) {
  const release = beginAssetMutation(object.id);
  try {
    const prepared = await prepareUpdate({
      object,
      operation: "batch",
      rules: context.rules,
      attributes: context.attributes,
      connection: context.connection,
      isCurrent: context.isCurrent,
      buildChanges: (baseline, attrs) => planChanges(baseline, attrs, context.actions),
    });
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await updatePrepared(prepared);
        try {
          context.onResult?.(result);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          result.publicationWarning = `${result.didWrite ? "The save succeeded, but" : "The asset was loaded, but"} its display could not be updated. Refresh it before editing again. ${reason}`;
        }
        return result;
      } catch (e) {
        if (e instanceof ApiError && e.status === 429 && attempt < RATE_LIMIT_RETRIES) {
          await (context.sleep ?? sleep)(1000 * 2 ** attempt);
          continue;
        }
        if (prepared.plan.payload.length && (!context.isCurrent || context.isCurrent())) {
          try {
            await context.onUnconfirmed?.(object.id);
          } catch (refreshError) {
            const updateReason = e instanceof Error ? e.message : String(e);
            const refreshReason = refreshError instanceof Error ? refreshError.message : String(refreshError);
            throw new Error(`The update failed: ${updateReason}. Its outcome could not be refreshed: ${refreshReason}`);
          }
        }
        throw e;
      }
    }
  } finally {
    release();
  }
}

/** Sends every job with limited parallelism; one failure never stops the rest. */
export async function runBatch(jobs: BatchJob[], onProgress: (done: number) => void, context: BatchContext) {
  const failures: BatchFailure[] = [];
  const results: RuleMutationResult[] = [];
  let next = 0;
  let done = 0;

  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        const result = await send(job, context);
        results.push(result);
      } catch (e) {
        failures.push({ job, error: e instanceof Error ? e.message : String(e) });
      }
      onProgress(++done);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  return { updated: results.filter((result) => result.didWrite).length, unchanged: results.filter((result) => !result.didWrite).length, failures, results };
}
