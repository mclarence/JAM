import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_STATUS_COLORS, type ColorKey } from "@/lib/statusColors";
import { fileStorage } from "./persist";

export interface AqlPreset {
  id: string;
  name: string;
  aql: string;
}

export interface ColumnPrefs {
  hidden: string[];
  order?: string[];
  sizes?: Record<string, number>;
}

export type PdfOutput = "open" | "save";

interface SettingsState {
  schemaId: string | null;
  objectTypeId: string | null;
  /** Lower-cased status name -> colour. */
  statusColors: Record<string, ColorKey>;
  columns: Record<string, ColumnPrefs>;
  aqlPresets: AqlPreset[];
  labelDefaults: { unit: "mm" | "in" | "px"; width: number; height: number; output: PdfOutput };

  setSchema: (schemaId: string | null) => void;
  setObjectType: (objectTypeId: string | null) => void;
  setStatusColor: (name: string, color: ColorKey | null) => void;
  resetStatusColors: () => void;
  setColumnPrefs: (objectTypeId: string, prefs: ColumnPrefs) => void;
  resetColumnPrefs: (objectTypeId: string) => void;
  savePreset: (name: string, aql: string) => void;
  deletePreset: (id: string) => void;
  setLabelDefaults: (patch: Partial<SettingsState["labelDefaults"]>) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      schemaId: null,
      objectTypeId: null,
      statusColors: { ...DEFAULT_STATUS_COLORS },
      columns: {},
      aqlPresets: [],
      labelDefaults: { unit: "mm", width: 62, height: 29, output: "open" },

      setSchema: (schemaId) => set({ schemaId, objectTypeId: null }),
      setObjectType: (objectTypeId) => set({ objectTypeId }),
      setStatusColor: (name, color) =>
        set((s) => {
          const key = name.trim().toLowerCase();
          const next = { ...s.statusColors };
          if (color) next[key] = color;
          else delete next[key];
          return { statusColors: next };
        }),
      resetStatusColors: () => set({ statusColors: { ...DEFAULT_STATUS_COLORS } }),
      setColumnPrefs: (objectTypeId, prefs) => set((s) => ({ columns: { ...s.columns, [objectTypeId]: prefs } })),
      resetColumnPrefs: (objectTypeId) =>
        set((s) => {
          const columns = { ...s.columns };
          delete columns[objectTypeId];
          return { columns };
        }),
      savePreset: (name, aql) =>
        set((s) => ({ aqlPresets: [...s.aqlPresets, { id: crypto.randomUUID(), name, aql }] })),
      deletePreset: (id) => set((s) => ({ aqlPresets: s.aqlPresets.filter((p) => p.id !== id) })),
      setLabelDefaults: (patch) => set((s) => ({ labelDefaults: { ...s.labelDefaults, ...patch } })),
    }),
    { name: "settings", storage: fileStorage("settings.json"), version: 1 },
  ),
);
