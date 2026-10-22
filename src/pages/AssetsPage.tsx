import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColumnSizingState, RowSelectionState, SortingState, VisibilityState } from "@tanstack/react-table";
import { Database, Loader2, PlugZap, Plus, RefreshCw } from "lucide-react";
import {
  useAssetsInfinite,
  useAttributes,
  useConnection,
  useObjectTypes,
  useSchemas,
  useStatusTypes,
  useTotalCount,
} from "@/api/queries";
import type { AssetObject } from "@/api/types";
import { AssetGrid } from "@/components/assets/AssetGrid";
import { ColumnDrawer } from "@/components/assets/ColumnDrawer";
import { CreateAssetDialog } from "@/components/assets/CreateAssetDialog";
import { DetailDrawer } from "@/components/assets/DetailDrawer";
import { FilterBar } from "@/components/assets/FilterBar";
import { PrintActionBar } from "@/components/assets/PrintActionBar";
import { EmptyState, PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/primitives";
import { useDebounce } from "@/hooks/useDebounce";
import { buildAssetsQuery } from "@/lib/aql";
import { sortAttributes } from "@/lib/attributes";
import { notify } from "@/lib/notify";
import { useSettings, type ColumnPrefs } from "@/store/settings";
import { useUi } from "@/store/ui";

const DEFAULT_HIDDEN_NAMES = new Set(["created", "updated"]);
const DEFAULT_VISIBLE_COUNT = 10;

export function AssetsPage() {
  const connection = useConnection();
  const { schemaId, objectTypeId, columns: columnPrefs, setColumnPrefs, resetColumnPrefs } = useSettings();
  const { search, searchField, rawAql, navigate } = useUi();

  const schemas = useSchemas();
  const objectTypes = useObjectTypes(schemaId);
  const attrsQuery = useAttributes(objectTypeId);
  const statuses = useStatusTypes(schemaId);

  const attributes = useMemo(
    () => sortAttributes(attrsQuery.data ?? []).filter((a) => !a.hidden),
    [attrsQuery.data],
  );

  const [sorting, setSorting] = useState<SortingState>([]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [selectingAll, setSelectingAll] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const debouncedSearch = useDebounce(search, 300);

  const sortAttr = sorting[0] ? attributes.find((a) => a.id === sorting[0].id) : undefined;
  const query = useMemo(
    () =>
      objectTypeId && attrsQuery.isSuccess
        ? buildAssetsQuery({
            objectTypeId,
            search: debouncedSearch,
            searchField,
            rawAql,
            attributes,
            sort: sortAttr ? { attrName: sortAttr.name, desc: sorting[0].desc } : null,
          })
        : null,
    [objectTypeId, attrsQuery.isSuccess, debouncedSearch, searchField, rawAql, attributes, sortAttr, sorting],
  );

  const objects = useAssetsInfinite(query?.full ?? null);
  const total = useTotalCount(query?.where ?? null);
  const rows = useMemo(() => objects.data?.pages.flatMap((p) => p.values) ?? [], [objects.data]);

  useEffect(() => setRowSelection({}), [query?.where]);

  // Column visibility & sizing (persisted per object type)
  const prefs: ColumnPrefs | undefined = objectTypeId ? columnPrefs[objectTypeId] : undefined;
  const hidden = useMemo(() => {
    if (prefs) return new Set(prefs.hidden);
    return new Set(
      attributes
        .filter((a, i) => DEFAULT_HIDDEN_NAMES.has(a.name.toLowerCase()) || (i >= DEFAULT_VISIBLE_COUNT && !a.label))
        .map((a) => a.id),
    );
  }, [prefs, attributes]);
  const columnVisibility = useMemo<VisibilityState>(
    () => Object.fromEntries([...hidden].map((id) => [id, false])),
    [hidden],
  );
  const columnSizing: ColumnSizingState = prefs?.sizes ?? {};
  const savePrefs = (patch: Partial<ColumnPrefs>) =>
    objectTypeId && setColumnPrefs(objectTypeId, { hidden: [...hidden], sizes: columnSizing, ...prefs, ...patch });

  const orderedAttributes = useMemo(() => {
    const order = prefs?.order;
    if (!order?.length) return attributes;
    const byId = new Map(attributes.map((a) => [a.id, a]));
    const known = order.flatMap((id) => byId.get(id) ?? []);
    const seen = new Set(known.map((a) => a.id));
    return [...known, ...attributes.filter((a) => !seen.has(a.id))];
  }, [prefs?.order, attributes]);
  const moveColumn = (activeId: string, overId: string) => {
    const ids = orderedAttributes.map((a) => a.id);
    const from = ids.indexOf(activeId);
    const to = ids.indexOf(overId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, activeId);
    savePrefs({ order: ids });
  };

  const selectedObjects = useMemo(() => rows.filter((r) => rowSelection[r.id]), [rows, rowSelection]);
  const findLoaded = useCallback((id: string) => rows.find((r) => r.id === id), [rows]);

  const selectAllMatching = async () => {
    setSelectingAll(true);
    try {
      let data = objects.data;
      let more = objects.hasNextPage;
      while (more) {
        const next = await objects.fetchNextPage();
        if (next.isError) throw next.error;
        data = next.data;
        more = next.hasNextPage;
      }
      const all: AssetObject[] = data?.pages.flatMap((p) => p.values) ?? [];
      setRowSelection(Object.fromEntries(all.map((o) => [o.id, true])));
    } catch (e) {
      notify.error(e, "Could not load all matching objects");
    } finally {
      setSelectingAll(false);
    }
  };

  if (!connection.isLoading && !connection.data) {
    return (
      <div className="flex-1 overflow-auto p-8">
        <PageHeader title="Assets" />
        <EmptyState icon={<PlugZap />} title="Not connected to JIRA Assets">
          <p className="mb-4">Add your Atlassian site and API token to get started.</p>
          <Button onClick={() => navigate("settings", "connection")}>Open connection settings</Button>
        </EmptyState>
      </div>
    );
  }

  if (!schemaId || !objectTypeId) {
    return (
      <div className="flex-1 overflow-auto p-8">
        <PageHeader title="Assets" />
        <EmptyState icon={<Database />} title="Choose a schema and object type">
          <p className="mb-4">Select which JIRA Assets object type to manage.</p>
          <Button onClick={() => navigate("settings", "schema")}>Select schema</Button>
        </EmptyState>
      </div>
    );
  }

  const schemaName = schemas.data?.find((s) => s.id === schemaId)?.name ?? "…";
  const typeName = objectTypes.data?.find((t) => t.id === objectTypeId)?.name ?? "…";
  const queryError = objects.error ? objects.error.message : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col p-6">
      <PageHeader
        title="Assets Management"
        description={
          <>
            {total.data !== undefined ? `Showing ${total.data.toLocaleString()}` : "Loading"} {typeName} objects in
            the "{schemaName}" schema
            {rows.length > 0 && total.data !== undefined && rows.length < total.data && ` · ${rows.length.toLocaleString()} loaded`}
          </>
        }
        actions={
          <>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus /> Add
            </Button>
            <ColumnDrawer
              attributes={orderedAttributes}
              hidden={hidden}
              onChange={(h) => savePrefs({ hidden: [...h] })}
              onReset={() => objectTypeId && resetColumnPrefs(objectTypeId)}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                objects.refetch();
                total.refetch();
              }}
              disabled={objects.isFetching}
            >
              {objects.isFetching ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh
            </Button>
          </>
        }
      />

      <FilterBar attributes={attributes} error={queryError} />

      {objects.isLoading || attrsQuery.isLoading ? (
        <div className="grid gap-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      ) : rows.length === 0 && !objects.isFetching ? (
        <EmptyState icon={<Database />} title="No objects match">
          Adjust the search or AQL filter.
        </EmptyState>
      ) : (
        <AssetGrid
          rows={rows}
          attributes={orderedAttributes}
          statuses={statuses.data ?? []}
          sorting={sorting}
          onSortingChange={setSorting}
          rowSelection={rowSelection}
          onRowSelectionChange={setRowSelection}
          columnVisibility={columnVisibility}
          columnSizing={columnSizing}
          onColumnSizingChange={(updater) =>
            savePrefs({ sizes: typeof updater === "function" ? updater(columnSizing) : updater })
          }
          onReorderColumn={moveColumn}
          hasNextPage={!!objects.hasNextPage}
          isFetchingNextPage={objects.isFetchingNextPage}
          fetchNextPage={objects.fetchNextPage}
        />
      )}

      <PrintActionBar
        selected={selectedObjects}
        attributes={attributes}
        totalMatching={total.data}
        onSelectAllMatching={selectAllMatching}
        selectingAll={selectingAll}
        onClear={() => setRowSelection({})}
      />

      <DetailDrawer fallback={findLoaded} />

      <CreateAssetDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        objectTypeId={objectTypeId}
        objectTypeName={typeName}
        attributes={attributes}
        statuses={statuses.data ?? []}
      />
    </div>
  );
}
