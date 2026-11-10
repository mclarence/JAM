import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_CATEGORIES, CATEGORY_RECORDS, categoryOf, selectedAdapter, validateCategories, type SyncCategory } from "./categories";
import {
  capture, emptyState, ingest, partitionPending, pushPending, runSync,
  type Adapter, type ApplyResult, type Change, type Ctx, type Json, type PendingBatch, type PulledBatch, type SyncState, type Transport,
} from "./engine";
import { prepareSelection, selectionReview } from "./selection";

let count = 0;
const id = () => (++count).toString(16).padStart(32, "0");
const ctx: Ctx = { deviceId: "d", platform: "desktop", now: () => "", newId: id };
const save = async () => {};
class Settings implements Adapter {
  values = new Map<string, Json>();
  constructor(public scopes = ["shared", "desktop"]) {}
  project() { return new Map(this.values); }
  isManaged(rid: string) { return this.scopes.includes(rid.split("|")[0]); }
  apply(changes: Change[]): ApplyResult[] {
    return changes.map((c) => {
      if (c.value === undefined) this.values.delete(c.rid);
      else this.values.set(c.rid, c.value);
      return { status: "applied" };
    });
  }
  async flush() {}
}
class Drive {
  batches: PulledBatch[] = [];
  transport: Transport = {
    pull: async (scopes, known) => {
      const all = this.batches.filter((b) => scopes.includes(b.scope));
      return { batches: all.filter((b) => !known.includes(b.batchId)), listed: all.map((b) => b.batchId), stale: false };
    },
    push: async (b) => {
      if (!this.batches.some((old) => old.batchId === b.batchId)) this.batches.push({ batchId: b.batchId, scope: b.scope, plaintext: JSON.stringify(b.body) });
    },
  };
  cloud(scopes = ["shared", "desktop"]) {
    const state = emptyState("g");
    ingest(state, this.batches.filter((b) => scopes.includes(b.scope)));
    return state;
  }
}
function device(platform = "desktop", selected: SyncCategory[] = ALL_CATEGORIES) {
  const base = new Settings(["shared", platform]);
  const state = emptyState("g");
  state.merged = true;
  const choices = [...selected];
  return { base, state, selected: choices, adapter: selectedAdapter(base, () => choices) };
}
async function sync(d: ReturnType<typeof device>, drive: Drive) { return runSync(d.state, d.adapter, drive.transport, ctx, save); }

describe("per-device sync categories", () => {
  it("maps every canonical record and matches the cross-language fixture", () => {
    const fixture = JSON.parse(readFileSync(resolve(__dirname, "../../../fixtures/sync/categories.json"), "utf8"));
    expect(CATEGORY_RECORDS).toEqual(fixture);
    for (const [scope, kinds] of Object.entries(CATEGORY_RECORDS)) {
      for (const [kind, category] of Object.entries(kinds)) expect(categoryOf(`${scope}|${kind}:c:w:42`)).toBe(category);
    }
    expect(categoryOf("shared|future")).toBeUndefined();
    expect(categoryOf("ios|template:t")).toBeUndefined();
    expect(() => validateCategories(["not-a-category"])).toThrow();
    expect(validateCategories([])).toEqual([]);
  });

  it("filters projection, direct apply, defaults/deletions and unknown settings", () => {
    const d = device("ios", ["theme"]);
    d.base.values.set("shared|columns:c:w:42", { order: ["local"] });
    d.base.values.set("shared|theme", "dark");
    expect([...d.adapter.project().keys()]).toEqual(["shared|theme"]);
    expect(d.adapter.apply([{ rid: "shared|columns:c:w:42", value: undefined, parents: [] }])).toEqual([{ status: "deferred" }]);
    expect(d.base.values.get("shared|columns:c:w:42")).toEqual({ order: ["local"] });
    expect(d.adapter.isManaged("desktop|template:t")).toBe(false);
    d.selected.length = 0;
    expect([...d.adapter.project()]).toEqual([]);
  });

  it("keeps new batches category-homogeneous without changing the protocol", () => {
    const d = device();
    d.base.values.set("shared|theme", "dark");
    d.base.values.set("shared|columns:c:w:42", { order: ["a"] });
    d.base.values.set("shared|filter:f", { name: "F", aql: "x" });
    capture(d.state, d.adapter.project(), d.adapter, ctx);
    expect(d.state.pending).toHaveLength(3);
    for (const b of d.state.pending) expect(new Set(b.body.records.map((r) => categoryOf(`${b.scope}|${r.key}`))).size).toBe(1);
  });

  it("parks excluded pending records, partitions old mixed batches with fresh IDs, and retries idempotently", async () => {
    const d = device();
    d.base.values.set("shared|theme", "dark");
    d.base.values.set("shared|columns:c:w:42", { order: ["local"] });
    capture(d.state, d.base.project(), d.base, ctx);
    const original = structuredClone(d.state.pending[0]);
    expect(original.body.records).toHaveLength(2);
    d.selected.splice(0, d.selected.length, "theme");
    partitionPending(d.state, (rid) => d.adapter.isManaged(rid), ctx);
    expect(d.state.pending).toHaveLength(2);
    expect(d.state.pending.every((b) => b.batchId !== original.batchId)).toBe(true);
    expect(d.state.pending.flatMap((b) => b.body.records).map((r) => r.versionId).sort()).toEqual(original.body.records.map((r) => r.versionId).sort());
    const drive = new Drive();
    // The old whole batch may already have reached Drive before an acknowledgement was lost.
    await drive.transport.push(original);
    let attempts = 0;
    const flaky: Transport = { ...drive.transport, push: async (b) => {
      await drive.transport.push(b);
      if (++attempts === 1) throw new Error("lost acknowledgement");
    } };
    await expect(pushPending(d.state, flaky, save, (rid) => d.adapter.isManaged(rid))).rejects.toThrow("lost acknowledgement");
    await pushPending(d.state, drive.transport, save, (rid) => d.adapter.isManaged(rid));
    expect(d.state.pending).toHaveLength(1);
    expect(d.state.pending[0].body.records[0].key).toBe("columns:c:w:42");
    expect(drive.batches).toHaveLength(2);
    expect(JSON.parse(drive.batches[0].plaintext)).toEqual(original.body);
    expect(Object.keys(drive.cloud().graph["shared|theme"])).toHaveLength(1);
  });

  it("lets desktops exchange columns while iOS retains its columns, round-trips filters, and reviews re-enabling", async () => {
    const drive = new Drive(), a = device(), ios = device("ios", ["filters"]), b = device();
    a.base.values.set("shared|columns:c:w:42", { order: ["desktop"] });
    a.base.values.set("desktop|columnSizes:c:w:42", { a: 120 });
    a.base.values.set("desktop|template:t", { name: "Asset label" });
    a.base.values.set("shared|filter:laptops", { name: "Laptops", aql: "Laptop" });
    ios.base.values.set("shared|columns:c:w:42", { order: ["ios"] });
    await sync(a, drive);
    await sync(ios, drive);
    expect(ios.base.values.get("shared|columns:c:w:42")).toEqual({ order: ["ios"] });
    expect(Object.keys(ios.state.graph).some((key) => key.startsWith("desktop|"))).toBe(false);
    ios.base.values.set("shared|filter:phones", { name: "Phones", aql: "Phone" });
    await sync(ios, drive);
    await sync(a, drive);
    await sync(b, drive);
    expect(a.base.values.get("shared|filter:phones")).toEqual({ name: "Phones", aql: "Phone" });
    expect(b.base.values.get("shared|columns:c:w:42")).toEqual({ order: ["desktop"] });
    expect(b.base.values.get("desktop|template:t")).toEqual({ name: "Asset label" });
    expect(b.base.values.get("desktop|columnSizes:c:w:42")).toEqual({ a: 120 });
    const cloud = drive.cloud(["shared", "ios"]);
    const review = selectionReview(ios.state, cloud, ios.base, ["columns"]);
    expect(review.rows.map((r) => r.rid)).toEqual(["shared|columns:c:w:42"]);
    const row = review.rows[0];
    const prepared = prepareSelection(ios.state, cloud, ios.base, review, { [row.rid]: row.options[0].versionId }, ctx);
    ios.state = prepared.state;
    ios.base.apply(prepared.changes);
    ios.selected.push("columns");
    await sync(ios, drive);
    expect(ios.base.values.get(row.rid)).toEqual({ order: ["desktop"] });
    expect((await sync(a, drive)).conflicts).toEqual([]);
  });

  it("requires choices even for ancestor updates, deletions and local-only settings; rejects stale previews", async () => {
    const drive = new Drive(), a = device(), b = device();
    a.base.values.set("shared|theme", "dark");
    await sync(a, drive);
    await sync(b, drive);
    b.selected.splice(0, b.selected.length);
    a.base.values.delete("shared|theme");
    await sync(a, drive);
    const cloud = drive.cloud();
    b.base.values.set("shared|filter:local", { name: "Local", aql: "x" });
    const review = selectionReview(b.state, cloud, b.base, ["theme", "filters"]);
    expect(review.rows).toHaveLength(2);
    expect(() => prepareSelection(b.state, cloud, b.base, review, {}, ctx)).toThrow("Choose a version");
    const choices = Object.fromEntries(review.rows.map((r) => [r.rid, r.options[0]?.versionId ?? "local"]));
    const prepared = prepareSelection(b.state, cloud, b.base, review, choices, ctx);
    expect(prepared.changes.find((c) => c.rid === "shared|theme")?.value).toBeUndefined();
    b.base.values.set("shared|theme", "light");
    expect(() => prepareSelection(b.state, cloud, b.base, review, choices, ctx)).toThrow("changed during review");
    const remoteChanged: SyncState = structuredClone(cloud);
    remoteChanged.graph["shared|theme"][id()] = { parents: [], deleted: false, value: "light" };
    expect(() => prepareSelection(b.state, remoteChanged, b.base, review, choices, ctx)).toThrow("changed during review");
  });

  it("replaces parked local versions with the user's explicit remote choice without resurrecting them", async () => {
    const d = device(), drive = new Drive(), remote = device();
    d.base.values.set("shared|theme", "dark");
    capture(d.state, d.adapter.project(), d.adapter, ctx);
    remote.base.values.set("shared|theme", "light");
    await sync(remote, drive);
    const cloud = drive.cloud();
    ingest(d.state, drive.batches);
    const review = selectionReview(d.state, cloud, d.base, ["theme"]);
    const prepared = prepareSelection(d.state, cloud, d.base, review, { "shared|theme": review.rows[0].options[0].versionId }, ctx);
    expect(prepared.state.pending.flatMap((b: PendingBatch) => b.body.records).filter((r) => r.key === "theme")).toHaveLength(1);
    d.state = prepared.state;
    d.base.apply(prepared.changes);
    await sync(d, drive);
    expect((await sync(remote, drive)).conflicts).toEqual([]);
    expect(remote.base.values.get("shared|theme")).toBe("light");
  });

  it("makes a reviewed local choice descend from fresh remote heads even when excluded history was not ingested", async () => {
    const drive = new Drive(), a = device(), b = device();
    a.base.values.set("shared|theme", "dark");
    await sync(a, drive);
    await sync(b, drive);
    b.selected.splice(0, b.selected.length);
    a.base.values.set("shared|theme", "light");
    await sync(a, drive);
    const cloud = drive.cloud();
    const review = selectionReview(b.state, cloud, b.base, ["theme"]);
    const prepared = prepareSelection(b.state, cloud, b.base, review, { "shared|theme": "local" }, ctx);
    b.state = prepared.state;
    b.base.apply(prepared.changes);
    b.selected.push("theme");
    await sync(b, drive);
    expect((await sync(a, drive)).conflicts).toEqual([]);
    expect(a.base.values.get("shared|theme")).toBe("dark");
  });

  it("offers every distinct remote conflict version and requires an explicit selection", async () => {
    const drive = new Drive(), a = device(), b = device(), c = device("ios", []);
    a.base.values.set("shared|theme", "dark");
    b.base.values.set("shared|theme", "light");
    // Both edit offline, then upload concurrently.
    capture(a.state, a.adapter.project(), a.adapter, ctx);
    capture(b.state, b.adapter.project(), b.adapter, ctx);
    await sync(a, drive);
    await sync(b, drive);
    const cloud = drive.cloud();
    const review = selectionReview(c.state, cloud, c.base, ["theme"]);
    expect(review.rows[0].options.map((o) => o.value).sort()).toEqual(["dark", "light"]);
    const option = review.rows[0].options.find((o) => o.value === "light")!;
    const prepared = prepareSelection(c.state, cloud, c.base, review, { "shared|theme": option.versionId }, ctx);
    c.state = prepared.state;
    c.base.apply(prepared.changes);
    c.selected.push("theme");
    await sync(c, drive);
    expect((await sync(a, drive)).conflicts).toEqual([]);
    expect(a.base.values.get("shared|theme")).toBe("light");
  });
});
