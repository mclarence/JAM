import { expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pulls: 0, pushes: 0, settings: new Map<string, string>([["shared|theme", "dark"]]),
  saved: JSON.stringify({ v: 1, generationId: "g", known: [], graph: {}, local: {}, pending: [], merged: true }),
  failSave: false,
}));
vi.mock("sonner", () => ({ toast: Object.assign(() => {}, { dismiss: () => {}, success: () => {}, error: () => {} }) }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: async () => {}, Channel: class {} }));
vi.mock("@/store/persist", async () => {
  const { createJSONStorage } = await import("zustand/middleware");
  return { fileStorage: () => createJSONStorage(() => localStorage), flushStores: async () => {
    if (h.failSave) throw new Error("Preferences could not be saved");
  } };
});
vi.mock("@/store/theme", () => ({ useThemeStore: {
  getState: () => ({ pref: "system", setPref: () => {} }), subscribe: () => () => {},
} }));
vi.mock("@/lib/sync/adapter", () => ({
  createDesktopAdapter: () => ({
    scopes: ["shared", "desktop"],
    project: () => new Map(h.settings),
    isManaged: (rid: string) => rid.startsWith("shared|"),
    apply: (changes: { rid: string; value: string | undefined }[]) => changes.map((c) => {
      if (c.value === undefined) h.settings.delete(c.rid);
      else h.settings.set(c.rid, c.value);
      return { status: "applied" };
    }),
    flush: async () => {},
  }),
}));
vi.mock("@/api/client", async (orig) => {
  const actual = await orig<typeof import("@/api/client")>();
  return { ...actual, syncApi: {
    status: async () => ({ configured: true, signedIn: true, email: "e", generationId: "g", deviceId: "d" }),
    stateLoad: async () => h.saved,
    stateSave: async (s: string) => { h.saved = s; },
    pull: async () => { h.pulls++; return { batches: [], listed: [], stale: false }; },
    push: async () => { h.pushes++; },
  } };
});
vi.stubGlobal("window", { addEventListener: () => {} });
vi.stubGlobal("document", { hasFocus: () => false });

const { startSync, syncActions, useSync } = await import("./sync");

it("pauses an already-enrolled device until confirmation and never publishes unreviewed selections", async () => {
  startSync();
  for (let i = 0; i < 100 && useSync.getState().phase === "loading"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(useSync.getState().phase).toBe("selectionRequired");
  await syncActions.syncNow();
  await syncActions.resolve("shared|theme", "light");
  expect(h.settings.get("shared|theme")).toBe("dark");
  expect(h.pulls).toBe(0);
  expect(h.pushes).toBe(0);

  h.failSave = true;
  await expect(syncActions.saveSelection(["theme"])).rejects.toThrow("could not be saved");
  expect(useSync.getState().selected).toBeNull();
  await syncActions.syncNow();
  expect(h.pulls).toBe(0);
  h.failSave = false;
  await syncActions.saveSelection(["theme"]);
  expect(useSync.getState().phase).toBe("selectionReview");
  expect(h.pushes).toBe(0);
  const review = useSync.getState().selectionReview!;
  // A local edit invalidates the displayed review even when the cloud has not changed.
  h.settings.set("shared|theme", "light");
  await expect(syncActions.confirmSelectionReview({ "shared|theme": "local" })).rejects.toThrow("changed during review");
  expect(h.pushes).toBe(0);
  expect(useSync.getState().selectionReview?.fingerprint).not.toBe(review.fingerprint);
  await syncActions.confirmSelectionReview({ "shared|theme": "local" });
  expect(useSync.getState().phase).toBe("ready");
  expect(h.pushes).toBe(1);
});
