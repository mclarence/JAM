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
}

export const DEFAULT_SCAN_CONFIG: ScanConfig = { lookup: SEARCH_KEY, actions: [] };

interface QuickScanState {
  /** Per object type id. */
  configs: Record<string, ScanConfig>;
  sound: boolean;

  setConfig: (objectTypeId: string, patch: Partial<ScanConfig>) => void;
  setSound: (sound: boolean) => void;
}

export const useQuickScan = create<QuickScanState>()(
  persist(
    (set) => ({
      configs: {},
      sound: true,

      setConfig: (objectTypeId, patch) =>
        set((s) => ({
          configs: {
            ...s.configs,
            [objectTypeId]: { ...DEFAULT_SCAN_CONFIG, ...s.configs[objectTypeId], ...patch },
          },
        })),
      setSound: (sound) => set({ sound }),
    }),
    { name: "quickscan", storage: fileStorage("quickscan.json"), version: 1 },
  ),
);
