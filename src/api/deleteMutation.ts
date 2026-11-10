import type { QueryClient } from "@tanstack/react-query";
import { removeDeletedAsset } from "./mutationCache";
import { useUi } from "@/store/ui";

/** Remove confirmed deletions from every cache. Returns false when the workspace changed meanwhile. */
export async function publishDeletions(qc: QueryClient, ids: string[], isCurrent: () => boolean) {
  if (!ids.length) return true;
  if (!isCurrent()) return false;
  await qc.cancelQueries({ predicate: (query) => ["objects", "object", "refSearch", "inbound", "count", "previewObject", "sampleObject"].includes(String(query.queryKey[0])) });
  if (!isCurrent()) return false;
  const ui = useUi.getState();
  for (const id of ids) {
    removeDeletedAsset(qc, id);
    if (useUi.getState().detailObjectId === id) ui.openDetail(null);
    if (useUi.getState().previewObjectId === id) ui.setPreviewObjectId(null);
  }
  return true;
}

export function refreshAfterDeletion(qc: QueryClient) {
  return qc.invalidateQueries({
    predicate: (query) => ["objects", "count", "refSearch", "inbound", "previewObject", "sampleObject", "referenceInfo", "objectTypes", "schemas"].includes(String(query.queryKey[0])),
  }, { throwOnError: true });
}
