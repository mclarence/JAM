import { QueryClient, QueryObserver, type InfiniteData } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assetsApi } from "./assets";
import { connectionApi } from "./client";
import { qk } from "./queryKeys";
import type { AqlResult, AssetObject, ConnectionInfo } from "./types";
import { applyMutationResult, captureMutationContext, patchAssetCaches, reconcileAssetObject, reconcileAssetPage, refreshLockedAsset, refreshMutationQueries, resetMutationCaches, retryAssetRefresh } from "./mutationCache";
import { beginAssetMutation, type RuleMutationResult } from "@/lib/ruleMutations";
import { notify } from "@/lib/notify";
import { useUi } from "@/store/ui";

vi.mock("@/lib/notify", () => ({ notify: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

const connection: ConnectionInfo = {
  cloudId: "cloud", workspaceId: "workspace", siteUrl: "https://example.atlassian.net", email: "test@example.invalid",
};
const object = (status: string, updated = "2025-01-01T00:00:00Z"): AssetObject => ({
  id: "1", objectKey: "ASSET-1", label: "Asset", objectType: { id: "type", name: "Asset", objectSchemaId: "schema" },
  created: "", updated,
  attributes: [
    { objectTypeAttributeId: "room", objectAttributeValues: [{ value: "Lab" }] },
    { objectTypeAttributeId: "status", objectAttributeValues: [{ value: status }] },
  ],
});
const page = (values: AssetObject[]): AqlResult => ({ startAt: 0, maxResults: 50, total: values.length, isLast: true, values });
const status = (item: AssetObject | undefined) => item?.attributes.find((attribute) => attribute.objectTypeAttributeId === "status")?.objectAttributeValues[0]?.value;
const result = (item: AssetObject): RuleMutationResult => ({
  object: item, objectId: item.id, didWrite: true, authoritative: true, connection,
});

describe("mutation cache reconciliation", () => {
  let qc: QueryClient;
  const listKey = qk.objects("objectTypeId = 1");

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(qk.connection, connection);
    qc.setQueryData<InfiniteData<AqlResult>>(listKey, { pages: [page([object("inactive")])], pageParams: [0] });
    qc.setQueryData(qk.object("1"), object("inactive"));
    vi.spyOn(connectionApi, "get").mockResolvedValue(connection);
    useUi.setState({ staleAssets: {} });
  });

  afterEach(() => {
    qc.clear();
    useUi.setState({ staleAssets: {} });
    vi.restoreAllMocks();
  });

  it("publishes the canonical object to an observed table row and open detail", () => {
    const observedRows: string[] = [];
    const observedDetails: string[] = [];
    const rows = new QueryObserver<InfiniteData<AqlResult>>(qc, { queryKey: listKey, enabled: false });
    const details = new QueryObserver<AssetObject>(qc, { queryKey: qk.object("1"), enabled: false });
    const unsubscribeRows = rows.subscribe((value) => observedRows.push(status(value.data?.pages[0].values[0]) ?? ""));
    const unsubscribeDetails = details.subscribe((value) => observedDetails.push(status(value.data) ?? ""));

    applyMutationResult(qc, result(object("active", "2025-01-02T00:00:00Z")));
    expect(observedRows.at(-1)).toBe("active");
    expect(observedDetails.at(-1)).toBe("active");
    expect(status(qc.getQueryData<InfiniteData<AqlResult>>(listKey)?.pages[0].values[0])).toBe("active");
    expect(status(qc.getQueryData<AssetObject>(qk.object("1")))).toBe("active");
    unsubscribeRows();
    unsubscribeDetails();
  });

  it("overlays stale search/detail responses without adding rows excluded by a filter", () => {
    const saved = object("active", "2025-01-02T00:00:00Z");
    applyMutationResult(qc, result(saved));
    expect(reconcileAssetPage(qc, page([object("inactive")])).values).toEqual([saved]);
    expect(reconcileAssetObject(qc, object("inactive"))).toEqual(saved);
    expect(reconcileAssetPage(qc, page([])).values).toEqual([]);

    const newer = object("retired", "2025-01-03T00:00:00Z");
    expect(reconcileAssetPage(qc, page([newer])).values).toEqual([newer]);
    expect(reconcileAssetObject(qc, object("inactive"))).toEqual(newer);
  });

  it("removes a cleared attribute from observed rows and details even when canonical data omits it", () => {
    const saved = { ...object("active", "2025-01-02T00:00:00Z"), attributes: [object("active").attributes[0]] };
    const rows = new QueryObserver<InfiniteData<AqlResult>>(qc, { queryKey: listKey, enabled: false });
    const details = new QueryObserver<AssetObject>(qc, { queryKey: qk.object("1"), enabled: false });
    const observedRows: (string | undefined)[] = [];
    const observedDetails: (string | undefined)[] = [];
    const unsubscribeRows = rows.subscribe((value) => observedRows.push(status(value.data?.pages[0].values[0])));
    const unsubscribeDetails = details.subscribe((value) => observedDetails.push(status(value.data)));
    applyMutationResult(qc, result(saved));
    expect(observedRows.at(-1)).toBeUndefined();
    expect(observedDetails.at(-1)).toBeUndefined();
    expect(qc.getQueryData(qk.object("1"))).toEqual(saved);
    expect(qc.getQueryData<InfiniteData<AqlResult>>(listKey)?.pages[0].values[0]).toEqual(saved);
    expect(reconcileAssetPage(qc, page([object("inactive")])).values).toEqual([saved]);
    expect(reconcileAssetObject(qc, object("inactive"))).toEqual(saved);
    unsubscribeRows();
    unsubscribeDetails();
  });

  it("does not restore an older save when a delayed list refresh overlaps a newer save", async () => {
    let finish!: () => void;
    const delayed = new Promise<void>((resolve) => { finish = resolve; });
    vi.spyOn(qc, "invalidateQueries").mockImplementation(() => delayed);
    const first = result(object("active", "2025-01-02T00:00:00Z"));
    applyMutationResult(qc, first);
    const refreshing = refreshMutationQueries(qc, [first]);
    const second = result(object("retired", "2025-01-03T00:00:00Z"));
    applyMutationResult(qc, second);
    finish();
    await refreshing;

    expect(status(qc.getQueryData<InfiniteData<AqlResult>>(listKey)?.pages[0].values[0])).toBe("retired");
    expect(status(qc.getQueryData<AssetObject>(qk.object("1")))).toBe("retired");
    expect(status(reconcileAssetPage(qc, page([object("inactive")])).values[0])).toBe("retired");
  });

  it("marks a refresh failure as stale, blocks edits, and clears the warning after retry", async () => {
    const saved = object("active", "2025-01-02T00:00:00Z");
    const invalidation = vi.spyOn(qc, "invalidateQueries").mockRejectedValue(new Error("offline"));
    const published = result(saved);
    applyMutationResult(qc, published);
    await refreshMutationQueries(qc, [published]);
    expect(useUi.getState().staleAssets["1"]).toContain("save succeeded");
    expect(() => beginAssetMutation("1")).toThrow("Refresh this asset");

    invalidation.mockResolvedValue(undefined);
    vi.spyOn(assetsApi, "getObject").mockResolvedValue(saved);
    await retryAssetRefresh(qc, "1");
    expect(useUi.getState().staleAssets["1"]).toBeUndefined();
    expect(status(qc.getQueryData<AssetObject>(qk.object("1")))).toBe("active");
    const release = beginAssetMutation("1");
    release();
  });

  it("serializes manual refreshes with saves for the same asset", async () => {
    const saved = object("active", "2025-01-02T00:00:00Z");
    const get = vi.spyOn(assetsApi, "getObject");
    const release = beginAssetMutation("1");
    await retryAssetRefresh(qc, "1");
    expect(get).not.toHaveBeenCalled();
    expect(notify.error).toHaveBeenCalledWith(expect.any(Error), "Could not refresh asset");
    release();

    let finish!: (value: AssetObject) => void;
    get.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const refresh = retryAssetRefresh(qc, "1");
    expect(() => beginAssetMutation("1")).toThrow("already being updated");
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    finish(saved);
    await refresh;
    expect(status(qc.getQueryData<AssetObject>(qk.object("1")))).toBe("active");
    const later = beginAssetMutation("1");
    later();
  });

  it("ignores an in-flight refresh after reconnecting to the same workspace", async () => {
    let finish!: (value: AssetObject) => void;
    const get = vi.spyOn(assetsApi, "getObject").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const refresh = retryAssetRefresh(qc, "1");
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    resetMutationCaches(qc);
    qc.setQueryData(qk.connection, { ...connection });
    finish(object("active", "2025-01-02T00:00:00Z"));
    await refresh;

    expect(status(qc.getQueryData<AssetObject>(qk.object("1")))).toBe("inactive");
    expect(notify.info).toHaveBeenCalledWith(expect.stringContaining("connection changed"));
  });

  it("does not claim a failed write succeeded when reconciliation cannot refresh the list", async () => {
    vi.spyOn(assetsApi, "getObject").mockResolvedValue(object("inactive"));
    vi.spyOn(qc, "invalidateQueries").mockRejectedValue(new Error("offline"));
    await refreshLockedAsset(qc, "1");
    expect(useUi.getState().staleAssets["1"]).toContain("asset list could not be refreshed");
    expect(useUi.getState().staleAssets["1"]).not.toContain("save succeeded");
  });

  it("preserves unrelated values from partial non-authoritative write responses", () => {
    const partial = { ...object("active"), attributes: [object("active").attributes[1]] };
    patchAssetCaches(qc, partial, false);
    const detail = qc.getQueryData<AssetObject>(qk.object("1"));
    expect(detail?.attributes.map((attribute) => attribute.objectTypeAttributeId)).toEqual(["room", "status"]);
    expect(status(detail)).toBe("active");
  });

  it("does not publish an old workspace's result after a connection change", () => {
    qc.setQueryData(qk.connection, { ...connection, workspaceId: "other" });
    resetMutationCaches(qc);
    applyMutationResult(qc, result(object("active")));
    expect(status(qc.getQueryData<AssetObject>(qk.object("1")))).toBe("inactive");
    expect(notify.error).toHaveBeenCalledWith(expect.stringContaining("previous connection"));
    expect(reconcileAssetPage(qc, page([object("inactive")])).values[0]).toEqual(object("inactive"));
  });

  it("does not publish a completed save from before a same-workspace reconnect", () => {
    const isCurrent = captureMutationContext(qc);
    resetMutationCaches(qc);
    qc.setQueryData(qk.connection, { ...connection });
    applyMutationResult(qc, { ...result(object("active")), isCurrent });
    expect(status(qc.getQueryData<AssetObject>(qk.object("1")))).toBe("inactive");
    expect(notify.error).toHaveBeenCalledWith(expect.stringContaining("previous connection"));
  });

  it("makes lock release idempotent and keeps later mutations locked", () => {
    const release = beginAssetMutation("1");
    release();
    const later = beginAssetMutation("1");
    release();
    expect(() => beginAssetMutation("1")).toThrow("already being updated");
    later();
  });
});
