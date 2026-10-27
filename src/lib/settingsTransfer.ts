import { PAPER_MM, type LabelElement, type LabelTemplate, type SheetLayout, type Unit } from "@/components/labels/model";
import { foldBaseStyle } from "@/components/labels/richText";
import { SEARCH_KEY } from "@/lib/aql";
import type { AssetTagConfig } from "@/lib/assetTag";
import { COLOR_KEYS, type ColorKey } from "@/lib/statusColors";
import { useSettings, type AqlPreset, type ColumnPrefs, type PdfOutput } from "@/store/settings";
import { useQuickScan, type ScanAction, type ScanPreset } from "@/store/quickScan";
import { useTemplates } from "@/store/templates";
import { useThemeStore, type ThemePref } from "@/store/theme";

// Only whitelisted data is exported, so the API token, auth settings and network options can never leak into a file.
const FORMAT = "jira-assets-manager-settings";
const VERSION = 1;

export type Section = "filters" | "columns" | "assetTags" | "statusColors" | "scanPresets" | "templates" | "preferences";
export type ImportMode = "merge" | "replace";

export const SECTION_LABELS: Record<Section, string> = {
  filters: "Saved filters",
  columns: "Column layouts",
  assetTags: "Asset tag numbering",
  statusColors: "Status colours",
  scanPresets: "Quick Scan presets",
  templates: "Label templates",
  preferences: "Preferences (selected schema/type, label defaults, theme)",
};

interface Preferences {
  schemaId: string | null;
  objectTypeId: string | null;
  labelDefaults: { unit: Unit; width: number; height: number; output: PdfOutput };
  theme: ThemePref;
}

export interface SettingsBundle {
  filters?: AqlPreset[];
  columns?: Record<string, ColumnPrefs>;
  assetTags?: Record<string, AssetTagConfig>;
  statusColors?: Record<string, ColorKey>;
  /** Quick Scan presets per object type id. */
  scanPresets?: Record<string, ScanPreset[]>;
  templates?: { items: LabelTemplate[]; defaultTemplateId: string | null };
  preferences?: Preferences;
}

export function buildExport(): string {
  const s = useSettings.getState();
  const t = useTemplates.getState();
  const bundle: SettingsBundle = {
    filters: s.aqlPresets,
    columns: s.columns,
    assetTags: s.assetTags,
    statusColors: s.statusColors,
    scanPresets: useQuickScan.getState().presets,
    templates: { items: t.templates, defaultTemplateId: t.defaultTemplateId },
    preferences: {
      schemaId: s.schemaId,
      objectTypeId: s.objectTypeId,
      labelDefaults: s.labelDefaults,
      theme: useThemeStore.getState().pref,
    },
  };
  return JSON.stringify({ format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), ...bundle }, null, 2);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPos = (v: unknown): v is number => isNum(v) && v > 0;
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): v is T => allowed.includes(v as T);
const strArray = (v: unknown) => (Array.isArray(v) ? v.filter(isStr) : []);

function mapValues<T>(v: unknown, fn: (x: unknown) => T | null): Record<string, T> {
  const out: Record<string, T> = {};
  if (!isObj(v)) return out;
  for (const [k, x] of Object.entries(v)) {
    const r = fn(x);
    if (r !== null) out[k] = r;
  }
  return out;
}

function cleanFilters(v: unknown): AqlPreset[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((p) => (isObj(p) && isStr(p.id) && isStr(p.name) && isStr(p.aql) ? [{ id: p.id, name: p.name, aql: p.aql }] : []));
}

function cleanColumns(v: unknown) {
  return mapValues<ColumnPrefs>(v, (c) => {
    if (!isObj(c)) return null;
    const sizes = mapValues<number>(c.sizes, (n) => (isPos(n) ? n : null));
    return {
      hidden: strArray(c.hidden),
      ...(Array.isArray(c.order) ? { order: strArray(c.order) } : {}),
      ...(Object.keys(sizes).length ? { sizes } : {}),
    };
  });
}

function cleanAssetTags(v: unknown) {
  return mapValues<AssetTagConfig>(v, (c) =>
    isObj(c) && isStr(c.attributeId) && isStr(c.template) ? { attributeId: c.attributeId, template: c.template } : null,
  );
}

function cleanScanAction(a: unknown): ScanAction | null {
  if (!isObj(a) || !isStr(a.id) || !isStr(a.attrId) || !oneOf(a.mode, ["set", "clear", "now"] as const)) return null;
  return { id: a.id, attrId: a.attrId, mode: a.mode, value: isStr(a.value) ? a.value : "", display: isStr(a.display) ? a.display : "" };
}

// Older exports carry a single `lookup` string.
function cleanLookups(p: Record<string, unknown>) {
  const list = Array.isArray(p.lookups) ? p.lookups.filter(isStr) : isStr(p.lookup) ? [p.lookup] : [];
  return list.length ? list : [SEARCH_KEY];
}

function cleanScanPresets(v: unknown) {
  return mapValues<ScanPreset[]>(v, (list) => {
    if (!Array.isArray(list)) return null;
    return list.flatMap((p) =>
      isObj(p) && isStr(p.id) && isStr(p.name) && Array.isArray(p.actions)
        ? [{ id: p.id, name: p.name, lookups: cleanLookups(p), actions: p.actions.flatMap((a) => cleanScanAction(a) ?? []) }]
        : [],
    );
  });
}

function cleanElement(e: unknown): LabelElement | null {
  if (!isObj(e) || !isStr(e.id) || !isNum(e.x) || !isNum(e.y) || !isPos(e.w) || !isPos(e.h)) return null;
  const base = { id: e.id, x: e.x, y: e.y, w: e.w, h: e.h };
  if (e.kind === "text") {
    if (!isStr(e.content) || !isPos(e.fontSize) || !isPos(e.lineHeight) || !oneOf(e.align, ["left", "center", "right"] as const)) {
      return null;
    }
    return foldBaseStyle({
      ...base,
      kind: "text" as const,
      content: e.content,
      fontSize: e.fontSize,
      bold: e.bold === true,
      italic: e.italic === true,
      align: e.align,
      lineHeight: e.lineHeight,
      fit: e.fit === "shrink" ? ("shrink" as const) : ("wrap" as const),
    });
  }
  if (e.kind === "barcode") {
    if (!isStr(e.value) || !oneOf(e.symbology, ["qrcode", "code128"] as const)) return null;
    return { ...base, kind: "barcode", symbology: e.symbology, value: e.value, showText: e.showText === true };
  }
  return null;
}

function cleanLayout(l: unknown): SheetLayout | null {
  if (!isObj(l)) return null;
  if (l.mode === "single") return { mode: "single" };
  if (
    l.mode === "sheet" &&
    oneOf(l.paper, Object.keys(PAPER_MM) as (keyof typeof PAPER_MM)[]) &&
    oneOf(l.orientation, ["portrait", "landscape"] as const) &&
    isPos(l.columns) &&
    isPos(l.rows) &&
    isNum(l.marginTop) &&
    isNum(l.marginLeft) &&
    isNum(l.gapX) &&
    isNum(l.gapY)
  ) {
    return {
      mode: "sheet",
      paper: l.paper,
      orientation: l.orientation,
      columns: Math.floor(l.columns),
      rows: Math.floor(l.rows),
      marginTop: l.marginTop,
      marginLeft: l.marginLeft,
      gapX: l.gapX,
      gapY: l.gapY,
    };
  }
  return null;
}

function cleanTemplate(t: unknown): LabelTemplate | null {
  if (!isObj(t) || !isStr(t.id) || !isStr(t.name) || !oneOf(t.unit, ["mm", "in", "px"] as const) || !isPos(t.width) || !isPos(t.height)) {
    return null;
  }
  const layout = cleanLayout(t.layout);
  if (!layout || !Array.isArray(t.elements)) return null;
  return {
    id: t.id,
    name: t.name,
    unit: t.unit,
    width: t.width,
    height: t.height,
    layout,
    elements: t.elements.flatMap((e) => cleanElement(e) ?? []),
    updatedAt: isNum(t.updatedAt) ? t.updatedAt : Date.now(),
  };
}

function cleanPreferences(p: unknown): Preferences | undefined {
  if (!isObj(p) || !isObj(p.labelDefaults)) return undefined;
  const d = p.labelDefaults;
  if (!oneOf(d.unit, ["mm", "in", "px"] as const) || !isPos(d.width) || !isPos(d.height) || !oneOf(d.output, ["open", "save"] as const)) {
    return undefined;
  }
  return {
    schemaId: isStr(p.schemaId) ? p.schemaId : null,
    objectTypeId: isStr(p.objectTypeId) ? p.objectTypeId : null,
    labelDefaults: { unit: d.unit, width: d.width, height: d.height, output: d.output },
    theme: oneOf(p.theme, ["light", "dark", "system"] as const) ? p.theme : "system",
  };
}

/** Validates a settings file and returns only the recognised, well-formed data. */
export function parseImport(text: string): SettingsBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("The file is not valid JSON.");
  }
  if (!isObj(raw) || raw.format !== FORMAT) throw new Error("This is not a JAM settings export.");
  if (!isNum(raw.version) || raw.version > VERSION) {
    throw new Error("This export was created by a newer version of the app. Update the app and try again.");
  }

  const bundle: SettingsBundle = {};
  if ("filters" in raw) bundle.filters = cleanFilters(raw.filters);
  if ("columns" in raw) bundle.columns = cleanColumns(raw.columns);
  if ("assetTags" in raw) bundle.assetTags = cleanAssetTags(raw.assetTags);
  if ("statusColors" in raw) {
    bundle.statusColors = mapValues<ColorKey>(raw.statusColors, (c) => (oneOf(c, COLOR_KEYS) ? c : null));
  }
  if ("scanPresets" in raw) bundle.scanPresets = cleanScanPresets(raw.scanPresets);
  if (isObj(raw.templates)) {
    const items = Array.isArray(raw.templates.items) ? raw.templates.items.flatMap((t) => cleanTemplate(t) ?? []) : [];
    const def = isStr(raw.templates.defaultTemplateId) ? raw.templates.defaultTemplateId : null;
    bundle.templates = { items, defaultTemplateId: items.some((t) => t.id === def) ? def : null };
  }
  const prefs = cleanPreferences(raw.preferences);
  if (prefs) bundle.preferences = prefs;

  if (Object.keys(bundle).length === 0) throw new Error("The file contains no recognised settings.");
  return bundle;
}

export function sectionCounts(b: SettingsBundle): Partial<Record<Section, number>> {
  return {
    ...(b.filters && { filters: b.filters.length }),
    ...(b.columns && { columns: Object.keys(b.columns).length }),
    ...(b.assetTags && { assetTags: Object.keys(b.assetTags).length }),
    ...(b.statusColors && { statusColors: Object.keys(b.statusColors).length }),
    ...(b.scanPresets && { scanPresets: Object.values(b.scanPresets).reduce((n, l) => n + l.length, 0) }),
    ...(b.templates && { templates: b.templates.items.length }),
    ...(b.preferences && { preferences: 1 }),
  };
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]) {
  const ids = new Set(incoming.map((x) => x.id));
  return [...current.filter((x) => !ids.has(x.id)), ...incoming];
}

export function applyImport(bundle: SettingsBundle, sections: Set<Section>, mode: ImportMode) {
  const replace = mode === "replace";
  const patch: Partial<ReturnType<typeof useSettings.getState>> = {};
  const cur = useSettings.getState();

  if (sections.has("filters") && bundle.filters) {
    patch.aqlPresets = replace ? bundle.filters : mergeById(cur.aqlPresets, bundle.filters);
  }
  if (sections.has("columns") && bundle.columns) patch.columns = replace ? bundle.columns : { ...cur.columns, ...bundle.columns };
  if (sections.has("assetTags") && bundle.assetTags) {
    patch.assetTags = replace ? bundle.assetTags : { ...cur.assetTags, ...bundle.assetTags };
  }
  if (sections.has("statusColors") && bundle.statusColors) {
    patch.statusColors = replace ? bundle.statusColors : { ...cur.statusColors, ...bundle.statusColors };
  }
  if (sections.has("preferences") && bundle.preferences) {
    patch.schemaId = bundle.preferences.schemaId;
    patch.objectTypeId = bundle.preferences.objectTypeId;
    patch.labelDefaults = bundle.preferences.labelDefaults;
  }
  useSettings.setState(patch);

  if (sections.has("scanPresets") && bundle.scanPresets) {
    const current = useQuickScan.getState().presets;
    const presets = replace ? bundle.scanPresets : { ...current };
    if (!replace) {
      for (const [typeId, list] of Object.entries(bundle.scanPresets)) presets[typeId] = mergeById(current[typeId] ?? [], list);
    }
    useQuickScan.setState({ presets });
  }
  if (sections.has("templates") && bundle.templates) {
    const t = useTemplates.getState();
    const templates = replace ? bundle.templates.items : mergeById(t.templates, bundle.templates.items);
    const defaultTemplateId = bundle.templates.defaultTemplateId ?? (replace ? null : t.defaultTemplateId);
    const fallback = templates.some((x) => x.id === defaultTemplateId) ? defaultTemplateId : (templates[0]?.id ?? null);
    useTemplates.setState({
      templates,
      defaultTemplateId: fallback,
      selectedId: templates.some((x) => x.id === t.selectedId) ? t.selectedId : (templates[0]?.id ?? null),
    });
  }
  if (sections.has("preferences") && bundle.preferences) useThemeStore.getState().setPref(bundle.preferences.theme);
}
