import type { QueryClient } from "@tanstack/react-query";
import { applyMutationResult, captureMutationContext, refreshLockedAsset, refreshMutationQueries } from "./mutationCache";
import { runBatch, type BatchContext, type BatchJob } from "@/lib/batchUpdate";
import { notify } from "@/lib/notify";
import { useUi } from "@/store/ui";

export async function runCachedBatch(
  qc: QueryClient,
  jobs: BatchJob[],
  onProgress: (done: number) => void,
  context: Omit<BatchContext, "onResult" | "onUnconfirmed">,
) {
  const isCurrent = context.isCurrent ?? captureMutationContext(qc);
  const result = await runBatch(jobs, onProgress, {
    ...context,
    isCurrent,
    onResult: (item) => applyMutationResult(qc, item),
    onUnconfirmed: async (id) => { if (isCurrent()) await refreshLockedAsset(qc, id); },
  });
  for (const item of result.results) {
    if (item.publicationWarning) {
      useUi.getState().markAssetStale(item.objectId, item.publicationWarning);
      notify.error(item.publicationWarning);
    }
  }
  await refreshMutationQueries(qc, result.results);
  return result;
}
