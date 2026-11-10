import { isTauri } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";
import { createJSONStorage, type StateStorage } from "zustand/middleware";

const stores = new Map<string, Promise<Store>>();
const pendingWrites = new Set<Promise<unknown>>();

function track<T>(p: Promise<T>): Promise<T> {
  pendingWrites.add(p);
  void p.finally(() => pendingWrites.delete(p)).catch(() => {});
  return p;
}

function getStore(file: string) {
  let s = stores.get(file);
  if (!s) {
    s = load(file, { defaults: {}, autoSave: 300 });
    stores.set(file, s);
  }
  return s;
}

/** Zustand storage backed by a tauri-plugin-store JSON file (localStorage in a plain browser). */
export function fileStorage(file: string) {
  const storage: StateStorage = isTauri()
    ? {
        getItem: async (name) => (await (await getStore(file)).get<string>(name)) ?? null,
        setItem: (name, value) => track((async () => (await getStore(file)).set(name, value))()),
        removeItem: async (name) => {
          await (await getStore(file)).delete(name);
        },
      }
    : localStorage;
  return createJSONStorage(() => storage);
}

/** Waits for queued store writes and saves every store file to disk now, instead of after the autosave delay. */
export async function flushStores() {
  if (!isTauri()) return;
  while (pendingWrites.size) await Promise.all([...pendingWrites]);
  await Promise.all([...stores.values()].map(async (s) => (await s).save()));
}
