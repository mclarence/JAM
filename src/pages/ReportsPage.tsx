import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChartColumn, Database, Loader2, Play, Plug, RefreshCw, Save, UserSearch } from "lucide-react";
import { isStale, reportsApi } from "@/api/reports";
import { EmptyState } from "@/components/layout/PageHeader";
import { Builder, specProblem } from "@/components/reports/Builder";
import { filterProblem } from "@/components/reports/FilterEditor";
import { IdentityDialog } from "@/components/reports/IdentityDialog";
import { RefreshDialog, StatusLine } from "@/components/reports/RefreshDialog";
import { ReportList } from "@/components/reports/ReportList";
import { PAGE_SIZE } from "@/components/reports/ResultTable";
import { Results } from "@/components/reports/Results";
import { SourceDialog } from "@/components/reports/SourceDialog";
import {
  blankDraft,
  draftFrom,
  isDirty,
  normKey,
  useDataset,
  useRefresh,
  useReportFields,
  useReportStatus,
  useWorkspace,
  useWorkspaceSources,
  type Draft,
} from "@/components/reports/state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { executableSpec, newId, type ReportSource, type SavedReport, type SavedSpec } from "@/lib/reports/model";
import { workspaceDeletions } from "@/lib/deletion";
import { notify } from "@/lib/notify";
import { useReports } from "@/store/reports";
import { useSettings } from "@/store/settings";
import { useUi } from "@/store/ui";

type Modal = { kind: "source"; source: ReportSource | null } | { kind: "refresh"; source: ReportSource } | { kind: "identity"; source: ReportSource } | null;

let initialized = false;

export function ReportsPage() {
  const { connection, sources, reports } = useWorkspaceSources();
  const saveReport = useReports((s) => s.saveReport);
  const lastReportId = useReports((s) => s.lastReportId);
  const setLastReport = useReports((s) => s.setLastReport);
  const deletions = useSettings((s) => s.deletions);
  const navigate = useUi((s) => s.navigate);
  const ws = useWorkspace();
  const { draft, setDraft, patch, setRun, markSaved } = ws;
  const [modal, setModal] = useState<Modal>(null);
  const [pending, setPending] = useState<Draft | null>(null);
  const refreshingId = useRefresh((s) => s.sourceId);

  const source = sources.find((s) => s.id === draft.sourceId) ?? null;
  const dataset = useDataset(source);
  const status = useReportStatus(dataset);
  const version = status.data?.dataVersion ?? 0;
  const fieldsQuery = useReportFields(dataset, draft.spec.entity, version);
  const fields = useMemo(() => fieldsQuery.data ?? [], [fieldsQuery.data]);
  const fieldMap = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields]);
  const dirty = isDirty(ws);

  // Restore the last report once per app session; the workspace store keeps the draft across page switches.
  useEffect(() => {
    if (initialized || !connection) return;
    initialized = true;
    const last = reports.find((r) => r.id === lastReportId);
    setDraft(last ? draftFrom(last) : blankDraft(sources[0]?.id ?? null));
  }, [connection, reports, sources, lastReportId, setDraft]);

  // A new draft without a source picks the first one once it exists.
  useEffect(() => {
    if (draft.sourceId || !sources[0]) return;
    const untouched = !isDirty(useWorkspace.getState());
    patch({ sourceId: sources[0].id });
    if (untouched) markSaved();
  }, [draft.sourceId, sources, patch, markSaved]);

  const deletionKey = JSON.stringify(workspaceDeletions(deletions, connection));
  const runKey = useMemo(
    () => JSON.stringify([draft.sourceId, { ...draft.spec, sort: undefined }, normKey(dataset), deletionKey]),
    [draft.sourceId, draft.spec, dataset, deletionKey],
  );

  const run = useCallback(async () => {
    if (!dataset || !source) return;
    const problem = filterProblem(draft.spec.filter, fieldMap) ?? specProblem(draft.spec, fieldMap);
    if (problem) {
      setRun({ error: problem });
      return;
    }
    setRun({ running: true, error: null });
    try {
      const result = await reportsApi.run(dataset, executableSpec(draft.spec, deletions, connection), PAGE_SIZE, draft.spec.sort);
      setRun({ result, resultKey: runKey, runSort: draft.spec.sort, running: false });
    } catch (e) {
      setRun({ running: false, error: e instanceof Error ? e.message : String(e) });
    }
  }, [dataset, source, draft.spec, fieldMap, deletions, connection, runKey, setRun]);

  // Results become stale when data is refreshed or names are matched; re-run once per stale result.
  const staleHandled = useRef<string | null>(null);
  const onStale = useCallback(
    (e: unknown) => {
      const id = ws.result?.runId ?? null;
      if (!isStale(e) || staleHandled.current === id) return;
      staleHandled.current = id;
      void run();
    },
    [ws.result, run],
  );

  const open = (next: Draft) => {
    if (dirty) setPending(next);
    else setDraft(next);
  };
  const openReport = (r: SavedReport) => {
    if (r.id === draft.savedId) return;
    setLastReport(r.id);
    open(draftFrom(r));
  };

  const save = (asNew = false) => {
    if (!source) return;
    const id = asNew || !draft.savedId ? newId() : draft.savedId;
    const name = (asNew && draft.savedId ? `${draft.name} (copy)` : draft.name).trim().slice(0, 200) || "Untitled report";
    const saved: SavedReport = {
      id,
      name,
      sourceId: source.id,
      cloudId: source.cloudId,
      workspaceId: source.workspaceId,
      spec: structuredClone(draft.spec),
      view: { ...draft.view },
      updatedAt: Date.now(),
    };
    saveReport(saved);
    setLastReport(id);
    patch({ savedId: id, name });
    markSaved();
    notify.success(`Saved "${name}"`);
  };

  // The saved report was deleted (here or by sync): keep the draft as an unsaved report.
  useEffect(() => {
    if (draft.savedId && !reports.some((r) => r.id === draft.savedId)) {
      patch({ savedId: null });
      useWorkspace.setState({ baseline: "" });
    }
  }, [draft.savedId, reports, patch]);

  if (!connection) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <EmptyState icon={<Plug />} title="Not connected">
          <p className="mb-4">Connect to Jira to build reports.</p>
          <Button onClick={() => navigate("settings")}>Open settings</Button>
        </EmptyState>
      </div>
    );
  }

  const outdated = !!ws.result && ws.resultKey !== runKey;
  const collected = status.data?.collected ?? false;
  const blocker = !source
    ? sources.length
      ? "Choose a data source."
      : "Add a data source first."
    : !collected
      ? "Refresh the data source to collect data before running."
      : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <ReportList
        reports={reports}
        sources={sources}
        currentId={draft.savedId}
        onOpen={openReport}
        onNew={() => open(blankDraft(source?.id ?? sources[0]?.id ?? null))}
        onAddSource={() => setModal({ kind: "source", source: null })}
        onEditSource={(s) => setModal({ kind: "source", source: s })}
        onRefreshSource={(s) => setModal({ kind: "refresh", source: s })}
        onIdentities={(s) => setModal({ kind: "identity", source: s })}
      />

      {sources.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <EmptyState icon={<ChartColumn />} title="Build reports from your assets">
            <p className="mb-4">
              Add a data source to choose which object types to report on. Their inventory and change history are copied to this computer when you refresh, so
              running reports never contacts Jira.
            </p>
            <Button onClick={() => setModal({ kind: "source", source: null })}>
              <Database /> Add data source
            </Button>
          </EmptyState>
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
            <Input
              aria-label="Report name"
              className="h-8 w-64 font-medium"
              value={draft.name}
              maxLength={200}
              onChange={(e) => ws.patch({ name: e.target.value })}
            />
            <Select value={draft.sourceId ?? ""} onValueChange={(id) => ws.patch({ sourceId: id })}>
              <SelectTrigger className="h-8 w-52" aria-label="Data source">
                <SelectValue placeholder="Choose a data source" />
              </SelectTrigger>
              <SelectContent>
                {sources.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {source && (
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <StatusLine status={status.data} />
                <Button size="sm" variant="ghost" className="h-7" onClick={() => setModal({ kind: "refresh", source })}>
                  <RefreshCw className={refreshingId === source.id ? "animate-spin" : undefined} /> Refresh
                </Button>
                {(status.data?.unresolvedEvents ?? 0) > 0 && (
                  <Button size="sm" variant="ghost" className="h-7 text-amber-700 dark:text-amber-400" onClick={() => setModal({ kind: "identity", source })}>
                    <UserSearch /> {status.data!.unresolvedEvents.toLocaleString()} unmatched
                  </Button>
                )}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              {dirty && <Badge variant="outline">Unsaved</Badge>}
              {draft.savedId && (
                <Button size="sm" variant="ghost" disabled={!source} onClick={() => save(true)}>
                  Save as copy
                </Button>
              )}
              <Button size="sm" variant="outline" disabled={!source || (!dirty && !!draft.savedId)} onClick={() => save()}>
                <Save /> Save
              </Button>
              <Button size="sm" disabled={!!blocker || ws.running} title={blocker ?? "Run the report on the local data"} onClick={() => void run()}>
                {ws.running ? <Loader2 className="animate-spin" /> : <Play />} Run
              </Button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1">
            <aside className="w-80 shrink-0 overflow-auto border-r xl:w-96">
              {dataset ? (
                fieldsQuery.isError ? (
                  <p className="p-4 text-sm text-destructive">{fieldsQuery.error.message}</p>
                ) : (
                  <Builder spec={draft.spec} onChange={(fn: (s: SavedSpec) => SavedSpec) => ws.patchSpec(fn)} dataset={dataset} fields={fields} version={version} />
                )
              ) : (
                <p className="p-4 text-sm text-muted-foreground">Choose a data source to build the report.</p>
              )}
            </aside>
            <main className="min-w-0 flex-1 overflow-auto p-4">
              {ws.error && <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{ws.error}</p>}
              {ws.result && source ? (
                <Results
                  name={draft.name}
                  sourceName={source.name}
                  result={ws.result}
                  spec={draft.spec}
                  view={draft.view}
                  fields={fieldMap}
                  outdated={outdated}
                  runSort={ws.runSort}
                  onView={(view) => ws.patch({ view })}
                  onSort={(sort) => ws.patchSpec((s) => ({ ...s, sort }))}
                  onStale={onStale}
                />
              ) : ws.running ? (
                <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" /> Running…
                </div>
              ) : (
                <EmptyState icon={<ChartColumn />} title={blocker ? "Not ready to run" : "Run the report"}>
                  <p className="mb-4">{blocker ?? "Choose filters, groupings and measures, then press Run. Reports read the local copy of your data."}</p>
                  {source && !collected && (
                    <Button onClick={() => setModal({ kind: "refresh", source })}>
                      <RefreshCw /> Refresh data
                    </Button>
                  )}
                </EmptyState>
              )}
            </main>
          </div>
        </div>
      )}

      {modal?.kind === "source" && (
        <SourceDialog
          source={modal.source}
          onClose={() => setModal(null)}
          onSaved={(s) => {
            if (!draft.sourceId) ws.patch({ sourceId: s.id });
            if (!modal.source) setModal({ kind: "refresh", source: s });
          }}
        />
      )}
      {modal?.kind === "refresh" && <RefreshDialog source={modal.source} onClose={() => setModal(null)} />}
      {modal?.kind === "identity" && <IdentityDialog source={modal.source} onClose={() => setModal(null)} />}

      {pending && (
        <Dialog open onOpenChange={(o) => !o && setPending(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Discard unsaved changes?</DialogTitle>
              <DialogDescription>"{draft.name}" has changes that are not saved.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPending(null)}>
                Keep editing
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  ws.setDraft(pending);
                  setPending(null);
                }}
              >
                Discard
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
