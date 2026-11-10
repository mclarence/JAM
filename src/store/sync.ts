/**
 * Runs settings sync (docs/sync-protocol.md §5, §7): owns the engine state, schedules runs, and exposes status to the UI.
 * The Jira API token never passes through here; the native side encrypts, uploads, and holds every secret.
 */
import { isTauri } from "@tauri-apps/api/core";
import { create } from "zustand";
import { ApiError, syncApi, type SyncStatus, type SyncVault } from "@/api/client";
import { queryClient } from "@/api/queryClient";
import { qk } from "@/api/queryKeys";
import type { ConnectionInfo } from "@/api/types";
import { createDesktopAdapter } from "@/lib/sync/adapter";
import { selectedAdapter, validateCategories, type SyncCategory } from "@/lib/sync/categories";
import { prepareSelection, selectionReview, type SelectionReview } from "@/lib/sync/selection";
import {
  applyChanges,
  currentConflicts,
  emptyState,
  jsonEqual,
  ingest,
  NewerVersionError,
  preview,
  pushPending,
  randomId,
  remoteValue,
  resolveConflict,
  runSync,
  partitionPending,
  type Adapter,
  type Ctx,
  type Json,
  type SyncState,
  type Transport,
} from "@/lib/sync/engine";
import { useQuickScan } from "@/store/quickScan";
import { useSettings } from "@/store/settings";
import { useTemplates } from "@/store/templates";
import { useThemeStore } from "@/store/theme";
import { useUpdater } from "@/store/updater";
import { loadSyncPreferences, saveSyncPreferences, type SyncPreferences } from "./syncPreferences";

const DEBOUNCE_MS = 3_000;
const POLL_MS = 5 * 60_000;
const FOCUS_MIN_GAP_MS = 30_000;

export type SyncPhase =
  | "loading"
  /** This build has no Google client ID, or is running outside the desktop shell. */
  | "unavailable"
  | "signedOut"
  /** Signed in to Google, but this device has not created or unlocked a vault. */
  | "locked"
  /** Another device reset sync; this device must unlock the new vault. */
  | "stale"
  /** Waiting for the user to confirm the first merge. */
  | "preview"
  | "selectionRequired"
  | "selectionReview"
  | "paused"
  | "ready";

export interface ConflictView {
  rid: string;
  local: Json | undefined;
  options: { versionId: string; value: Json | undefined }[];
}

export interface MergePreview {
  outgoing: number;
  incoming: string[];
  conflicts: string[];
}

interface SyncStore {
  phase: SyncPhase;
  status: SyncStatus | null;
  vaults: SyncVault[];
  busy: boolean;
  signingIn: boolean;
  lastSyncedAt: string | null;
  error: string | null;
  /** Problems from the last run that need no action but should be visible. */
  warnings: string[];
  conflicts: ConflictView[];
  preview: MergePreview | null;
  /** A synced Jira connection this device is not using (new device or different workspace). */
  suggestedConnection: { siteUrl: string; email: string } | null;
  selected: SyncCategory[] | null;
  selectionReview: SelectionReview | null;
}

export const useSync = create<SyncStore>(() => ({
  phase: "loading",
  status: null,
  vaults: [],
  busy: false,
  signingIn: false,
  lastSyncedAt: null,
  error: null,
  warnings: [],
  conflicts: [],
  preview: null,
  suggestedConnection: null,
  selected: null,
  selectionReview: null,
}));

let state: SyncState | null = null;
let ctx: Ctx | null = null;
let started = false;
let queue: Promise<unknown> = Promise.resolve();
let debounce: ReturnType<typeof setTimeout> | undefined;
let lastRunAt = 0;
let preferences: SyncPreferences | null = null;

const connection = () => (queryClient.getQueryData<ConnectionInfo | null>(qk.connection) ?? null);

const baseAdapter: Adapter = createDesktopAdapter({
  connection,
  theme: { get: () => useThemeStore.getState().pref, set: (p) => useThemeStore.getState().setPref(p) },
  snapshot: (id) => state?.local[id]?.snapshot,
});

const activeCategories = () => preferences?.generationId === state?.generationId ? preferences?.active ?? [] : [];
const adapter = selectedAdapter(baseAdapter, activeCategories);

const transport: Transport = {
  pull: (scopes, known) => syncApi.pull(scopes, known),
  push: (batch) => {
    if (!batch.body.records.every((r) => adapter.isManaged(`${batch.scope}|${r.key}`))) {
      throw new Error("This upload contains settings not enabled for sync on this device.");
    }
    return syncApi.push(batch.batchId, batch.scope, JSON.stringify(batch.body));
  },
};

const save = (s: SyncState) => syncApi.stateSave(JSON.stringify(s));

/** Serialises every operation that touches the engine state. */
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    useSync.setState({ busy: true });
    try {
      return await task();
    } finally {
      useSync.setState({ busy: false });
    }
  });
  queue = run.catch(() => {});
  return run;
}

function message(e: unknown): string {
  if (e instanceof NewerVersionError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

async function loadState(status: SyncStatus): Promise<void> {
  const generationId = status.generationId!;
  ctx = { deviceId: status.deviceId!, platform: "desktop", now: () => new Date().toISOString(), newId: randomId };
  const text = await syncApi.stateLoad();
  let loaded: SyncState | null = null;
  if (text) {
    try {
      loaded = JSON.parse(text) as SyncState;
    } catch {
      loaded = null;
    }
  }
  state = loaded && loaded.v === 1 && loaded.generationId === generationId ? loaded : emptyState(generationId);
}

function refreshDerived() {
  if (!state) return;
  const conflicts = state.merged ? currentConflicts(state, adapter) : [];
  const remote = activeCategories().includes("connection") ? remoteValue(state, "shared|connection")?.value : undefined;
  const conn = connection();
  let suggestedConnection: SyncStore["suggestedConnection"] = null;
  if (remote && typeof remote === "object" && !Array.isArray(remote) && typeof remote.siteUrl === "string" && typeof remote.email === "string") {
    const differs = !conn || conn.cloudId !== remote.cloudId || conn.workspaceId !== remote.workspaceId;
    if (differs) suggestedConnection = { siteUrl: remote.siteUrl, email: remote.email };
  }
  useSync.setState({ conflicts, suggestedConnection });
}

async function handleError(e: unknown) {
  if (e instanceof ApiError && e.kind === "syncStale") {
    useSync.setState({ phase: "stale", error: null, vaults: await syncApi.listVaults().catch(() => []) });
    return;
  }
  if (e instanceof ApiError && e.kind === "syncAuth") {
    await refreshStatus();
    useSync.setState({ error: "Google access has expired or was revoked. Sign in again to resume sync." });
    return;
  }
  useSync.setState({ error: message(e) });
}

/** One sync run, including the first-merge preview when this device has not merged yet. */
async function runOnce(): Promise<void> {
  if (!state || !ctx) return;
  if (!preferences) {
    useSync.setState({ phase: "selectionRequired", conflicts: [], suggestedConnection: null });
    return;
  }
  if (!preferences.selected.length) {
    useSync.setState({ phase: "paused", conflicts: [], suggestedConnection: null, selectionReview: null });
    return;
  }
  lastRunAt = Date.now();
  if (preferences.selected.some((c) => !activeCategories().includes(c))) {
    if (activeCategories().length) {
      try {
        const result = await runSync(state, adapter, transport, ctx, save);
        useSync.setState({ warnings: runWarnings(result) });
        if (result.stale) {
          useSync.setState({ phase: "stale", vaults: await syncApi.listVaults() });
          return;
        }
      } catch (e) {
        await handleError(e);
        return;
      }
    }
    await reviewSelection();
    return;
  }
  try {
    const result = await runSync(state, adapter, transport, ctx, save);
    if (result.stale) {
      useSync.setState({ phase: "stale", vaults: await syncApi.listVaults().catch(() => []) });
      return;
    }
    const warnings = runWarnings(result);
    if (!state.merged) {
      const p = preview(state, adapter, ctx);
      if (!p.incoming.length && !p.conflicts.length) {
        // Nothing to review (e.g. a brand-new vault): merge straight away.
        state.merged = true;
        await runSync(state, adapter, transport, ctx, save);
      } else {
        useSync.setState({ phase: "preview", preview: p, warnings, error: null });
        return;
      }
    }
    useSync.setState({ phase: "ready", preview: null, warnings, error: null, lastSyncedAt: new Date().toISOString() });
  } catch (e) {
    await handleError(e);
  } finally {
    refreshDerived();
  }
}

function runWarnings(result: Awaited<ReturnType<typeof runSync>>): string[] {
  const warnings: string[] = [];
  if (result.rejected.length) warnings.push(`${result.rejected.length} sync file(s) could not be read and were skipped.`);
  if (result.missing.length) warnings.push(`${result.missing.length} previously synced file(s) are no longer in Google Drive.`);
  for (const i of result.invalid) warnings.push(`A synced setting was not applied: ${i.message}`);
  return warnings;
}

async function reviewSelection(): Promise<void> {
  if (!state || !preferences) return;
  const categories = preferences.selected.filter((id) => !activeCategories().includes(id));
  const previous = useSync.getState().selectionReview;
  useSync.setState({ phase: "selectionReview", selectionReview:
    previous && jsonEqual(previous.categories, categories) ? previous : null, conflicts: [] });
  try {
    const pulled = await syncApi.pull(baseAdapter.scopes, []);
    if (pulled.stale) {
      useSync.setState({ phase: "stale", error: null, vaults: await syncApi.listVaults() });
      return;
    }
    const cloud = emptyState(state.generationId);
    const result = ingest(cloud, pulled.batches);
    if (result.rejected.length) throw new Error("Some synced settings could not be read. Review cannot continue until the sync files are repaired.");
    ingest(state, pulled.batches);
    await save(state);
    const review = selectionReview(state, cloud, baseAdapter, categories);
    useSync.setState({ selectionReview: previous?.fingerprint === review.fingerprint &&
      jsonEqual(previous.categories, review.categories) ? previous : review, error: null });
  } catch (e) {
    await handleError(e);
  } finally {
    refreshDerived();
  }
}

function hasLocalChanges(): boolean {
  if (!state?.merged) return false;
  const projection = adapter.project();
  const ids = new Set([...projection.keys(), ...Object.keys(state.local)]);
  for (const id of ids) {
    if (!adapter.isManaged(id)) continue;
    const ks = state.local[id];
    const snap = ks?.has ? ks.snapshot : undefined;
    if (!jsonEqual(projection.get(id), snap)) return true;
  }
  return false;
}

function schedule(delay = DEBOUNCE_MS, onlyIfChanged = true) {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    if (!["ready", "selectionReview"].includes(useSync.getState().phase)) return;
    if (onlyIfChanged && !hasLocalChanges()) return;
    void exclusive(runOnce);
  }, delay);
}

async function refreshStatus(): Promise<SyncStatus> {
  const status = await syncApi.status();
  let phase: SyncPhase;
  if (!status.configured) phase = "unavailable";
  else if (!status.signedIn) phase = "signedOut";
  else if (!status.generationId) phase = "locked";
  else phase = useSync.getState().phase === "stale" ? "stale" : "loading";
  if (phase !== "loading") state = null;
  useSync.setState({ status, phase, ...(phase === "signedOut" ? { conflicts: [], preview: null, suggestedConnection: null } : {}) });
  if (phase === "locked") useSync.setState({ vaults: await syncApi.listVaults().catch(() => []) });
  return status;
}

/** Loads the engine state for an enrolled device and runs once. */
async function activate(status: SyncStatus) {
  await loadState(status);
  await runOnce();
}

async function gateEnrollment() {
  if (!preferences) throw new Error("Choose which settings to sync before enrolling or resetting this device.");
  const next: SyncPreferences = { ...preferences, active: [], generationId: null };
  await saveSyncPreferences(next);
  preferences = next;
}

/** Starts background sync. Call once, after the persisted stores have hydrated. */
export function startSync() {
  if (started) return;
  started = true;
  if (!isTauri()) {
    useSync.setState({ phase: "unavailable" });
    return;
  }
  void exclusive(async () => {
    try {
      try {
        preferences = await loadSyncPreferences();
        useSync.setState({ selected: preferences?.selected ?? null });
      } catch (e) {
        preferences = null;
        useSync.setState({ selected: null, error: message(e) });
      }
      const status = await refreshStatus();
      if (status.signedIn && status.generationId) await activate(status);
    } catch (e) {
      useSync.setState({ phase: "signedOut", error: message(e) });
    }
  });

  const onLocalChange = () => schedule();
  for (const store of [useSettings, useQuickScan, useTemplates, useUpdater, useThemeStore] as { subscribe: (l: () => void) => () => void }[]) {
    store.subscribe(onLocalChange);
  }
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type === "updated" && event.query.queryKey[0] === qk.connection[0]) {
      refreshDerived();
      schedule(DEBOUNCE_MS, false);
    }
  });
  window.addEventListener("focus", () => {
    if (Date.now() - lastRunAt > FOCUS_MIN_GAP_MS) schedule(0, false);
  });
  setInterval(() => {
    if (document.hasFocus()) schedule(0, false);
  }, POLL_MS);
}

export const syncActions = {
  syncNow: () => exclusive(runOnce),

  signIn: () =>
    exclusive(async () => {
      useSync.setState({ signingIn: true, error: null });
      try {
        const status = await syncApi.signIn();
        await refreshStatus();
        if (status.generationId) await activate(status);
      } catch (e) {
        if (!(e instanceof ApiError && e.kind === "cancelled")) await handleError(e);
      } finally {
        useSync.setState({ signingIn: false });
      }
    }),

  /** Not queued: it must interrupt a sign-in that holds the queue. */
  cancelSignIn: () => syncApi.signInCancel(),

  createVault: (password: string) =>
    exclusive(async () => {
      if (!preferences) throw new Error("Choose which settings to sync before turning on sync.");
      await gateEnrollment();
      const status = await syncApi.createVault(password);
      useSync.setState({ status, error: null });
      await activate(status);
    }),

  unlockVault: (generationId: string, password: string) =>
    exclusive(async () => {
      if (!preferences) throw new Error("Choose which settings to sync before unlocking sync.");
      await gateEnrollment();
      const status = await syncApi.unlockVault(generationId, password);
      useSync.setState({ status, phase: "loading", error: null });
      await activate(status);
    }),

  /** Replaces the vault (new password); every other device must unlock again. */
  reset: (password: string) =>
    exclusive(async () => {
      await gateEnrollment();
      const { status, cleanupFailures } = await syncApi.reset(password);
      useSync.setState({ status, phase: "loading", error: null });
      // Local settings stay as they are and are uploaded as the new vault's starting point.
      await loadState(status);
      await runOnce();
      return cleanupFailures;
    }),

  disconnect: () =>
    exclusive(async () => {
      await syncApi.disconnect();
      state = null;
      await refreshStatus();
      useSync.setState({ error: null, warnings: [], lastSyncedAt: null });
    }),

  confirmMerge: () =>
    exclusive(async () => {
      if (!state) return;
      state.merged = true;
      await save(state);
      await runOnce();
    }),

  /** Keeps `value` for a conflicted record and uploads that choice. */
  resolve: (id: string, value: Json | undefined) =>
    exclusive(async () => {
      if (!state || !ctx) return;
      try {
        if (!adapter.isManaged(id)) throw new Error("This setting is not enabled for sync on this device.");
        const change = resolveConflict(state, id, value, ctx);
        const projection = adapter.project();
        await applyChanges(state, adapter, [change], projection);
        await save(state);
        partitionPending(state, (id) => adapter.isManaged(id), ctx);
        await save(state);
        await pushPending(state, transport, save, (id) => adapter.isManaged(id));
        useSync.setState({ error: null });
      } catch (e) {
        await handleError(e);
      } finally {
        refreshDerived();
      }
    }),

  saveSelection: (selected: SyncCategory[]) =>
    exclusive(async () => {
      clearTimeout(debounce);
      const categories = validateCategories(selected);
      const next: SyncPreferences = {
        v: 1, selected: categories,
        active: activeCategories().filter((id) => categories.includes(id)),
        generationId: state?.generationId ?? null,
      };
      await saveSyncPreferences(next);
      preferences = next;
      useSync.setState({ selected: categories, selectionReview: null, error: null });
      refreshDerived();
      if (state) await runOnce();
    }),

  cancelSelectionReview: () =>
    exclusive(async () => {
      if (!preferences) return;
      const next = { ...preferences, selected: [...activeCategories()] };
      await saveSyncPreferences(next);
      preferences = next;
      useSync.setState({ selected: next.selected, selectionReview: null, error: null });
      await runOnce();
    }),

  confirmSelectionReview: (choices: Record<string, string>) =>
    exclusive(async () => {
      const review = useSync.getState().selectionReview;
      if (!state || !ctx || !preferences || !review) throw new Error("Refresh the sync review before continuing.");
      const pulled = await syncApi.pull(baseAdapter.scopes, []);
      if (pulled.stale) {
        useSync.setState({ phase: "stale", vaults: await syncApi.listVaults() });
        throw new Error("Sync was reset on another device. Unlock the new vault first.");
      }
      const cloud = emptyState(state.generationId);
      if (ingest(cloud, pulled.batches).rejected.length) throw new Error("Some synced settings could not be read. Review cannot continue.");
      ingest(state, pulled.batches);
      const fresh = selectionReview(state, cloud, baseAdapter, review.categories);
      if (fresh.fingerprint !== review.fingerprint) {
        useSync.setState({ selectionReview: fresh });
        throw new Error("Settings changed during review. Review the refreshed differences before continuing.");
      }
      const prepared = prepareSelection(state, cloud, baseAdapter, review, choices, ctx);
      await save(prepared.state);
      if (selectionReview(state, cloud, baseAdapter, review.categories).fingerprint !== review.fingerprint) {
        await reviewSelection();
        throw new Error("Local settings changed while saving. Review the refreshed differences before continuing.");
      }
      state = prepared.state;
      const results = baseAdapter.apply(prepared.changes);
      await baseAdapter.flush();
      const failed = results.find((result, i) => result.status === "invalid" ||
        (result.status === "deferred" && prepared.changes[i].rid !== "shared|connection"));
      if (failed) throw new Error(failed.status === "invalid" ? failed.message : "A reviewed setting cannot be applied to this workspace.");
      const appliedProjection = baseAdapter.project();
      if (prepared.changes.some((change, i) => results[i].status !== "deferred" && !jsonEqual(appliedProjection.get(change.rid), change.value))) {
        throw new Error("Local settings changed while saving. Review your choices again before enabling sync.");
      }
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === "deferred") {
          const change = prepared.changes[i];
          const local = baseAdapter.project().get(change.rid);
          state.local[change.rid] = local === undefined ? { has: false, parents: change.parents } : { has: true, snapshot: local, parents: change.parents };
        }
      }
      await save(state);
      const next: SyncPreferences = { ...preferences, active: [...preferences.selected], generationId: state.generationId };
      await saveSyncPreferences(next);
      preferences = next;
      useSync.setState({ selectionReview: null, error: null });
      await runOnce();
    }),
};
