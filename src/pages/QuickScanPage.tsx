import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Database, Loader2, MinusCircle, PlugZap, Plus, RotateCcw, ScanLine, Volume2, VolumeX, XCircle } from "lucide-react";
import { assetsApi } from "@/api/assets";
import { qk, useAttributes, useConnection, useObjectTypes, useStatusTypes } from "@/api/queries";
import type { ObjectTypeAttribute } from "@/api/types";
import { EmptyState, PageHeader } from "@/components/layout/PageHeader";
import { ScanActionRow } from "@/components/quickscan/ScanActionRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, Label } from "@/components/ui/primitives";
import { SEARCH_KEY } from "@/lib/aql";
import { sortAttributes, editorKind } from "@/lib/attributes";
import { actionAttributes, lookupAttributes, lookupQuery, planChanges, sanitizeScan } from "@/lib/quickScan";
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
  const { configs, setConfig, sound, setSound } = useQuickScan();
  const objectTypes = useObjectTypes(schemaId);
  const attrsQuery = useAttributes(objectTypeId);
  const statuses = useStatusTypes(schemaId);

  const attrs = useMemo(() => sortAttributes(attrsQuery.data ?? []), [attrsQuery.data]);
  const lookupOptions = useMemo(() => lookupAttributes(attrs), [attrs]);
  const actionOptions = useMemo(() => actionAttributes(attrs), [attrs]);
  const config = (objectTypeId ? configs[objectTypeId] : undefined) ?? DEFAULT_SCAN_CONFIG;

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
      const q = lookupQuery(job.objectTypeId, job.config.lookup, job.attrs, job.text);
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
  const lookupLabel = config.lookup === SEARCH_KEY ? "Key" : (attrs.find((a) => a.id === config.lookup)?.name ?? "Key");

  return (
    <div className="flex-1 overflow-auto p-8">
      <PageHeader
        title="Quick Scan"
        description={<>Scan or type a value and press Enter to update the matching <strong>{typeName}</strong> straight away.</>}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setSound(!sound)} aria-pressed={sound}>
              {sound ? <Volume2 /> : <VolumeX />} Sound {sound ? "on" : "off"}
            </Button>
            <Button variant="outline" size="sm" onClick={newSession}>
              <RotateCcw /> New session
            </Button>
          </>
        }
      />

      <div className="mx-auto grid max-w-5xl gap-6">
        <Card className="grid gap-4 p-5">
          <div className="grid gap-1">
            <h2 className="font-medium">Setup</h2>
            <p className="text-sm text-muted-foreground">Choose how assets are found and which fields change on every scan.</p>
          </div>
          <div className="flex items-center gap-3">
            <Label className="w-56 shrink-0">Match the scanned value against</Label>
            <Select value={config.lookup} onValueChange={(lookup) => updateConfig({ lookup })}>
              <SelectTrigger className="h-9 w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SEARCH_KEY}>Key</SelectItem>
                {lookupOptions.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Fields to update on each scan</Label>
            {config.actions.map((a) => (
              <ScanActionRow
                key={a.id}
                action={a}
                attrs={actionOptions}
                statuses={statuses.data ?? []}
                onChange={(patch) => updateAction(a.id, patch)}
                onRemove={() => updateConfig({ actions: config.actions.filter((x) => x.id !== a.id) })}
              />
            ))}
            <div>
              <Button variant="outline" size="sm" onClick={addAction} disabled={actionOptions.length === 0}>
                <Plus /> Add field
              </Button>
            </div>
            {incomplete && <p className="text-xs text-amber-600">Choose a value for every "Set to" field before scanning.</p>}
          </div>
        </Card>

        <Card className={cn("grid gap-3 border-2 p-5 transition-colors", lastTone && BANNER[lastTone])}>
          <div className="flex items-center gap-3">
            <ScanLine className="size-6 shrink-0 text-muted-foreground" />
            <Input
              ref={inputRef}
              autoFocus
              value={input}
              disabled={!ready}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), submit())}
              placeholder={ready ? `Scan or type ${lookupLabel} and press Enter` : "Add at least one field to update to start scanning"}
              className="h-12 text-lg"
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
              <span>Updated <b className="text-foreground">{counts.updated}</b></span>
              <span>No change <b className="text-foreground">{counts.unchanged}</b></span>
              <span>Errors <b className="text-foreground">{counts.errors}</b></span>
            </div>
          </div>
        </Card>

        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b px-5 py-3">
            <h2 className="font-medium">Scan log</h2>
            <span className="text-xs text-muted-foreground">Session started {new Date(sessionStart).toLocaleTimeString()}</span>
          </div>
          {rows.length === 0 ? (
            <p className="p-5 text-sm text-muted-foreground">No scans in this session yet.</p>
          ) : (
            <ul className="divide-y">
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
  );
}
