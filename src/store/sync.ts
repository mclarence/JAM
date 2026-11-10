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
import {
  applyChanges,
  currentConflicts,
  emptyState,
  jsonEqual,
  NewerVersionError,
  preview,
  pushPending,
  randomId,
  remoteValue,
  resolveConflict,
  runSync,
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
}));

let state: SyncState | null = null;
let ctx: Ctx | null = null;
let started = false;
let queue: Promise<unknown> = Promise.resolve();
let debounce: ReturnType<typeof setTimeout> | undefined;
let lastRunAt = 0;

const connection = () => (queryClient.getQueryData<ConnectionInfo | null>(qk.connection) ?? null);

const adapter: Adapter = createDesktopAdapter({
  connection,
  theme: { get: () => useThemeStore.getState().pref, set: (p) => useThemeStore.getState().setPref(p) },
  snapshot: (id) => state?.local[id]?.snapshot,
});

const transport: Transport = {
  pull: (scopes, known) => syncApi.pull(scopes, known),
  push: (batch) => syncApi.push(batch.batchId, batch.scope, JSON.stringify(batch.body)),
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
  const remote = remoteValue(state, "shared|connection")?.value;
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
  lastRunAt = Date.now();
  try {
    const result = await runSync(state, adapter, transport, ctx, save);
    if (result.stale) {
      useSync.setState({ phase: "stale", vaults: await syncApi.listVaults().catch(() => []) });
      return;
    }
    const warnings: string[] = [];
    if (result.rejected.length) warnings.push(`${result.rejected.length} sync file(s) could not be read and were skipped.`);
    if (result.missing.length) warnings.push(`${result.missing.length} previously synced file(s) are no longer in Google Drive.`);
    for (const i of result.invalid) warnings.push(`A synced setting was not applied: ${i.message}`);
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
    if (useSync.getState().phase !== "ready") return;
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
      const status = await syncApi.createVault(password);
      useSync.setState({ status, error: null });
      await activate(status);
    }),

  unlockVault: (generationId: string, password: string) =>
    exclusive(async () => {
      const status = await syncApi.unlockVault(generationId, password);
      useSync.setState({ status, phase: "loading", error: null });
      await activate(status);
    }),

  /** Replaces the vault (new password); every other device must unlock again. */
  reset: (password: string) =>
    exclusive(async () => {
      const { status, cleanupFailures } = await syncApi.reset(password);
      useSync.setState({ status, phase: "loading", error: null });
      // Local settings stay as they are and are uploaded as the new vault's starting point.
      await loadState(status);
      state!.merged = true;
      await save(state!);
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
        const change = resolveConflict(state, id, value, ctx);
        const projection = adapter.project();
        await applyChanges(state, adapter, [change], projection);
        await save(state);
        await pushPending(state, transport, save);
        useSync.setState({ error: null });
      } catch (e) {
        await handleError(e);
      } finally {
        refreshDerived();
      }
    }),
};
