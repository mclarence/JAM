import { create } from "zustand";
import { persist } from "zustand/middleware";
import { SEARCH_KEY } from "@/lib/aql";
import { fileStorage } from "./persist";

export type ScanMode = "set" | "clear" | "now";

export interface ScanAction {
  id: string;
  attrId: string;
  mode: ScanMode;
  /** Raw API value (status id, object key, option, ISO date, text); unused for clear/now. */
  value: string;
  /** Human-readable form of `value` for the scan log. */
  display: string;
}

export interface ScanConfig {
  /** SEARCH_KEY or an attribute id to match the scanned text against. */
  lookup: string;
  actions: ScanAction[];
  /** Preset this setup was loaded from or saved as. */
  presetId?: string | null;
}

export interface ScanPreset {
  id: string;
  name: string;
  lookup: string;
  actions: ScanAction[];
}

export const DEFAULT_SCAN_CONFIG: ScanConfig = { lookup: SEARCH_KEY, actions: [] };

interface QuickScanState {
  /** Per object type id. */
  configs: Record<string, ScanConfig>;
  presets: Record<string, ScanPreset[]>;
  sound: boolean;

  setConfig: (objectTypeId: string, patch: Partial<ScanConfig>) => void;
  /** Saves the current setup as a new preset and links the setup to it. */
  savePreset: (objectTypeId: string, name: string) => void;
  updatePreset: (objectTypeId: string, presetId: string) => void;
  deletePreset: (objectTypeId: string, presetId: string) => void;
  loadPreset: (objectTypeId: string, presetId: string) => void;
  setSound: (sound: boolean) => void;
}

const freshIds = (actions: ScanAction[]) => actions.map((a) => ({ ...a, id: crypto.randomUUID() }));

export const useQuickScan = create<QuickScanState>()(
  persist(
    (set) => ({
      configs: {},
      presets: {},
      sound: true,

      setConfig: (objectTypeId, patch) =>
        set((s) => ({
          configs: {
            ...s.configs,
            [objectTypeId]: { ...DEFAULT_SCAN_CONFIG, ...s.configs[objectTypeId], ...patch },
          },
        })),
      savePreset: (objectTypeId, name) =>
        set((s) => {
          const cfg = s.configs[objectTypeId] ?? DEFAULT_SCAN_CONFIG;
          const preset: ScanPreset = { id: crypto.randomUUID(), name, lookup: cfg.lookup, actions: freshIds(cfg.actions) };
          return {
            presets: { ...s.presets, [objectTypeId]: [...(s.presets[objectTypeId] ?? []), preset] },
            configs: { ...s.configs, [objectTypeId]: { ...cfg, presetId: preset.id } },
          };
        }),
      updatePreset: (objectTypeId, presetId) =>
        set((s) => {
          const cfg = s.configs[objectTypeId] ?? DEFAULT_SCAN_CONFIG;
          return {
            presets: {
              ...s.presets,
              [objectTypeId]: (s.presets[objectTypeId] ?? []).map((p) =>
                p.id === presetId ? { ...p, lookup: cfg.lookup, actions: freshIds(cfg.actions) } : p,
              ),
            },
          };
        }),
      deletePreset: (objectTypeId, presetId) =>
        set((s) => {
          const cfg = s.configs[objectTypeId] ?? DEFAULT_SCAN_CONFIG;
          return {
            presets: { ...s.presets, [objectTypeId]: (s.presets[objectTypeId] ?? []).filter((p) => p.id !== presetId) },
            configs: {
              ...s.configs,
              [objectTypeId]: { ...cfg, presetId: cfg.presetId === presetId ? null : cfg.presetId },
            },
          };
        }),
      loadPreset: (objectTypeId, presetId) =>
        set((s) => {
          const p = s.presets[objectTypeId]?.find((x) => x.id === presetId);
          if (!p) return s;
          return {
            configs: {
              ...s.configs,
              [objectTypeId]: { lookup: p.lookup, actions: freshIds(p.actions), presetId: p.id },
            },
          };
        }),
      setSound: (sound) => set({ sound }),
    }),
    { name: "quickscan", storage: fileStorage("quickscan.json"), version: 1 },
  ),
);
