import { assetsApi } from "@/api/assets";
import { ApiError } from "@/api/client";
import type { AssetObject, ObjectAttributeIn } from "@/api/types";

export interface BatchJob {
  object: AssetObject;
  payload: ObjectAttributeIn[];
}

export interface BatchFailure {
  job: BatchJob;
  error: string;
}

const CONCURRENCY = 4;
const RATE_LIMIT_RETRIES = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function send({ object, payload }: BatchJob) {
  for (let attempt = 0; ; attempt++) {
    try {
      await assetsApi.updateObject(object.id, { objectTypeId: object.objectType.id, attributes: payload });
      return;
    } catch (e) {
      if (e instanceof ApiError && e.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw e;
    }
  }
}

/** Sends every job with limited parallelism; one failure never stops the rest. */
export async function runBatch(jobs: BatchJob[], onProgress: (done: number) => void) {
  const failures: BatchFailure[] = [];
  let next = 0;
  let done = 0;

  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        await send(job);
      } catch (e) {
        failures.push({ job, error: e instanceof Error ? e.message : String(e) });
      }
      onProgress(++done);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  return { updated: jobs.length - failures.length, failures };
}
