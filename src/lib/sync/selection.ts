import { categoryOf, type SyncCategory } from "./categories";
import {
  commitApplied, heads, jsonEqual, resolveConflict, rid,
  type Adapter, type Change, type Ctx, type Json, type SyncState,
} from "./engine";

export interface SelectionRow {
  rid: string;
  local: Json | undefined;
  options: { versionId: string; value: Json | undefined }[];
}

export interface SelectionReview {
  categories: SyncCategory[];
  rows: SelectionRow[];
  /** Includes local values and all cloud heads, including equal-valued ones. */
  fingerprint: string;
}

function sortedJson(value: Json | undefined): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const present = (value: Json | undefined): Json => value === undefined ? { absent: true } : { value };

export function selectionRecords(state: SyncState, cloud: SyncState, base: Adapter, categories: readonly SyncCategory[]): SelectionRow[] {
  const local = base.project();
  const ids = new Set([...local.keys(), ...Object.keys(state.local), ...Object.keys(state.graph), ...Object.keys(cloud.graph)]);
  return [...ids].sort().filter((id) => {
    const category = categoryOf(id);
    return category !== undefined && categories.includes(category) && base.isManaged(id);
  }).map((id) => {
    const versions = cloud.graph[id] ?? {};
    const options = heads(versions).map((versionId) => {
      const v = versions[versionId];
      return { versionId, value: v.deleted ? undefined : v.value };
    });
    return { rid: id, local: local.get(id), options };
  });
}

export function selectionReview(state: SyncState, cloud: SyncState, base: Adapter, categories: SyncCategory[]): SelectionReview {
  const all = selectionRecords(state, cloud, base, categories);
  return {
    categories,
    rows: all.filter((r) => {
      const values = r.options.length ? r.options.map((o) => o.value) : [undefined];
      return values.some((v) => !jsonEqual(v, r.local));
    }),
    fingerprint: sortedJson(all.map((r) => ({
      rid: r.rid, local: present(r.local),
      options: r.options.map((o) => ({ id: o.versionId, value: present(o.value) })),
    }))),
  };
}

/** Builds a new state without touching stores. Its uploads remain gated until review writes and policy are durable. */
export function prepareSelection(
  state: SyncState, cloud: SyncState, base: Adapter, review: SelectionReview,
  choices: Record<string, string>, ctx: Ctx,
): { state: SyncState; changes: Change[] } {
  const fresh = selectionReview(state, cloud, base, review.categories);
  if (fresh.fingerprint !== review.fingerprint) throw new Error("Settings changed during review. Review the refreshed differences before continuing.");
  const draft: SyncState = structuredClone(state);
  for (const [id, versions] of Object.entries(cloud.graph)) {
    draft.graph[id] = { ...draft.graph[id], ...versions };
  }
  draft.known = [...new Set([...draft.known, ...cloud.known])];
  const enabling = (id: string) => {
    const category = categoryOf(id);
    return category !== undefined && review.categories.includes(category) && base.isManaged(id);
  };
  // Never reuse an immutable batch ID after removing records; retain unrelated queued work.
  draft.pending = draft.pending.flatMap((batch) => {
    const records = batch.body.records.filter((r) => !enabling(rid(batch.scope, r.key)));
    if (!records.length) return [];
    return records.length === batch.body.records.length ? [batch] : [{ ...batch, batchId: ctx.newId(), body: { ...batch.body, records } }];
  });
  const changes: Change[] = [];
  for (const row of selectionRecords(state, cloud, base, review.categories)) {
    const differs = review.rows.some((r) => r.rid === row.rid);
    const choice = differs ? choices[row.rid] : "local";
    if (!choice) throw new Error("Choose a version for every setting before continuing.");
    let value = row.local;
    if (choice !== "local") {
      const option = row.options.find((o) => o.versionId === choice);
      if (choice === "default" && !row.options.length) value = undefined;
      else if (option) value = option.value;
      else throw new Error("That synced version is no longer available. Review the differences again.");
    }
    // Local pending versions are retained as ancestors, but replaced by this explicit choice.
    const change = resolveConflict(draft, row.rid, value, ctx);
    commitApplied(draft, change);
    changes.push(change);
  }
  draft.merged = true;
  return { state: draft, changes };
}
