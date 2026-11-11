import { create } from "zustand";
import { persist } from "zustand/middleware";
import { parseMappings, parseReport, parseSource, type ReportSource, type SavedReport } from "@/lib/reports/model";
import type { CollectSettings } from "@/lib/reports/types";
import { fileStorage } from "./persist";

export const DEFAULT_COLLECT: CollectSettings = { concurrency: 4, requestsPerSecond: 5 };

type Mappings = Record<string, Record<string, string>>;

interface ReportsState {
  /** Synced (optional "Reports" category) and included in settings backups. */
  sources: ReportSource[];
  reports: SavedReport[];
  /** Device-only: per source, attrId → raw history text → object key. Never synced or exported. */
  mappings: Record<string, Mappings>;
  /** Device-only Jira request limits for refreshes. */
  collect: CollectSettings;
  lastReportId: string | null;

  saveSource: (source: ReportSource) => void;
  /** Removes a source and the reports built on it. */
  removeSource: (id: string) => void;
  saveReport: (report: SavedReport) => void;
  removeReport: (id: string) => void;
  setMapping: (sourceId: string, attrId: string, raw: string, key: string | null) => void;
  setCollect: (settings: CollectSettings) => void;
  setLastReport: (id: string | null) => void;
}

const upsert = <T extends { id: string }>(list: T[], item: T) =>
  list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item];

const clamp = (n: unknown, min: number, max: number, fallback: number) =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;

export function cleanCollect(v: unknown): CollectSettings {
  const s = (v ?? {}) as Partial<CollectSettings>;
  return {
    concurrency: Math.round(clamp(s.concurrency, 1, 8, DEFAULT_COLLECT.concurrency)),
    requestsPerSecond: clamp(s.requestsPerSecond, 0.2, 20, DEFAULT_COLLECT.requestsPerSecond),
  };
}

const keep = <T,>(list: unknown, parse: (v: unknown) => T): T[] =>
  Array.isArray(list) ? list.flatMap((x) => {
    try {
      return [parse(x)];
    } catch {
      return [];
    }
  }) : [];

export const useReports = create<ReportsState>()(
  persist(
    (set) => ({
      sources: [],
      reports: [],
      mappings: {},
      collect: DEFAULT_COLLECT,
      lastReportId: null,

      saveSource: (source) => set((s) => ({ sources: upsert(s.sources, { ...source, updatedAt: Date.now() }) })),
      removeSource: (id) =>
        set((s) => {
          const mappings = { ...s.mappings };
          delete mappings[id];
          const reports = s.reports.filter((r) => r.sourceId !== id);
          return {
            sources: s.sources.filter((x) => x.id !== id),
            reports,
            mappings,
            lastReportId: reports.some((r) => r.id === s.lastReportId) ? s.lastReportId : null,
          };
        }),
      saveReport: (report) => set((s) => ({ reports: upsert(s.reports, { ...report, updatedAt: Date.now() }) })),
      removeReport: (id) =>
        set((s) => ({ reports: s.reports.filter((r) => r.id !== id), lastReportId: s.lastReportId === id ? null : s.lastReportId })),
      setMapping: (sourceId, attrId, raw, key) =>
        set((s) => {
          const forSource = { ...(s.mappings[sourceId] ?? {}) };
          const forAttr = { ...(forSource[attrId] ?? {}) };
          if (key) forAttr[raw] = key;
          else delete forAttr[raw];
          if (Object.keys(forAttr).length) forSource[attrId] = forAttr;
          else delete forSource[attrId];
          return { mappings: { ...s.mappings, [sourceId]: forSource } };
        }),
      setCollect: (collect) => set({ collect: cleanCollect(collect) }),
      setLastReport: (lastReportId) => set({ lastReportId }),
    }),
    {
      name: "reports",
      storage: fileStorage("reports.json"),
      version: 1,
      partialize: (s) => ({ sources: s.sources, reports: s.reports, mappings: s.mappings, collect: s.collect, lastReportId: s.lastReportId }),
      // Persisted data is validated like synced data, so a damaged file cannot break the page.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<ReportsState>;
        const mappings = p.mappings && typeof p.mappings === "object"
          ? Object.fromEntries(Object.entries(p.mappings).map(([id, m]) => [id, parseMappings(m)]))
          : {};
        return {
          ...current,
          sources: keep(p.sources, parseSource),
          reports: keep(p.reports, parseReport),
          mappings,
          collect: cleanCollect(p.collect),
          lastReportId: typeof p.lastReportId === "string" ? p.lastReportId : null,
        };
      },
    },
  ),
);
