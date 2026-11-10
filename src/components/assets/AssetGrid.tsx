import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnSizingState,
  type OnChangeFn,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Loader2, Maximize2 } from "lucide-react";
import type { AssetObject, ObjectTypeAttribute, StatusType } from "@/api/types";
import { useUpdateAttribute } from "@/api/queries";
import { Checkbox } from "@/components/ui/primitives";
import { editorKind, getAttrValues } from "@/lib/attributes";
import { cn, modKey } from "@/lib/utils";
import { notify } from "@/lib/notify";
import { useCellSelection } from "@/hooks/useCellSelection";
import type { InlineBulkInput } from "@/hooks/useInlineBulkUpdate";
import { useUi } from "@/store/ui";
import { AttributeValue } from "./AttributeValue";
import { CellEditor } from "./CellEditor";

const ROW_HEIGHT = 36;

function HeaderCell({ id, width, draggable, children }: { id: string; width: number; draggable: boolean; children: ReactNode }) {
  const drag = useDraggable({ id, disabled: !draggable });
  const drop = useDroppable({ id, disabled: !draggable });
  const x = drag.transform?.x ?? 0;
  return (
    <div
      ref={(el) => {
        drag.setNodeRef(el);
        drop.setNodeRef(el);
      }}
      {...drag.attributes}
      {...drag.listeners}
      style={{ width, transform: x ? `translate3d(${x}px, 0, 0)` : undefined }}
      className={cn(
        "group/h relative flex h-9 shrink-0 items-center border-r bg-card px-3 last:border-r-0",
        draggable && "cursor-grab",
        drag.isDragging && "z-20 cursor-grabbing opacity-80 shadow-md",
        drop.isOver && !drag.isDragging && "bg-accent",
      )}
    >
      {children}
    </div>
  );
}

interface Props {
  rows: AssetObject[];
  attributes: ObjectTypeAttribute[];
  statuses: StatusType[];
  sorting: SortingState;
  onSortingChange: OnChangeFn<SortingState>;
  rowSelection: RowSelectionState;
  onRowSelectionChange: OnChangeFn<RowSelectionState>;
  columnVisibility: VisibilityState;
  columnSizing: ColumnSizingState;
  onColumnSizingChange: OnChangeFn<ColumnSizingState>;
  onReorderColumn: (activeId: string, overId: string) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  selectionContext: string;
  bulkBusy: boolean;
  onBulkCommit: (input: InlineBulkInput) => void;
}

export function AssetGrid(props: Props) {
  const { rows, attributes, statuses, hasNextPage, isFetchingNextPage, fetchNextPage } = props;
  const { editing, setEditing, openDetail } = useUi();
  const staleAssets = useUi((state) => state.staleAssets);
  const update = useUpdateAttribute();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [bulkEdit, setBulkEdit] = useState<{ objects: AssetObject[]; attrId: string; anchorId: string; context: string } | null>(null);
  const rowIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const rowsById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const editableIds = useMemo(() => attributes
    .filter((attr) => props.columnVisibility[attr.id] !== false && editorKind(attr) !== "readonly")
    .map((attr) => attr.id), [attributes, props.columnVisibility]);
  const cells = useCellSelection({
    scrollRef, rowIds, attributeIds: editableIds, context: props.selectionContext,
    disabled: props.bulkBusy || update.isPending || !!editing, rowHeight: ROW_HEIGHT,
    onClear: () => {
      setBulkEdit(null);
      setEditing(null);
    },
  });
  const highlightedIds = useMemo(() => new Set(cells.selection?.ids), [cells.selection]);
  useEffect(() => () => setEditing(null), [setEditing]);
  // The distance threshold keeps plain header clicks working as sort toggles.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) props.onReorderColumn(String(active.id), String(over.id));
  };

  const columns = useMemo<ColumnDef<AssetObject>[]>(
    () => [
      {
        id: "__select",
        size: 64,
        enableResizing: false,
        enableSorting: false,
        enableHiding: false,
        header: ({ table }) => (
          <Checkbox
            aria-label="Select all loaded rows"
            checked={table.getIsAllRowsSelected() ? true : table.getIsSomeRowsSelected() ? "indeterminate" : false}
            onCheckedChange={(v) => table.toggleAllRowsSelected(!!v)}
          />
        ),
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <Checkbox
              aria-label="Select row"
              checked={row.getIsSelected()}
              onCheckedChange={(v) => row.toggleSelected(!!v)}
              onClick={(e) => e.stopPropagation()}
            />
            <button
              type="button"
              aria-label="Open details"
              className="rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground"
              onClick={() => openDetail(row.original.id)}
            >
              <Maximize2 className="size-3.5" />
            </button>
          </div>
        ),
      },
      ...attributes.map<ColumnDef<AssetObject>>((attr) => ({
        id: attr.id,
        header: attr.name,
        size: attr.label ? 240 : 180,
        minSize: 80,
        enableSorting: attr.sortable !== false,
        accessorFn: (o) => o,
        cell: ({ row }) => <AttributeValue attr={attr} values={getAttrValues(row.original, attr.id)} />,
        meta: { attr },
      })),
    ],
    [attributes, openDetail],
  );

  const table = useReactTable({
    data: rows,
    columns,
    getRowId: (o) => o.id,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    enableMultiSort: false,
    enableRowSelection: true,
    columnResizeMode: "onChange",
    state: {
      sorting: props.sorting,
      rowSelection: props.rowSelection,
      columnVisibility: props.columnVisibility,
      columnSizing: props.columnSizing,
    },
    onSortingChange: props.onSortingChange,
    onRowSelectionChange: props.onRowSelectionChange,
    onColumnSizingChange: props.onColumnSizingChange,
  });

  const tableRows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastIndex = virtualItems.at(-1)?.index ?? 0;
  useEffect(() => {
    if (editing && !virtualItems.some((item) => tableRows[item.index]?.id === editing.objectId)) {
      setEditing(null);
      setBulkEdit(null);
    }
  }, [editing, virtualItems, tableRows, setEditing]);

  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && lastIndex >= tableRows.length - 20) fetchNextPage();
  }, [lastIndex, tableRows.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const totalWidth = table.getTotalSize();

  return (
    <>
    <div data-cell-selection-controls className="mb-2 flex items-center gap-3 text-xs text-muted-foreground">
      {cells.selection ? (
        <>
          <span role="status">{cells.selection.ids.length} cells highlighted in {attributes.find((attr) => attr.id === cells.selection?.attrId)?.name}. Double-click a highlighted cell to edit.</span>
          <button type="button" className="underline" disabled={props.bulkBusy || !!editing} onClick={cells.clear}>Clear highlights</button>
        </>
      ) : <span>Hold {modKey} and drag cells in one column to highlight, then double-click to edit them together.</span>}
    </div>
    <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto rounded-lg border bg-background"
      onContextMenu={(event) => { if (cells.dragging()) event.preventDefault(); }}>
      <div style={{ width: totalWidth, minWidth: "100%" }}>
        {/* The sticky header sits at the top edge, so vertical auto-scroll would jump the grid to the top. */}
        <DndContext sensors={sensors} onDragEnd={onDragEnd} autoScroll={{ threshold: { x: 0.2, y: 0 } }}>
        <div className="sticky top-0 z-10 flex border-b bg-card text-xs font-medium text-muted-foreground">
          {table.getFlatHeaders().map((header) => {
            const sorted = header.column.getIsSorted();
            return (
              <HeaderCell
                key={header.id}
                id={header.column.id}
                width={header.getSize()}
                draggable={header.column.id !== "__select"}
              >
                {header.column.getCanSort() ? (
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-1 hover:text-foreground"
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    <span className="truncate">{flexRender(header.column.columnDef.header, header.getContext())}</span>
                    {sorted === "asc" && <ArrowUp className="size-3 shrink-0" />}
                    {sorted === "desc" && <ArrowDown className="size-3 shrink-0" />}
                  </button>
                ) : (
                  flexRender(header.column.columnDef.header, header.getContext())
                )}
                {header.column.getCanResize() && (
                  <div
                    onPointerDown={(e) => e.stopPropagation()}
                    onMouseDown={header.getResizeHandler()}
                    onDoubleClick={() => header.column.resetSize()}
                    className={cn(
                      "absolute right-0 top-0 h-full w-1.5 cursor-col-resize opacity-0 group-hover/h:opacity-100 hover:bg-primary/40",
                      header.column.getIsResizing() && "bg-primary opacity-100",
                    )}
                  />
                )}
              </HeaderCell>
            );
          })}
        </div>
        </DndContext>

        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((vi) => {
            const row = tableRows[vi.index];
            return (
              <div
                key={row.id}
                className={cn(
                  "group absolute left-0 flex w-full border-b text-sm transition-colors hover:bg-accent/40",
                  row.getIsSelected() && "bg-accent/60 hover:bg-accent/70",
                )}
                style={{ height: ROW_HEIGHT, transform: `translateY(${vi.start}px)` }}
              >
                {row.getVisibleCells().map((cell) => {
                  const attr = (cell.column.columnDef.meta as { attr?: ObjectTypeAttribute } | undefined)?.attr;
                  const isEditing = !!attr && editing?.objectId === row.id && editing.attrId === attr.id;
                  const editable = !!attr && !staleAssets[row.id] && editorKind(attr) !== "readonly";
                  const highlighted = !!attr && cells.selection?.attrId === attr.id && highlightedIds.has(row.id);
                  return (
                    <div
                      key={cell.id}
                      data-asset-cell={row.id}
                      data-attribute={attr?.id}
                      data-highlighted={highlighted || undefined}
                      aria-label={highlighted ? `${attr?.name}, ${row.original.objectKey}, highlighted` : undefined}
                      style={{ width: cell.column.getSize() }}
                      className={cn(
                        "relative flex shrink-0 items-center overflow-hidden border-r px-3 last:border-r-0",
                        isEditing && "overflow-visible p-0",
                        editable && "cursor-cell",
                        highlighted && "bg-primary/15 ring-1 ring-inset ring-primary/60 select-none",
                      )}
                      onPointerDown={(event) => {
                        if (editable && attr) cells.begin(event, attr.id, row.id);
                      }}
                      onDoubleClick={() => {
                        if (!attr) openDetail(row.id);
                        else if (editable && !props.bulkBusy && !update.isPending) {
                          if (highlighted && cells.selection) {
                            const targets = cells.selection.ids.map((id) => rowsById.get(id));
                            if (targets.some((object) => !object || staleAssets[object.id])) {
                              notify.error("Refresh stale or missing assets before editing the highlighted cells.");
                              return;
                            }
                            setBulkEdit({
                              objects: targets.filter((object): object is AssetObject => !!object),
                              attrId: attr.id, anchorId: row.id, context: props.selectionContext,
                            });
                          } else setBulkEdit(null);
                          setEditing({ objectId: row.id, attrId: attr.id });
                        }
                      }}
                      title={editable || !attr ? undefined : "Read-only attribute"}
                    >
                      {isEditing && attr ? (
                        <div className="relative h-full w-full">
                          <CellEditor
                            attr={attr}
                            values={getAttrValues(row.original, attr.id)}
                            statuses={statuses}
                            bulk={!!bulkEdit}
                            onCancel={() => { setEditing(null); setBulkEdit(null); }}
                            onCommit={(value, optimistic) => {
                              setEditing(null);
                              if (bulkEdit) {
                                if (bulkEdit.context !== props.selectionContext || bulkEdit.attrId !== attr.id ||
                                  bulkEdit.anchorId !== row.id) {
                                  notify.error("The table changed. Highlight the cells again before updating.");
                                  setBulkEdit(null);
                                  return;
                                }
                                props.onBulkCommit({ objects: bulkEdit.objects, attr, value, optimistic });
                                setBulkEdit(null);
                              } else update.mutate({ object: row.original, attr, value, optimistic });
                            }}
                          />
                        </div>
                      ) : (
                        flexRender(cell.column.columnDef.cell, cell.getContext())
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {isFetchingNextPage && (
          <div className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading more…
          </div>
        )}
      </div>
    </div>
    </>
  );
}
