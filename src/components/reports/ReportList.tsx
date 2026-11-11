import { useState } from "react";
import { Copy, Database, FileBarChart, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2, UserSearch } from "lucide-react";
import { reportsApi } from "@/api/reports";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/overlays";
import { newId, type ReportSource, type SavedReport } from "@/lib/reports/model";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { useReports } from "@/store/reports";
import { useRefresh } from "./state";

type Confirm = { kind: "report"; item: SavedReport } | { kind: "source"; item: ReportSource; reports: number };

export function ReportList({
  reports,
  sources,
  currentId,
  onOpen,
  onNew,
  onAddSource,
  onEditSource,
  onRefreshSource,
  onIdentities,
}: {
  reports: SavedReport[];
  sources: ReportSource[];
  currentId: string | null;
  onOpen: (r: SavedReport) => void;
  onNew: () => void;
  onAddSource: () => void;
  onEditSource: (s: ReportSource) => void;
  onRefreshSource: (s: ReportSource) => void;
  onIdentities: (s: ReportSource) => void;
}) {
  const { saveReport, removeReport, removeSource } = useReports();
  const refreshing = useRefresh((s) => s.sourceId);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const sorted = [...reports].sort((a, b) => a.name.localeCompare(b.name));

  const commitRename = (r: SavedReport) => {
    const name = draft.trim().slice(0, 200);
    if (name && name !== r.name) saveReport({ ...r, name, updatedAt: Date.now() });
    setRenaming(null);
  };

  return (
    <div className="flex w-52 shrink-0 flex-col border-r xl:w-64">
      <div className="flex items-center justify-between border-b p-3">
        <span className="text-sm font-medium">Reports</span>
        <Button size="sm" variant="outline" onClick={onNew} disabled={sources.length === 0}>
          <Plus /> New
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {sorted.length === 0 && <p className="p-2 text-sm text-muted-foreground">No saved reports yet.</p>}
        {sorted.map((r) => (
          <div
            key={r.id}
            className={cn(
              "group flex items-center gap-1 rounded-md border-l-2 px-2 py-1.5 text-sm",
              currentId === r.id ? "border-primary bg-accent" : "border-transparent hover:bg-accent/50",
            )}
          >
            {renaming === r.id ? (
              <Input
                autoFocus
                value={draft}
                className="h-7"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commitRename(r)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(r);
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => onOpen(r)}>
                <FileBarChart className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{r.name}</span>
              </button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="iconSm" variant="ghost" className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100" aria-label={`Actions for ${r.name}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => {
                    setDraft(r.name);
                    setRenaming(r.id);
                  }}
                >
                  <Pencil /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => saveReport({ ...structuredClone(r), id: newId(), name: `${r.name} (copy)`.slice(0, 200), updatedAt: Date.now() })}>
                  <Copy /> Duplicate
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive" onSelect={() => setConfirm({ kind: "report", item: r })}>
                  <Trash2 /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between border-y p-3">
        <span className="text-sm font-medium">Data sources</span>
        <Button size="sm" variant="ghost" onClick={onAddSource}>
          <Plus /> Add
        </Button>
      </div>
      <div className="max-h-[40%] overflow-auto p-2">
        {sources.length === 0 && <p className="p-2 text-sm text-muted-foreground">Add a data source to start.</p>}
        {sources.map((s) => (
          <div key={s.id} className="group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50">
            <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => onRefreshSource(s)}>
              {refreshing === s.id ? <RefreshCw className="size-4 shrink-0 animate-spin" /> : <Database className="size-4 shrink-0 text-muted-foreground" />}
              <span className="truncate">{s.name}</span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="iconSm" variant="ghost" className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100" aria-label={`Actions for ${s.name}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onRefreshSource(s)}>
                  <RefreshCw /> Refresh data…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onIdentities(s)}>
                  <UserSearch /> Match names…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onEditSource(s)}>
                  <Pencil /> Edit
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive"
                  disabled={refreshing === s.id}
                  onSelect={() => setConfirm({ kind: "source", item: s, reports: reports.filter((r) => r.sourceId === s.id).length })}
                >
                  <Trash2 /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </div>

      {confirm && (
        <Dialog open onOpenChange={(o) => !o && setConfirm(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Delete "{confirm.item.name}"?</DialogTitle>
              <DialogDescription>
                {confirm.kind === "report"
                  ? "The saved report is removed from this computer and, if report sync is on, from your other computers."
                  : `The data source${confirm.reports ? ` and its ${confirm.reports} report${confirm.reports === 1 ? "" : "s"}` : ""} will be removed, along with the data collected for it on this computer.`}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  if (confirm.kind === "report") removeReport(confirm.item.id);
                  else {
                    const id = confirm.item.id;
                    removeSource(id);
                    reportsApi.clear(id).catch((e) => notify.error(e, "Could not delete the collected data"));
                  }
                  setConfirm(null);
                }}
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
