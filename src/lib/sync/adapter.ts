/**
 * Maps the desktop stores to sync records (docs/sync-protocol.md §6) and applies incoming records to them.
 * Secrets never pass through here: the connection record carries only non-secret identity.
 */
import type { ConnectionInfo } from "@/api/types";
import type { LabelTemplate } from "@/components/labels/model";
import { SEARCH_KEY } from "@/lib/aql";
import { deletionScope, parseDeletionConfigs, type DeletionConfig } from "@/lib/deletion";
import { parseReport, parseSource, ReportInvalid, sameWorkspace, type ReportSource, type SavedReport } from "@/lib/reports/model";
import { parseRules, type Rule } from "@/lib/rules";
import { cleanTemplate } from "@/lib/settingsTransfer";
import { COLOR_KEYS, DEFAULT_STATUS_COLORS, type ColorKey } from "@/lib/statusColors";
import { flushStores } from "@/store/persist";
import { useReports } from "@/store/reports";
import { useQuickScan, type ScanAction, type ScanConfig, type ScanPreset } from "@/store/quickScan";
import { useSettings } from "@/store/settings";
import { useTemplates } from "@/store/templates";
import { useUpdater } from "@/store/updater";
import { decodeKey, jsonEqual, recordKey, rid, splitRid, type Adapter, type ApplyResult, type Change, type Json } from "./engine";

export type ThemeValue = "light" | "dark" | "system";

export interface DesktopDeps {
  connection: () => ConnectionInfo | null;
  theme: { get: () => ThemeValue; set: (pref: ThemeValue) => void };
  /** The last synced value of a record (from the engine state). */
  snapshot: (rid: string) => Json | undefined;
}

export const DESKTOP_SCOPES = ["shared", "desktop"] as const;

/** Record kinds whose key starts with `<cloudId>:<workspaceId>` and whose local storage is per object type only. */
const WORKSPACE_KINDS = new Set(["columns", "assetTag", "referenceDisplay", "scanConfig", "scanPreset", "columnSizes", "reportSource", "report"]);
const DESKTOP_WORKSPACE_KINDS = new Set(["columnSizes", "reportSource", "report"]);
const GLOBAL_KINDS = new Set([
  "shared|theme", "shared|filter", "shared|filterOrder", "shared|statusColor", "shared|rule", "shared|ruleOrder", "shared|deletion", "shared|scanSound",
  "desktop|template", "desktop|defaultTemplate", "desktop|labelDefaults", "desktop|updater",
]);
/** Application order inside one batch of changes, so that dependent records land after what they refer to. */
const APPLY_ORDER = ["filter", "filterOrder", "rule", "ruleOrder", "columns", "columnSizes", "template", "defaultTemplate", "reportSource", "report"];

const DEFAULT_LABEL = { unit: "mm", width: 62, height: 29 } as const;
const DEFAULT_UPDATER = { channel: "stable", autoCheck: true } as const;

type Obj = { [key: string]: Json };
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isPos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

class Invalid extends Error {}
const check = (ok: boolean, message = "The synced value is malformed."): void => {
  if (!ok) throw new Invalid(message);
};

/** Keeps fields a newer app version added to a record, so editing it here does not drop them. */
function withUnknown(local: Obj, snapshot: Json | undefined, known: readonly string[]): Obj {
  if (!isObj(snapshot)) return local;
  const out: Obj = { ...local };
  for (const [k, v] of Object.entries(snapshot)) if (!known.includes(k) && !(k in out)) out[k] = v;
  return out;
}

const FIELDS = {
  connection: ["siteUrl", "email", "cloudId", "workspaceId"],
  selection: ["cloudId", "workspaceId", "schemaId", "objectTypeId"],
  filter: ["name", "aql"],
  columns: ["hidden", "order"],
  assetTag: ["attributeId", "template"],
  deletion: ["method", "marker", "additional"],
  scanConfig: ["lookups", "actions", "presetId"],
  scanPreset: ["name", "lookups", "actions"],
  labelDefaults: ["unit", "width", "height"],
  updater: ["channel", "autoCheck"],
  rule: ["id", "name", "enabled", "cloudId", "workspaceId", "schemaId", "objectTypeId", "operations", "watchedAttributeIds", "match", "conditions", "actions"],
  template: ["id", "name", "unit", "width", "height", "layout", "elements", "updatedAt"],
  reportSource: ["name", "objectTypeIds", "scopeAql", "attributeAliases", "updatedAt"],
  report: ["name", "sourceId", "spec", "view", "updatedAt"],
} as const;

/** Report records carry IDs, AQL and configuration only; identity mappings and results stay on this device. */
const canonSource = (s: ReportSource): Obj =>
  JSON.parse(JSON.stringify({ name: s.name, objectTypeIds: s.objectTypeIds, scopeAql: s.scopeAql, attributeAliases: s.attributeAliases, updatedAt: s.updatedAt })) as Obj;
const canonReport = (r: SavedReport): Obj =>
  JSON.parse(JSON.stringify({ name: r.name, sourceId: r.sourceId, spec: r.spec, view: r.view, updatedAt: r.updatedAt })) as Obj;

const canonAction = (a: ScanAction): Obj => ({ id: a.id, attrId: a.attrId, mode: a.mode, value: a.value, display: a.display });

function readActions(v: unknown): ScanAction[] {
  check(Array.isArray(v));
  return (v as unknown[]).map((a) => {
    check(isObj(a) && isStr(a.id) && isStr(a.attrId) && ["set", "clear", "now"].includes(a.mode as string) && isStr(a.value) && isStr(a.display));
    const x = a as Obj;
    return { id: x.id as string, attrId: x.attrId as string, mode: x.mode as ScanAction["mode"], value: x.value as string, display: x.display as string };
  });
}

function readLookups(v: unknown): string[] {
  check(isStrArray(v) && (v as string[]).length > 0);
  return v as string[];
}

const canonRule = (r: Rule): Obj => JSON.parse(JSON.stringify(parseRules([r])[0])) as Obj;
const ruleGroup = (r: Pick<Rule, "cloudId" | "workspaceId" | "objectTypeId">) => recordKey("ruleOrder", r.cloudId, r.workspaceId, r.objectTypeId);

function canonDeletion(config: DeletionConfig): Obj {
  return JSON.parse(JSON.stringify(config)) as Obj;
}

function isDefaultScanConfig(c: ScanConfig) {
  return c.lookups.length === 1 && c.lookups[0] === SEARCH_KEY && c.actions.length === 0 && !c.presetId;
}

export function createDesktopAdapter(deps: DesktopDeps): Adapter {
  const ws = (conn: ConnectionInfo, kind: string, ...rest: string[]) => recordKey(kind, conn.cloudId, conn.workspaceId, ...rest);

  function project(): Map<string, Json> {
    const out = new Map<string, Json>();
    const put = (scope: string, key: string, value: Json, known?: readonly string[]) => {
      const id = rid(scope, key);
      out.set(id, known && isObj(value) ? withUnknown(value, deps.snapshot(id), known) : value);
    };
    const conn = deps.connection();
    const s = useSettings.getState();
    const q = useQuickScan.getState();
    const t = useTemplates.getState();
    const u = useUpdater.getState();

    const theme = deps.theme.get();
    if (theme !== "system") put("shared", "theme", theme);
    for (const p of s.aqlPresets) put("shared", recordKey("filter", p.id), { name: p.name, aql: p.aql }, FIELDS.filter);
    const filterOrder = s.aqlPresets.map((p) => p.id);
    const filterSnapshot = deps.snapshot(rid("shared", "filterOrder"));
    if (isStrArray(filterSnapshot)) {
      const mine = filterOrder.filter((id) => filterSnapshot.includes(id));
      const theirs = filterSnapshot.filter((id) => filterOrder.includes(id));
      put("shared", "filterOrder", jsonEqual(mine, theirs) ? filterSnapshot : filterOrder);
    } else if (filterOrder.length > 0) {
      put("shared", "filterOrder", filterOrder);
    }

    const colorNames = new Set([...Object.keys(DEFAULT_STATUS_COLORS), ...Object.keys(s.statusColors)]);
    for (const name of colorNames) {
      const cur = s.statusColors[name] ?? null;
      if (cur !== (DEFAULT_STATUS_COLORS[name] ?? null)) put("shared", recordKey("statusColor", name), cur);
    }

    const groups = new Map<string, string[]>();
    for (const r of s.rules) {
      let canonical: Obj;
      try {
        canonical = canonRule(r);
      } catch {
        // An incomplete local rule is not shared until it is fixed.
        continue;
      }
      put("shared", recordKey("rule", r.id), canonical, FIELDS.rule);
      const g = ruleGroup(r);
      groups.set(g, [...(groups.get(g) ?? []), r.id]);
    }
    for (const [key, order] of groups) {
      // Only a change in the relative order of rules both sides know counts as a reorder.
      const snap = deps.snapshot(rid("shared", key));
      if (isStrArray(snap)) {
        const mine = order.filter((id) => snap.includes(id));
        const theirs = snap.filter((id) => order.includes(id));
        if (jsonEqual(mine, theirs)) {
          put("shared", key, snap);
          continue;
        }
      }
      put("shared", key, order);
    }

    for (const [scope, config] of Object.entries(s.deletions)) {
      let parts: unknown;
      try {
        parts = JSON.parse(scope);
      } catch {
        continue;
      }
      if (!isStrArray(parts) || parts.length !== 3) continue;
      put("shared", recordKey("deletion", ...parts), canonDeletion(config), FIELDS.deletion);
    }

    if (!q.sound) put("shared", "scanSound", false);

    if (conn) {
      put("shared", "connection", { siteUrl: conn.siteUrl, email: conn.email, cloudId: conn.cloudId, workspaceId: conn.workspaceId }, FIELDS.connection);
      if (s.schemaId) {
        put("shared", "selection", { cloudId: conn.cloudId, workspaceId: conn.workspaceId, schemaId: s.schemaId, objectTypeId: s.objectTypeId }, FIELDS.selection);
      }
      for (const [type, prefs] of Object.entries(s.columns)) {
        put("shared", ws(conn, "columns", type), { hidden: prefs.hidden, ...(prefs.order ? { order: prefs.order } : {}) }, FIELDS.columns);
        if (prefs.sizes && Object.keys(prefs.sizes).length) put("desktop", ws(conn, "columnSizes", type), prefs.sizes);
      }
      for (const [type, tag] of Object.entries(s.assetTags)) {
        put("shared", ws(conn, "assetTag", type), { attributeId: tag.attributeId, template: tag.template }, FIELDS.assetTag);
      }
      for (const [type, attr] of Object.entries(s.referenceDisplay)) put("shared", ws(conn, "referenceDisplay", type), attr);
      for (const [type, config] of Object.entries(q.configs)) {
        if (isDefaultScanConfig(config)) continue;
        put(
          "shared",
          ws(conn, "scanConfig", type),
          { lookups: config.lookups, actions: config.actions.map(canonAction), ...(config.presetId ? { presetId: config.presetId } : {}) },
          FIELDS.scanConfig,
        );
      }
      for (const [type, presets] of Object.entries(q.presets)) {
        for (const p of presets) {
          put("shared", ws(conn, "scanPreset", type, p.id), { name: p.name, lookups: p.lookups, actions: p.actions.map(canonAction) }, FIELDS.scanPreset);
        }
      }
      const r = useReports.getState();
      for (const source of r.sources) {
        if (sameWorkspace(source, conn)) put("desktop", ws(conn, "reportSource", source.id), canonSource(source), FIELDS.reportSource);
      }
      for (const report of r.reports) {
        if (sameWorkspace(report, conn)) put("desktop", ws(conn, "report", report.id), canonReport(report), FIELDS.report);
      }
    }

    for (const tpl of t.templates) put("desktop", recordKey("template", tpl.id), JSON.parse(JSON.stringify(tpl)) as Json, FIELDS.template);
    if (t.defaultTemplateId) put("desktop", "defaultTemplate", t.defaultTemplateId);
    const { unit, width, height } = s.labelDefaults;
    if (unit !== DEFAULT_LABEL.unit || width !== DEFAULT_LABEL.width || height !== DEFAULT_LABEL.height) {
      put("desktop", "labelDefaults", { unit, width, height }, FIELDS.labelDefaults);
    }
    if (u.channel !== DEFAULT_UPDATER.channel || u.autoCheck !== DEFAULT_UPDATER.autoCheck) {
      put("desktop", "updater", { channel: u.channel, autoCheck: u.autoCheck }, FIELDS.updater);
    }
    return out;
  }

  function isManaged(id: string): boolean {
    const [scope, key] = splitRid(id);
    const [kind, cloudId, workspaceId] = decodeKey(key);
    const conn = deps.connection();
    if (scope === "shared" && (kind === "connection" || kind === "selection")) return !!conn;
    if (WORKSPACE_KINDS.has(kind)) {
      const expected = DESKTOP_WORKSPACE_KINDS.has(kind) ? "desktop" : "shared";
      return scope === expected && !!conn && cloudId === conn.cloudId && workspaceId === conn.workspaceId;
    }
    return GLOBAL_KINDS.has(`${scope}|${kind}`);
  }

  function applyOne(change: Change): ApplyResult {
    const [scope, key] = splitRid(change.rid);
    const parts = decodeKey(key);
    const [kind] = parts;
    const v = change.value;
    const conn = deps.connection();
    const typeId = parts[3];

    switch (`${scope}|${kind}`) {
      case "shared|connection":
        // Never switch Jira connections automatically; the UI offers the synced profile instead.
        return { status: "deferred" };
      case "shared|selection": {
        if (v === undefined) {
          useSettings.setState({ schemaId: null, objectTypeId: null });
          return { status: "applied" };
        }
        check(isObj(v) && isStr(v.cloudId) && isStr(v.workspaceId) && isStr(v.schemaId) && (v.objectTypeId === null || isStr(v.objectTypeId)));
        const sel = v as Obj;
        if (!conn || sel.cloudId !== conn.cloudId || sel.workspaceId !== conn.workspaceId) return { status: "deferred" };
        useSettings.setState({ schemaId: sel.schemaId as string, objectTypeId: sel.objectTypeId as string | null });
        return { status: "applied" };
      }
      case "shared|theme":
        check(v === undefined || v === "light" || v === "dark");
        deps.theme.set((v as ThemeValue | undefined) ?? "system");
        return { status: "applied" };
      case "shared|filter": {
        const id = parts[1];
        if (v !== undefined) check(isObj(v) && isStr(v.name) && isStr(v.aql));
        useSettings.setState((s) => {
          const rest = s.aqlPresets.filter((p) => p.id !== id);
          if (v === undefined) return { aqlPresets: rest };
          const preset = { id, name: (v as Obj).name as string, aql: (v as Obj).aql as string };
          const i = s.aqlPresets.findIndex((p) => p.id === id);
          return { aqlPresets: i < 0 ? [...rest, preset] : s.aqlPresets.map((p) => (p.id === id ? preset : p)) };
        });
        return { status: "applied" };
      }
      case "shared|filterOrder": {
        check(parts.length === 1);
        if (v === undefined) return { status: "applied" };
        if (!isStrArray(v) || new Set(v).size !== v.length) throw new Invalid("The synced filter order is malformed.");
        useSettings.setState((s) => {
          const byId = new Map(s.aqlPresets.map((p) => [p.id, p]));
          return { aqlPresets: [
            ...v.flatMap((id) => byId.get(id) ?? []),
            ...s.aqlPresets.filter((p) => !v.includes(p.id)),
          ] };
        });
        return { status: "applied" };
      }
      case "shared|statusColor": {
        const name = parts[1];
        check(v === undefined || v === null || (COLOR_KEYS as readonly string[]).includes(v as string));
        useSettings.setState((s) => {
          const next = { ...s.statusColors };
          const value = v === undefined ? DEFAULT_STATUS_COLORS[name] : v;
          if (value) next[name] = value as ColorKey;
          else delete next[name];
          return { statusColors: next };
        });
        return { status: "applied" };
      }
      case "shared|rule": {
        const id = parts[1];
        let rule: Rule | null = null;
        if (v !== undefined) {
          try {
            rule = parseRules([v])[0];
          } catch (e) {
            throw new Invalid(e instanceof Error ? e.message : "The synced rule is malformed.");
          }
          check(rule.id === id);
        }
        useSettings.setState((s) => {
          if (!rule) return { rules: s.rules.filter((r) => r.id !== id) };
          const exists = s.rules.some((r) => r.id === id);
          return { rules: exists ? s.rules.map((r) => (r.id === id ? rule! : r)) : [...s.rules, rule] };
        });
        return { status: "applied" };
      }
      case "shared|ruleOrder": {
        if (v === undefined) return { status: "applied" };
        check(isStrArray(v));
        const [, cloudId, workspaceId, objectTypeId] = parts;
        useSettings.setState((s) => {
          const inGroup = (r: Rule) => r.cloudId === cloudId && r.workspaceId === workspaceId && r.objectTypeId === objectTypeId;
          const group = s.rules.filter(inGroup);
          const byId = new Map(group.map((r) => [r.id, r]));
          const ordered = [
            ...(v as string[]).flatMap((rid) => byId.get(rid) ?? []),
            ...group.filter((r) => !(v as string[]).includes(r.id)),
          ];
          let i = 0;
          return { rules: s.rules.map((r) => (inGroup(r) ? ordered[i++] : r)) };
        });
        return { status: "applied" };
      }
      case "shared|deletion": {
        const scopeKey = deletionScope({ cloudId: parts[1], workspaceId: parts[2] }, parts[3]);
        let config: DeletionConfig | undefined;
        if (v !== undefined) {
          try {
            config = parseDeletionConfigs({ [scopeKey]: v })[scopeKey];
          } catch (e) {
            throw new Invalid(e instanceof Error ? e.message : "The synced deletion settings are malformed.");
          }
        }
        useSettings.setState((s) => {
          const deletions = { ...s.deletions };
          if (config) deletions[scopeKey] = config;
          else delete deletions[scopeKey];
          return { deletions };
        });
        return { status: "applied" };
      }
      case "shared|scanSound":
        check(v === undefined || v === false);
        useQuickScan.setState({ sound: v === undefined });
        return { status: "applied" };
      case "shared|columns": {
        if (v !== undefined) check(isObj(v) && isStrArray(v.hidden) && (v.order === undefined || isStrArray(v.order)));
        useSettings.setState((s) => {
          const columns = { ...s.columns };
          if (v === undefined) delete columns[typeId];
          else {
            const c = v as Obj;
            const sizes = s.columns[typeId]?.sizes;
            columns[typeId] = { hidden: c.hidden as string[], ...(c.order ? { order: c.order as string[] } : {}), ...(sizes ? { sizes } : {}) };
          }
          return { columns };
        });
        return { status: "applied" };
      }
      case "desktop|columnSizes": {
        if (v !== undefined) check(isObj(v) && Object.values(v).every(isPos));
        const existing = useSettings.getState().columns[typeId];
        if (!existing) return v === undefined ? { status: "applied" } : { status: "deferred" };
        useSettings.setState((s) => {
          const { sizes: _old, ...rest } = s.columns[typeId];
          const sizes = v as Record<string, number> | undefined;
          return { columns: { ...s.columns, [typeId]: sizes && Object.keys(sizes).length ? { ...rest, sizes } : rest } };
        });
        return { status: "applied" };
      }
      case "shared|assetTag": {
        if (v !== undefined) check(isObj(v) && isStr(v.attributeId) && isStr(v.template));
        useSettings.setState((s) => {
          const assetTags = { ...s.assetTags };
          if (v === undefined) delete assetTags[typeId];
          else assetTags[typeId] = { attributeId: (v as Obj).attributeId as string, template: (v as Obj).template as string };
          return { assetTags };
        });
        return { status: "applied" };
      }
      case "shared|referenceDisplay": {
        check(v === undefined || (isStr(v) && v.length > 0));
        useSettings.getState().setReferenceDisplay(typeId, (v as string | undefined) ?? null);
        return { status: "applied" };
      }
      case "shared|scanConfig": {
        let config: ScanConfig | undefined;
        if (v !== undefined) {
          check(isObj(v) && (v.presetId === undefined || isStr(v.presetId)));
          const c = v as Obj;
          config = { lookups: readLookups(c.lookups), actions: readActions(c.actions), presetId: (c.presetId as string | undefined) ?? null };
        }
        useQuickScan.setState((q) => {
          const configs = { ...q.configs };
          if (config) configs[typeId] = config;
          else delete configs[typeId];
          return { configs };
        });
        return { status: "applied" };
      }
      case "shared|scanPreset": {
        const presetId = parts[4];
        let preset: ScanPreset | undefined;
        if (v !== undefined) {
          check(isObj(v) && isStr(v.name));
          const p = v as Obj;
          preset = { id: presetId, name: p.name as string, lookups: readLookups(p.lookups), actions: readActions(p.actions) };
        }
        useQuickScan.setState((q) => {
          const list = q.presets[typeId] ?? [];
          const exists = list.some((p) => p.id === presetId);
          const next = !preset
            ? list.filter((p) => p.id !== presetId)
            : exists
              ? list.map((p) => (p.id === presetId ? preset! : p))
              : [...list, preset];
          return { presets: { ...q.presets, [typeId]: next } };
        });
        return { status: "applied" };
      }
      case "desktop|template": {
        const id = parts[1];
        let tpl: LabelTemplate | null = null;
        if (v !== undefined) {
          tpl = cleanTemplate(v);
          check(!!tpl && tpl.id === id && isObj(v) && Array.isArray(v.elements) && tpl.elements.length === v.elements.length && v.updatedAt === tpl.updatedAt);
        }
        useTemplates.setState((s) => {
          if (!tpl) {
            const templates = s.templates.filter((x) => x.id !== id);
            return { templates, selectedId: s.selectedId === id ? (templates[0]?.id ?? null) : s.selectedId };
          }
          const exists = s.templates.some((x) => x.id === id);
          return { templates: exists ? s.templates.map((x) => (x.id === id ? tpl! : x)) : [...s.templates, tpl] };
        });
        return { status: "applied" };
      }
      case "desktop|defaultTemplate":
        check(v === undefined || isStr(v));
        useTemplates.setState({ defaultTemplateId: (v as string | undefined) ?? null });
        return { status: "applied" };
      case "desktop|labelDefaults": {
        if (v !== undefined) check(isObj(v) && ["mm", "in", "px"].includes(v.unit as string) && isPos(v.width) && isPos(v.height));
        const d = (v ?? DEFAULT_LABEL) as { unit: "mm" | "in" | "px"; width: number; height: number };
        useSettings.getState().setLabelDefaults({ unit: d.unit, width: d.width, height: d.height });
        return { status: "applied" };
      }
      case "desktop|updater": {
        if (v !== undefined) check(isObj(v) && (v.channel === "stable" || v.channel === "nightly") && typeof v.autoCheck === "boolean");
        const d = (v ?? DEFAULT_UPDATER) as { channel: "stable" | "nightly"; autoCheck: boolean };
        useUpdater.getState().setChannel(d.channel);
        useUpdater.getState().setAutoCheck(d.autoCheck);
        return { status: "applied" };
      }
      case "desktop|reportSource":
      case "desktop|report": {
        const [, cloudId, workspaceId, id] = parts;
        if (!conn || cloudId !== conn.cloudId || workspaceId !== conn.workspaceId) return { status: "deferred" };
        const parse = kind === "report" ? parseReport : parseSource;
        let item: ReportSource | SavedReport | null = null;
        if (v !== undefined) {
          check(isObj(v));
          try {
            item = parse({ ...(v as Obj), id, cloudId, workspaceId });
          } catch (e) {
            throw new Invalid(e instanceof ReportInvalid ? e.message : "The synced report is malformed.");
          }
        }
        // A deleted source leaves its reports in place; they cannot run until the source returns.
        const listKey = kind === "report" ? "reports" : "sources";
        useReports.setState((s) => {
          const list = s[listKey] as (ReportSource | SavedReport)[];
          const rest = list.filter((x) => x.id !== id);
          if (!item) return { [listKey]: rest };
          return { [listKey]: list.some((x) => x.id === id) ? list.map((x) => (x.id === id ? item! : x)) : [...rest, item] };
        });
        return { status: "applied" };
      }
      default:
        return { status: "deferred" };
    }
  }

  return {
    scopes: DESKTOP_SCOPES,
    project,
    isManaged,
    apply(changes) {
      const rank = (c: Change) => {
        const i = APPLY_ORDER.indexOf(decodeKey(splitRid(c.rid)[1])[0]);
        return i < 0 ? -1 : i;
      };
      const order = changes.map((_, i) => i).sort((a, b) => rank(changes[a]) - rank(changes[b]) || a - b);
      const results: ApplyResult[] = new Array(changes.length);
      for (const i of order) {
        try {
          results[i] = applyOne(changes[i]);
        } catch (e) {
          if (!(e instanceof Invalid)) throw e;
          results[i] = { status: "invalid", message: e.message };
        }
      }
      return results;
    },
    flush: flushStores,
    autoResolveLocal: (id) => id === "shared|connection" || id === "shared|selection",
  };
}
