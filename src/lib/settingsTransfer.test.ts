import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Rule } from "./rules";
import type { Section } from "./settingsTransfer";
import { deletionScope } from "./deletion";

vi.mock("@/store/theme", () => ({
  useThemeStore: { getState: () => ({ pref: "system", setPref: vi.fn() }) },
}));

const data = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => data.set(key, value),
  removeItem: (key: string) => data.delete(key),
});

const { applyImport, buildExport, parseImport, sectionCounts } = await import("./settingsTransfer");
const { useSettings } = await import("@/store/settings");
const selected = new Set<Section>(["rules"]);

function rule(id: string): Rule {
  return {
    id, name: id, enabled: true, cloudId: "cloud", workspaceId: "workspace", schemaId: "schema", objectTypeId: "type",
    operations: ["edit", "batch"], watchedAttributeIds: ["room"], match: "any",
    conditions: [{ id: `${id}-condition`, attributeId: "room", operator: "isSet" }],
    actions: [{ id: `${id}-action`, attributeId: "status", mode: "set", value: { raw: "active", display: "Active" } }],
  };
}

describe("Rules settings transfer and persistence", () => {
  beforeEach(() => {
    data.clear();
    useSettings.setState({ rules: [], deletions: {} });
  });

  it("persists and transfers deletion settings without losing workspace scope or retained markers", async () => {
    const scope = deletionScope({ cloudId: "cloud", workspaceId: "workspace" }, "1");
    const config = { method: "permanent" as const, marker: { attributeId: "10", attributeName: "Asset Tag", value: { raw: "DELETED", display: "" } } };
    useSettings.getState().setDeletion(scope, config);
    const saved = data.get("settings")!;
    const bundle = parseImport(buildExport());
    expect(sectionCounts(bundle).deletions).toBe(1);
    useSettings.setState({ deletions: {} });
    data.set("settings", saved);
    await useSettings.persist.rehydrate();
    expect(useSettings.getState().deletions[scope]).toEqual(config);
    applyImport({ deletions: { [deletionScope({ cloudId: "cloud", workspaceId: "other" }, "1")]: { method: "permanent" } } }, new Set(["deletions"]), "merge");
    expect(Object.keys(useSettings.getState().deletions)).toHaveLength(2);
    applyImport(bundle, new Set(["deletions"]), "replace");
    expect(useSettings.getState().deletions).toEqual({ [scope]: config });
    const older = JSON.parse(buildExport());
    delete older.deletions;
    expect(parseImport(JSON.stringify(older)).deletions).toBeUndefined();
  });

  it("persists ordered rules, exports their count, and restores them", async () => {
    useSettings.getState().saveRule(rule("first"));
    useSettings.getState().saveRule(rule("second"));
    useSettings.getState().swapRules("first", "second");
    const saved = data.get("settings");
    expect(saved).toBeDefined();
    const bundle = parseImport(buildExport());
    expect(sectionCounts(bundle).rules).toBe(2);
    expect(bundle.rules?.map((item) => item.id)).toEqual(["second", "first"]);

    useSettings.setState({ rules: [] });
    data.set("settings", saved!);
    await useSettings.persist.rehydrate();
    expect(useSettings.getState().rules.map((item) => item.id)).toEqual(["second", "first"]);
  });

  it("merges imported rules in their incoming order, replaces only selected sections, and preserves scope", () => {
    useSettings.setState({ rules: [rule("old"), rule("same")] });
    const incoming = [{ ...rule("same"), workspaceId: "other" }, rule("new")];
    applyImport({ rules: incoming }, selected, "merge");
    expect(useSettings.getState().rules.map((item) => item.id)).toEqual(["old", "same", "new"]);
    expect(useSettings.getState().rules[1].workspaceId).toBe("other");
    applyImport({ rules: [rule("replacement")] }, selected, "replace");
    expect(useSettings.getState().rules.map((item) => item.id)).toEqual(["replacement"]);
  });

  it("accepts older settings without rules and rejects malformed rule fragments", async () => {
    data.set("settings", JSON.stringify({ state: { schemaId: "schema" }, version: 1 }));
    await useSettings.persist.rehydrate();
    expect(useSettings.getState().rules).toEqual([]);
    const envelope = (rules: unknown) => JSON.stringify({ format: "jira-assets-manager-settings", version: 1, rules });
    expect(parseImport(JSON.stringify({ format: "jira-assets-manager-settings", version: 1, filters: [] })).rules).toBeUndefined();
    expect(() => parseImport(envelope([{ ...rule("broken"), actions: [] }]))).toThrow("at least one valid action");
    expect(() => parseImport(envelope([{ ...rule("broken"), operations: ["other"] }]))).toThrow("malformed");
    expect(() => parseImport(envelope([rule("duplicate"), rule("duplicate")]))).toThrow("duplicate ID");
  });

  it("persists mixed actions and round-trips clear actions through export, merge and replace", async () => {
    const mixed = rule("mixed");
    mixed.actions.push({ id: "clear-room", attributeId: "room", mode: "clear" });
    useSettings.getState().saveRule(mixed);
    const saved = data.get("settings");
    const bundle = parseImport(buildExport());
    expect(bundle.rules).toEqual([mixed]);
    expect(sectionCounts(bundle).rules).toBe(1);
    useSettings.setState({ rules: [] });
    data.set("settings", saved!);
    await useSettings.persist.rehydrate();
    expect(useSettings.getState().rules).toEqual([mixed]);
    applyImport({ rules: [rule("first")] }, selected, "replace");
    applyImport(bundle, selected, "merge");
    expect(useSettings.getState().rules).toEqual([rule("first"), mixed]);
    applyImport(bundle, selected, "replace");
    expect(useSettings.getState().rules).toEqual([mixed]);
  });

  it("hydrates legacy set actions without a mode and imports them as set actions", async () => {
    const legacy = { ...rule("legacy"), actions: [{ id: "legacy-action", attributeId: "status", value: { raw: "active", display: "Active" } }] };
    data.set("settings", JSON.stringify({ state: { rules: [legacy] }, version: 1 }));
    await useSettings.persist.rehydrate();
    expect(useSettings.getState().rules[0].actions[0].mode ?? "set").toBe("set");
    expect(parseImport(buildExport()).rules).toEqual([rule("legacy")]);
  });
});
