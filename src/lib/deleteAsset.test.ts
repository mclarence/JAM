import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assetsApi } from "@/api/assets";
import { ApiError, connectionApi } from "@/api/client";
import { captureMutationContext, reconcileAssetPage, removeDeletedAsset, resetMutationCaches } from "@/api/mutationCache";
import { qk } from "@/api/queryKeys";
import { AttrType, DefaultType, type AqlResult, type AssetObject, type ConnectionInfo, type ObjectTypeAttribute } from "@/api/types";
import { useSettings } from "@/store/settings";
import { useUi } from "@/store/ui";
import { deleteAsset, deleteAssets } from "./deleteAsset";
import { deletionScope, type DeletionConfig } from "./deletion";
import { beginAssetMutation } from "./ruleMutations";

const connection: ConnectionInfo = { cloudId: "cloud", workspaceId: "workspace", siteUrl: "https://example.invalid", email: "test@example.invalid" };
const marker: ObjectTypeAttribute = { id: "10", name: "Asset Tag", type: 0, defaultType: { id: DefaultType.Text, name: "Text" } };
const room: ObjectTypeAttribute = { id: "11", name: "Room", type: 0, defaultType: { id: DefaultType.Text, name: "Text" } };
const object: AssetObject = {
  id: "1", objectKey: "DEV-1", label: "Device", objectType: { id: "2", name: "Devices", objectSchemaId: "3" },
  created: "", updated: "", attributes: [{ objectTypeAttributeId: "10", objectAttributeValues: [{ value: "DEV001" }] }],
};
const config: DeletionConfig = { method: "soft", marker: { attributeId: "10", attributeName: "Asset Tag", value: { raw: "DELETED", display: "DELETED" } } };
const scope = deletionScope(connection, "2");
const page: AqlResult = { values: [object], startAt: 0, maxResults: 100, isLast: false, total: 10 };
const key = qk.objects("objectTypeId = 2");
let qc: QueryClient;
let input: Parameters<typeof deleteAsset>[0];

beforeEach(() => {
  qc = new QueryClient();
  qc.setQueryData(qk.connection, connection);
  qc.setQueryData<InfiniteData<AqlResult>>(key, { pages: [page], pageParams: [0] });
  qc.setQueryData(qk.object("1"), object);
  useUi.setState({ staleAssets: {} });
  useSettings.setState({ deletions: { [scope]: config }, rules: [] });
  vi.spyOn(connectionApi, "get").mockResolvedValue(connection);
  vi.spyOn(assetsApi, "getObject").mockResolvedValue(object);
  vi.spyOn(assetsApi, "getObjectTypeAttributes").mockResolvedValue([marker, room]);
  vi.spyOn(assetsApi, "updateObject").mockResolvedValue(object);
  vi.spyOn(assetsApi, "deleteObject").mockResolvedValue(undefined);
  input = { object, config, connection, isCurrent: captureMutationContext(qc) };
});
afterEach(() => { qc.clear(); useSettings.setState({ deletions: {}, rules: [] }); useUi.setState({ staleAssets: {} }); vi.restoreAllMocks(); });

describe("confirmed asset deletion", () => {
  it("sends a real DELETE, never a PUT, for permanent deletion", async () => {
    const permanent = { ...config, method: "permanent" as const };
    useSettings.getState().setDeletion(scope, permanent);
    await deleteAsset({ ...input, config: permanent });
    expect(assetsApi.deleteObject).toHaveBeenCalledWith("1");
    expect(assetsApi.updateObject).not.toHaveBeenCalled();
  });
  it.each([401, 403])("reports permission errors (%s) with no fallback or local removal", async (status) => {
    const permanent = { ...config, method: "permanent" as const };
    useSettings.getState().setDeletion(scope, permanent);
    vi.mocked(assetsApi.deleteObject).mockRejectedValue(new ApiError("Forbidden", "http", status));
    await expect(deleteAsset({ ...input, config: permanent })).rejects.toThrow("permission");
    expect(assetsApi.updateObject).not.toHaveBeenCalled();
    expect(qc.getQueryData(qk.object("1"))).toEqual(object);
    expect(reconcileAssetPage(qc, page).values).toEqual([object]);
    const release = beginAssetMutation("1"); release();
  });
  it("atomically writes marker and arbitrary additional attribute without edit rules", async () => {
    const extra = { ...config, additional: { attributeId: "11", attributeName: "Room", value: { raw: "Retired storage", display: "" } } };
    useSettings.getState().setDeletion(scope, extra);
    await deleteAsset({ ...input, config: extra });
    expect(assetsApi.updateObject).toHaveBeenCalledExactlyOnceWith("1", {
      objectTypeId: "2", attributes: [
        { objectTypeAttributeId: "10", objectAttributeValues: [{ value: "DELETED" }] },
        { objectTypeAttributeId: "11", objectAttributeValues: [{ value: "Retired storage" }] },
      ],
    });
    expect(assetsApi.deleteObject).not.toHaveBeenCalled();
  });
  it("does not remove rows while pending or after a failed write; releases the mutation lock", async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(assetsApi.updateObject).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const pending = deleteAsset(input);
    await vi.waitFor(() => expect(assetsApi.updateObject).toHaveBeenCalled());
    expect(reconcileAssetPage(qc, page).values).toEqual([object]);
    expect(() => beginAssetMutation("1")).toThrow("already");
    reject(new Error("Jira rejected marker"));
    await expect(pending).rejects.toThrow("Jira rejected marker");
    expect(reconcileAssetPage(qc, page).values).toEqual([object]);
    const release = beginAssetMutation("1"); release();
  });
  it("validates fresh metadata before writing, rejecting readonly markers and marker conflicts", async () => {
    vi.mocked(assetsApi.getObjectTypeAttributes).mockResolvedValue([{ ...marker, editable: false }]);
    await expect(deleteAsset(input)).rejects.toThrow("editable");
    expect(assetsApi.updateObject).not.toHaveBeenCalled();
    vi.mocked(assetsApi.getObjectTypeAttributes).mockResolvedValue([marker]);
    const conflict = { ...config, additional: config.marker };
    useSettings.getState().setDeletion(scope, conflict);
    await expect(deleteAsset({ ...input, config: conflict })).rejects.toThrow("overwrite");
    expect(assetsApi.updateObject).not.toHaveBeenCalled();
  });
  it("validates permitted status choices and reference identities", async () => {
    const status: ObjectTypeAttribute = { id: "11", name: "State", type: AttrType.Status, typeValueMulti: ["retired"] };
    const extra = { ...config, additional: { attributeId: "11", attributeName: "State", value: { raw: "active", display: "Active" } } };
    useSettings.getState().setDeletion(scope, extra);
    vi.spyOn(assetsApi, "listStatusTypes").mockResolvedValue([{ id: "active", name: "Active", category: 1 }]);
    vi.mocked(assetsApi.getObjectTypeAttributes).mockResolvedValue([marker, status]);
    await expect(deleteAsset({ ...input, config: extra })).rejects.toThrow("status");
    const reference = { ...extra, additional: { ...extra.additional, value: { raw: "ROOM-2", display: "Room", referenceId: "9" } } };
    useSettings.getState().setDeletion(scope, reference);
    vi.mocked(assetsApi.getObjectTypeAttributes).mockResolvedValue([marker, { id: "11", name: "Room", type: 1, referenceObjectTypeId: "4" }]);
    vi.mocked(assetsApi.getObject).mockImplementation(async (id) => id === "1" ? object : { ...object, id: "9", objectKey: "ROOM-CHANGED" });
    await expect(deleteAsset({ ...input, config: reference })).rejects.toThrow("reference changed");
    expect(assetsApi.updateObject).not.toHaveBeenCalled();
  });
  it("rejects connection/config changes before writing", async () => {
    vi.mocked(connectionApi.get).mockResolvedValue({ ...connection, workspaceId: "other" });
    await expect(deleteAsset(input)).rejects.toThrow("connection changed");
    vi.mocked(connectionApi.get).mockResolvedValue(connection);
    useSettings.getState().setDeletion(scope, { method: "permanent" });
    await expect(deleteAsset(input)).rejects.toThrow("settings changed");
    expect(assetsApi.updateObject).not.toHaveBeenCalled();
    expect(assetsApi.deleteObject).not.toHaveBeenCalled();
  });
  it("removes confirmed rows/details and suppresses stale search responses without breaking server offsets", async () => {
    await deleteAsset(input);
    removeDeletedAsset(qc, "1");
    expect(qc.getQueryData<InfiniteData<AqlResult>>(key)?.pages[0].values).toEqual([]);
    expect(qc.getQueryData(qk.object("1"))).toBeUndefined();
    expect(reconcileAssetPage(qc, page)).toMatchObject({ values: [], nextStartAt: 1 });
    resetMutationCaches(qc);
    expect(reconcileAssetPage(qc, page).values).toEqual([object]);
  });
});

describe("bulk asset deletion", () => {
  const permanent = { ...config, method: "permanent" as const };
  const many = (count: number) => Array.from({ length: count }, (_, i) => ({ ...object, id: String(i + 1), objectKey: `DEV-${i + 1}` }));
  beforeEach(() => useSettings.getState().setDeletion(scope, permanent));

  it("continues after individual failures and reports them in selection order", async () => {
    vi.mocked(assetsApi.deleteObject).mockImplementation(async (id) => {
      if (id === "2" || id === "5") throw new ApiError("Forbidden", "http", 403);
    });
    const progress: number[] = [];
    const result = await deleteAssets({
      objects: many(6), typeId: "2", config: permanent, connection, isCurrent: input.isCurrent, onProgress: (done) => progress.push(done),
    });
    expect(result.deleted.map((o) => o.id).sort()).toEqual(["1", "3", "4", "6"]);
    expect(result.failures.map((f) => f.object.id)).toEqual(["2", "5"]);
    expect(result.failures[0].error).toContain("permission");
    expect(progress).toEqual([1, 2, 3, 4, 5, 6]);
    expect(assetsApi.updateObject).not.toHaveBeenCalled();
  });

  it("retries rate limits with backoff", async () => {
    vi.mocked(assetsApi.deleteObject).mockRejectedValueOnce(new ApiError("Too many requests", "http", 429));
    const sleep = vi.fn(async () => {});
    const result = await deleteAssets({ objects: [object], typeId: "2", config: permanent, connection, isCurrent: input.isCurrent, sleep });
    expect(result.failures).toEqual([]);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(assetsApi.deleteObject).toHaveBeenCalledTimes(2);
  });

  it("refuses objects of a different type without contacting Jira", async () => {
    const other = { ...object, objectType: { ...object.objectType, id: "9" } };
    const result = await deleteAssets({ objects: [other], typeId: "2", config: permanent, connection, isCurrent: input.isCurrent });
    expect(result.failures[0].error).toContain("different object type");
    expect(assetsApi.deleteObject).not.toHaveBeenCalled();
  });

  it("soft deletes every object with the configured marker", async () => {
    useSettings.getState().setDeletion(scope, config);
    vi.mocked(assetsApi.getObject).mockImplementation(async (id) => ({ ...object, id }));
    const result = await deleteAssets({ objects: many(3), typeId: "2", config, connection, isCurrent: input.isCurrent });
    expect(result.failures).toEqual([]);
    expect(vi.mocked(assetsApi.updateObject).mock.calls.map(([id, body]) => [id, body.attributes])).toEqual(["1", "2", "3"].map((id) => [id, [
      { objectTypeAttributeId: "10", objectAttributeValues: [{ value: "DELETED" }] },
    ]]));
    expect(assetsApi.deleteObject).not.toHaveBeenCalled();
  });
});
