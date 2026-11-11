import { useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { AlertTriangle, Database, Loader2, RefreshCw, Square, Trash2 } from "lucide-react";
import { reportsApi } from "@/api/reports";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/primitives";
import { formatAgo } from "@/lib/reports/format";
import type { ReportSource } from "@/lib/reports/model";
import type { CollectSettings, Dataset, Estimate, Status } from "@/lib/reports/types";
import { notify } from "@/lib/notify";
import { useReports } from "@/store/reports";
import { estimateSeconds, reportKeys, useDataset, useRefresh, useReportStatus } from "./state";

const PHASES: Record<string, string> = {
  metadata: "Reading attribute definitions",
  inventory: "Collecting asset inventory",
  history: "Collecting change history",
  publishing: "Saving",
};

const duration = (s: number) => (s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

/** Starts a refresh. Lives outside React so closing the dialog does not stop or lose it. */
async function startRefresh(qc: QueryClient, source: ReportSource, dataset: Dataset, full: boolean, settings: CollectSettings) {
  const refresh = useRefresh.getState();
  if (refresh.sourceId) return;
  refresh.set({ sourceId: source.id, progress: null, summary: null, error: null });
  void qc.invalidateQueries({ queryKey: reportKeys.status(source.id) });
  try {
    const summary = await reportsApi.refresh(dataset, full, settings, (p) => useRefresh.getState().set({ progress: p }));
    useRefresh.getState().set({ summary });
    notify.success(`"${source.name}" refreshed: ${summary.assets.toLocaleString()} assets, ${summary.historiesFetched.toLocaleString()} histories fetched`);
  } catch (e) {
    useRefresh.getState().set({ error: e instanceof Error ? e.message : String(e) });
    notify.error(e, `Refresh of "${source.name}" stopped`);
  } finally {
    useRefresh.getState().set({ sourceId: null, progress: null });
    void qc.invalidateQueries({ queryKey: reportKeys.all });
  }
}

export function StatusLine({ status }: { status: Status | undefined }) {
  if (!status) return null;
  if (!status.collected) return <span>Not collected yet</span>;
  return (
    <span>
      Refreshed {formatAgo(status.lastRefreshMs)} · {status.assets.toLocaleString()} assets · {status.events.toLocaleString()} changes
    </span>
  );
}

export function RefreshDialog({ source, onClose }: { source: ReportSource; onClose: () => void }) {
  const qc = useQueryClient();
  const dataset = useDataset(source)!;
  const status = useReportStatus(dataset);
  const collect = useReports((s) => s.collect);
  const setCollect = useReports((s) => s.setCollect);
  const refresh = useRefresh();
  const [estimating, setEstimating] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const running = refresh.sourceId === source.id;
  const otherRunning = !!refresh.sourceId && !running;
  const s = status.data;
  const cooldown = Math.max(estimate?.fullCooldownMs ?? 0, s?.fullCooldownMs ?? 0);

  const check = async () => {
    setEstimating(true);
    try {
      setEstimate(await reportsApi.estimate(dataset, collect));
      refresh.set({ error: null });
    } catch (e) {
      notify.error(e, "Could not estimate the refresh");
    } finally {
      setEstimating(false);
    }
  };

  const clear = async () => {
    try {
      await reportsApi.clear(source.id);
      setEstimate(null);
      refresh.set({ summary: null });
      await qc.invalidateQueries({ queryKey: reportKeys.all });
      notify.success(`Local report data for "${source.name}" cleared`);
    } catch (e) {
      notify.error(e, "Could not clear the data");
    } finally {
      setConfirmClear(false);
    }
  };

  const p = refresh.progress;
  const pct = p && p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : null;
  const requests = estimate ? estimate.inventoryRequests + estimate.metadataRequests + estimate.historyRequests : 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Refresh "{source.name}"</DialogTitle>
          <DialogDescription>
            Reports read a local copy of the data. Jira is only contacted when you refresh, and only for the chosen object types and scope.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 text-sm">
          <div className="grid gap-1 rounded-md border p-3">
            {status.isLoading && <Loader2 className="size-4 animate-spin" />}
            {s && (
              <>
                <div className="flex items-center gap-2 font-medium">
                  <Database className="size-4" /> <StatusLine status={s} />
                </div>
                {s.collected && (
                  <ul className="grid gap-0.5 text-xs text-muted-foreground">
                    {s.unavailableAssets > 0 && <li>{s.unavailableAssets.toLocaleString()} assets are no longer in Jira or out of scope (kept for history).</li>}
                    {s.historiesFailed + s.historiesDenied + s.historiesMissing > 0 && (
                      <li>
                        History unavailable for {(s.historiesFailed + s.historiesDenied + s.historiesMissing).toLocaleString()} assets
                        {s.historiesDenied ? ` (${s.historiesDenied.toLocaleString()} without permission)` : ""}. A refresh retries them.
                      </li>
                    )}
                    {s.unresolvedEvents > 0 && <li>{s.unresolvedEvents.toLocaleString()} changes use recorded labels. They are included in reports without matching; "Match names" is optional.</li>}
                  </ul>
                )}
                {s.scopeChanged && (
                  <p className="flex gap-1 text-xs text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="size-3.5 shrink-0" /> The object types or scope changed since the last refresh. Refresh to update the data.
                  </p>
                )}
                {s.resumable > 0 && !running && <p className="text-xs text-muted-foreground">An interrupted refresh can resume: {s.resumable.toLocaleString()} histories are already saved.</p>}
                {s.lastError && !running && <p className="text-xs text-destructive">Last refresh failed: {s.lastError}</p>}
              </>
            )}
          </div>

          {running && (
            <div className="grid gap-1.5">
              <div className="flex justify-between text-xs">
                <span>{p ? PHASES[p.phase] ?? p.phase : "Starting…"}</span>
                <span className="tabular-nums text-muted-foreground">
                  {p && p.total > 0 && `${p.done.toLocaleString()} / ${p.total.toLocaleString()} · `}
                  {p ? `${p.requests.toLocaleString()} requests` : ""}
                  {p && p.throttled > 0 ? ` · Jira asked us to slow down ${p.throttled}×` : ""}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-secondary">
                <div className={pct === null ? "h-full w-1/3 animate-pulse bg-primary" : "h-full bg-primary transition-all"} style={pct === null ? undefined : { width: `${pct}%` }} />
              </div>
              {p?.message && <p className="text-xs text-muted-foreground">{p.message}</p>}
            </div>
          )}

          {!running && estimate && (
            <div className="grid gap-1 rounded-md border border-primary/30 bg-primary/5 p-3 text-xs">
              <p className="font-medium">
                {estimate.assets.toLocaleString()} assets in scope. About {requests.toLocaleString()} Jira requests
                {estimate.historyRequestsMax > estimate.historyRequests && ` (up to ${(estimate.inventoryRequests + estimate.metadataRequests + estimate.historyRequestsMax).toLocaleString()})`}
                , taking about {duration(estimateSeconds(requests, collect))}.
              </p>
              <p className="text-muted-foreground">
                {estimate.firstCollection
                  ? "First refresh: the history of every asset is fetched once."
                  : "Only assets changed since the last refresh have their history fetched again."}{" "}
                At most {collect.concurrency} requests at a time and {collect.requestsPerSecond} per second; Jira rate limits are respected.
              </p>
              {estimate.resumable > 0 && <p className="text-muted-foreground">{estimate.resumable.toLocaleString()} histories from an interrupted refresh are reused.</p>}
            </div>
          )}

          {refresh.error && !running && <p className="text-xs text-destructive">{refresh.error}</p>}
          {otherRunning && <p className="text-xs text-muted-foreground">Another data source is refreshing. Wait for it to finish.</p>}

          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Request limits</summary>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <div className="grid gap-1">
                <Label className="text-xs">Parallel requests (1–8)</Label>
                <NumberInput min={1} max={8} step={1} value={collect.concurrency} onCommit={(n) => setCollect({ ...collect, concurrency: Math.round(n) })} />
              </div>
              <div className="grid gap-1">
                <Label className="text-xs">Requests per second (0.2–20)</Label>
                <NumberInput min={0.2} max={20} value={collect.requestsPerSecond} onCommit={(n) => setCollect({ ...collect, requestsPerSecond: n })} />
              </div>
            </div>
          </details>

          {confirmClear ? (
            <div className="flex items-center gap-2 rounded-md border border-destructive/40 p-2 text-xs">
              <span className="flex-1">Delete the local copy of this source's data, including collected history? Reports stay; refresh to collect again.</span>
              <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>
                Keep
              </Button>
              <Button size="sm" variant="destructive" onClick={() => void clear()}>
                Delete data
              </Button>
            </div>
          ) : (
            s?.collected && (
              <Button size="sm" variant="ghost" className="w-fit text-destructive" disabled={running} onClick={() => setConfirmClear(true)}>
                <Trash2 /> Clear local data
              </Button>
            )
          )}
        </div>

        <DialogFooter className="gap-2">
          {running ? (
            <Button variant="outline" onClick={() => void reportsApi.cancel()}>
              <Square /> Stop
            </Button>
          ) : estimate ? (
            <>
              <Button
                variant="outline"
                disabled={otherRunning || cooldown > 0 || estimate.firstCollection}
                title={cooldown > 0 ? `Available again in ${Math.ceil(cooldown / 60_000)} min` : "Fetch every history again, ignoring what is stored"}
                onClick={() => {
                  setEstimate(null);
                  void startRefresh(qc, source, dataset, true, collect);
                }}
              >
                Full refresh{cooldown > 0 ? ` (${Math.ceil(cooldown / 60_000)} min)` : ""}
              </Button>
              <Button disabled={otherRunning} onClick={() => {
                  setEstimate(null);
                  void startRefresh(qc, source, dataset, false, collect);
                }}>
                <RefreshCw /> Start refresh
              </Button>
            </>
          ) : (
            <Button disabled={otherRunning || estimating} onClick={() => void check()}>
              {estimating ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check what to fetch
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
