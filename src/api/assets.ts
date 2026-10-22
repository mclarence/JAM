import { assetsRequest } from "./client";
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

  getObjectTypeAttributes: (objectTypeId: string) =>
    assetsRequest<ObjectTypeAttribute[]>("GET", `/objecttype/${encodeURIComponent(objectTypeId)}/attributes`),

  searchObjects: (qlQuery: string, startAt = 0, maxResults = PAGE_SIZE) =>
    assetsRequest<AqlResult>("POST", "/object/aql", {
      query: { startAt, maxResults, includeAttributes: true },
      body: { qlQuery },
    }),

  countObjects: async (qlQuery: string) =>
    (await assetsRequest<{ totalCount: number }>("POST", "/object/aql/totalcount", { body: { qlQuery } })).totalCount,

  getObject: (id: string) => assetsRequest<AssetObject>("GET", `/object/${encodeURIComponent(id)}`),

  createObject: (body: ObjectIn) => assetsRequest<AssetObject>("POST", "/object/create", { body }),

  updateObject: (id: string, body: ObjectIn) =>
    assetsRequest<AssetObject>("PUT", `/object/${encodeURIComponent(id)}`, { body }),

  getHistory: (id: string) =>
    assetsRequest<ObjectHistory[]>("GET", `/object/${encodeURIComponent(id)}/history`, { query: { asc: false } }),

  getReferenceInfo: (id: string) =>
    assetsRequest<ReferenceTypeInfo[]>("GET", `/object/${encodeURIComponent(id)}/referenceinfo`),

  listStatusTypes: (objectSchemaId?: string) =>
    assetsRequest<StatusType[]>("GET", "/config/statustype", { query: { objectSchemaId } }),
};

export function isLast(page: { isLast: boolean | string }) {
  return page.isLast === true || page.isLast === "true";
}
