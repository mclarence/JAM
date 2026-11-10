import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyChanges, capture, currentConflicts, emptyState, encodePart, ingest, parseBatch, plan, preview, recordKey, resolveConflict, runSync,
  type Adapter, type ApplyResult, type Change, type Ctx, type Json, type PulledBatch, type SyncState, type Transport,
} from "./engine";

type Step = Record<string, unknown> & { do: string };
interface Scenario { name: string; devices: Record<string, string>; steps: Step[] }

const fixture = JSON.parse(readFileSync(resolve(__dirname, "../../../fixtures/sync/engine-scenarios.json"), "utf8")) as { scenarios: Scenario[] };

let counter = 0;
const nextId = () => (++counter).toString(16).padStart(32, "0");

class MemoryAdapter implements Adapter {
  values = new Map<string, Json>();
  deferred = new Set<string>();
  autoResolveLocal?: (rid: string) => boolean;
  constructor(public scopes: string[]) {}
  project() { return new Map(this.values); }
  isManaged(rid: string) { return this.scopes.includes(rid.split("|")[0]); }
  apply(changes: Change[]): ApplyResult[] {
    return changes.map((c) => {
      if (this.deferred.has(c.rid)) return { status: "deferred" };
      if (c.value === undefined) this.values.delete(c.rid);
      else this.values.set(c.rid, c.value);
      return { status: "applied" };
    });
  }
  async flush() {}
}

class Cloud {
  batches: PulledBatch[] = [];
  transport(): Transport {
    return {
      pull: async (scopes, known) => {
        const inScope = this.batches.filter((b) => scopes.includes(b.scope));
        return { batches: inScope.filter((b) => !known.includes(b.batchId)), listed: inScope.map((b) => b.batchId), stale: false };
      },
      push: async (batch) => {
        this.batches.push({ batchId: batch.batchId, scope: batch.scope, plaintext: JSON.stringify(batch.body) });
      },
    };
  }
}

interface Device { state: SyncState; adapter: MemoryAdapter; ctx: Ctx }

function makeDevice(platform: string): Device {
  const deviceId = nextId();
  return {
    state: emptyState("0".repeat(32)),
    adapter: new MemoryAdapter(["shared", platform]),
    ctx: { deviceId, platform, now: () => "2026-01-01T00:00:00Z", newId: nextId },
  };
}

async function sync(d: Device, cloud: Cloud, confirm = true) {
  const save = async () => {};
  if (d.state.merged) return runSync(d.state, d.adapter, cloud.transport(), d.ctx, save);
  await runSync(d.state, d.adapter, cloud.transport(), d.ctx, save);
  if (!confirm) return;
  d.state.merged = true;
  return runSync(d.state, d.adapter, cloud.transport(), d.ctx, save);
}

describe("shared engine scenarios", () => {
  for (const scenario of fixture.scenarios) {
    it(scenario.name, async () => {
      const cloud = new Cloud();
      const devices = Object.fromEntries(Object.entries(scenario.devices).map(([name, platform]) => [name, makeDevice(platform)]));
      for (const step of scenario.steps) {
        const d = devices[step.device as string];
        switch (step.do) {
          case "set":
            for (const [k, v] of Object.entries(step.values as Record<string, Json>)) d.adapter.values.set(k, v);
            break;
          case "delete":
            for (const k of step.keys as string[]) d.adapter.values.delete(k);
            break;
          case "sync":
            await sync(d, cloud, step.confirm !== false);
            break;
          case "syncError":
            await expect(sync(d, cloud)).rejects.toThrow(step.contains as string);
            break;
          case "inject":
            cloud.batches.push({ batchId: nextId(), scope: step.scope as string, plaintext: step.plaintext as string });
            break;
          case "reverseCloud":
            cloud.batches.reverse();
            break;
          case "duplicateCloud":
            cloud.batches = [...cloud.batches, ...cloud.batches];
            break;
          case "resolve": {
            const value = step.delete ? undefined : (step.value as Json);
            const change = resolveConflict(d.state, step.key as string, value, d.ctx);
            await applyChanges(d.state, d.adapter, [change], d.adapter.project());
            break;
          }
          case "preview": {
            const p = preview(d.state, d.adapter, d.ctx);
            expect([...p.incoming].sort()).toEqual([...(step.incoming as string[])].sort());
            expect(p.outgoing).toBe(step.outgoing);
            expect([...p.conflicts].sort()).toEqual([...(step.conflicts as string[])].sort());
            break;
          }
          case "expect": {
            for (const [k, v] of Object.entries((step.values ?? {}) as Record<string, Json>)) {
              expect(d.adapter.values.has(k), `${step.device} has ${k}`).toBe(true);
              expect(d.adapter.values.get(k), `${step.device} ${k}`).toEqual(v);
            }
            for (const k of (step.absent ?? []) as string[]) expect(d.adapter.values.has(k), `${step.device} lacks ${k}`).toBe(false);
            if (step.conflicts) {
              expect(currentConflicts(d.state, d.adapter).map((c) => c.rid).sort()).toEqual([...(step.conflicts as string[])].sort());
            }
            // iOS must never hold desktop-scoped history.
            if (!d.adapter.scopes.includes("desktop")) {
              expect(Object.keys(d.state.graph).filter((k) => k.startsWith("desktop|"))).toEqual([]);
            }
            break;
          }
          default:
            throw new Error(`Unknown step ${step.do}`);
        }
      }
    });
  }
});

describe("engine details", () => {
  it("encodes key parts like encodeURIComponent", () => {
    expect(encodePart("a:b|c/é 1")).toBe(encodeURIComponent("a:b|c/é 1"));
    expect(recordKey("columns", "cloud:1", "ws", "42")).toBe("columns:cloud%3A1:ws:42");
  });

  it("skips records edited locally during a run and captures them next time", async () => {
    const cloud = new Cloud();
    const a = makeDevice("desktop");
    const b = makeDevice("desktop");
    a.adapter.values.set("shared|theme", "dark");
    await sync(a, cloud);
    await sync(b, cloud);
    a.adapter.values.set("shared|theme", "light");
    await sync(a, cloud);
    // b edits while its pull is in flight.
    const transport = cloud.transport();
    const racing: Transport = {
      pull: async (scopes, known) => {
        b.adapter.values.set("shared|theme", "system-ish");
        return transport.pull(scopes, known);
      },
      push: transport.push,
    };
    await runSync(b.state, b.adapter, racing, b.ctx, async () => {});
    expect(b.adapter.values.get("shared|theme")).toBe("system-ish");
    await sync(b, cloud);
    expect(currentConflicts(b.state, b.adapter).map((c) => c.rid)).toEqual(["shared|theme"]);
  });

  it("deferred changes are retried and not marked applied", async () => {
    const cloud = new Cloud();
    const a = makeDevice("desktop");
    const b = makeDevice("ios");
    a.adapter.values.set("shared|selection", { schemaId: "1" });
    await sync(a, cloud);
    b.adapter.deferred.add("shared|selection");
    const r = await sync(b, cloud);
    expect(r?.deferred).toBe(1);
    expect(b.state.local["shared|selection"]).toBeUndefined();
    b.adapter.deferred.clear();
    const r2 = await sync(b, cloud);
    expect(r2?.applied).toBe(1);
    expect(b.adapter.values.get("shared|selection")).toEqual({ schemaId: "1" });
    // No spurious upload of the applied value.
    expect(r2?.uploaded).toBe(0);
  });

  it("auto-resolves selected records in favour of the local value", async () => {
    const cloud = new Cloud();
    const a = makeDevice("desktop");
    const b = makeDevice("ios");
    const auto = (rid: string) => rid === "shared|selection";
    a.adapter.autoResolveLocal = auto;
    b.adapter.autoResolveLocal = auto;
    a.adapter.values.set("shared|selection", "x");
    b.adapter.values.set("shared|selection", "y");
    await sync(a, cloud);
    const r = await sync(b, cloud);
    expect(r?.conflicts).toEqual([]);
    expect(b.adapter.values.get("shared|selection")).toBe("y");
    await sync(a, cloud);
    expect(a.adapter.values.get("shared|selection")).toBe("y");
  });

  it("crash after applying but before saving converges on retry", async () => {
    const cloud = new Cloud();
    const a = makeDevice("desktop");
    const b = makeDevice("ios");
    a.adapter.values.set("shared|theme", "dark");
    await sync(a, cloud);
    await sync(b, cloud, false);
    b.state.merged = true;
    const before = structuredClone(b.state);
    await sync(b, cloud);
    // Simulate losing the final save: restore the old state but keep the applied local value.
    b.state = before;
    await sync(b, cloud);
    await sync(a, cloud);
    // The re-captured value equals the remote one, so both devices converge without a prompt.
    expect(currentConflicts(b.state, b.adapter)).toEqual([]);
    expect(currentConflicts(a.state, a.adapter)).toEqual([]);
    expect(b.adapter.values.get("shared|theme")).toBe("dark");
  });

  it("splits large local edits into several batches", () => {
    const d = makeDevice("desktop");
    const big = "x".repeat(300_000);
    for (let i = 0; i < 8; i++) d.adapter.values.set(`desktop|template:t${i}`, big);
    d.state.merged = true;
    capture(d.state, d.adapter.project(), d.adapter, d.ctx);
    expect(d.state.pending.length).toBeGreaterThan(1);
    for (const p of d.state.pending) expect(JSON.stringify(p.body).length).toBeLessThan(4 * 1024 * 1024);
  });

  it("rejects malformed batches as a whole", () => {
    const valid = { format: "jam-sync-changes", version: 1, deviceId: "x", platform: "ios", createdAt: "", records: [] as unknown[] };
    expect(parseBatch(JSON.stringify(valid)).records).toEqual([]);
    const badId = { ...valid, records: [{ key: "theme", versionId: "nope", parents: [], deleted: false, value: "dark" }] };
    expect(() => parseBatch(JSON.stringify(badId))).toThrow();
    const atLimit: Json = JSON.parse("[".repeat(32) + "]".repeat(32));
    expect(parseBatch(JSON.stringify({ ...valid, records: [{ key: "k", versionId: nextId(), parents: [], deleted: false, value: atLimit }] })).records).toHaveLength(1);
    const deep: Json = JSON.parse("[".repeat(33) + "]".repeat(33));
    const tooDeep = { ...valid, records: [{ key: "theme", versionId: nextId(), parents: [], deleted: false, value: deep }] };
    expect(() => parseBatch(JSON.stringify(tooDeep))).toThrow();
    const deletedWithValue = { ...valid, records: [{ key: "theme", versionId: nextId(), parents: [], deleted: true, value: "x" }] };
    expect(() => parseBatch(JSON.stringify(deletedWithValue))).toThrow();
    const state = emptyState("0".repeat(32));
    expect(ingest(state, [{ batchId: nextId(), scope: "shared", plaintext: JSON.stringify(badId) }]).rejected).toHaveLength(1);
    expect(state.graph).toEqual({});
  });

  it("plans nothing for records the adapter does not manage", () => {
    const d = makeDevice("desktop");
    d.state.graph["shared|columns:other:ws:1"] = { [nextId()]: { parents: [], deleted: false, value: { hidden: [] } } };
    d.adapter.isManaged = () => false;
    expect(plan(d.state, d.adapter.project(), d.adapter)).toEqual({ changes: [], conflicts: [] });
  });
});
