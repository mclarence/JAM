import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { assetsApi } from "../../../src/api/assets";
import { ApiError, connectionApi } from "../../../src/api/client";
import { qk, useAssetsInfinite } from "../../../src/api/queries";
import { DefaultType, type AssetObject, type ConnectionInfo, type ObjectIn, type ObjectTypeAttribute } from "../../../src/api/types";
import { useState } from "react";
import { BatchDeleteDialog } from "../../../src/components/assets/BatchDeleteDialog";
import { DeleteAssetButton } from "../../../src/components/assets/DeleteAssetButton";
import { DeletionTab } from "../../../src/components/settings/DeletionTab";
import { deletionScope, type DeletionConfig } from "../../../src/lib/deletion";
import { useSettings } from "../../../src/store/settings";
import "../../../src/index.css";

const connection: ConnectionInfo = { cloudId: "cloud", workspaceId: "workspace", siteUrl: "https://example.invalid", email: "test@example.invalid" };
const object: AssetObject = {
  id: "1", objectKey: "DEV-1", label: "Device 1", objectType: { id: "2", name: "Devices", objectSchemaId: "3" },
  created: "", updated: "", attributes: [{ objectTypeAttributeId: "10", objectAttributeValues: [{ value: "DEV001" }] }],
};
const attrs: ObjectTypeAttribute[] = [
  { id: "10", name: "Asset Tag", type: 0, defaultType: { id: DefaultType.Text, name: "Text" } },
  { id: "11", name: "Room", type: 0, defaultType: { id: DefaultType.Text, name: "Text" } },
  { id: "12", name: "Notes", type: 0, defaultType: { id: DefaultType.Textarea, name: "Text area" } },
  { id: "13", name: "Locked", type: 0, editable: false, defaultType: { id: DefaultType.Text, name: "Text" } },
];
const scope = deletionScope(connection, "2");
const params = new URLSearchParams(location.search);
const config: DeletionConfig = {
  method: params.get("method") === "permanent" ? "permanent" : "soft",
  marker: { attributeId: "10", attributeName: "Asset Tag", value: { raw: "DELETED", display: "DELETED" } },
  additional: { attributeId: "11", attributeName: "Room", value: { raw: "Retired storage", display: "Retired storage" } },
};
let resume: (() => void) | undefined;
let wait: Promise<void> | undefined;
let failure: "permission" | "validation" | undefined;
const failOnce = new Set<string>();
const bulkObjects: AssetObject[] = ["1", "2", "3"].map((id) => ({ ...object, id, objectKey: `DEV-${id}`, label: `Device ${id}` }));
const writes: { method: string; id: string; body?: ObjectIn }[] = [];
const fixture = {
  writes,
  config: () => useSettings.getState().deletions[scope],
  pause: () => { wait = new Promise((resolve) => { resume = resolve; }); },
  resume: () => { wait = undefined; resume?.(); resume = undefined; },
  fail: (kind: "permission" | "validation") => { failure = kind; },
  failOnce: (id: string) => { failOnce.add(id); },
};
declare global { interface Window { deletionFixture: typeof fixture } }
window.deletionFixture = fixture;
connectionApi.get = async () => connection;
assetsApi.getObject = async (id) => structuredClone(bulkObjects.find((o) => o.id === id) ?? object);
assetsApi.getObjectTypeAttributes = async () => attrs;
assetsApi.listStatusTypes = async () => [];
// Deliberately return stale search data after writes to exercise cache reconciliation.
assetsApi.searchObjects = async () => {
  const values = params.has("bulk") ? bulkObjects : [object];
  return { values: structuredClone(values), startAt: 0, maxResults: 100, isLast: true, total: values.length };
};
assetsApi.countObjects = async () => 1;
const finish = async (id: string) => {
  if (wait) await wait;
  if (failOnce.delete(id)) throw new ApiError(`Jira rejected ${id}`, "http", 400);
  const error = failure;
  failure = undefined;
  if (error === "permission") throw new ApiError("Forbidden by Jira", "http", 403);
  if (error === "validation") throw new ApiError("Marker value rejected by Jira", "http", 400);
};
assetsApi.deleteObject = async (id) => { writes.push({ method: "DELETE", id }); await finish(id); };
assetsApi.updateObject = async (id, body) => {
  writes.push({ method: "PUT", id, body });
  await finish(id);
  return object;
};
useSettings.setState({
  schemaId: "3", objectTypeId: "2", rules: [],
  deletions: params.has("settings") || params.has("unconfigured") ? {} : { [scope]: config },
});
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
qc.setQueryData(qk.connection, connection);
function Fixture() {
  const objects = useAssetsInfinite("objectTypeId = 2");
  const [bulkOpen, setBulkOpen] = useState(false);
  if (params.has("settings")) return <DeletionTab />;
  if (params.has("bulk")) return <>
    <div data-testid="asset-list">{objects.data?.pages.flatMap((page) => page.values).map((asset) =>
      <p key={asset.id}>{asset.label}</p>)}</div>
    <button onClick={() => setBulkOpen(true)}>Delete selected</button>
    <BatchDeleteDialog open={bulkOpen} onOpenChange={setBulkOpen} objects={bulkObjects} typeId="2" config={config} connection={connection} />
  </>;
  return <>
    <div data-testid="asset-list">{objects.data?.pages.flatMap((page) => page.values).map((asset) =>
      <p key={asset.id}>{asset.label}</p>)}</div>
    <DeleteAssetButton object={object} />
  </>;
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={qc}><main className="p-8"><Fixture /></main></QueryClientProvider>,
);
