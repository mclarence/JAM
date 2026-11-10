import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ failFlush: false }));
vi.mock("@/store/persist", async () => {
  const { createJSONStorage } = await import("zustand/middleware");
  return {
    fileStorage: () => createJSONStorage(() => localStorage),
    flushStores: async () => { if (h.failFlush) throw new Error("Could not save preferences"); },
  };
});

import { loadSyncPreferences, saveSyncPreferences, type SyncPreferences } from "./syncPreferences";

beforeEach(() => {
  localStorage.clear();
  h.failFlush = false;
});

it("keeps a missing selection unconfirmed and persists an explicit empty selection", async () => {
  expect(await loadSyncPreferences()).toBeNull();
  const empty: SyncPreferences = { v: 1, selected: [], active: [], generationId: null };
  await saveSyncPreferences(empty);
  expect(await loadSyncPreferences()).toEqual(empty);
});

it("persists staged choices separately from approved categories for crash-safe review", async () => {
  const staged: SyncPreferences = { v: 1, selected: ["theme", "columns"], active: ["theme"], generationId: "g" };
  await saveSyncPreferences(staged);
  expect(await loadSyncPreferences()).toEqual(staged);
});

it.each([
  { v: 2, selected: ["theme"], active: [], generationId: null },
  { v: 1, selected: ["future"], active: [], generationId: null },
  { v: 1, selected: [], active: ["columns"], generationId: "g" },
  { v: 1, selected: ["theme"] },
])("rejects malformed or unsupported preferences instead of enabling defaults", async (state) => {
  localStorage.setItem("sync-preferences", JSON.stringify({ state, version: 1 }));
  await expect(loadSyncPreferences()).rejects.toThrow();
});

it("surfaces unreadable JSON and persistence failures", async () => {
  localStorage.setItem("sync-preferences", "{broken");
  await expect(loadSyncPreferences()).rejects.toThrow();
  h.failFlush = true;
  await expect(saveSyncPreferences({ v: 1, selected: ["theme"], active: [], generationId: null })).rejects.toThrow("Could not save");
});
