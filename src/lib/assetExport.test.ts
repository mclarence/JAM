import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assetsApi } from "@/api/assets";
import { connectionApi, fileApi } from "@/api/client";
import { DefaultType, type AssetObject, type ConnectionInfo, type ObjectTypeAttribute } from "@/api/types";
import { assetCsvRow, csvRecord, prepareAssetExport, saveAssetExport, type ExportInput } from "./assetExport";
import { deletionScope } from "./deletion";
import { useSettings } from "@/store/settings";

const connection: ConnectionInfo = { cloudId: "cloud", workspaceId: "workspace", siteUrl: "https://example.atlassian.net", email: "test@example.invalid" };
const columns: ObjectTypeAttribute[] = [{ id: "name", name: "Name", type: 0, label: true }];
const object = (id: string): AssetObject => ({
  id, objectKey: `ASSET-${id}`, label: `Asset ${id}`, objectType: { id: "type", name: "Asset", objectSchemaId: "schema" },
  created: "2026-01-01", updated: "2026-02-01",
  attributes: [{ objectTypeAttributeId: "name", objectAttributeValues: [{ value: `Asset ${id}` }] }],
});
const page = (ids: string[], startAt = 0, isLast: boolean | string = true) => ({
  values: ids.map(object), startAt, isLast, maxResults: 100, total: 0,
});
function input(overrides: Partial<ExportInput> = {}): ExportInput {
  return {
    aql: 'objectTypeId = 1 AND "Room" = "Lab" ORDER BY "Name" DESC',
    typeId: "type", columns, connection, signal: new AbortController().signal, onProgress: vi.fn(),
    ...overrides,
  };
}
beforeEach(() => {
  useSettings.setState({ deletions: {} });
  vi.spyOn(connectionApi, "get").mockResolvedValue(connection);
  vi.spyOn(assetsApi, "getObject").mockImplementation(async (id) => object(id));
  vi.spyOn(assetsApi, "searchExportObjects").mockResolvedValue(page(["1"]));
});
afterEach(() => { useSettings.setState({ deletions: {} }); vi.restoreAllMocks(); });

describe("deleted asset exports", () => {
  it.each([true, false])("skips returned hidden deletion markers and advances past a wholly deleted page (selected=%s)", async (selected) => {
    useSettings.getState().setDeletion(deletionScope(connection, "type"), {
      method: "permanent", marker: { attributeId: "hidden", attributeName: "Hidden marker", value: { raw: "DELETED", display: "" } },
    });
    const deleted = {
      ...object("1"),
      attributes: [...object("1").attributes, { objectTypeAttributeId: "hidden", objectAttributeValues: [{ value: "DELETED" }] }],
    };
    const search = vi.mocked(assetsApi.searchExportObjects)
      .mockResolvedValueOnce({ ...page(["1"], 0, false), values: [deleted] })
      .mockResolvedValueOnce(page(["2"], 1, true));
    const result = await prepareAssetExport(input(selected ? { selectedIds: ["1", "2"] } : {}));
    expect(result.count).toBe(1);
    expect(result.csv).toContain("Asset 2");
    expect(result.csv).not.toContain("Asset 1");
    expect(result.csv).not.toContain("DELETED");
    expect(result.skippedIds).toEqual(selected ? ["1"] : []);
    expect(result.missingIds).toEqual([]);
    if (!selected) {
      expect(search).toHaveBeenCalledTimes(2);
      expect(search).toHaveBeenLastCalledWith(expect.any(String), 1, false);
    }
  });
});

describe("CSV contract", () => {
  it("preserves exact content and escapes delimiters, quotes, Unicode and newlines", () => {
    expect(csvRecord(["Name", "Name", "", "a,b", 'a"b', "a\r\nb", " =1+1", "é"]))
      .toBe('Name,Name,,"a,b","a""b","a\r\nb", =1+1,é\r\n');
  });
  it("uses readable values but raw primitives, in exactly the chosen order", () => {
    const attrs: ObjectTypeAttribute[] = [
      { id: "status", name: "Status", type: 7 },
      { id: "number", name: "Number", type: 0, defaultType: { id: DefaultType.Integer, name: "" } },
      { id: "bool", name: "Boolean", type: 0, defaultType: { id: DefaultType.Boolean, name: "" } },
      { id: "date", name: "Date", type: 0, defaultType: { id: DefaultType.DateTime, name: "" } },
      { id: "reference", name: "Reference", type: 1 },
      { id: "text", name: "Text", type: 0 },
      { id: "missing", name: "Missing", type: 0 },
    ];
    const values = [
      { value: "7", status: { id: "7", name: "Active", category: 1 } },
      { value: "-12", displayValue: "minus twelve" }, { value: "false", displayValue: "No" },
      { value: "2026-01-02T03:04:05Z", displayValue: "Jan 2" },
      { value: "9", referencedObject: { id: "9", objectKey: "R-9", label: "Room" } }, { value: "=1+1" },
    ];
    const asset = { ...object("1"), attributes: values.map((value, i) => ({
      objectTypeAttributeId: attrs[i].id, objectAttributeValues: [value],
    })) };
    expect(assetCsvRow(asset, attrs)).toBe("Active,-12,false,2026-01-02T03:04:05Z,Room,=1+1,\r\n");
    expect(assetCsvRow(asset, [attrs[5], attrs[0]])).toBe("=1+1,Active\r\n");
    expect(assetCsvRow({ ...asset, attributes: [
      { objectTypeAttributeId: "number", objectAttributeValues: [{ value: "0" }] },
      { objectTypeAttributeId: "text", objectAttributeValues: [{ value: "=1+1" }, { value: "second" }] },
    ] }, [attrs[1], attrs[5]])).toBe('0,"=1+1, second"\r\n');
  });
  it("does not add intrinsic columns or replace explicit empty values", () => {
    const attrs: ObjectTypeAttribute[] = [
      { id: "key", name: "Key", type: 0, system: true },
      { id: "created", name: "Created", type: 0, system: true },
      { id: "updated", name: "Updated", type: 0, system: true }, ...columns,
    ];
    expect(assetCsvRow({ ...object("1"), attributes: [] }, attrs)).toBe("ASSET-1,2026-01-01,2026-02-01,Asset 1\r\n");
    expect(assetCsvRow({ ...object("1"), attributes: [{ objectTypeAttributeId: "name", objectAttributeValues: [] }] }, columns)).toBe("\r\n");
  });
  it("joins readable user and group names", () => {
    expect(assetCsvRow({ ...object("1"), attributes: [{
      objectTypeAttributeId: "name", objectAttributeValues: [
        { value: "id", user: { displayName: "Alice" } }, { value: "group-id", group: { name: "IT" } },
      ],
    }] }, columns)).toBe('"Alice, IT"\r\n');
  });
});

describe("export reads and saving", () => {
  it("exports 1,000 AQL objects in ten requests with no detail reads", async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => String(i + 1));
    const search = vi.mocked(assetsApi.searchExportObjects).mockImplementation(async (_, start = 0) =>
      page(ids.slice(start, start + 100), start, start + 100 >= ids.length));
    const result = await prepareAssetExport(input());
    expect(result.count).toBe(1000);
    expect(result.csv.split("\r\n")).toHaveLength(1002);
    expect(connectionApi.get).toHaveBeenCalledTimes(21);
    expect(search.mock.calls.map((call) => call[1])).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(assetsApi.getObject).not.toHaveBeenCalled();
  });
  it("exports AQL attributes in server order without duplicate rows", async () => {
    vi.mocked(assetsApi.getObject).mockResolvedValue({ ...object("1"), label: "stale detail", attributes: [] });
    const search = vi.mocked(assetsApi.searchExportObjects)
      .mockResolvedValueOnce(page(["1", "2"], 0, "false")).mockResolvedValueOnce(page(["2", "3"], 2, "true"));
    const request = input();
    const result = await prepareAssetExport(request);
    expect(result).toEqual({ count: 3, skippedIds: [], missingIds: [], csv: "\uFEFFName\r\nAsset 1\r\nAsset 2\r\nAsset 3\r\n" });
    expect(search.mock.calls).toEqual([[request.aql, 0, false], [request.aql, 2, false]]);
    expect(assetsApi.getObject).not.toHaveBeenCalled();
    expect(request.onProgress).toHaveBeenLastCalledWith(3);
  });
  it("reads only selected IDs in selected order, independently of filters or loaded rows", async () => {
    const search = vi.mocked(assetsApi.searchExportObjects).mockResolvedValue(page(["1", "3"]));
    expect(await prepareAssetExport(input({ selectedIds: ["3", "1", "3"] })))
      .toEqual({ count: 2, skippedIds: [], missingIds: [], csv: "\uFEFFName\r\nAsset 3\r\nAsset 1\r\n" });
    expect(search).toHaveBeenCalledExactlyOnceWith("objectId IN (3,1) ORDER BY Key ASC", 0, true);
    expect(assetsApi.getObject).not.toHaveBeenCalled();
  });
  it("batches 205 selections at 100/101 boundaries without losing precision or order", async () => {
    const ids = Array.from({ length: 204 }, (_, i) => String(i + 1)).concat("9007199254740993");
    const search = vi.mocked(assetsApi.searchExportObjects).mockImplementation(async (query) =>
      page(query.match(/\(([^)]+)\)/)![1].split(",").reverse()));
    const result = await prepareAssetExport(input({ selectedIds: [...ids, "1"] }));
    expect(result.count).toBe(205);
    expect(result.csv).toBe("\uFEFFName\r\n" + ids.map((id) => `Asset ${id}\r\n`).join(""));
    expect(search).toHaveBeenCalledTimes(3);
    expect(search.mock.calls.map(([query]) => query.match(/\(([^)]+)\)/)![1].split(",").length)).toEqual([100, 100, 5]);
    expect(assetsApi.getObject).not.toHaveBeenCalled();
  });
  it("skips absent selections only after all shorter batch pages complete", async () => {
    vi.mocked(assetsApi.searchExportObjects).mockResolvedValueOnce(page(["2"], 0, false)).mockResolvedValueOnce(page(["1"], 1));
    const result = await prepareAssetExport(input({ selectedIds: ["3", "1", "2"] }));
    expect(result).toEqual({ count: 2, skippedIds: ["3"], missingIds: ["3"], csv: "\uFEFFName\r\nAsset 1\r\nAsset 2\r\n" });
  });
  it("accepts empty attributes and omits legitimately absent optional columns", async () => {
    vi.mocked(assetsApi.searchExportObjects).mockResolvedValue({ ...page([]), values: [{ ...object("1"), attributes: [] }] });
    const result = await prepareAssetExport(input({ columns: [...columns, { id: "optional", name: "Optional", type: 0 }] }));
    expect(result.csv).toBe("\uFEFFName,Optional\r\nAsset 1,\r\n");
  });
  it("does not offer earlier selected batches after a later batch fails", async () => {
    vi.mocked(assetsApi.searchExportObjects).mockResolvedValueOnce(page(["1"])).mockRejectedValueOnce(new Error("offline"));
    const choose = vi.fn();
    const write = vi.spyOn(fileApi, "saveCsv");
    await expect(saveAssetExport(input({ selectedIds: Array.from({ length: 101 }, (_, i) => String(i + 1)) }), "assets.csv", choose))
      .rejects.toThrow("offline");
    expect(choose).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
  it("does not offer a file for an entirely absent selection and reports the skipped count", async () => {
    vi.mocked(assetsApi.searchExportObjects).mockResolvedValue(page([]));
    const choose = vi.fn();
    await expect(saveAssetExport(input({ selectedIds: ["1", "2"] }), "assets.csv", choose))
      .rejects.toThrow("Skipped 2 selected assets: 2 not returned by search");
    expect(choose).not.toHaveBeenCalled();
  });
  it.each(["", "0", "-1", "01", "1.5", "1 OR true", "1e2"])("rejects unsafe selected ID %j before searching", async (id) => {
    await expect(prepareAssetExport(input({ selectedIds: ["1", id] }))).rejects.toThrow("numeric Jira IDs");
    expect(assetsApi.searchExportObjects).not.toHaveBeenCalled();
  });
  it("never offers a partial file after a later-page failure", async () => {
    vi.mocked(assetsApi.searchExportObjects).mockResolvedValueOnce(page(["1"], 0, false)).mockRejectedValueOnce(new Error("offline"));
    const choose = vi.fn();
    const write = vi.spyOn(fileApi, "saveCsv");
    await expect(saveAssetExport(input(), "assets.csv", choose)).rejects.toThrow("offline");
    expect(choose).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
  it.each([
    page([], 0, false),
    page(["1"], 10, true),
  ])("rejects incomplete or nonadvancing pages", async (response) => {
    vi.mocked(assetsApi.searchExportObjects).mockResolvedValue(response);
    await expect(prepareAssetExport(input())).rejects.toThrow("incomplete export page");
  });
  it("rejects repeated pages instead of looping forever", async () => {
    vi.mocked(assetsApi.searchExportObjects).mockResolvedValueOnce(page(["1"], 0, false)).mockResolvedValueOnce(page(["1"], 1, false));
    await expect(prepareAssetExport(input())).rejects.toThrow("stopped making progress");
  });
  it.each(["failed", "incomplete", "mismatched", "wrong type"])("fails the entire selected export for a %s response", async (kind) => {
    const get = vi.mocked(assetsApi.searchExportObjects);
    if (kind === "failed") get.mockRejectedValue(new Error("not found"));
    if (kind === "incomplete") {
      const partial = object("1");
      Reflect.deleteProperty(partial, "attributes");
      get.mockResolvedValue({ ...page([]), values: [partial] });
    }
    if (kind === "mismatched") get.mockResolvedValue(page(["2"]));
    if (kind === "wrong type") get.mockResolvedValue({ ...page([]), values: [{ ...object("1"), objectType: { id: "other", name: "Other", objectSchemaId: "schema" } }] });
    const choose = vi.fn();
    await expect(saveAssetExport(input({ selectedIds: ["1"] }), "assets.csv", choose)).rejects.toThrow();
    expect(choose).not.toHaveBeenCalled();
  });
  it("rejects wrong-type all-results objects even if they match a deletion marker", async () => {
    useSettings.getState().setDeletion(deletionScope(connection, "other"), {
      method: "permanent", marker: { attributeId: "name", attributeName: "Name", value: { raw: "Asset 1", display: "" } },
    });
    vi.mocked(assetsApi.searchExportObjects).mockResolvedValue({
      ...page([]), values: [{ ...object("1"), objectType: { id: "other", name: "Other", objectSchemaId: "schema" } }],
    });
    const choose = vi.fn();
    await expect(saveAssetExport(input(), "assets.csv", choose)).rejects.toThrow("object type");
    expect(choose).not.toHaveBeenCalled();
  });
  it("rejects empty results and no columns", async () => {
    vi.mocked(assetsApi.searchExportObjects).mockResolvedValue(page([]));
    await expect(prepareAssetExport(input())).rejects.toThrow("No exportable assets");
    await expect(prepareAssetExport(input({ columns: [] }))).rejects.toThrow("at least one column");
  });
  it("stops cancellation before any request", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(prepareAssetExport(input({ selectedIds: ["1"], signal: abort.signal }))).rejects.toThrow();
    expect(assetsApi.getObject).not.toHaveBeenCalled();
  });
  it("discards a late response and never starts another request after cancellation", async () => {
    const abort = new AbortController();
    vi.mocked(assetsApi.searchExportObjects).mockImplementation(async () => { abort.abort(); return page(["1"]); });
    await expect(prepareAssetExport(input({ selectedIds: ["1", "2"], signal: abort.signal }))).rejects.toThrow();
    expect(assetsApi.searchExportObjects).toHaveBeenCalledTimes(1);
    expect(assetsApi.getObject).not.toHaveBeenCalled();
  });
  it("discards a response from a changed connection", async () => {
    vi.mocked(assetsApi.searchExportObjects).mockImplementation(async () => {
      vi.mocked(connectionApi.get).mockResolvedValue({ ...connection, workspaceId: "other" });
      return page(["1"]);
    });
    await expect(prepareAssetExport(input({ selectedIds: ["1"] }))).rejects.toThrow("connection changed");
  });
  it("treats save dialog cancellation as cancellation, not a successful write", async () => {
    const write = vi.spyOn(fileApi, "saveCsv");
    expect(await saveAssetExport(input({ selectedIds: ["1"] }), "assets.csv", async () => null)).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });
  it("rechecks cancellation after the native save dialog", async () => {
    const abort = new AbortController();
    const write = vi.spyOn(fileApi, "saveCsv");
    await expect(saveAssetExport(input({ selectedIds: ["1"], signal: abort.signal }), "assets.csv", async () => {
      abort.abort();
      return "/tmp/assets.csv";
    })).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });
  it("rechecks connection identity after the native save dialog", async () => {
    const write = vi.spyOn(fileApi, "saveCsv");
    await expect(saveAssetExport(input({ selectedIds: ["1"] }), "assets.csv", async () => {
      vi.mocked(connectionApi.get).mockResolvedValue(null);
      return "/tmp/assets.csv";
    })).rejects.toThrow("connection changed");
    expect(write).not.toHaveBeenCalled();
  });
  it("reports write failures and returns counts only after successful writing", async () => {
    const write = vi.spyOn(fileApi, "saveCsv").mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce(undefined);
    await expect(saveAssetExport(input({ selectedIds: ["1"] }), "assets.csv", async () => "/tmp/assets.csv")).rejects.toThrow("disk full");
    expect(await saveAssetExport(input({ selectedIds: ["1"] }), "assets.csv", async () => "/tmp/assets.csv")).toEqual({ count: 1, skippedIds: [], missingIds: [] });
    expect(write).toHaveBeenLastCalledWith("/tmp/assets.csv", "\uFEFFName\r\nAsset 1\r\n");
  });
  it("passes skipped information before choosing a path and through successful saving", async () => {
    vi.spyOn(fileApi, "saveCsv").mockResolvedValue(undefined);
    const choose = vi.fn().mockResolvedValue("/fixture/assets.csv");
    const before = vi.fn(async (summary) => {
      expect(summary.skippedIds).toEqual(["2"]);
      expect(choose).not.toHaveBeenCalled();
      return true;
    });
    expect(await saveAssetExport(input({ selectedIds: ["1", "2"] }), "assets.csv", choose, before))
      .toEqual({ count: 1, skippedIds: ["2"], missingIds: ["2"] });
    expect(before).toHaveBeenCalledOnce();
  });
});
