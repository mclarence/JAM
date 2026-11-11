import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionInfo } from "@/api/types";

vi.mock("sonner", () => ({ toast: Object.assign(() => {}, { dismiss: () => {}, success: () => {}, error: () => {} }) }));
vi.mock("@/store/theme", () => ({ useThemeStore: { getState: () => ({ pref: "system", setPref: () => {} }) } }));

import { DEFAULT_STATUS_COLORS } from "@/lib/statusColors";
import { useQuickScan } from "@/store/quickScan";
import { useReports } from "@/store/reports";
import { useSettings } from "@/store/settings";
import { useTemplates } from "@/store/templates";
import { useUpdater } from "@/store/updater";
import { createDesktopAdapter, type ThemeValue } from "./adapter";
import { emptyState, runSync, type Change, type Json, type PendingBatch, type PulledBatch, type Transport } from "./engine";

const fixture = JSON.parse(readFileSync(resolve(__dirname, "../../../fixtures/sync/adapter-records.json"), "utf8")) as {
  connection: ConnectionInfo;
  shared: Record<string, Json>;
  desktop: Record<string, Json>;
};

let connection: ConnectionInfo | null;
let theme: ThemeValue;
let snapshots: Map<string, Json>;

function reset() {
  connection = fixture.connection;
  theme = "system";
  snapshots = new Map();
  useSettings.setState({
    schemaId: null, objectTypeId: null, statusColors: { ...DEFAULT_STATUS_COLORS }, columns: {}, assetTags: {}, aqlPresets: [],
    labelDefaults: { unit: "mm", width: 62, height: 29, output: "open" }, referenceDisplay: {}, rules: [], deletions: {},
  });
  useQuickScan.setState({ configs: {}, presets: {}, sound: true });
  useTemplates.setState({ templates: [], defaultTemplateId: null, selectedId: null });
  useUpdater.setState({ channel: "stable", autoCheck: true });
  useReports.setState({ sources: [], reports: [], mappings: {}, lastReportId: null });
}

const adapter = () =>
  createDesktopAdapter({
    connection: () => connection,
    theme: { get: () => theme, set: (p) => (theme = p) },
    snapshot: (rid) => snapshots.get(rid),
  });

const changes = (records: Record<string, Json>): Change[] =>
  Object.entries(records).map(([rid, value]) => ({ rid, value, parents: [] }));

describe("desktop sync adapter", () => {
  beforeEach(reset);

  it("starts with nothing but the connection when settings are at their defaults", () => {
    expect([...adapter().project().keys()]).toEqual(["shared|connection"]);
  });

  it("round-trips every canonical shared and desktop record exactly", () => {
    const a = adapter();
    const { "shared|connection": conn, ...rest } = fixture.shared;
    const results = a.apply(changes({ ...rest, ...fixture.desktop }));
    expect(results.filter((r) => r.status !== "applied")).toEqual([]);
    expect(Object.fromEntries(a.project())).toEqual({ ...fixture.shared, "shared|connection": conn, ...fixture.desktop });
  });

  it("never projects secrets or device-local settings", () => {
    const a = adapter();
    a.apply(changes({ ...fixture.shared, ...fixture.desktop }));
    useSettings.getState().setLabelDefaults({ output: "save" });
    useQuickScan.getState().setPanelOpen(false);
    const text = JSON.stringify(Object.fromEntries(a.project()));
    for (const banned of ["secret", "token", "apiBase", "output", "panelOpen", "selectedId", "proxy"]) expect(text).not.toContain(banned);
  });

  it("manages workspace records only for the connected workspace", () => {
    const a = adapter();
    expect(a.isManaged("shared|columns:cloud-1:ws-1:42")).toBe(true);
    expect(a.isManaged("shared|columns:cloud-1:ws-2:42")).toBe(false);
    expect(a.isManaged("desktop|columnSizes:cloud-1:ws-1:42")).toBe(true);
    expect(a.isManaged("shared|rule:r1")).toBe(true);
    expect(a.isManaged("shared|futureThing")).toBe(false);
    expect(a.isManaged("ios|anything")).toBe(false);
    connection = null;
    expect(a.isManaged("shared|columns:cloud-1:ws-1:42")).toBe(false);
    expect(a.isManaged("shared|connection")).toBe(false);
    expect(a.isManaged("shared|theme")).toBe(true);
  });

  it("does not switch connections or selections across workspaces", () => {
    const a = adapter();
    const other = { ...fixture.connection, workspaceId: "ws-9" };
    expect(a.apply(changes({ "shared|connection": other }))).toEqual([{ status: "deferred" }]);
    expect(a.apply(changes({ "shared|selection": { ...other, schemaId: "1", objectTypeId: null } }))).toEqual([{ status: "deferred" }]);
    expect(useSettings.getState().schemaId).toBeNull();
  });

  it("rejects malformed records without changing settings", () => {
    const a = adapter();
    const bad = a.apply(changes({
      "shared|rule:r1": { id: "r1" },
      "shared|deletion:cloud-1:ws-1:42": { method: "soft", marker: { attributeId: "a8", value: { raw: "X", display: "X" } } },
      "shared|theme": "purple",
      "desktop|template:t1": { id: "t1" },
    }));
    expect(bad.map((r) => r.status)).toEqual(["invalid", "invalid", "invalid", "invalid"]);
    expect(useSettings.getState().rules).toEqual([]);
    expect(useSettings.getState().deletions).toEqual({});
    expect(theme).toBe("system");
  });

  it("restores defaults when records are deleted", () => {
    const a = adapter();
    a.apply(changes({ ...fixture.shared, ...fixture.desktop }));
    a.apply(Object.keys({ ...fixture.shared, ...fixture.desktop }).map((rid) => ({ rid, value: undefined, parents: [] })));
    expect(theme).toBe("system");
    expect(useSettings.getState().statusColors).toEqual(DEFAULT_STATUS_COLORS);
    expect(useSettings.getState().labelDefaults).toEqual({ unit: "mm", width: 62, height: 29, output: "open" });
    expect(useQuickScan.getState().sound).toBe(true);
    expect(useUpdater.getState().channel).toBe("stable");
    expect([...a.project().keys()]).toEqual(["shared|connection"]);
  });

  it("keeps fields added by newer app versions", () => {
    const a = adapter();
    const rid = "shared|filter:f1";
    const value = { name: "A", aql: "x", colour: "teal" };
    a.apply(changes({ [rid]: value }));
    snapshots.set(rid, value);
    expect(a.project().get(rid)).toEqual(value);
    useSettings.setState((s) => ({ aqlPresets: s.aqlPresets.map((p) => ({ ...p, name: "B" })) }));
    expect(a.project().get(rid)).toEqual({ ...value, name: "B" });
  });

  it("treats only a change in the relative order of shared rules as a reorder", () => {
    const a = adapter();
    a.apply(changes({ "shared|rule:r1": fixture.shared["shared|rule:r1"], "shared|rule:r2": fixture.shared["shared|rule:r2"] }));
    const key = "shared|ruleOrder:cloud-1:ws-1:42";
    snapshots.set(key, ["r1", "r2", "r9"]);
    expect(a.project().get(key)).toEqual(["r1", "r2", "r9"]);
    useSettings.getState().swapRules("r1", "r2");
    expect(a.project().get(key)).toEqual(["r2", "r1"]);
  });

  it("keeps desktop column widths when shared column settings arrive", () => {
    const a = adapter();
    a.apply(changes({ "desktop|columnSizes:cloud-1:ws-1:42": { a1: 50 }, "shared|columns:cloud-1:ws-1:42": { hidden: ["a1"] } }));
    expect(useSettings.getState().columns["42"]).toEqual({ hidden: ["a1"], sizes: { a1: 50 } });
    a.apply(changes({ "shared|columns:cloud-1:ws-1:42": { hidden: [] } }));
    expect(useSettings.getState().columns["42"]).toEqual({ hidden: [], sizes: { a1: 50 } });
  });

  it("syncs desktop-only records between desktops but never offers them to iOS", async () => {
    const uploaded: PendingBatch[] = [];
    const transport: Transport = {
      pull: async () => ({ batches: [] as PulledBatch[], listed: [], stale: false }),
      push: async (b) => void uploaded.push(b),
    };
    const a = adapter();
    a.apply(changes(fixture.desktop));
    const state = { ...emptyState("0".repeat(32)), merged: true };
    let n = 0;
    const ctx = { deviceId: "d".repeat(32), platform: "desktop", now: () => "", newId: () => (n++).toString(16).padStart(32, "0") };
    await runSync(state, a, transport, ctx, async () => {});
    const scopes = new Set(uploaded.map((b) => b.scope));
    expect(scopes).toEqual(new Set(["shared", "desktop"]));
    const desktopKinds = new Set(Object.keys(fixture.desktop).map((rid) => rid.slice("desktop|".length).split(":")[0]));
    for (const b of uploaded) {
      for (const r of b.body.records) expect(desktopKinds.has(r.key.split(":")[0])).toBe(b.scope === "desktop");
    }
  });

  describe("report records", () => {
    const srcRid = "desktop|reportSource:cloud-1:ws-1:src-1";
    const repRid = "desktop|report:cloud-1:ws-1:rep-1";

    it("never syncs identity mappings, results or the last opened report", () => {
      const a = adapter();
      a.apply(changes({ [srcRid]: fixture.desktop[srcRid], [repRid]: fixture.desktop[repRid] }));
      useReports.getState().setMapping("src-1", "7", "Jane Student", "STU-12");
      useReports.getState().setLastReport("rep-1");
      const text = JSON.stringify(Object.fromEntries(a.project()));
      for (const banned of ["Jane Student", "STU-12", "mappings", "lastReportId", "rows", "runId", "softDelete"]) expect(text).not.toContain(banned);
      expect(a.project().get(srcRid)).toEqual(fixture.desktop[srcRid]);
    });

    it("defers report records from another workspace and only projects the connected one", () => {
      const a = adapter();
      const other = "desktop|report:cloud-1:ws-2:rep-9";
      expect(a.isManaged(other)).toBe(false);
      expect(a.apply(changes({ [other]: fixture.desktop[repRid] }))).toEqual([{ status: "deferred" }]);
      expect(useReports.getState().reports).toEqual([]);
    });

    it("rejects reports with unsafe or unsupported queries", () => {
      const a = adapter();
      const report = fixture.desktop[repRid] as { spec: Record<string, Json> };
      const bad = a.apply(changes({
        [repRid]: { ...report, spec: { ...report.spec, v: 2 } },
        "desktop|report:cloud-1:ws-1:rep-2": { ...report, spec: { ...report.spec, filter: { kind: "condition", field: "x", op: "__raw" } } },
        "desktop|reportSource:cloud-1:ws-1:src-2": { ...(fixture.desktop[srcRid] as object), objectTypeIds: [] },
      }));
      expect(bad.map((r) => r.status)).toEqual(["invalid", "invalid", "invalid"]);
      expect(useReports.getState().reports).toEqual([]);
      expect(useReports.getState().sources).toEqual([]);
    });

    it("keeps reports when their source is deleted remotely", () => {
      const a = adapter();
      a.apply(changes({ [srcRid]: fixture.desktop[srcRid], [repRid]: fixture.desktop[repRid] }));
      a.apply([{ rid: srcRid, value: undefined, parents: [] }]);
      expect(useReports.getState().sources).toEqual([]);
      expect(useReports.getState().reports.map((r) => r.id)).toEqual(["rep-1"]);
    });
  });
});
