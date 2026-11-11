import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { reportsApi } from "@/api/reports";
import { Button } from "@/components/ui/button";
import { formatCell } from "@/lib/reports/format";
import type { AggRow, Cell, Column, RunResult, Sort } from "@/lib/reports/types";
import { cn } from "@/lib/utils";
import { reportKeys } from "./state";

export const PAGE_SIZE = 100;

type Row = Cell[];

/** All result columns in display order, with the cell accessor for each. */
export function tableColumns(result: RunResult): { col: Column; get: (r: Row) => Cell; numeric: boolean }[] {
  const agg = result.aggregate;
  if (!agg) return result.columns.map((col, i) => ({ col, get: (r) => r[i], numeric: col.type === "number" }));
  const d = agg.dimensions.length;
  return [
    ...agg.dimensions.map((col, i) => ({ col, get: (r: Row) => r[i], numeric: col.type === "number" })),
    ...agg.measures.map((col, i) => ({ col, get: (r: Row) => r[d + i], numeric: true })),
  ];
}

/** Flattens aggregate rows to labels followed by values, matching `tableColumns`. */
export const flatRows = (result: RunResult, rows: Cell[][] | AggRow[]): Row[] =>
  result.aggregate ? (rows as AggRow[]).map((r) => [...r.labels, ...r.values]) : (rows as Cell[][]);

export function ResultTable({
  result,
  sort,
  runSort,
  onSort,
  timezone,
  onStale,
}: {
  result: RunResult;
  /** The sort the user chose; undefined uses the engine default. */
  sort: Sort | undefined;
  /** The sort `result.rows` was produced with. */
  runSort: Sort | undefined;
  onSort: (s: Sort | undefined) => void;
  timezone: string;
  onStale: (e: unknown) => void;
}) {
  const [offset, setOffset] = useState(0);
  const sortKey = JSON.stringify(sort ?? null);
  const firstPage = offset === 0 && sortKey === JSON.stringify(runSort ?? null);
  const page = useQuery({
    queryKey: reportKeys.page(result.runId, sortKey, offset),
    queryFn: () => reportsApi.page(result.runId, offset, PAGE_SIZE, sort),
    enabled: !firstPage,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    retry: false,
  });
  useEffect(() => {
    if (page.isError) onStale(page.error);
  }, [page.isError, page.error, onStale]);

  const rows = useMemo(
    () => (firstPage ? flatRows(result, result.rows) : page.data ? flatRows(result, page.data.rows) : []),
    [firstPage, result, page.data],
  );
  const cols = useMemo(() => tableColumns(result), [result]);
  const columns = useMemo<ColumnDef<Row>[]>(
    () =>
      cols.map(({ col, get, numeric }) => ({
        id: col.id,
        header: col.label,
        accessorFn: get,
        cell: (c) => <span className={cn(numeric && "tabular-nums")}>{formatCell(c.getValue() as Cell, col, timezone)}</span>,
        meta: { numeric },
      })),
    [cols, timezone],
  );
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel(), manualSorting: true, manualPagination: true });

  const total = result.total;
  const toggleSort = (id: string) => {
    setOffset(0);
    if (sort?.column !== id) onSort({ column: id, desc: !!result.aggregate && id.startsWith("m:") });
    else if (sort.desc === (!!result.aggregate && id.startsWith("m:"))) onSort({ column: id, desc: !sort.desc });
    else onSort(undefined);
  };

  return (
    <div className="grid min-w-0 gap-2">
      <div className="max-h-[32rem] overflow-auto rounded-md border">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-card">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const numeric = (h.column.columnDef.meta as { numeric?: boolean })?.numeric;
                  const active = sort?.column === h.column.id;
                  return (
                    <th
                      key={h.id}
                      className={cn("border-b px-3 py-2 text-left font-medium whitespace-nowrap", numeric && "text-right")}
                      aria-sort={active ? (sort!.desc ? "descending" : "ascending") : undefined}
                    >
                      <button
                        type="button"
                        className={cn("inline-flex items-center gap-1 hover:text-foreground", active ? "text-foreground" : "text-muted-foreground")}
                        onClick={() => toggleSort(h.column.id)}
                      >
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        {active && (sort!.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                      </button>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody className={cn(page.isFetching && "opacity-60")}>
            {table.getRowModel().rows.map((r) => (
              <tr key={r.id} className="border-b last:border-b-0 hover:bg-accent/40">
                {r.getVisibleCells().map((c) => (
                  <td key={c.id} className={cn("max-w-80 truncate px-3 py-1.5", (c.column.columnDef.meta as { numeric?: boolean })?.numeric && "text-right")}>
                    {flexRender(c.column.columnDef.cell, c.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && !page.isFetching && (
              <tr>
                <td colSpan={columns.length} className="p-8 text-center text-muted-foreground">
                  No records match the filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {total === 0 ? "0 rows" : `${(offset + 1).toLocaleString()}–${Math.min(offset + PAGE_SIZE, total).toLocaleString()} of ${total.toLocaleString()} ${result.aggregate ? "groups" : "records"}`}
          {page.isFetching && <Loader2 className="ml-2 inline size-3 animate-spin" />}
        </span>
        <div className="flex gap-1">
          <Button size="iconSm" variant="outline" aria-label="Previous page" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            <ChevronLeft />
          </Button>
          <Button size="iconSm" variant="outline" aria-label="Next page" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
            <ChevronRight />
          </Button>
        </div>
      </div>
    </div>
  );
}
