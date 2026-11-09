import { afterEach, describe, expect, it, vi } from "vitest";
import { assetsApi } from "@/api/assets";
import { ApiError, connectionApi } from "@/api/client";
import { AttrType, type AssetObject, type ConnectionInfo, type ObjectTypeAttribute, type StatusType } from "@/api/types";
import { useUi } from "@/store/ui";
import { beginAssetMutation } from "./ruleMutations";
import { runBatch } from "./batchUpdate";
import type { Rule } from "./rules";
import type { ScanAction } from "@/store/quickScan";

const connection: ConnectionInfo = {
  cloudId: "cloud", workspaceId: "workspace", siteUrl: "https://example.atlassian.net", email: "test@example.invalid",
};
const attributes: ObjectTypeAttribute[] = [
  { id: "room", name: "Room", type: AttrType.Default },
  { id: "status", name: "Status", type: AttrType.Status },
];
const statuses: StatusType[] = [{ id: "active", name: "Active", category: 1 }];
const actions: ScanAction[] = [{ id: "manual", attrId: "room", mode: "set", value: "Lab", display: "Lab" }];
const rule: Rule = {
  id: "activate", name: "Activate", enabled: true, cloudId: "cloud", workspaceId: "workspace", schemaId: "schema",
  objectTypeId: "type", operations: ["batch"], watchedAttributeIds: ["room"], match: "any",
  conditions: [{ id: "condition", attributeId: "room", operator: "isSet" }],
  actions: [{ id: "action", attributeId: "status", value: { raw: "active", display: "Active" } }],
};
const object = (id: string, room = "Old"): AssetObject => ({
  id, objectKey: `ASSET-${id}`, label: id, objectType: { id: "type", name: "Asset", objectSchemaId: "schema" },
  created: "", updated: "", attributes: [{ objectTypeAttributeId: "room", objectAttributeValues: [{ value: room }] }],
});

afterEach(() => {
  useUi.setState({ staleAssets: {} });
  vi.restoreAllMocks();
});

describe("rule-aware batch updates", () => {
  it("freezes the merged payload across rate-limit retries and continues other jobs", async () => {
    vi.spyOn(connectionApi, "get").mockResolvedValue(connection);
    vi.spyOn(assetsApi, "getObjectTypeAttributes").mockResolvedValue(attributes);
    vi.spyOn(assetsApi, "listStatusTypes").mockResolvedValue(statuses);
    const attempts: Record<string, number> = {};
    const get = vi.spyOn(assetsApi, "getObject").mockImplementation(async (id) => object(id, (attempts[id] ?? 0) > 1 ? "Lab" : "Old"));
    const write = vi.spyOn(assetsApi, "updateObject").mockImplementation(async (id) => {
      attempts[id] = (attempts[id] ?? 0) + 1;
      if (id === "fail") throw new ApiError("Forbidden", "http", 403);
      if (attempts[id] === 1) throw new ApiError("Rate limited", "http", 429);
      return { ...object(id), attributes: [] };
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const progress: number[] = [];
    let lockedDuringPublication = false;
    let lockedDuringReconciliation = false;
    const onUnconfirmed = vi.fn(async (id: string) => {
      try {
        const release = beginAssetMutation(id);
        release();
      } catch {
        lockedDuringReconciliation = true;
      }
    });
    const jobs = [object("retry"), object("fail")].map((item) => ({ object: item, payload: [] }));
    const batch = await runBatch(jobs, (done) => progress.push(done), {
      rules: [rule], attributes, actions, connection, sleep,
      onResult: (item) => {
        try {
          const release = beginAssetMutation(item.objectId);
          release();
        } catch {
          lockedDuringPublication = true;
        }
      },
      onUnconfirmed,
    });

    expect(batch.updated).toBe(1);
    expect(batch.failures.map((failure) => failure.job.object.id)).toEqual(["fail"]);
    expect(progress).toEqual([1, 2]);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(write.mock.calls.filter(([id]) => id === "retry").map(([, body]) => body)).toEqual([
      { objectTypeId: "type", attributes: [
        { objectTypeAttributeId: "room", objectAttributeValues: [{ value: "Lab" }] },
        { objectTypeAttributeId: "status", objectAttributeValues: [{ value: "active" }] },
      ] },
      { objectTypeId: "type", attributes: [
        { objectTypeAttributeId: "room", objectAttributeValues: [{ value: "Lab" }] },
        { objectTypeAttributeId: "status", objectAttributeValues: [{ value: "active" }] },
      ] },
    ]);
    expect(get.mock.calls.filter(([id]) => id === "retry")).toHaveLength(2);
    expect(lockedDuringPublication).toBe(true);
    expect(onUnconfirmed).toHaveBeenCalledWith("fail");
    expect(lockedDuringReconciliation).toBe(true);
  });

  it("does not turn a successful write into a failed job if publishing throws", async () => {
    vi.spyOn(connectionApi, "get").mockResolvedValue(connection);
    vi.spyOn(assetsApi, "updateObject").mockResolvedValue(object("1", "Lab"));
    const batch = await runBatch([{ object: object("1"), payload: [] }], () => {}, {
      rules: [], attributes, actions, connection,
      onResult: () => { throw new Error("render failure"); },
    });
    expect(batch.updated).toBe(1);
    expect(batch.failures).toEqual([]);
    expect(batch.results[0].publicationWarning).toContain("save succeeded");
    expect(batch.results[0].publicationWarning).toContain("render failure");
  });
});
