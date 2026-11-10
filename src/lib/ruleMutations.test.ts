import { afterEach, describe, expect, it, vi } from "vitest";
import { assetsApi } from "@/api/assets";
import { connectionApi } from "@/api/client";
import { AttrType, type AssetObject, type ConnectionInfo, type ObjectTypeAttribute, type StatusType } from "@/api/types";
import { createPrepared, plannedChangeDescriptions, prepareCreate, prepareUpdate, updatePrepared } from "./ruleMutations";
import type { Rule, RuleOperation } from "./rules";

const connection: ConnectionInfo = { cloudId: "cloud", workspaceId: "workspace", siteUrl: "https://example.atlassian.net", email: "user@example.test" };
const attributes: ObjectTypeAttribute[] = [
  { id: "room", name: "Room", type: AttrType.ObjectReference },
  { id: "status", name: "Status", type: AttrType.Status },
];
const statuses: StatusType[] = [{ id: "active", name: "Active", category: 1 }];
const baseline: AssetObject = {
  id: "1", objectKey: "ASSET-1", label: "Asset", objectType: { id: "type", name: "Asset", objectSchemaId: "schema" },
  created: "", updated: "", attributes: [],
};
const manual = { objectTypeAttributeId: "room", objectAttributeValues: [{ value: "ROOM-1" }] };
const automatic = { objectTypeAttributeId: "status", objectAttributeValues: [{ value: "active" }] };
const rule: Rule = {
  id: "rule", name: "Activate", enabled: true, cloudId: "cloud", workspaceId: "workspace", schemaId: "schema", objectTypeId: "type",
  operations: ["edit", "batch", "scan", "create"], watchedAttributeIds: ["room"], match: "any",
  conditions: [{ id: "condition", attributeId: "room", operator: "isSet" }],
  actions: [{ id: "action", attributeId: "status", value: { raw: "active", display: "Active" } }],
};
const clearRule: Rule = { ...rule, actions: [{ id: "clear", attributeId: "status", mode: "clear" }] };
const populated = { ...baseline, attributes: [{ objectTypeAttributeId: "status", objectAttributeValues: [{ status: statuses[0] }] }] };

function setup() {
  vi.spyOn(connectionApi, "get").mockResolvedValue(connection);
  vi.spyOn(assetsApi, "getObjectTypeAttributes").mockResolvedValue(attributes);
  vi.spyOn(assetsApi, "getObjectType").mockResolvedValue(baseline.objectType);
  vi.spyOn(assetsApi, "listStatusTypes").mockResolvedValue(statuses);
}

afterEach(() => vi.restoreAllMocks());

describe("rule-aware mutations", () => {
  it.each(["edit", "batch", "scan"] as const)("merges %s rules into one write and reloads an incomplete response", async (operation) => {
    setup();
    const saved: AssetObject = { ...baseline, attributes: [
      { objectTypeAttributeId: "room", objectAttributeValues: [{ value: "ROOM-1" }] },
      { objectTypeAttributeId: "status", objectAttributeValues: [{ status: statuses[0] }] },
    ] };
    vi.spyOn(assetsApi, "getObject").mockResolvedValueOnce(baseline).mockResolvedValueOnce(saved);
    const write = vi.spyOn(assetsApi, "updateObject").mockResolvedValue({ ...baseline, attributes: [] });
    const prepared = await prepareUpdate({
      object: baseline, operation, rules: [rule], attributes, connection,
      buildChanges: () => ({ payload: [manual], changes: ["Room → ROOM-1"] }),
    });
    const result = await updatePrepared(prepared);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("1", { objectTypeId: "type", attributes: [manual, automatic] });
    expect(result.object).toEqual(saved);
    expect(result.didWrite).toBe(true);
  });

  it("uses an empty baseline for creation and sends one merged create", async () => {
    setup();
    const saved = { ...baseline, attributes: [{ objectTypeAttributeId: "status", objectAttributeValues: [{ status: statuses[0] }] }] };
    const get = vi.spyOn(assetsApi, "getObject").mockResolvedValue(saved);
    const create = vi.spyOn(assetsApi, "createObject").mockResolvedValue({ ...baseline, attributes: [] });
    const prepared = await prepareCreate({ body: { objectTypeId: "type", attributes: [manual] }, rules: [rule], attributes, connection });
    const result = await createPrepared(prepared);
    expect(create).toHaveBeenCalledWith({ objectTypeId: "type", attributes: [manual, automatic] });
    expect(create).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(result.object).toEqual(saved);
  });

  it("does not fetch rule metadata or an extra baseline without applicable rules", async () => {
    const get = vi.spyOn(assetsApi, "getObject");
    const metadata = vi.spyOn(assetsApi, "getObjectTypeAttributes");
    const write = vi.spyOn(assetsApi, "updateObject").mockResolvedValue(baseline);
    const prepared = await prepareUpdate({
      object: baseline, operation: "edit", rules: [], attributes,
      buildChanges: () => ({ payload: [manual], changes: [] }),
    });
    await updatePrepared(prepared);
    expect(get).not.toHaveBeenCalled();
    expect(metadata).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("does not send an unchanged write after reloading the baseline", async () => {
    setup();
    vi.spyOn(assetsApi, "getObject").mockResolvedValue({
      ...baseline, attributes: [{ objectTypeAttributeId: "room", objectAttributeValues: [{ value: "ROOM-1" }] }],
    });
    const write = vi.spyOn(assetsApi, "updateObject");
    const prepared = await prepareUpdate({
      object: baseline, operation: "scan", rules: [rule], attributes, connection,
      buildChanges: () => ({ payload: [manual], changes: [] }),
    });
    expect((await updatePrepared(prepared)).didWrite).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it.each([rule, clearRule])("reports a refresh failure separately from a successful $actions.0.mode write", async (config) => {
    setup();
    vi.spyOn(assetsApi, "getObject").mockResolvedValueOnce(populated).mockRejectedValueOnce(new Error("offline"));
    const write = vi.spyOn(assetsApi, "updateObject").mockResolvedValue(baseline);
    const prepared = await prepareUpdate({
      object: baseline, operation: "edit", rules: [config], attributes, connection,
      buildChanges: () => ({ payload: [manual], changes: [] }),
    });
    const result = await updatePrepared(prepared);
    expect(write).toHaveBeenCalledTimes(1);
    expect(result.didWrite).toBe(true);
    expect(result.object).toBeUndefined();
    expect(result.refreshWarning).toContain("save succeeded");
  });

  it("reports a mismatched refresh instead of publishing a different asset", async () => {
    setup();
    vi.spyOn(assetsApi, "getObject").mockResolvedValueOnce(baseline).mockResolvedValueOnce({ ...baseline, id: "other" });
    vi.spyOn(assetsApi, "updateObject").mockResolvedValue(baseline);
    const prepared = await prepareUpdate({
      object: baseline, operation: "edit", rules: [rule], attributes, connection,
      buildChanges: () => ({ payload: [manual], changes: [] }),
    });
    const result = await updatePrepared(prepared);
    expect(result.didWrite).toBe(true);
    expect(result.object).toBeUndefined();
    expect(result.refreshWarning).toContain("did not match");
  });

  it("blocks invalid rules and connection changes before the write", async () => {
    setup();
    vi.spyOn(assetsApi, "getObject").mockResolvedValue(baseline);
    const write = vi.spyOn(assetsApi, "updateObject");
    const invalid = { ...rule, watchedAttributeIds: ["deleted"] };
    const prepare = (rules: Rule[], operation: Exclude<RuleOperation, "create"> = "edit") => prepareUpdate({
      object: baseline, operation, rules, attributes, connection,
      buildChanges: () => ({ payload: [manual], changes: [] }),
    });
    await expect(prepare([invalid])).rejects.toThrow("Watched attribute deleted");
    const prepared = await prepare([rule]);
    vi.mocked(connectionApi.get).mockResolvedValue({ ...connection, workspaceId: "other" });
    await expect(updatePrepared(prepared)).rejects.toThrow("connection changed");
    expect(write).not.toHaveBeenCalled();
  });

  it("does not write a prepared update or creation after the connection context is reset", async () => {
    let current = true;
    const isCurrent = () => current;
    const write = vi.spyOn(assetsApi, "updateObject");
    const create = vi.spyOn(assetsApi, "createObject");
    const preparedUpdate = await prepareUpdate({
      object: baseline, operation: "edit", rules: [], attributes, isCurrent,
      buildChanges: () => ({ payload: [manual], changes: [] }),
    });
    const preparedCreate = await prepareCreate({
      body: { objectTypeId: "type", attributes: [manual] }, rules: [], attributes, isCurrent,
    });
    current = false;
    await expect(updatePrepared(preparedUpdate)).rejects.toThrow("connection changed");
    await expect(createPrepared(preparedCreate)).rejects.toThrow("connection changed");
    expect(write).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("does not block a save for invalid disabled or differently scoped rules", async () => {
    setup();
    const write = vi.spyOn(assetsApi, "updateObject").mockResolvedValue(baseline);
    const disabled = { ...rule, enabled: false, actions: [] };
    const otherWorkspace = { ...rule, id: "other", workspaceId: "other", conditions: [] };
    const prepared = await prepareUpdate({
      object: baseline, operation: "edit", rules: [disabled, otherWorkspace], attributes, connection,
      buildChanges: () => ({ payload: [manual], changes: [] }),
    });
    await updatePrepared(prepared);
    expect(prepared.hasApplicableRules).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(assetsApi.getObjectTypeAttributes).not.toHaveBeenCalled();
  });

  it("rejects incomplete baselines and warns on incomplete post-write reloads", async () => {
    setup();
    const incomplete = JSON.parse(JSON.stringify({ ...baseline, attributes: undefined })) as AssetObject;
    const get = vi.spyOn(assetsApi, "getObject").mockResolvedValueOnce(incomplete);
    const write = vi.spyOn(assetsApi, "updateObject").mockResolvedValue(baseline);
    const prepare = () => prepareUpdate({
      object: baseline, operation: "edit", rules: [rule], attributes, connection,
      buildChanges: () => ({ payload: [manual], changes: [] }),
    });
    await expect(prepare()).rejects.toThrow("did not include its attributes");
    expect(write).not.toHaveBeenCalled();
    get.mockResolvedValueOnce(baseline).mockResolvedValueOnce(incomplete);
    const result = await updatePrepared(await prepare());
    expect(result.didWrite).toBe(true);
    expect(result.object).toBeUndefined();
    expect(result.refreshWarning).toContain("save succeeded");
    expect(result.refreshWarning).toContain("did not include its attributes");
  });

  it("blocks creation if the rule's object type has moved to another schema", async () => {
    setup();
    vi.mocked(assetsApi.getObjectType).mockResolvedValue({ ...baseline.objectType, objectSchemaId: "other" });
    const create = vi.spyOn(assetsApi, "createObject");
    await expect(prepareCreate({
      body: { objectTypeId: "type", attributes: [manual] }, rules: [rule], attributes, connection,
    })).rejects.toThrow('Rule "Activate": The object type no longer belongs');
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects references whose stored key and ID no longer match", async () => {
    setup();
    vi.spyOn(assetsApi, "getObject")
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce({ ...baseline, id: "20", objectKey: "ROOM-CHANGED" });
    const write = vi.spyOn(assetsApi, "updateObject");
    const referenceRule: Rule = {
      ...rule, actions: [{ id: "reference", attributeId: "room", value: { raw: "ROOM-20", display: "Lab", referenceId: "20" } }],
    };
    await expect(prepareUpdate({
      object: baseline, operation: "edit", rules: [referenceRule], attributes, connection,
      buildChanges: () => ({ payload: [manual], changes: [] }),
    })).rejects.toThrow('Choose the object for "Room" again');
    expect(write).not.toHaveBeenCalled();
  });

  it.each(["edit", "batch", "scan"] as const)("merges a %s clear into one write and reloads the cleared object", async (operation) => {
    setup();
    const saved = { ...baseline, attributes: [manual] };
    vi.spyOn(assetsApi, "getObject").mockResolvedValueOnce(populated).mockResolvedValueOnce(saved);
    const write = vi.spyOn(assetsApi, "updateObject").mockResolvedValue({ ...populated, attributes: [] });
    const prepared = await prepareUpdate({
      object: populated, operation, rules: [clearRule], attributes, connection,
      buildChanges: () => ({ payload: [manual], changes: ["Room → ROOM-1"] }),
    });
    expect(plannedChangeDescriptions(prepared)).toEqual(["Room → ROOM-1", "Status cleared (rule: Activate)"]);
    const result = await updatePrepared(prepared);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("1", {
      objectTypeId: "type", attributes: [manual, { objectTypeAttributeId: "status", objectAttributeValues: [] }],
    });
    expect(result.object).toEqual(saved);
    expect(result.authoritative).toBe(true);
  });

  it.each([false, true])("sends an explicit creation clear when the target was manually supplied: %s", async (supplied) => {
    setup();
    const saved = { ...baseline, attributes: [manual] };
    vi.spyOn(assetsApi, "getObject").mockResolvedValue(saved);
    const write = vi.spyOn(assetsApi, "createObject").mockResolvedValue(baseline);
    const prepared = await prepareCreate({
      body: { objectTypeId: "type", attributes: supplied ? [manual, automatic] : [manual] },
      rules: [clearRule], attributes, connection,
    });
    expect((await createPrepared(prepared)).object).toEqual(saved);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({
      objectTypeId: "type", attributes: [manual, { objectTypeAttributeId: "status", objectAttributeValues: [] }],
    });
  });

  it.each(["edit", "batch", "scan", "create"] as const)("rejects a newly required clear target before a %s write", async (operation) => {
    setup();
    vi.mocked(assetsApi.getObjectTypeAttributes).mockResolvedValue(attributes.map((attribute) =>
      attribute.id === "status" ? { ...attribute, minimumCardinality: 1 } : attribute));
    vi.spyOn(assetsApi, "getObject").mockResolvedValue(populated);
    const update = vi.spyOn(assetsApi, "updateObject");
    const create = vi.spyOn(assetsApi, "createObject");
    const prepare = operation === "create"
      ? prepareCreate({ body: { objectTypeId: "type", attributes: [manual] }, rules: [clearRule], attributes, connection })
      : prepareUpdate({
        object: populated, operation, rules: [clearRule], attributes, connection,
        buildChanges: () => ({ payload: [manual], changes: [] }),
      });
    await expect(prepare).rejects.toThrow('Rule "Activate": "Status" is required and cannot be cleared.');
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("clears a reference without looking up its previous value", async () => {
    setup();
    const saved = { ...baseline, attributes: [automatic] };
    const get = vi.spyOn(assetsApi, "getObject").mockResolvedValueOnce({ ...baseline, attributes: [manual] }).mockResolvedValueOnce(saved);
    vi.spyOn(assetsApi, "updateObject").mockResolvedValue(baseline);
    const config: Rule = {
      ...clearRule, watchedAttributeIds: ["status"], conditions: [{ id: "status-set", attributeId: "status", operator: "isSet" }],
      actions: [{ id: "clear-reference", attributeId: "room", mode: "clear" }],
    };
    const prepared = await prepareUpdate({
      object: baseline, operation: "edit", rules: [config], attributes, connection,
      buildChanges: () => ({ payload: [automatic], changes: [] }),
    });
    await updatePrepared(prepared);
    expect(prepared.plan.payload).toEqual([automatic, { objectTypeAttributeId: "room", objectAttributeValues: [] }]);
    expect(get.mock.calls).toEqual([["1"], ["1"]]);
  });
});
