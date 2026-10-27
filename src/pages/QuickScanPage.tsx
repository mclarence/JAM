import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Database, Loader2, MinusCircle, PanelLeftClose, PanelLeftOpen, PlugZap, RotateCcw, ScanLine, Volume2, VolumeX, XCircle } from "lucide-react";
import { assetsApi } from "@/api/assets";
import { qk, useAttributes, useConnection, useObjectTypes, useStatusTypes } from "@/api/queries";
import type { ObjectTypeAttribute } from "@/api/types";
import { EmptyState, PageHeader } from "@/components/layout/PageHeader";
import { ScanOptionsPanel } from "@/components/quickscan/ScanOptionsPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/primitives";
import { SEARCH_KEY } from "@/lib/aql";
import { sortAttributes, editorKind } from "@/lib/attributes";
import {
  actionAttributes,
  lookupAttributes,
  lookupLabel,
  lookupQuery,
  planChanges,
  sanitizeScan,
  validLookups,
} from "@/lib/quickScan";
import { playScanTone, type ScanTone } from "@/lib/scanSound";
import { cn } from "@/lib/utils";
import { DEFAULT_SCAN_CONFIG, useQuickScan, type ScanAction, type ScanConfig } from "@/store/quickScan";
import { useSettings } from "@/store/settings";
import { useUi } from "@/store/ui";

type ScanState = "pending" | "updated" | "unchanged" | "notFound" | "ambiguous" | "failed";

interface ScanRow {
  id: string;
  at: number;
  text: string;
  state: ScanState;
  asset?: { key: string; label: string };
  changes?: string[];
  warning?: string;
  error?: string;
}

interface Job {
  rowId: string;
  session: number;
  text: string;
  objectTypeId: string;
  config: ScanConfig;
  attrs: ObjectTypeAttribute[];
}

const MAX_ROWS = 500;

const STATE_META: Record<ScanState, { label: string; tone: ScanTone | null; badge: string; icon: React.ReactNode }> = {
  pending: { label: "Working", tone: null, badge: "text-muted-foreground", icon: <Loader2 className="animate-spin" /> },
  updated: { label: "Updated", tone: "success", badge: "text-green-700 dark:text-green-400", icon: <CheckCircle2 /> },
  unchanged: { label: "No change", tone: "warning", badge: "text-amber-700 dark:text-amber-400", icon: <MinusCircle /> },
  notFound: { label: "Not found", tone: "error", badge: "text-red-700 dark:text-red-400", icon: <XCircle /> },
  ambiguous: { label: "Ambiguous", tone: "error", badge: "text-red-700 dark:text-red-400", icon: <XCircle /> },
  failed: { label: "Failed", tone: "error", badge: "text-red-700 dark:text-red-400", icon: <XCircle /> },
};

const BANNER: Record<ScanTone, string> = {
  success: "border-green-500/50 bg-green-500/10",
  warning: "border-amber-500/50 bg-amber-500/10",
  error: "border-red-500/50 bg-red-500/10",
};

export function QuickScanPage() {
  const qc = useQueryClient();
  const connection = useConnection();
  const navigate = useUi((s) => s.navigate);
  const { schemaId, objectTypeId } = useSettings();
  const { configs, presets: presetsByType, setConfig, savePreset, updatePreset, deletePreset, loadPreset, sound, setSound, panelOpen, setPanelOpen } =
    useQuickScan();
  const objectTypes = useObjectTypes(schemaId);
  const attrsQuery = useAttributes(objectTypeId);
  const statuses = useStatusTypes(schemaId);

  const attrs = useMemo(() => sortAttributes(attrsQuery.data ?? []), [attrsQuery.data]);
  const lookupOptions = useMemo(() => lookupAttributes(attrs), [attrs]);
  const actionOptions = useMemo(() => actionAttributes(attrs), [attrs]);
  const stored = (objectTypeId ? configs[objectTypeId] : undefined) ?? DEFAULT_SCAN_CONFIG;
  // Saved lookup attributes that no longer exist are dropped; with none left it falls back to Key.
  const config = useMemo(() => {
    if (!attrsQuery.isSuccess) return stored;
    const lookups = validLookups(
      stored.lookups.filter((l) => l === SEARCH_KEY || lookupOptions.some((a) => a.id === l)),
      attrs,
    );
    return { ...stored, lookups };
  }, [stored, attrsQuery.isSuccess, lookupOptions, attrs]);
  const presets = (objectTypeId && presetsByType[objectTypeId]) || [];
  const activePreset = presets.find((p) => p.id === config.presetId);
  const signature = (lookups: string[], actions: ScanAction[]) =>
    JSON.stringify([[...lookups].sort(), actions.map((a) => [a.attrId, a.mode, a.value])]);
  const modified =
    !!activePreset && signature(activePreset.lookups, activePreset.actions) !== signature(config.lookups, config.actions);

  const [rows, setRows] = useState<ScanRow[]>([]);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const queue = useRef<Job[]>([]);
  const running = useRef(false);
  const session = useRef(0);
  const seen = useRef(new Set<string>());
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const [sessionStart, setSessionStart] = useState(() => Date.now());

  const patchRow = (id: string, patch: Partial<ScanRow>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const process = async (job: Job): Promise<Partial<ScanRow>> => {
    try {
      const q = lookupQuery(job.objectTypeId, job.config.lookups, job.attrs, job.text);
      const found = await assetsApi.searchObjects(q, 0, 2);
      if (found.values.length === 0) return { state: "notFound" };
      if (found.values.length > 1) return { state: "ambiguous", error: "More than one asset matches" };

      const obj = found.values[0];
      const asset = { key: obj.objectKey, label: obj.label };
      const warning = seen.current.has(obj.id) ? "Already scanned this session" : undefined;
      seen.current.add(obj.id);

      const plan = planChanges(obj, job.attrs, job.config.actions);
      if (plan.payload.length === 0) return { state: "unchanged", asset, warning };

      await assetsApi.updateObject(obj.id, { objectTypeId: obj.objectType.id, attributes: plan.payload });
      void qc.invalidateQueries({ queryKey: ["objects"] });
      void qc.invalidateQueries({ queryKey: ["count"] });
      void qc.invalidateQueries({ queryKey: qk.object(obj.id) });
      void qc.invalidateQueries({ queryKey: qk.history(obj.id) });
      return { state: "updated", asset, warning, changes: plan.changes };
    } catch (e) {
      return { state: "failed", error: e instanceof Error ? e.message : String(e) };
    }
  };

  // Scans run one at a time so duplicate detection and updates stay in scan order.
  const drain = async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (queue.current.length) {
        const job = queue.current.shift()!;
        if (job.session !== session.current) continue;
        const result = await process(job);
        if (job.session !== session.current) continue;
        patchRow(job.rowId, result);
        const state = result.state ?? "failed";
        const tone = result.warning && state === "updated" ? "warning" : STATE_META[state].tone;
        if (tone && soundRef.current) playScanTone(tone);
      }
    } finally {
      running.current = false;
    }
  };

  const incomplete = config.actions.some((a) => a.mode === "set" && !a.value);
  const ready = !!objectTypeId && attrsQuery.isSuccess && config.actions.length > 0 && !incomplete;

  // A disabled input drops focus, so take it back once scanning becomes possible.
  useEffect(() => {
    if (ready) inputRef.current?.focus();
  }, [ready]);

  // Scanning can't start until the setup is complete, so surface the options.
  useEffect(() => {
    if (attrsQuery.isSuccess && !ready) setPanelOpen(true);
  }, [attrsQuery.isSuccess, ready, setPanelOpen]);

  const submit = () => {
    const text = sanitizeScan(input);
    setInput("");
    if (!text || !ready || !objectTypeId) return;
    const rowId = crypto.randomUUID();
    setRows((rs) => [{ id: rowId, at: Date.now(), text, state: "pending" as const }, ...rs].slice(0, MAX_ROWS));
    queue.current.push({ rowId, session: session.current, text, objectTypeId, config, attrs });
    void drain();
  };

  const newSession = () => {
    session.current += 1;
    queue.current = [];
    seen.current = new Set();
    setRows([]);
    setSessionStart(Date.now());
    inputRef.current?.focus();
  };

  const updateConfig = (patch: Partial<ScanConfig>) => objectTypeId && setConfig(objectTypeId, patch);
  const updateAction = (id: string, patch: Partial<ScanAction>) =>
    updateConfig({ actions: config.actions.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  const addAction = () => {
    const used = new Set(config.actions.map((a) => a.attrId));
    const attr = actionOptions.find((a) => !used.has(a.id)) ?? actionOptions[0];
    if (!attr) return;
    const settable = editorKind(attr) !== "readonly";
    updateConfig({
      actions: [...config.actions, { id: crypto.randomUUID(), attrId: attr.id, mode: settable ? "set" : "clear", value: "", display: "" }],
    });
  };

  if (!connection.isLoading && !connection.data) {
    return (
      <div className="flex-1 overflow-auto p-8">
        <PageHeader title="Quick Scan" />
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
        <PageHeader title="Quick Scan" />
        <EmptyState icon={<Database />} title="Choose a schema and object type">
          <p className="mb-4">Quick Scan works on the object type selected in Settings.</p>
          <Button onClick={() => navigate("settings", "schema")}>Select schema</Button>
        </EmptyState>
      </div>
    );
  }

  const typeName = objectTypes.data?.find((t) => t.id === objectTypeId)?.name ?? "…";
  const finished = rows.filter((r) => r.state !== "pending");
  const last = finished[0];
  const counts = {
    updated: rows.filter((r) => r.state === "updated").length,
    unchanged: rows.filter((r) => r.state === "unchanged").length,
    errors: rows.filter((r) => ["notFound", "ambiguous", "failed"].includes(r.state)).length,
  };
  const lastTone = last ? (last.warning && last.state === "updated" ? "warning" : STATE_META[last.state].tone) : null;
  const matchLabel = lookupLabel(config.lookups, attrs);

  const summary = config.actions.map((a) => {
    const name = attrs.find((x) => x.id === a.attrId)?.name ?? "Field";
    if (a.mode === "clear") return `${name} cleared`;
    return `${name} → ${a.mode === "now" ? "now" : a.display || a.value || "…"}`;
  });

  const closePanel = () => {
    setPanelOpen(false);
    inputRef.current?.focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6 lg:overflow-hidden">
      <PageHeader
        title="Quick Scan"
        description={<>Scan or type a value and press Enter to update the matching <strong>{typeName}</strong> straight away.</>}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => (panelOpen ? closePanel() : setPanelOpen(true))} aria-pressed={panelOpen}>
              {panelOpen ? <PanelLeftClose /> : <PanelLeftOpen />} Options
            </Button>
            <Button variant="outline" size="sm" onClick={() => setSound(!sound)} aria-pressed={sound}>
              {sound ? <Volume2 /> : <VolumeX />} Sound {sound ? "on" : "off"}
            </Button>
            <Button variant="outline" size="sm" onClick={newSession}>
              <RotateCcw /> New session
            </Button>
          </>
        }
      />

      <div className={cn("grid gap-4 lg:min-h-0 lg:flex-1", panelOpen ? "lg:grid-cols-[20rem_minmax(0,1fr)]" : "grid-cols-1")}>
        {panelOpen && (
          <ScanOptionsPanel
            config={config}
            presets={presets}
            activePreset={activePreset}
            modified={modified}
            lookupOptions={lookupOptions}
            actionOptions={actionOptions}
            statuses={statuses.data ?? []}
            incomplete={incomplete}
            onConfigChange={updateConfig}
            onUpdateAction={updateAction}
            onAddAction={addAction}
            onLoadPreset={(id) => objectTypeId && loadPreset(objectTypeId, id)}
            onSavePreset={(name) => objectTypeId && savePreset(objectTypeId, name)}
            onUpdatePreset={(id) => objectTypeId && updatePreset(objectTypeId, id)}
            onDeletePreset={(id) => objectTypeId && deletePreset(objectTypeId, id)}
            onClose={closePanel}
          />
        )}

        <div className="flex min-h-0 min-w-0 flex-col gap-4">
        <Card className={cn("grid shrink-0 gap-3 border-2 p-5 transition-colors", lastTone && BANNER[lastTone])}>
          <div className="flex items-center gap-3">
            <ScanLine className="size-6 shrink-0 text-muted-foreground" />
            <Input
              ref={inputRef}
              autoFocus
              value={input}
              disabled={!ready}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), submit())}
              placeholder={ready ? `Scan or type ${matchLabel.replace(/, (?=[^,]*$)/, " or ")} and press Enter` : "Add at least one field to update to start scanning"}
              className="h-14 text-xl"
              aria-label="Scan input"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div className="min-w-0 truncate">
              {last ? (
                <span className={cn("inline-flex items-center gap-2 font-medium [&_svg]:size-4", STATE_META[last.state].badge)}>
                  {STATE_META[last.state].icon}
                  {STATE_META[last.state].label}
                  <span className="font-normal text-foreground">
                    {last.asset ? `${last.asset.key} — ${last.asset.label}` : last.text}
                  </span>
                </span>
              ) : (
                <span className="text-muted-foreground">Waiting for the first scan</span>
              )}
            </div>
            <div className="flex gap-4 text-muted-foreground">
              <span className="inline-flex items-center gap-1.5" title="Updated">
                <CheckCircle2 className="size-4 text-green-600 dark:text-green-400" /> <b className="text-foreground">{counts.updated}</b>
              </span>
              <span className="inline-flex items-center gap-1.5" title="No change">
                <MinusCircle className="size-4 text-amber-600 dark:text-amber-400" /> <b className="text-foreground">{counts.unchanged}</b>
              </span>
              <span className="inline-flex items-center gap-1.5" title="Errors">
                <XCircle className="size-4 text-red-600 dark:text-red-400" /> <b className="text-foreground">{counts.errors}</b>
              </span>
            </div>
          </div>
          {!panelOpen && (
            <p className="truncate text-xs text-muted-foreground" title={summary.join(" · ")}>
              Matching on {matchLabel}
              {summary.map((s) => ` · ${s}`).join("")}
            </p>
          )}
        </Card>

        <Card className="flex min-h-64 flex-1 flex-col overflow-hidden lg:min-h-0">
          <div className="flex shrink-0 items-center justify-between border-b px-5 py-3">
            <h2 className="font-medium">Scan log</h2>
            <span className="text-xs text-muted-foreground">Session started {new Date(sessionStart).toLocaleTimeString()}</span>
          </div>
          {rows.length === 0 ? (
            <p className="flex flex-1 items-center justify-center p-5 text-sm text-muted-foreground">No scans in this session yet.</p>
          ) : (
            <ul className="min-h-0 flex-1 divide-y overflow-y-auto">
              {rows.map((r) => {
                const meta = STATE_META[r.state];
                return (
                  <li key={r.id} className="grid grid-cols-[5rem_10rem_1fr_auto] items-start gap-3 px-5 py-2 text-sm">
                    <span className="text-muted-foreground">{new Date(r.at).toLocaleTimeString()}</span>
                    <span className="truncate font-mono" title={r.text}>{r.text}</span>
                    <div className="min-w-0">
                      {r.asset && <div className="truncate">{r.asset.key} — {r.asset.label}</div>}
                      {r.changes && <div className="truncate text-xs text-muted-foreground">{r.changes.join("; ")}</div>}
                      {r.state === "unchanged" && <div className="text-xs text-muted-foreground">Already in the target state</div>}
                      {r.error && <div className="text-xs text-red-600 dark:text-red-400">{r.error}</div>}
                      {r.warning && (
                        <div className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                          <AlertTriangle className="size-3" /> {r.warning}
                        </div>
                      )}
                    </div>
                    <span className={cn("inline-flex items-center gap-1.5 font-medium [&_svg]:size-4", meta.badge)}>
                      {meta.icon} {meta.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        </div>
      </div>
    </div>
  );
}
