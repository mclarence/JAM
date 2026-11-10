import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assetsApi } from "@/api/assets";
import { connectionApi, fileApi } from "@/api/client";
import { DefaultType, type AssetObject, type ConnectionInfo, type ObjectTypeAttribute } from "@/api/types";
import { assetCsvRow, csvRecord, prepareAssetExport, saveAssetExport, type ExportInput } from "./assetExport";

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
  vi.spyOn(connectionApi, "get").mockResolvedValue(connection);
  vi.spyOn(assetsApi, "getObject").mockImplementation(async (id) => object(id));
});
afterEach(() => vi.restoreAllMocks());

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
  it("exports more than two full API pages without a row cap", async () => {
    const ids = Array.from({ length: 205 }, (_, i) => String(i + 1));
    const search = vi.spyOn(assetsApi, "searchObjects").mockImplementation(async (_, start = 0) =>
      page(ids.slice(start, start + 100), start, start + 100 >= ids.length));
    const result = await prepareAssetExport(input());
    expect(result.count).toBe(205);
    expect(result.csv.split("\r\n")).toHaveLength(207);
    expect(search.mock.calls.map((call) => call[1])).toEqual([0, 100, 200]);
    expect(assetsApi.getObject).toHaveBeenCalledTimes(205);
  });
  it("exports all pages of the frozen query and hydrates fresh objects, without duplicate rows", async () => {
    const search = vi.spyOn(assetsApi, "searchObjects")
      .mockResolvedValueOnce(page(["1", "2"], 0, "false")).mockResolvedValueOnce(page(["2", "3"], 2, "true"));
    const request = input();
    const result = await prepareAssetExport(request);
    expect(result).toEqual({ count: 3, csv: "\uFEFFName\r\nAsset 1\r\nAsset 2\r\nAsset 3\r\n" });
    expect(search.mock.calls).toEqual([[request.aql, 0], [request.aql, 2]]);
    expect(assetsApi.getObject).toHaveBeenCalledTimes(3);
    expect(request.onProgress).toHaveBeenLastCalledWith(3);
  });
  it("reads only selected IDs in selected order, independently of filters or loaded rows", async () => {
    const search = vi.spyOn(assetsApi, "searchObjects");
    expect(await prepareAssetExport(input({ selectedIds: ["3", "1", "3"] })))
      .toEqual({ count: 2, csv: "\uFEFFName\r\nAsset 3\r\nAsset 1\r\n" });
    expect(search).not.toHaveBeenCalled();
  });
  it("never offers a partial file after a later-page failure", async () => {
    vi.spyOn(assetsApi, "searchObjects").mockResolvedValueOnce(page(["1"], 0, false)).mockRejectedValueOnce(new Error("offline"));
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
    vi.spyOn(assetsApi, "searchObjects").mockResolvedValue(response);
    await expect(prepareAssetExport(input())).rejects.toThrow("incomplete export page");
  });
  it("rejects repeated pages instead of looping forever", async () => {
    vi.spyOn(assetsApi, "searchObjects").mockResolvedValueOnce(page(["1"], 0, false)).mockResolvedValueOnce(page(["1"], 1, false));
    await expect(prepareAssetExport(input())).rejects.toThrow("stopped making progress");
  });
  it.each(["missing", "incomplete", "mismatched", "wrong type"])("fails the entire selected export for a %s object", async (kind) => {
    const get = vi.mocked(assetsApi.getObject);
    if (kind === "missing") get.mockRejectedValue(new Error("not found"));
    if (kind === "incomplete") {
      const partial = object("1");
      Reflect.deleteProperty(partial, "attributes");
      get.mockResolvedValue(partial);
    }
    if (kind === "mismatched") get.mockResolvedValue(object("2"));
    if (kind === "wrong type") get.mockResolvedValue({ ...object("1"), objectType: { id: "other", name: "Other", objectSchemaId: "schema" } });
    await expect(prepareAssetExport(input({ selectedIds: ["1"] }))).rejects.toThrow();
  });
  it("rejects empty results and no columns", async () => {
    vi.spyOn(assetsApi, "searchObjects").mockResolvedValue(page([]));
    await expect(prepareAssetExport(input())).rejects.toThrow("No assets match");
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
    vi.mocked(assetsApi.getObject).mockImplementation(async () => { abort.abort(); return object("1"); });
    await expect(prepareAssetExport(input({ selectedIds: ["1", "2"], signal: abort.signal }))).rejects.toThrow();
    expect(assetsApi.getObject).toHaveBeenCalledTimes(1);
  });
  it("discards a response from a changed connection", async () => {
    vi.mocked(assetsApi.getObject).mockImplementation(async () => {
      vi.mocked(connectionApi.get).mockResolvedValue({ ...connection, workspaceId: "other" });
      return object("1");
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
    expect(await saveAssetExport(input({ selectedIds: ["1"] }), "assets.csv", async () => "/tmp/assets.csv")).toBe(1);
    expect(write).toHaveBeenLastCalledWith("/tmp/assets.csv", "\uFEFFName\r\nAsset 1\r\n");
  });
});
