import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  type Batch = { batchId: string; scope: string; plaintext: string };
  const drive = { vaults: [] as { generationId: string; createdAt: string }[], batches: new Map<string, Batch[]>() };
  const status = { configured: true, signedIn: true, email: "me@example.com", generationId: null as string | null, deviceId: "d".repeat(32) };
  const theme = { pref: "system" as "light" | "dark" | "system" };
  let saved: string | null = null;
  const newest = () => drive.vaults[0]?.generationId;
  const addVault = (generationId: string) => {
    drive.vaults.unshift({ generationId, createdAt: new Date().toISOString() });
    drive.batches.set(generationId, []);
  };
  const syncApi = {
    status: async () => ({ ...status }),
    listVaults: async () => [...drive.vaults],
    createVault: async () => {
      addVault("1".repeat(32));
      status.generationId = newest();
      return { ...status };
    },
    unlockVault: async (generationId: string, password: string) => {
      if (password !== "correct horse battery staple") throw new Error("The sync password is incorrect.");
      status.generationId = generationId;
      return { ...status };
    },
    pull: async (scopes: readonly string[], known: string[]) => {
      if (status.generationId !== newest()) return { batches: [], listed: [], stale: true };
      const all = drive.batches.get(status.generationId!)!.filter((b) => scopes.includes(b.scope));
      return { batches: all.filter((b) => !known.includes(b.batchId)), listed: all.map((b) => b.batchId), stale: false };
    },
    push: async (batchId: string, scope: string, plaintext: string) => {
      if (status.generationId !== newest()) throw Object.assign(new Error("stale"), { kind: "syncStale" });
      drive.batches.get(status.generationId!)!.push({ batchId, scope, plaintext });
    },
    stateLoad: async () => saved,
    stateSave: async (s: string) => void (saved = s),
  };
  return { drive, status, theme, syncApi, addVault };
});

vi.mock("sonner", () => ({ toast: Object.assign(() => {}, { dismiss: () => {}, success: () => {}, error: () => {} }) }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: async () => {}, Channel: class {} }));
vi.mock("@/store/persist", async () => {
  const { createJSONStorage } = await import("zustand/middleware");
  return { fileStorage: () => createJSONStorage(() => localStorage), flushStores: async () => {} };
});
vi.mock("@/store/theme", async () => {
  const { create } = await import("zustand");
  const useThemeStore = create<{ pref: "light" | "dark" | "system"; setPref: (p: "light" | "dark" | "system") => void }>((set) => ({
    pref: "system",
    setPref: (pref) => {
      h.theme.pref = pref;
      set({ pref });
    },
  }));
  return { useThemeStore };
});
vi.mock("@/api/client", async (orig) => {
  const actual = await orig<typeof import("@/api/client")>();
  const wrap = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A) => {
    try {
      return await f(...a);
    } catch (e) {
      const kind = (e as { kind?: string }).kind;
      throw new actual.ApiError((e as Error).message, (kind ?? "invalid") as never);
    }
  };
  return { ...actual, syncApi: Object.fromEntries(Object.entries(h.syncApi).map(([k, f]) => [k, wrap(f as never)])) };
});

vi.stubGlobal("window", { addEventListener: () => {} });
vi.stubGlobal("document", { hasFocus: () => false });

const { queryClient } = await import("@/api/queryClient");
const { qk } = await import("@/api/queryKeys");
const { useTemplates } = await import("@/store/templates");
const { useThemeStore } = await import("@/store/theme");
const { startSync, syncActions, useSync } = await import("./sync");
const { ALL_CATEGORIES } = await import("@/lib/sync/categories");

const PASSWORD = "correct horse battery staple";
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ok()).toBe(true);
};
const records = (gen: string) =>
  h.drive.batches.get(gen)!.flatMap((b) => (JSON.parse(b.plaintext) as { records: { key: string }[] }).records.map((r) => `${b.scope}|${r.key}`));
const remoteBatch = (gen: string, scope: string, records: unknown[]) =>
  h.drive.batches.get(gen)!.push({
    batchId: `${h.drive.batches.get(gen)!.length + 1}`.padStart(32, "e"),
    scope,
    plaintext: JSON.stringify({ format: "jam-sync-changes", version: 1, deviceId: "f".repeat(32), platform: "ios", createdAt: "2024-01-01T00:00:00Z", records }),
  });

describe("sync coordinator", () => {
  beforeAll(() => {
    queryClient.setQueryData(qk.connection, { siteUrl: "https://example.atlassian.net", email: "me@example.com", cloudId: "c", workspaceId: "w" });
    useTemplates.setState({
      templates: [{ id: "t1", name: "Label", unit: "mm", width: 62, height: 29, layout: { mode: "single" }, elements: [], updatedAt: 1 } as never],
    });
    startSync();
  });

  it("asks for a new password when no vault exists", async () => {
    await until(() => useSync.getState().phase === "locked");
    expect(useSync.getState().vaults).toEqual([]);
  });

  it("uploads this device's settings when sync is turned on, in the right scopes", async () => {
    await expect(syncActions.createVault(PASSWORD)).rejects.toThrow("Choose which settings");
    await syncActions.saveSelection(ALL_CATEGORIES);
    await syncActions.createVault(PASSWORD);
    expect(useSync.getState().phase).toBe("selectionReview");
    expect(records("1".repeat(32))).toEqual([]);
    const review = useSync.getState().selectionReview!;
    await syncActions.confirmSelectionReview(Object.fromEntries(review.rows.map((r) => [r.rid, "local"])));
    expect(useSync.getState().phase).toBe("ready");
    const uploaded = records("1".repeat(32));
    expect(uploaded).toContain("shared|connection");
    expect(uploaded).toContain("desktop|template:t1");
    expect(JSON.stringify([...h.drive.batches.values()])).not.toMatch(/token|secret/i);
  });

  it("applies settings from other devices and ignores scopes it does not sync", async () => {
    const gen = "1".repeat(32);
    remoteBatch(gen, "shared", [{ key: "theme", versionId: "a".repeat(32), parents: [], deleted: false, value: "dark" }]);
    remoteBatch(gen, "ios", [{ key: "haptics", versionId: "b".repeat(32), parents: [], deleted: false, value: false }]);
    await syncActions.syncNow();
    expect(useThemeStore.getState().pref).toBe("dark");
    expect(useSync.getState().conflicts).toEqual([]);
    expect(useSync.getState().error).toBeNull();
  });

  it("stops and asks for the new password after a reset on another device", async () => {
    h.addVault("2".repeat(32));
    remoteBatch("2".repeat(32), "shared", [{ key: "theme", versionId: "c".repeat(32), parents: [], deleted: false, value: "light" }]);
    await syncActions.syncNow();
    expect(useSync.getState().phase).toBe("stale");
    expect(useSync.getState().vaults[0].generationId).toBe("2".repeat(32));
  });

  it("reviews differences before syncing a new vault and uses explicit choices", async () => {
    await syncActions.unlockVault("2".repeat(32), PASSWORD);
    const s = useSync.getState();
    expect(s.phase).toBe("selectionReview");
    expect(s.selectionReview?.rows.map((r) => r.rid)).toContain("shared|theme");
    expect(useThemeStore.getState().pref).toBe("dark");

    const choices = Object.fromEntries(s.selectionReview!.rows.map((r) => [r.rid, r.rid === "shared|theme" ? r.options[0].versionId : "local"]));
    await syncActions.confirmSelectionReview(choices);
    expect(useSync.getState().phase).toBe("ready");
    expect(useThemeStore.getState().pref).toBe("light");
    expect(useSync.getState().conflicts).toEqual([]);
    expect(useSync.getState().error).toBeNull();
    expect(records("2".repeat(32)).filter((r) => r === "shared|theme")).toHaveLength(2);
  });

  it("pauses without uploading or applying when all categories are unchecked", async () => {
    await syncActions.saveSelection([]);
    const before = records("2".repeat(32)).length;
    useThemeStore.getState().setPref("dark");
    await syncActions.syncNow();
    expect(useSync.getState().phase).toBe("paused");
    expect(records("2".repeat(32))).toHaveLength(before);
    await syncActions.resolve("shared|theme", "light");
    expect(useThemeStore.getState().pref).toBe("dark");
    expect(useSync.getState().error).toContain("not enabled");
  });

  it("requires a fresh review after re-enabling a category and can cancel safely", async () => {
    await syncActions.saveSelection(["theme"]);
    expect(useSync.getState().phase).toBe("selectionReview");
    expect(useSync.getState().selectionReview?.rows.map((r) => r.rid)).toEqual(["shared|theme"]);
    expect(useThemeStore.getState().pref).toBe("dark");
    await syncActions.cancelSelectionReview();
    expect(useSync.getState().phase).toBe("paused");
    expect(useSync.getState().selected).toEqual([]);
    expect(useThemeStore.getState().pref).toBe("dark");
  });

  it("offers a reviewed connection as a suggestion without switching credentials or republishing the local profile", async () => {
    const gen = "2".repeat(32);
    remoteBatch(gen, "shared", [{
      key: "connection", versionId: "9".repeat(32), parents: [], deleted: false,
      value: { siteUrl: "https://other.atlassian.net", email: "other@example.com", cloudId: "other", workspaceId: "w2" },
    }]);
    await syncActions.saveSelection(["connection"]);
    const review = useSync.getState().selectionReview!;
    const row = review.rows.find((r) => r.rid === "shared|connection")!;
    await syncActions.confirmSelectionReview({ [row.rid]: "9".repeat(32) });
    expect(useSync.getState().suggestedConnection).toEqual({ siteUrl: "https://other.atlassian.net", email: "other@example.com" });
    expect(queryClient.getQueryData(qk.connection)).toMatchObject({ cloudId: "c", workspaceId: "w" });
    const before = records(gen).length;
    await syncActions.syncNow();
    expect(records(gen)).toHaveLength(before);
    await syncActions.saveSelection([]);
    expect(useSync.getState().suggestedConnection).toBeNull();
  });
});
