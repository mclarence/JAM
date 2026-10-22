import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { assetsApi, isLast, PAGE_SIZE } from "./assets";
import { connectionApi } from "./client";
import type { AqlResult, AssetObject, ObjectAttributeValue, ObjectTypeAttribute, StatusType } from "./types";
import { aqlAttr, aqlString } from "@/lib/aql";
import { notify } from "@/lib/notify";

export const qk = {
  connection: ["connection"] as const,
  schemas: ["schemas"] as const,
  objectTypes: (schemaId: string) => ["objectTypes", schemaId] as const,
  attributes: (typeId: string) => ["attributes", typeId] as const,
  statusTypes: (schemaId: string) => ["statusTypes", schemaId] as const,
  objects: (aql: string) => ["objects", aql] as const,
  count: (aql: string) => ["count", aql] as const,
  object: (id: string) => ["object", id] as const,
  history: (id: string) => ["history", id] as const,
  referenceInfo: (id: string) => ["referenceInfo", id] as const,
  inbound: (key: string) => ["inbound", key] as const,
  refSearch: (typeId: string, term: string) => ["refSearch", typeId, term] as const,
};

export function useConnection() {
  return useQuery({ queryKey: qk.connection, queryFn: connectionApi.get, staleTime: Infinity });
}

function useConnected() {
  return !!useConnection().data;
}

export function useSchemas() {
  const connected = useConnected();
  return useQuery({ queryKey: qk.schemas, queryFn: assetsApi.listSchemas, enabled: connected });
}

export function useObjectTypes(schemaId: string | null) {
  const connected = useConnected();
  return useQuery({
    queryKey: qk.objectTypes(schemaId ?? ""),
    queryFn: () => assetsApi.listObjectTypes(schemaId!),
    enabled: connected && !!schemaId,
  });
}

export function useAttributes(objectTypeId: string | null | undefined) {
  const connected = useConnected();
  return useQuery({
    queryKey: qk.attributes(objectTypeId ?? ""),
    queryFn: () => assetsApi.getObjectTypeAttributes(objectTypeId!),
    enabled: connected && !!objectTypeId,
    staleTime: 5 * 60_000,
  });
}

/** Global status types plus those scoped to the schema. */
export function useStatusTypes(schemaId: string | null) {
  const connected = useConnected();
  return useQuery({
    queryKey: qk.statusTypes(schemaId ?? ""),
    queryFn: async () => {
      // Optional: tokens without read:cmdb-config:jira get no status colours.
      const none = () => [] as StatusType[];
      const [global, scoped] = await Promise.all([
        assetsApi.listStatusTypes().catch(none),
        schemaId ? assetsApi.listStatusTypes(schemaId).catch(none) : Promise.resolve(none()),
      ]);
      const byId = new Map<string, StatusType>();
      [...global, ...scoped].forEach((s) => byId.set(s.id, s));
      return [...byId.values()];
    },
    enabled: connected,
    staleTime: 5 * 60_000,
  });
}

export function useAssetsInfinite(aql: string | null) {
  const connected = useConnected();
  return useInfiniteQuery({
    queryKey: qk.objects(aql ?? ""),
    queryFn: ({ pageParam }) => assetsApi.searchObjects(aql!, pageParam, PAGE_SIZE),
    initialPageParam: 0,
    getNextPageParam: (last: AqlResult) =>
      isLast(last) || last.values.length === 0 ? undefined : last.startAt + last.values.length,
    enabled: connected && !!aql,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useTotalCount(aql: string | null) {
  const connected = useConnected();
  return useQuery({
    queryKey: qk.count(aql ?? ""),
    queryFn: () => assetsApi.countObjects(aql!),
    enabled: connected && !!aql,
    retry: false,
  });
}

export function useObject(id: string | null) {
  return useQuery({ queryKey: qk.object(id ?? ""), queryFn: () => assetsApi.getObject(id!), enabled: !!id });
}

export function useHistory(id: string | null) {
  return useQuery({ queryKey: qk.history(id ?? ""), queryFn: () => assetsApi.getHistory(id!), enabled: !!id });
}

export function useReferenceInfo(id: string | null) {
  return useQuery({
    queryKey: qk.referenceInfo(id ?? ""),
    queryFn: () => assetsApi.getReferenceInfo(id!),
    enabled: !!id,
  });
}

/** Objects that reference the given object. */
export function useInboundReferences(objectKey: string | null) {
  return useQuery({
    queryKey: qk.inbound(objectKey ?? ""),
    queryFn: async () =>
      (await assetsApi.searchObjects(`object HAVING outboundReferences(Key = ${aqlString(objectKey!)})`, 0, 50))
        .values,
    enabled: !!objectKey,
  });
}

export function useReferenceSearch(refTypeId: string | undefined, term: string) {
  const attrs = useAttributes(refTypeId);
  const labelAttr = attrs.data?.find((a) => a.label)?.name ?? "Name";
  return useQuery({
    queryKey: qk.refSearch(refTypeId ?? "", term),
    queryFn: async () => {
      const t = term.trim();
      let q = `objectTypeId = ${Number(refTypeId)}`;
      if (t) q += ` AND (Key = ${aqlString(t)} OR ${aqlAttr(labelAttr)} LIKE ${aqlString(t)})`;
      q += ` ORDER BY ${aqlAttr(labelAttr)} ASC`;
      return (await assetsApi.searchObjects(q, 0, 25)).values;
    },
    enabled: !!refTypeId && attrs.isSuccess,
    placeholderData: keepPreviousData,
  });
}

export function useCreateObject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: assetsApi.createObject,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["objects"] });
      qc.invalidateQueries({ queryKey: ["count"] });
    },
  });
}

export interface UpdateAttributeInput {
  object: AssetObject;
  attr: ObjectTypeAttribute;
  /** Raw API value (status id, object key, ISO date, text); empty string clears. */
  value: string;
  optimistic: ObjectAttributeValue[];
}

function withAttribute(o: AssetObject, attrId: string, values: ObjectAttributeValue[]): AssetObject {
  const exists = o.attributes.some((a) => a.objectTypeAttributeId === attrId);
  const attributes = exists
    ? o.attributes.map((a) => (a.objectTypeAttributeId === attrId ? { ...a, objectAttributeValues: values } : a))
    : [...o.attributes, { objectTypeAttributeId: attrId, objectAttributeValues: values }];
  return { ...o, attributes };
}

export function useUpdateAttribute() {
  const qc = useQueryClient();

  const patchCaches = (id: string, fn: (o: AssetObject) => AssetObject) => {
    qc.setQueriesData<InfiniteData<AqlResult>>({ queryKey: ["objects"] }, (d) =>
      d
        ? { ...d, pages: d.pages.map((p) => ({ ...p, values: p.values.map((o) => (o.id === id ? fn(o) : o)) })) }
        : d,
    );
    qc.setQueryData<AssetObject>(qk.object(id), (o) => (o ? fn(o) : o));
  };

  return useMutation({
    mutationFn: ({ object, attr, value }: UpdateAttributeInput) =>
      assetsApi.updateObject(object.id, {
        objectTypeId: object.objectType.id,
        attributes: [
          { objectTypeAttributeId: attr.id, objectAttributeValues: value === "" ? [] : [{ value }] },
        ],
      }),
    onMutate: async ({ object, attr, optimistic }) => {
      await qc.cancelQueries({ queryKey: ["objects"] });
      await qc.cancelQueries({ queryKey: qk.object(object.id) });
      const snapshot = [
        ...qc.getQueriesData({ queryKey: ["objects"] }),
        ...qc.getQueriesData({ queryKey: qk.object(object.id) }),
      ];
      patchCaches(object.id, (o) => withAttribute(o, attr.id, optimistic));
      return { snapshot };
    },
    onError: (e, { attr }, ctx) => {
      ctx?.snapshot.forEach(([key, data]) => qc.setQueryData(key, data));
      notify.error(e, `Could not update "${attr.name}"`);
    },
    onSuccess: (updated, { object }) => {
      if (updated?.id) patchCaches(object.id, (o) => ({ ...o, ...updated, attributes: updated.attributes ?? o.attributes }));
    },
    onSettled: (_d, _e, { object }) => {
      qc.invalidateQueries({ queryKey: qk.history(object.id) });
    },
  });
}
