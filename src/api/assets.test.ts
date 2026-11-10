import { afterEach, describe, expect, it, vi } from "vitest";
import { assetsApi } from "./assets";
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
