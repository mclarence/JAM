import { useState } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { assetsApi } from "../../../src/api/assets";
import { connectionApi, fileApi } from "../../../src/api/client";
import { AttrType, type AssetObject, type ConnectionInfo, type ObjectTypeAttribute } from "../../../src/api/types";
import { ExportAssetsDialog } from "../../../src/components/assets/ExportAssetsDialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../src/components/ui/select";
import { AssetsPage } from "../../../src/pages/AssetsPage";
import { useSettings } from "../../../src/store/settings";
import { useUi } from "../../../src/store/ui";
import "../../../src/index.css";

const type = { id: "1", name: "Devices", objectSchemaId: "1" };
const connection: ConnectionInfo = {
  cloudId: "test",
  workspaceId: "test",
  siteUrl: "https://example.invalid",
  email: "test@example.invalid",
};
const attributes: ObjectTypeAttribute[] = [
  { id: "name", name: "Name", type: AttrType.Default, label: true },
  { id: "room", name: "Room", type: AttrType.Default },
];
const objects: AssetObject[] = ["Lab", "Office"].map((room, index) => {
  const id = String(index + 1);
  return {
    id,
    objectKey: `DEV-${id}`,
    label: `Device ${id}`,
    objectType: type,
    created: "2026-01-01",
    updated: "2026-01-01",
    attributes: [
      { objectTypeAttributeId: "name", objectAttributeValues: [{ value: `Device ${id}` }] },
      { objectTypeAttributeId: "room", objectAttributeValues: [{ value: room }] },
    ],
  };
});

const searches: { query: string; startAt: number }[] = [];
const requestedIds: string[] = [];
const returnedIds: string[] = [];
const writes: { path: string; content: string }[] = [];
const saveDialogs: unknown[] = [];
let readError: string | undefined;
let waitForRead: Promise<void> | undefined;
let releaseRead: (() => void) | undefined;
let savePath: string | null = "/fixture/assets.csv";

const fixture = {
  searches,
  requestedIds,
  returnedIds,
  writes,
  saveDialogs,
  failNextRead: () => { readError = "Fixture fetch failed"; },
  pauseRead: () => {
    if (waitForRead) throw new Error("A fixture read is already paused");
    waitForRead = new Promise((resolve) => { releaseRead = resolve; });
  },
  resumeRead: () => {
    if (!releaseRead) throw new Error("No fixture read is paused");
    const release = releaseRead;
    releaseRead = undefined;
    waitForRead = undefined;
    release();
  },
  setSavePath: (path: string | null) => { savePath = path; },
};

export type ExportFixture = typeof fixture;
declare global {
  interface Window { exportFixture: ExportFixture }
}
window.exportFixture = fixture;

connectionApi.get = async () => connection;
assetsApi.listSchemas = async () => [{ id: "1", name: "Test", objectSchemaKey: "TEST" }];
assetsApi.listObjectTypes = async () => [type];
assetsApi.getObjectTypeAttributes = async () => attributes;
assetsApi.listStatusTypes = async () => [];
assetsApi.countObjects = async () => objects.length;
assetsApi.searchObjects = async (query, startAt = 0, maxResults = 100) => {
  searches.push({ query, startAt });
  const values = objects.slice(startAt, startAt + maxResults);
  return structuredClone({
    startAt,
    maxResults,
    total: objects.length,
    isLast: startAt + values.length >= objects.length,
    values,
  });
};
assetsApi.searchExportObjects = async (query, startAt = 0, selected = false) => {
  searches.push({ query, startAt });
  if (waitForRead) await waitForRead;
  if (readError) {
    const message = readError;
    readError = undefined;
    throw new Error(message);
  }
  const ids = selected ? query.match(/\(([^)]+)\)/)![1].split(",") : undefined;
  const matches = objects.filter((object) => !ids || ids.includes(object.id));
  const values = matches.slice(startAt, startAt + 100);
  returnedIds.push(...values.map((object) => object.id));
  return structuredClone({ startAt, maxResults: 100, total: matches.length, isLast: startAt + values.length >= matches.length, values });
};
assetsApi.getObject = async (id) => {
  requestedIds.push(id);
  throw new Error("Export must not request asset details");
};
fileApi.saveCsv = async (path, content) => { writes.push({ path, content }); };

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const root = document.getElementById("root");
if (!root) throw new Error("Missing test root");

if (params.get("mode") === "assets") {
  useSettings.setState({ schemaId: "1", objectTypeId: "1", columns: {}, rules: [] });
  useUi.setState({ editing: null, staleAssets: {}, search: "", rawAql: "" });
  createRoot(root).render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <div className="flex h-screen flex-col"><AssetsPage /></div>
    </QueryClientProvider>,
  );
} else {
  mockIPC((command, payload) => {
    if (command !== "plugin:dialog|save") throw new Error(`Unexpected fixture command: ${command}`);
    saveDialogs.push(payload);
    return savePath;
  });
  const allColumns = params.get("attributes") === "none" ? [] : attributes;
  const visibleColumns = params.get("visible") === "none" ? [] : allColumns.slice(0, 1);
  const selectedIds = params.get("selected") === "none" ? [] : params.get("selected") === "missing" ? ["2", "3"] : ["2"];

  function Fixture() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Toaster />
        <div className="w-80 p-6">
          <Select defaultValue="reference">
            <SelectTrigger data-testid="reference-trigger"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="reference">Reference choice</SelectItem></SelectContent>
          </Select>
        </div>
        {open && (
          <ExportAssetsDialog
            aql={'objectTypeId = 1 ORDER BY "Name" ASC'}
            typeId="1"
            typeName="Devices"
            connection={connection}
            selectedIds={selectedIds}
            visibleColumns={visibleColumns}
            allColumns={allColumns}
            onClose={() => setOpen(false)}
          />
        )}
      </>
    );
  }

  createRoot(root).render(<Fixture />);
}
