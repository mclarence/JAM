/**
 * Platform-neutral settings-sync merge engine (docs/sync-protocol.md).
 * Mirrored in the iOS app (JAMKit/Sync/SyncEngine.swift); both run fixtures/sync/engine-scenarios.json.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const CHANGES_FORMAT = "jam-sync-changes";
export const PROTOCOL_VERSION = 1;

export const LIMITS = {
  maxRecordsPerBatch: 5000,
  maxKeyLength: 512,
  maxParents: 64,
  maxDepth: 32,
  /** Local edits are split so each batch stays well under the 4 MiB envelope limit. */
  targetBatchBytes: 1024 * 1024,
} as const;

export interface SyncVersion {
  parents: string[];
  deleted: boolean;
  value?: Json;
}

/** Local state for one record: the value this device last synced, and the versions it reflects. */
export interface KeyState {
  has: boolean;
  snapshot?: Json;
  parents: string[];
}

export interface WireRecord {
  key: string;
  versionId: string;
  parents: string[];
  deleted: boolean;
  value?: Json;
}

export interface BatchPlaintext {
  format: typeof CHANGES_FORMAT;
  version: number;
  deviceId: string;
  platform: string;
  createdAt: string;
  records: WireRecord[];
}

export interface PendingBatch {
  batchId: string;
  scope: string;
  body: BatchPlaintext;
}

export interface SyncState {
  v: 1;
  generationId: string;
  /** Batch IDs already ingested (including ones this device uploaded). */
  known: string[];
  /** `scope|key` -> versionId -> version. */
  graph: Record<string, Record<string, SyncVersion>>;
  local: Record<string, KeyState>;
  pending: PendingBatch[];
  /** False until the user confirms the first-merge preview. */
  merged: boolean;
}

export interface Change {
  rid: string;
  /** `undefined` means the record is deleted (the local default applies). */
  value: Json | undefined;
  parents: string[];
}

export type ApplyResult = { status: "applied" } | { status: "deferred" } | { status: "invalid"; message: string };

export interface Conflict {
  rid: string;
  local: Json | undefined;
  options: { versionId: string; value: Json | undefined }[];
}

export interface Adapter {
  /** Scopes this platform syncs, e.g. ["shared", "desktop"]. */
  scopes: readonly string[];
  /** Current local values of every managed record. Missing keys mean absent/default. */
  project(): Map<string, Json>;
  /** Whether this device currently owns the record (e.g. it belongs to the connected workspace). */
  isManaged(rid: string): boolean;
  /** Writes values into the local stores synchronously; persistence happens in `flush`. */
  apply(changes: Change[]): ApplyResult[];
  flush(): Promise<void>;
  /** Records whose conflicts are resolved automatically in favour of the local value. */
  autoResolveLocal?(rid: string): boolean;
  /** Optional local-only grouping; the wire format and platform scopes are unchanged. */
  batchGroup?(rid: string): string;
}

export interface Ctx {
  deviceId: string;
  platform: string;
  now: () => string;
  newId: () => string;
}

export const rid = (scope: string, key: string) => `${scope}|${key}`;

export function splitRid(id: string): [scope: string, key: string] {
  const i = id.indexOf("|");
  return [id.slice(0, i), id.slice(i + 1)];
}

const URI_SAFE = /^[A-Za-z0-9\-_.!~*'()]$/;

/** encodeURIComponent-compatible encoding, identical on every platform. */
export function encodePart(part: string): string {
  let out = "";
  for (const ch of part) out += URI_SAFE.test(ch) ? ch : encodeURIComponent(ch);
  return out;
}

export const recordKey = (...parts: string[]) => parts.map(encodePart).join(":");

export function decodeKey(key: string): string[] {
  return key.split(":").map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
}

export function emptyState(generationId: string): SyncState {
  return { v: 1, generationId, known: [], graph: {}, local: {}, pending: [], merged: false };
}

export function isId(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{32}$/.test(s);
}

export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function jsonEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (typeof a === "object") {
    if (Array.isArray(b) || typeof b !== "object") return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

/** At most `maxDepth` nested arrays/objects. */
function depthOk(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= LIMITS.maxDepth) return false;
  if (Array.isArray(value)) return value.every((v) => depthOk(v, depth + 1));
  if (typeof value === "object") return Object.values(value as object).every((v) => depthOk(v, depth + 1));
  return false;
}

function keyState(state: SyncState, id: string): KeyState {
  return state.local[id] ?? { has: false, parents: [] };
}

const snapshotOf = (s: KeyState) => (s.has ? s.snapshot : undefined);

const stateFor = (value: Json | undefined, parents: string[]): KeyState =>
  value === undefined ? { has: false, parents: [...parents] } : { has: true, snapshot: value, parents: [...parents] };

const versionFor = (value: Json | undefined, parents: string[]): SyncVersion =>
  value === undefined ? { parents: [...parents], deleted: true } : { parents: [...parents], deleted: false, value };

/** Records local edits (projection differs from the last synced value) as new versions in pending batches. */
export function capture(state: SyncState, projection: Map<string, Json>, adapter: Adapter, ctx: Ctx): number {
  const ids = new Set<string>();
  for (const id of projection.keys()) if (adapter.isManaged(id)) ids.add(id);
  for (const id of Object.keys(state.local)) if (adapter.isManaged(id)) ids.add(id);

  const groups = new Map<string, { scope: string; records: WireRecord[] }>();
  for (const id of [...ids].sort()) {
    const [scope, key] = splitRid(id);
    if (!adapter.scopes.includes(scope)) continue;
    const cur = projection.get(id);
    const ks = keyState(state, id);
    if (jsonEqual(cur, snapshotOf(ks))) continue;
    const versionId = ctx.newId();
    const version = versionFor(cur, ks.parents);
    (state.graph[id] ??= {})[versionId] = version;
    state.local[id] = stateFor(cur, [versionId]);
    const groupKey = `${scope}|${adapter.batchGroup?.(id) ?? ""}`;
    const group = groups.get(groupKey) ?? { scope, records: [] };
    group.records.push({ key, versionId, ...version });
    groups.set(groupKey, group);
  }

  let count = 0;
  for (const groupKey of [...groups.keys()].sort()) {
    const { scope, records } = groups.get(groupKey)!;
    count += records.length;
    let chunk: WireRecord[] = [];
    let size = 0;
    const flushChunk = () => {
      if (!chunk.length) return;
      state.pending.push({ batchId: ctx.newId(), scope, body: batchBody(ctx, chunk) });
      chunk = [];
      size = 0;
    };
    for (const r of records) {
      const bytes = JSON.stringify(r).length;
      if (chunk.length && (size + bytes > LIMITS.targetBatchBytes || chunk.length >= LIMITS.maxRecordsPerBatch)) flushChunk();
      chunk.push(r);
      size += bytes;
    }
    flushChunk();
  }
  return count;
}

function batchBody(ctx: Ctx, records: WireRecord[]): BatchPlaintext {
  return { format: CHANGES_FORMAT, version: PROTOCOL_VERSION, deviceId: ctx.deviceId, platform: ctx.platform, createdAt: ctx.now(), records };
}

export class NewerVersionError extends Error {
  constructor() {
    super("The sync data was created by a newer version of the app. Update this app to continue syncing.");
  }
}

/** Validates a decrypted batch. Throws on anything malformed; a batch is never partially used. */
export function parseBatch(text: string): BatchPlaintext {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("A sync batch is malformed.");
  }
  const b = body as Partial<BatchPlaintext>;
  if (!b || typeof b !== "object" || b.format !== CHANGES_FORMAT) throw new Error("A sync batch is malformed.");
  if (typeof b.version !== "number" || b.version > PROTOCOL_VERSION) throw new NewerVersionError();
  if (b.version !== PROTOCOL_VERSION || !Array.isArray(b.records) || b.records.length > LIMITS.maxRecordsPerBatch) {
    throw new Error("A sync batch is malformed.");
  }
  for (const r of b.records as unknown[]) {
    const rec = r as Partial<WireRecord>;
    const ok =
      !!rec && typeof rec === "object" &&
      typeof rec.key === "string" && rec.key.length > 0 && rec.key.length <= LIMITS.maxKeyLength &&
      isId(rec.versionId) &&
      Array.isArray(rec.parents) && rec.parents.length <= LIMITS.maxParents && rec.parents.every(isId) &&
      typeof rec.deleted === "boolean" &&
      (rec.deleted ? rec.value === undefined : rec.value !== undefined && depthOk(rec.value));
    if (!ok) throw new Error("A sync batch contains a malformed record.");
  }
  return b as BatchPlaintext;
}

/** Adds remote versions to the history graph. Returns the IDs of batches that were rejected as malformed. */
export function ingest(state: SyncState, batches: { batchId: string; scope: string; plaintext: string }[]): { rejected: string[] } {
  const known = new Set(state.known);
  const rejected: string[] = [];
  for (const batch of batches) {
    if (known.has(batch.batchId)) continue;
    let body: BatchPlaintext;
    try {
      body = parseBatch(batch.plaintext);
    } catch (e) {
      if (e instanceof NewerVersionError) throw e;
      rejected.push(batch.batchId);
      continue;
    }
    for (const r of body.records) {
      const versions = (state.graph[rid(batch.scope, r.key)] ??= {});
      versions[r.versionId] ??= versionFor(r.deleted ? undefined : r.value, r.parents);
    }
    known.add(batch.batchId);
    state.known.push(batch.batchId);
  }
  return { rejected };
}

export function heads(versions: Record<string, SyncVersion>): string[] {
  const referenced = new Set<string>();
  for (const v of Object.values(versions)) for (const p of v.parents) referenced.add(p);
  return Object.keys(versions).filter((id) => !referenced.has(id)).sort();
}

const valueOf = (v: SyncVersion): Json | undefined => (v.deleted ? undefined : v.value);

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Works out which remote values to apply and which records are in conflict. */
export function plan(state: SyncState, projection: Map<string, Json>, adapter: Adapter): { changes: Change[]; conflicts: Conflict[] } {
  const changes: Change[] = [];
  const conflicts: Conflict[] = [];
  for (const id of Object.keys(state.graph).sort()) {
    const [scope] = splitRid(id);
    if (!adapter.scopes.includes(scope) || !adapter.isManaged(id)) continue;
    const versions = state.graph[id];
    const hs = heads(versions);
    if (!hs.length) continue;
    const ks = keyState(state, id);
    // Edited locally since the last capture: leave it for the next run.
    if (!jsonEqual(projection.get(id), snapshotOf(ks))) continue;
    if (sameSet(hs, ks.parents)) continue;
    const values = hs.map((h) => valueOf(versions[h]));
    if (values.every((v) => jsonEqual(v, values[0]))) changes.push({ rid: id, value: values[0], parents: hs });
    else conflicts.push({ rid: id, local: snapshotOf(ks), options: hs.map((h) => ({ versionId: h, value: valueOf(versions[h]) })) });
  }
  return { changes, conflicts };
}

/** Marks a change as applied locally. Call only after the local stores have been durably written. */
export function commitApplied(state: SyncState, change: Change) {
  state.local[change.rid] = stateFor(change.value, change.parents);
}

/** Resolves a conflict with a version descending from every current head; queues it for upload and returns the change to apply. */
export function resolveConflict(state: SyncState, id: string, value: Json | undefined, ctx: Ctx): Change {
  const versions = (state.graph[id] ??= {});
  const parents = heads(versions);
  const versionId = ctx.newId();
  const version = versionFor(value, parents);
  versions[versionId] = version;
  const [scope, key] = splitRid(id);
  state.pending.push({ batchId: ctx.newId(), scope, body: batchBody(ctx, [{ key, versionId, ...version }]) });
  return { rid: id, value, parents: [versionId] };
}

/** The agreed remote value of a record, or null when unknown or in conflict. */
export function remoteValue(state: SyncState, id: string): { value: Json | undefined } | null {
  const versions = state.graph[id];
  if (!versions) return null;
  const hs = heads(versions);
  if (!hs.length) return null;
  const values = hs.map((h) => valueOf(versions[h]));
  return values.every((v) => jsonEqual(v, values[0])) ? { value: values[0] } : null;
}

export interface PulledBatch {
  batchId: string;
  scope: string;
  plaintext: string;
}

export interface Transport {
  pull(scopes: readonly string[], known: string[]): Promise<{ batches: PulledBatch[]; listed: string[]; stale: boolean }>;
  push(batch: PendingBatch): Promise<void>;
}

export interface RunResult {
  uploaded: number;
  applied: number;
  deferred: number;
  conflicts: Conflict[];
  invalid: { rid: string; message: string }[];
  rejected: string[];
  /** Batches this device had seen that are no longer in the cloud (possible rollback or deletion). */
  missing: string[];
  stale: boolean;
}

/** Applies changes through the adapter, flushes, then commits the applied ones. */
export async function applyChanges(state: SyncState, adapter: Adapter, changes: Change[], projection: Map<string, Json>) {
  const outcome = { applied: 0, deferred: 0, invalid: [] as { rid: string; message: string }[] };
  // Equal values only need their ancestry recorded.
  const writes = changes.filter((c) => !jsonEqual(c.value, projection.get(c.rid)));
  const results = writes.length ? adapter.apply(writes) : [];
  if (writes.length) await adapter.flush();
  for (const change of changes) {
    const i = writes.indexOf(change);
    const r: ApplyResult = i < 0 ? { status: "applied" } : results[i];
    if (r.status === "applied") {
      commitApplied(state, change);
      outcome.applied++;
    } else if (r.status === "deferred") outcome.deferred++;
    else outcome.invalid.push({ rid: change.rid, message: r.message });
  }
  return outcome;
}

/**
 * One sync run: capture → save → pull/ingest → save → push → re-project/apply → flush → save.
 * Local stores are flushed before the sync state is saved, so a crash re-applies instead of losing changes.
 */
export async function runSync(state: SyncState, adapter: Adapter, transport: Transport, ctx: Ctx, save: (s: SyncState) => Promise<void>): Promise<RunResult> {
  const result: RunResult = { uploaded: 0, applied: 0, deferred: 0, conflicts: [], invalid: [], rejected: [], missing: [], stale: false };
  if (state.merged) {
    capture(state, adapter.project(), adapter, ctx);
    await save(state);
  }

  const knownBefore = new Set(state.known);
  const pulled = await transport.pull(adapter.scopes, state.known);
  if (pulled.stale) return { ...result, stale: true };
  const listed = new Set(pulled.listed);
  result.missing = [...knownBefore].filter((id) => !listed.has(id));
  result.rejected = ingest(state, pulled.batches).rejected;
  await save(state);
  if (!state.merged) return result;

  partitionPending(state, (id) => adapter.isManaged(id), ctx);
  await save(state);
  result.uploaded += await pushPending(state, transport, save, (id) => adapter.isManaged(id));

  const projection = adapter.project();
  const { changes, conflicts } = plan(state, projection, adapter);
  const applied = await applyChanges(state, adapter, changes, projection);
  result.applied = applied.applied;
  result.deferred = applied.deferred;
  result.invalid = applied.invalid;

  for (const conflict of conflicts) {
    if (adapter.autoResolveLocal?.(conflict.rid)) commitApplied(state, resolveConflict(state, conflict.rid, conflict.local, ctx));
    else result.conflicts.push(conflict);
  }
  await save(state);
  result.uploaded += await pushPending(state, transport, save, (id) => adapter.isManaged(id));
  return result;
}

/** Uploads queued batches in order. Each is removed only after a successful upload (uploads are idempotent by batch ID). */
export function partitionPending(state: SyncState, allowed: (rid: string) => boolean, ctx: Ctx) {
  state.pending = state.pending.flatMap((batch) => {
    const yes = batch.body.records.filter((r) => allowed(rid(batch.scope, r.key)));
    const no = batch.body.records.filter((r) => !allowed(rid(batch.scope, r.key)));
    if (!yes.length || !no.length) return [batch];
    return [yes, no].map((records) => ({ ...batch, batchId: ctx.newId(), body: { ...batch.body, records } }));
  });
}

export async function pushPending(
  state: SyncState, transport: Transport, save: (s: SyncState) => Promise<void>,
  allowed: (rid: string) => boolean = () => true,
): Promise<number> {
  let uploaded = 0;
  for (;;) {
    const index = state.pending.findIndex((b) => b.body.records.every((r) => allowed(rid(b.scope, r.key))));
    if (index < 0) break;
    const batch = state.pending[index];
    await transport.push(batch);
    state.pending.splice(index, 1);
    if (!state.known.includes(batch.batchId)) state.known.push(batch.batchId);
    uploaded += batch.body.records.length;
    await save(state);
  }
  return uploaded;
}

/** What the first merge would do, without changing local settings or uploading anything. */
export function preview(state: SyncState, adapter: Adapter, ctx: Ctx) {
  const draft: SyncState = structuredClone(state);
  const projection = adapter.project();
  const outgoing = capture(draft, projection, adapter, ctx);
  const { changes, conflicts } = plan(draft, projection, adapter);
  return {
    outgoing,
    incoming: changes.filter((c) => !jsonEqual(c.value, projection.get(c.rid))).map((c) => c.rid),
    conflicts: conflicts.filter((c) => !adapter.autoResolveLocal?.(c.rid)).map((c) => c.rid),
  };
}

/** Conflicts currently outstanding, for display between runs. */
export function currentConflicts(state: SyncState, adapter: Adapter): Conflict[] {
  return plan(state, adapter.project(), adapter).conflicts.filter((c) => !adapter.autoResolveLocal?.(c.rid));
}
