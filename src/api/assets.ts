import { assetsRequest, connectionApi } from "./client";
import { excludeDeleted } from "@/lib/deletion";
import { useSettings } from "@/store/settings";
import type {
  AqlResult,
  AssetObject,
  ObjectHistory,
  ObjectIn,
  ObjectSchema,
  ObjectType,
  ObjectTypeAttribute,
  PagedResult,
  ReferenceTypeInfo,
  StatusType,
} from "./types";

export const PAGE_SIZE = 100;

async function visibleQuery(query: string) {
  const configs = useSettings.getState().deletions;
  if (!Object.keys(configs).length) return query;
  return excludeDeleted(query, configs, await connectionApi.get());
}

export const assetsApi = {
  listSchemas: async (): Promise<ObjectSchema[]> => {
    const all: ObjectSchema[] = [];
    let startAt = 0;
    for (;;) {
      const page = await assetsRequest<PagedResult<ObjectSchema>>("GET", "/objectschema/list", {
        query: { startAt, maxResults: 50 },
      });
      all.push(...page.values);
      startAt += page.values.length;
      if (isLast(page) || page.values.length === 0) return all;
    }
  },

  listObjectTypes: (schemaId: string) =>
    assetsRequest<ObjectType[]>("GET", `/objectschema/${encodeURIComponent(schemaId)}/objecttypes/flat`),

  getObjectType: (objectTypeId: string) =>
    assetsRequest<ObjectType>("GET", `/objecttype/${encodeURIComponent(objectTypeId)}`),

  getObjectTypeAttributes: (objectTypeId: string) =>
    assetsRequest<ObjectTypeAttribute[]>("GET", `/objecttype/${encodeURIComponent(objectTypeId)}/attributes`),

  searchObjects: async (qlQuery: string, startAt = 0, maxResults = PAGE_SIZE) =>
    assetsRequest<AqlResult>("POST", "/object/aql", {
      query: { startAt, maxResults, includeAttributes: true },
      body: { qlQuery: await visibleQuery(qlQuery) },
    }),

  searchExportObjects: async (qlQuery: string, startAt = 0, selected = false): Promise<AqlResult> => {
    const page = await assetsRequest<unknown>("POST", "/object/aql", {
      query: { startAt, maxResults: PAGE_SIZE, includeAttributes: true },
      body: { qlQuery: selected ? qlQuery : await visibleQuery(qlQuery) },
    });
    validateExportPage(page, startAt);
    return page;
  },

  countObjects: async (qlQuery: string) =>
    (await assetsRequest<{ totalCount: number }>("POST", "/object/aql/totalcount", { body: { qlQuery: await visibleQuery(qlQuery) } })).totalCount,

  getObject: (id: string) => assetsRequest<AssetObject>("GET", `/object/${encodeURIComponent(id)}`),

  createObject: (body: ObjectIn) => assetsRequest<AssetObject>("POST", "/object/create", { body }),

  updateObject: (id: string, body: ObjectIn) =>
    assetsRequest<AssetObject>("PUT", `/object/${encodeURIComponent(id)}`, { body }),

  deleteObject: (id: string) => assetsRequest<void>("DELETE", `/object/${encodeURIComponent(id)}`),

  getHistory: (id: string) =>
    assetsRequest<ObjectHistory[]>("GET", `/object/${encodeURIComponent(id)}/history`, { query: { asc: false } }),

  getReferenceInfo: (id: string) =>
    assetsRequest<ReferenceTypeInfo[]>("GET", `/object/${encodeURIComponent(id)}/referenceinfo`),

  listStatusTypes: (objectSchemaId?: string) =>
    assetsRequest<StatusType[]>("GET", "/config/statustype", { query: { objectSchemaId } }),
};

export function selectedExportQuery(ids: string[]): string {
  if (!ids.length || ids.length > PAGE_SIZE || ids.some((id) => typeof id !== "string" || !/^[1-9]\d*$/.test(id))) {
    throw new Error("Selected asset IDs must be positive numeric Jira IDs (at most 100 per batch).");
  }
  // Keep IDs as strings: Jira IDs can exceed JavaScript's safe integer range.
  return `objectId IN (${ids.join(",")}) ORDER BY Key ASC`;
}

export function validateExportPage(value: unknown, startAt: number): asserts value is AqlResult {
  const record = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item);
  const attributeValue = (item: unknown) => record(item)
    && ["value", "displayValue", "searchValue"].every((key) => item[key] == null || typeof item[key] === "string")
    && [["referencedObject", "label"], ["status", "name"], ["user", "displayName"], ["group", "name"]].every(([key, label]) =>
      item[key] == null || (record(item[key]) && (item[key][label] == null || typeof item[key][label] === "string")));
  if (!record(value) || value.startAt !== startAt || !Number.isSafeInteger(value.startAt)
    || !Number.isSafeInteger(value.maxResults) || Number(value.maxResults) <= 0 || Number(value.maxResults) > PAGE_SIZE
    || ![true, false, "true", "false"].includes(value.isLast as boolean | string)
    || (value.total !== undefined && (!Number.isSafeInteger(value.total) || Number(value.total) < 0))
    || !Array.isArray(value.values) || value.values.length > Number(value.maxResults)
    || (!value.values.length && value.isLast !== true && value.isLast !== "true")) {
    throw new Error("The server returned an incomplete export page. Retry the export.");
  }
  for (const object of value.values) {
    if (!record(object) || typeof object.id !== "string" || !/^[1-9]\d*$/.test(object.id)
      || !record(object.objectType) || typeof object.objectType.id !== "string"
      || !["objectKey", "label", "created", "updated"].every((key) => typeof object[key] === "string")
      || !Array.isArray(object.attributes) || !object.attributes.every((attribute: unknown) =>
        record(attribute) && typeof attribute.objectTypeAttributeId === "string"
        && Array.isArray(attribute.objectAttributeValues) && attribute.objectAttributeValues.every(attributeValue))) {
      throw new Error("The export response did not include complete asset attributes.");
    }
  }
}

export async function getCompleteObject(id: string): Promise<AssetObject> {
  const object = await assetsApi.getObject(id);
  if (!Array.isArray(object.attributes)) throw new Error("The asset response did not include its attributes.");
  if (object.id !== id) throw new Error("The asset response did not match the requested asset.");
  return object;
}

export function isLast(page: { isLast: boolean | string }) {
  return page.isLast === true || page.isLast === "true";
}
