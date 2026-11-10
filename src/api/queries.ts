import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { assetsApi, isLast, PAGE_SIZE } from "./assets";
import { ApiError, connectionApi } from "./client";
import type { AqlResult, AssetObject, ConnectionInfo, ObjectAttributeValue, ObjectIn, ObjectTypeAttribute, StatusType } from "./types";
import { qk } from "./queryKeys";
import { applyMutationResult, captureMutationContext, reconcileAssetObject, reconcileAssetPage, refreshLockedAsset, refreshMutationQueries } from "./mutationCache";
import { allFieldsClause, aqlAttr, aqlString } from "@/lib/aql";
import { notify } from "@/lib/notify";
import { beginAssetMutation, createPrepared, prepareCreate, prepareUpdate, updatePrepared } from "@/lib/ruleMutations";
import { useSettings } from "@/store/settings";
import { workspaceDeletions } from "@/lib/deletion";

export { qk } from "./queryKeys";

export function useConnection() {
  return useQuery({ queryKey: qk.connection, queryFn: connectionApi.get, staleTime: Infinity });
}

export function useDeletionVisibility() {
  const connection = useConnection().data ?? null;
  const configs = useSettings((s) => s.deletions);
  return JSON.stringify([connection?.cloudId, connection?.workspaceId, workspaceDeletions(configs, connection)]);
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
      const permitted = async (id?: string): Promise<StatusType[]> => {
        try {
          return await assetsApi.listStatusTypes(id);
        } catch (error) {
          if (error instanceof ApiError && error.status === 403) return [];
          throw error;
        }
      };
      const [global, scoped] = await Promise.all([
        permitted(),
        schemaId ? permitted(schemaId) : Promise.resolve([]),
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
  const qc = useQueryClient();
  const visibility = useDeletionVisibility();
  return useInfiniteQuery({
    queryKey: [...qk.objects(aql ?? ""), visibility],
    queryFn: async ({ pageParam }) => reconcileAssetPage(qc, await assetsApi.searchObjects(aql!, pageParam, PAGE_SIZE)),
    initialPageParam: 0,
    getNextPageParam: (last: AqlResult) =>
      isLast(last) || (last.nextStartAt ?? last.startAt + last.values.length) <= last.startAt
        ? undefined : last.nextStartAt ?? last.startAt + last.values.length,
    enabled: connected && !!aql,
    placeholderData: (previous, query) => query?.queryKey[2] === visibility ? previous : undefined,
    retry: false,
  });
}

export function useTotalCount(aql: string | null) {
  const connected = useConnected();
  const visibility = useDeletionVisibility();
  return useQuery({
    queryKey: [...qk.count(aql ?? ""), visibility],
    queryFn: () => assetsApi.countObjects(aql!),
    enabled: connected && !!aql,
    retry: false,
  });
}

export function useObject(id: string | null) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: qk.object(id ?? ""),
    queryFn: async () => reconcileAssetObject(qc, await assetsApi.getObject(id!)),
    enabled: !!id,
  });
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
  const visibility = useDeletionVisibility();
  const qc = useQueryClient();
  return useQuery({
    queryKey: [...qk.inbound(objectKey ?? ""), visibility],
    queryFn: async () =>
      reconcileAssetPage(qc, await assetsApi.searchObjects(`object HAVING outboundReferences(Key = ${aqlString(objectKey!)})`, 0, 50))
        .values,
    enabled: !!objectKey,
  });
}

export function useReferenceSearch(refTypeId: string | undefined, term: string) {
  const visibility = useDeletionVisibility();
  const qc = useQueryClient();
  const attrs = useAttributes(refTypeId);
  const labelAttr = attrs.data?.find((a) => a.label)?.name ?? "Name";
  const search = useQuery({
    queryKey: [...qk.refSearch(refTypeId ?? "", term), visibility],
    queryFn: async () => {
      const t = term.trim();
      let q = `objectTypeId = ${Number(refTypeId)}`;
      if (t) q += ` AND ${allFieldsClause(t, attrs.data ?? [])}`;
      q += ` ORDER BY ${aqlAttr(labelAttr)} ASC`;
      return reconcileAssetPage(qc, await assetsApi.searchObjects(q, 0, 25)).values;
    },
    enabled: !!refTypeId && attrs.isSuccess,
    placeholderData: (previous, query) => query?.queryKey[3] === visibility ? previous : undefined,
  });
  return {
    ...search,
    isError: attrs.isError || search.isError,
    error: attrs.error ?? search.error,
    retry: () => attrs.isError ? attrs.refetch() : search.refetch(),
  };
}

export function useCreateObject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ body, attributes }: { body: ObjectIn; attributes: ObjectTypeAttribute[] }) => {
      const prepared = await prepareCreate({
        body,
        attributes,
        rules: useSettings.getState().rules,
        connection: qc.getQueryData<ConnectionInfo | null>(qk.connection) ?? undefined,
        isCurrent: captureMutationContext(qc),
      });
      return createPrepared(prepared);
    },
    onSuccess: async (result) => {
      applyMutationResult(qc, result);
      await refreshMutationQueries(qc, [result]);
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

const updateContexts = new WeakMap<UpdateAttributeInput, () => boolean>();

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
    mutationFn: async (input: UpdateAttributeInput) => {
      const { object, attr, value } = input;
      const isCurrent = updateContexts.get(input);
      if (!isCurrent?.()) throw new Error("The connection changed while the operation was running. Try again on the current workspace.");
      const prepared = await prepareUpdate({
        object,
        operation: "edit",
        rules: useSettings.getState().rules,
        attributes: [attr],
        connection: qc.getQueryData<ConnectionInfo | null>(qk.connection) ?? undefined,
        isCurrent,
        buildChanges: () => ({
          payload: [{ objectTypeAttributeId: attr.id, objectAttributeValues: value === "" ? [] : [{ value }] }],
          changes: [],
        }),
      });
      return updatePrepared(prepared);
    },
    onMutate: async (input) => {
      const { object, attr, optimistic } = input;
      const release = beginAssetMutation(object.id);
      const isCurrent = captureMutationContext(qc);
      updateContexts.set(input, isCurrent);
      try {
        await qc.cancelQueries({ queryKey: ["objects"] });
        await qc.cancelQueries({ queryKey: qk.object(object.id) });
        if (!isCurrent()) throw new Error("The connection changed while the operation was running. Try again on the current workspace.");
        const previous = qc.getQueryData<AssetObject>(qk.object(object.id)) ?? object;
        patchCaches(object.id, (o) => withAttribute(o, attr.id, optimistic));
        return { previous, release, isCurrent };
      } catch (error) {
        updateContexts.delete(input);
        release();
        throw error;
      }
    },
    onError: async (e, { object, attr }, ctx) => {
      if (ctx?.isCurrent()) patchCaches(object.id, () => ctx.previous);
      notify.error(e, `Could not update "${attr.name}"`);
      if (ctx?.isCurrent()) await refreshLockedAsset(qc, object.id);
    },
    onSuccess: async (result) => {
      applyMutationResult(qc, result);
      await refreshMutationQueries(qc, [result]);
    },
    onSettled: (_d, _e, input, ctx) => {
      if (ctx) updateContexts.delete(input);
      ctx?.release();
      if (ctx?.isCurrent()) void qc.invalidateQueries({ queryKey: qk.history(input.object.id) });
    },
  });
}
