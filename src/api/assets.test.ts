import { afterEach, describe, expect, it, vi } from "vitest";
import { assetsApi, selectedExportQuery } from "./assets";
import * as client from "./client";
import type { ConnectionInfo } from "./types";
import { deletionScope } from "@/lib/deletion";
import { useSettings } from "@/store/settings";

const connection: ConnectionInfo = { cloudId: "cloud", workspaceId: "workspace", siteUrl: "https://example.invalid", email: "test@example.invalid" };
afterEach(() => { useSettings.setState({ deletions: {} }); vi.restoreAllMocks(); });

describe("asset visibility request contract", () => {
  it("adds the same server-side exclusion to page and count requests, retaining page offsets", async () => {
    useSettings.getState().setDeletion(deletionScope(connection, "1"), {
      method: "permanent", marker: { attributeId: "10", attributeName: "Asset Tag", value: { raw: "DELETED", display: "" } },
    });
    vi.spyOn(client.connectionApi, "get").mockResolvedValue(connection);
    const request = vi.spyOn(client, "assetsRequest").mockResolvedValue({ values: [], totalCount: 7 });
    await assetsApi.searchObjects('objectTypeId = 1 ORDER BY Key ASC', 100, 25);
    expect(await assetsApi.countObjects("objectTypeId = 1")).toBe(7);
    const exclusion = '(objectTypeId != 1 OR "Asset Tag" IS EMPTY OR "Asset Tag" != "DELETED")';
    expect(request).toHaveBeenNthCalledWith(1, "POST", "/object/aql", {
      query: { startAt: 100, maxResults: 25, includeAttributes: true },
      body: { qlQuery: `(objectTypeId = 1) AND ${exclusion} ORDER BY Key ASC` },
    });
    expect(request).toHaveBeenNthCalledWith(2, "POST", "/object/aql/totalcount", { body: { qlQuery: `(objectTypeId = 1) AND ${exclusion}` } });
  });
  it("uses DELETE on the encoded Jira object endpoint", async () => {
    const request = vi.spyOn(client, "assetsRequest").mockResolvedValue(null);
    await assetsApi.deleteObject("1/2");
    expect(request).toHaveBeenCalledExactlyOnceWith("DELETE", "/object/1%2F2");
  });
});

describe("strict AQL export searches", () => {
  const object = {
    id: "9007199254740993", objectKey: "ASSET-1", label: "Asset", created: "", updated: "",
    objectType: { id: "1" }, attributes: [],
  };
  const page = { startAt: 0, maxResults: 100, isLast: true, values: [object] };

  it("requests every attribute and retains deletion exclusion only for all-results exports", async () => {
    useSettings.getState().setDeletion(deletionScope(connection, "1"), {
      method: "permanent", marker: { attributeId: "10", attributeName: "Hidden marker", value: { raw: "DELETED", display: "" } },
    });
    vi.spyOn(client.connectionApi, "get").mockResolvedValue(connection);
    const request = vi.spyOn(client, "assetsRequest").mockResolvedValue(page);
    await assetsApi.searchExportObjects(selectedExportQuery([object.id]), 0, true);
    expect(request).toHaveBeenLastCalledWith("POST", "/object/aql", {
      query: { startAt: 0, maxResults: 100, includeAttributes: true }, body: { qlQuery: "objectId IN (9007199254740993) ORDER BY Key ASC" },
    });
    await assetsApi.searchExportObjects("objectTypeId = 1 ORDER BY Key ASC");
    expect(request).toHaveBeenLastCalledWith("POST", "/object/aql", {
      query: { startAt: 0, maxResults: 100, includeAttributes: true },
      body: { qlQuery: '(objectTypeId = 1) AND (objectTypeId != 1 OR "Hidden marker" IS EMPTY OR "Hidden marker" != "DELETED") ORDER BY Key ASC' },
    });
  });
  it.each([
    null, {}, { ...page, values: null }, { ...page, isLast: undefined }, { ...page, isLast: "yes" },
    { ...page, startAt: 1 }, { ...page, maxResults: 0 }, { ...page, maxResults: 101 },
    { ...page, values: [], isLast: false },
    ...[undefined, null, {}, [{ objectTypeAttributeId: "1" }], [{ objectTypeAttributeId: "1", objectAttributeValues: [null] }]]
      .map((attributes) => ({ ...page, values: [{ ...object, attributes }] })),
    { ...page, values: [{ ...object, id: 9007199254740992 }] },
    { ...page, values: [{ ...object, objectType: null }] },
  ])("rejects malformed export data %#", async (response) => {
    vi.spyOn(client, "assetsRequest").mockResolvedValue(response);
    await expect(assetsApi.searchExportObjects("query")).rejects.toThrow();
  });
  it("accepts empty attribute arrays and missing optional attributes without detail reads", async () => {
    const request = vi.spyOn(client, "assetsRequest").mockResolvedValue(page);
    await expect(assetsApi.searchExportObjects("query")).resolves.toMatchObject({ values: [{ attributes: [] }] });
    request.mockResolvedValue({
      ...page, isLast: "true", values: [{ ...object, attributes: [{ objectTypeAttributeId: "1", objectAttributeValues: [{}] }] }],
    });
    await expect(assetsApi.searchExportObjects("query")).resolves.toMatchObject({ isLast: "true" });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("fails rather than falling back after an AQL error", async () => {
    const request = vi.spyOn(client, "assetsRequest").mockRejectedValue(new Error("offline"));
    await expect(assetsApi.searchExportObjects("query")).rejects.toThrow("offline");
    expect(request).toHaveBeenCalledOnce();
  });
});
