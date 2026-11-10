import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { getCompleteObject } from "./assets";
import { qk } from "./queryKeys";
import type { AqlResult, AssetObject, ConnectionInfo } from "./types";
import { notify } from "@/lib/notify";
import { assertConnection, beginAssetRefresh, sameConnection, type RuleMutationResult } from "@/lib/ruleMutations";
import { useUi } from "@/store/ui";
import { useSettings } from "@/store/settings";
import { isSoftDeleted } from "@/lib/deletion";

interface MutationCacheState {
  versions: Map<string, number>;
  published: WeakMap<RuleMutationResult, number>;
  confirmed: Map<string, AssetObject>;
  removed: Set<string>;
}

const states = new WeakMap<QueryClient, MutationCacheState>();

function stateFor(qc: QueryClient): MutationCacheState {
  let state = states.get(qc);
  if (!state) {
    state = { versions: new Map(), published: new WeakMap(), confirmed: new Map(), removed: new Set() };
    states.set(qc, state);
  }
  return state;
}

function currentConnection(qc: QueryClient, result: RuleMutationResult) {
  return (!result.isCurrent || result.isCurrent()) &&
    (!result.connection || sameConnection(qc.getQueryData<ConnectionInfo | null>(qk.connection), result.connection));
}

export function captureMutationContext(qc: QueryClient): () => boolean {
  const state = stateFor(qc);
  return () => states.get(qc) === state;
}

function newerThan(left: AssetObject, right: AssetObject) {
  const leftTime = Date.parse(left.updated);
  const rightTime = Date.parse(right.updated);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime > rightTime;
}

/** Reconcile only rows returned by the server, so search filters and pagination still determine membership. */
export function reconcileAssetPage(qc: QueryClient, page: AqlResult): AqlResult {
  const state = stateFor(qc);
  return {
    ...page,
    nextStartAt: page.startAt + page.values.length,
    values: page.values.map((object) => {
      const saved = state.confirmed.get(object.id);
      if (!saved) return object;
      if (newerThan(object, saved)) {
        state.confirmed.set(object.id, object);
        return object;
      }
      return saved;
    }).filter((object) => !state.removed.has(object.id) &&
      !isSoftDeleted(object, useSettings.getState().deletions, qc.getQueryData<ConnectionInfo | null>(qk.connection) ?? null)),
  };
}

/** Only call after Jira confirms the delete/update. */
export function removeDeletedAsset(qc: QueryClient, objectId: string) {
  const state = stateFor(qc);
  state.removed.add(objectId);
  state.confirmed.delete(objectId);
  state.versions.set(objectId, (state.versions.get(objectId) ?? 0) + 1);
  qc.setQueriesData<InfiniteData<AqlResult>>({ queryKey: ["objects"] }, (data) => data ? {
    ...data,
    pages: data.pages.map((page) => ({
      ...page, nextStartAt: page.nextStartAt ?? page.startAt + page.values.length,
      values: page.values.filter((object) => object.id !== objectId),
    })),
  } : data);
  for (const prefix of ["refSearch", "inbound"]) {
    qc.setQueriesData<AssetObject[]>({ queryKey: [prefix] }, (data) => data?.filter((object) => object.id !== objectId));
  }
  qc.removeQueries({ queryKey: qk.object(objectId), exact: true });
  qc.removeQueries({ queryKey: qk.history(objectId), exact: true });
  qc.removeQueries({ queryKey: qk.referenceInfo(objectId), exact: true });
  useUi.getState().clearAssetStale(objectId);
}

export function isAssetRemoved(qc: QueryClient, objectId: string) {
  return stateFor(qc).removed.has(objectId);
}

export function reconcileAssetObject(qc: QueryClient, object: AssetObject): AssetObject {
  const state = stateFor(qc);
  const saved = state.confirmed.get(object.id);
  if (!saved) return object;
  if (newerThan(object, saved)) {
    state.confirmed.set(object.id, object);
    return object;
  }
  return saved;
}

export function resetMutationCaches(qc: QueryClient) {
  states.delete(qc);
  useUi.getState().clearStaleAssets();
}

export function patchAssetCaches(qc: QueryClient, object: AssetObject, authoritative = true) {
  const merge = (previous: AssetObject) => {
    const attributes = new Map(previous.attributes.map((attribute) => [attribute.objectTypeAttributeId, attribute]));
    for (const attribute of object.attributes ?? []) attributes.set(attribute.objectTypeAttributeId, attribute);
    return {
      ...previous,
      ...object,
      attributes: authoritative ? object.attributes : [...attributes.values()],
    };
  };
  qc.setQueriesData<InfiniteData<AqlResult>>({ queryKey: ["objects"] }, (data) =>
    data ? {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        values: page.values.map((item) => item.id === object.id ? merge(item) : item),
      })),
    } : data,
  );
  qc.setQueryData<AssetObject>(qk.object(object.id), (previous) => previous ? merge(previous) : object);
}

export function applyMutationResult(qc: QueryClient, result: RuleMutationResult) {
  if (!currentConnection(qc, result)) {
    if (result.didWrite) notify.error("The save completed on a previous connection. The current workspace was not updated.");
    return;
  }
  const state = stateFor(qc);
  const version = (state.versions.get(result.objectId) ?? 0) + 1;
  state.versions.set(result.objectId, version);
  state.published.set(result, version);
  if (result.object && result.authoritative) state.confirmed.set(result.objectId, result.object);
  else if (result.didWrite) state.confirmed.delete(result.objectId);
  try {
    if (result.object) {
      patchAssetCaches(qc, result.object, result.authoritative === true);
      if (result.authoritative) useUi.getState().clearAssetStale(result.objectId);
    }
    if (result.refreshWarning) {
      useUi.getState().markAssetStale(result.objectId, result.refreshWarning);
      notify.error(result.refreshWarning);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const message = `${result.didWrite ? "The save succeeded, but" : "The asset was loaded, but"} its display could not be updated. Refresh it before editing again. ${reason}`;
    useUi.getState().markAssetStale(result.objectId, message);
    notify.error(message);
  }
}

export async function refreshMutationQueries(qc: QueryClient, results: RuleMutationResult[], includeUnwritten = false) {
  const state = stateFor(qc);
  const latest = (result: RuleMutationResult) =>
    states.get(qc) === state && currentConnection(qc, result) &&
    state.published.get(result) === state.versions.get(result.objectId);
  const changed = results.filter((result) => (result.didWrite || includeUnwritten) && latest(result));
  if (!changed.length) return;
  try {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["objects"] }, { throwOnError: true }),
      qc.invalidateQueries({ queryKey: ["count"] }, { throwOnError: true }),
      ...changed.map((result) => qc.invalidateQueries({ queryKey: qk.history(result.objectId) }, { throwOnError: true })),
    ]);
    // Search indexing can lag behind the authoritative object endpoint.
    for (const result of changed) {
      const object = state.confirmed.get(result.objectId);
      if (latest(result) && result.authoritative && object) patchAssetCaches(qc, object);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const prefix = includeUnwritten ? "The asset list could not be refreshed." : "The save succeeded, but the asset list could not be refreshed.";
    const message = `${prefix} Displayed values may be out of date. ${reason}`;
    const affected = changed.filter(latest);
    for (const result of affected) useUi.getState().markAssetStale(result.objectId, message);
    if (affected.length) notify.error(message);
  }
}

export async function refreshLockedAsset(qc: QueryClient, objectId: string) {
  const state = stateFor(qc);
  const connection = qc.getQueryData<ConnectionInfo | null>(qk.connection) ?? undefined;
  const isCurrent = () => states.get(qc) === state &&
    (!connection || sameConnection(qc.getQueryData<ConnectionInfo | null>(qk.connection), connection));
  try {
    if (connection) await assertConnection(connection);
    const object = await getCompleteObject(objectId);
    if (connection) await assertConnection(connection);
    if (!isCurrent()) {
      notify.info("The connection changed before the asset refresh completed.");
      return;
    }
    const result = { object, objectId, didWrite: false, authoritative: true, connection };
    applyMutationResult(qc, result);
    await refreshMutationQueries(qc, [result], true);
  } catch (error) {
    if (!isCurrent()) {
      notify.info("The connection changed before the asset refresh completed.");
      return;
    }
    const reason = error instanceof Error ? error.message : String(error);
    const message = `Could not refresh the asset. Displayed values may be out of date. ${reason}`;
    useUi.getState().markAssetStale(objectId, message);
    notify.error(message);
  }
}

export async function retryAssetRefresh(qc: QueryClient, objectId: string) {
  let release: () => void;
  try {
    release = beginAssetRefresh(objectId);
  } catch (error) {
    notify.error(error, "Could not refresh asset");
    return;
  }
  try {
    await refreshLockedAsset(qc, objectId);
  } finally {
    release();
  }
}
