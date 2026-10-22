import { isTauri } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";
import { createJSONStorage, type StateStorage } from "zustand/middleware";

const stores = new Map<string, Promise<Store>>();

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
        setItem: async (name, value) => (await getStore(file)).set(name, value),
        removeItem: async (name) => {
          await (await getStore(file)).delete(name);
        },
      }
    : localStorage;
  return createJSONStorage(() => storage);
}
