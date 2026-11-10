import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { assetsApi } from "../../../src/api/assets";
import { ApiError, connectionApi } from "../../../src/api/client";
import { AttrType, DefaultType, type AssetObject, type ObjectIn, type ObjectTypeAttribute } from "../../../src/api/types";
import { AssetsPage } from "../../../src/pages/AssetsPage";
import { useSettings } from "../../../src/store/settings";
import { useUi } from "../../../src/store/ui";
import "../../../src/index.css";

const type = { id: "1", name: "Devices", objectSchemaId: "1" };
const studentType = { id: "2", name: "Students", objectSchemaId: "1" };
const attrs: ObjectTypeAttribute[] = [
  { id: "name", name: "Name", type: AttrType.Default, label: true },
  { id: "student", name: "Assigned to Student", type: AttrType.ObjectReference, referenceObjectTypeId: "2", referenceObjectType: studentType },
  { id: "room", name: "Room", type: AttrType.Default, minimumCardinality: 1 },
  { id: "choice", name: "Choice", type: AttrType.Default, defaultType: { id: DefaultType.Select, name: "Select" }, options: "One,Two" },
  { id: "status", name: "Status", type: AttrType.Status },
  { id: "key", name: "Key", type: AttrType.Default, system: true },
];
const students: AssetObject[] = ["Alex", "Sam"].map((label, index) => ({
  id: `s${index}`, objectKey: `ST-${index}`, label, objectType: studentType, created: "", updated: "", attributes: [],
}));
const objects: AssetObject[] = Array.from({ length: 180 }, (_, index) => ({
  id: `${index}`, objectKey: `DEV-${index}`, label: `Device ${index}`, objectType: type,
  created: "", updated: "2026-01-01T00:00:00Z",
  attributes: [
    { objectTypeAttributeId: "name", objectAttributeValues: [{ value: `Device ${index}` }] },
    { objectTypeAttributeId: "room", objectAttributeValues: [{ value: index % 2 ? "Old" : "Lab" }] },
    { objectTypeAttributeId: "choice", objectAttributeValues: [{ value: index % 2 ? "Two" : "One" }] },
    { objectTypeAttributeId: "student", objectAttributeValues: index % 2 ? [{ value: "ST-1", referencedObject: students[1] }] : [] },
    { objectTypeAttributeId: "key", objectAttributeValues: [{ value: `DEV-${index}` }] },
  ],
}));
const writes: { id: string; body: ObjectIn }[] = [];
const failIds = new Set<string>();
let hideUpdated = false;
connectionApi.get = async () => ({ cloudId: "test", workspaceId: "test", siteUrl: "https://example.invalid", email: "test@example.invalid" });
assetsApi.listSchemas = async () => [{ id: "1", name: "Test", objectSchemaKey: "TEST" }];
assetsApi.listObjectTypes = async () => [type, studentType];
assetsApi.getObjectTypeAttributes = async () => attrs;
assetsApi.listStatusTypes = async () => [{ id: "active", name: "Active", category: 1 }];
assetsApi.countObjects = async () => objects.length;
assetsApi.searchObjects = async (query, startAt = 0, maxResults = 100) => {
  const source = query.includes("objectTypeId = 2") ? students :
    objects.filter((object) => !hideUpdated || object.updated === "2026-01-01T00:00:00Z");
  const values = source.slice(startAt, startAt + maxResults);
  return structuredClone({ startAt, maxResults, total: source.length, isLast: startAt + values.length >= source.length, values });
};
assetsApi.getObject = async (id) => {
  const object = [...objects, ...students].find((item) => item.id === id);
  if (!object) throw new Error(`Unknown fixture asset ${id}`);
  return structuredClone(object);
};
assetsApi.getHistory = async () => [];
assetsApi.updateObject = async (id, body) => {
  writes.push({ id, body: structuredClone(body) });
  if (failIds.has(id)) throw new ApiError("Fixture permission denied", "http", 403);
  const object = objects.find((item) => item.id === id);
  if (!object) throw new Error(`Unknown fixture asset ${id}`);
  object.attributes = object.attributes.filter((attr) => !body.attributes.some((next) => next.objectTypeAttributeId === attr.objectTypeAttributeId));
  object.attributes.push(...body.attributes.map((attr) => ({
    ...attr, objectAttributeValues: attr.objectAttributeValues.map((value) => ({
      ...value,
      ...(attr.objectTypeAttributeId === "student" ? { referencedObject: students.find((student) => student.objectKey === value.value) } : {}),
    })),
  })));
  object.updated = new Date().toISOString();
  return structuredClone(object);
};
useSettings.setState({ schemaId: "1", objectTypeId: "1", columns: {}, rules: [] });
useUi.setState({ editing: null, staleAssets: {}, search: "", rawAql: "" });
const fixture = {
    writes, failIds, objects,
    hideUpdated: () => { hideUpdated = true; },
    markStale: (id: string) => useUi.getState().markAssetStale(id, "Fixture stale asset"),
    setSearch: (search: string) => useUi.getState().setSearch(search),
    hideStudent: () => useSettings.getState().setColumnPrefs("1", { hidden: ["student"], sizes: {} }),
    enableRule: () => useSettings.setState({ rules: [{
      id: "active", name: "Activate", enabled: true, cloudId: "test", workspaceId: "test", schemaId: "1",
      objectTypeId: "1", operations: ["batch"], watchedAttributeIds: ["student"], match: "any",
      conditions: [{ id: "set", attributeId: "student", operator: "isSet" }],
      actions: [{ id: "activate", attributeId: "status", value: { raw: "active", display: "Active" } }],
    }] }),
};
export type BulkFixture = typeof fixture;
declare global {
  interface Window { bulkFixture: BulkFixture }
}
window.bulkFixture = fixture;
const root = document.getElementById("root");
if (!root) throw new Error("Missing test root");
createRoot(root).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <div className="flex h-screen flex-col"><AssetsPage /></div>
  </QueryClientProvider>,
);
