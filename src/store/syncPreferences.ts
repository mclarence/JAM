import { validateCategories, type SyncCategory } from "@/lib/sync/categories";
import { fileStorage, flushStores } from "./persist";

export interface SyncPreferences {
  v: 1;
  selected: SyncCategory[];
  active: SyncCategory[];
  generationId: string | null;
}

const storage = fileStorage("sync-preferences.json");
const key = "sync-preferences";

export async function loadSyncPreferences(): Promise<SyncPreferences | null> {
  const saved = await storage!.getItem(key);
  if (!saved) return null;
  const data = saved.state;
  if (!data || typeof data !== "object" || !("v" in data) || data.v !== 1 ||
      !("selected" in data) || !("active" in data) || !("generationId" in data) ||
      (data.generationId !== null && typeof data.generationId !== "string")) {
    throw new Error("Could not read this device's sync choices. Confirm which settings to sync again.");
  }
  const selected = validateCategories(data.selected);
  const active = validateCategories(data.active);
  if (active.some((id) => !selected.includes(id))) throw new Error("This device's sync choices are inconsistent. Choose them again.");
  return { v: 1, selected, active, generationId: data.generationId };
}

export async function saveSyncPreferences(value: SyncPreferences): Promise<void> {
  await storage!.setItem(key, { state: value, version: 1 });
  await flushStores();
}
