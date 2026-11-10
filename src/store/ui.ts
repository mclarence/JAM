import { create } from "zustand";

export type Page = "dashboard" | "assets" | "quickscan" | "templates" | "settings";
export type SettingsTab = "connection" | "schema" | "assetTag" | "deletion" | "reference" | "status" | "rules" | "labels" | "backup" | "sync" | "updates";

export interface Notification {
  id: string;
  level: "error" | "success" | "info";
  message: string;
  at: number;
}

export interface EditingCell {
  objectId: string;
  attrId: string;
}

interface UiState {
  page: Page;
  settingsTab: SettingsTab;
  sidebarCollapsed: boolean;
  search: string;
  searchField: string;
  /** Asset used for the label designer preview; null means the first asset of the type. */
  previewObjectId: string | null;
  rawAql: string;
  editing: EditingCell | null;
  detailObjectId: string | null;
  notifications: Notification[];
  staleAssets: Record<string, string>;
  unread: number;
  searchFocusTick: number;

  navigate: (page: Page, settingsTab?: SettingsTab) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSearch: (search: string) => void;
  setSearchField: (field: string) => void;
  setPreviewObjectId: (id: string | null) => void;
  setRawAql: (aql: string) => void;
  setEditing: (cell: EditingCell | null) => void;
  openDetail: (objectId: string | null) => void;
  pushNotification: (n: Omit<Notification, "id" | "at">) => void;
  markRead: () => void;
  clearNotifications: () => void;
  focusSearch: () => void;
  markAssetStale: (id: string, message: string) => void;
  clearAssetStale: (id: string) => void;
  clearStaleAssets: () => void;
}

export const useUi = create<UiState>((set) => ({
  page: "assets",
  settingsTab: "connection",
  sidebarCollapsed: false,
  search: "",
  searchField: "__all__",
  previewObjectId: null,
  rawAql: "",
  editing: null,
  detailObjectId: null,
  notifications: [],
  staleAssets: {},
  unread: 0,
  searchFocusTick: 0,

  navigate: (page, settingsTab) => set((s) => ({ page, settingsTab: settingsTab ?? s.settingsTab })),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setSearch: (search) => set({ search }),
  setSearchField: (searchField) => set({ searchField }),
  setPreviewObjectId: (previewObjectId) => set({ previewObjectId }),
  setRawAql: (rawAql) => set({ rawAql }),
  setEditing: (editing) => set({ editing }),
  openDetail: (detailObjectId) => set({ detailObjectId }),
  pushNotification: (n) =>
    set((s) => ({
      notifications: [{ ...n, id: crypto.randomUUID(), at: Date.now() }, ...s.notifications].slice(0, 50),
      unread: s.unread + 1,
    })),
  markRead: () => set({ unread: 0 }),
  clearNotifications: () => set({ notifications: [], unread: 0 }),
  focusSearch: () => set((s) => ({ searchFocusTick: s.searchFocusTick + 1 })),
  markAssetStale: (id, message) => set((s) => ({ staleAssets: { ...s.staleAssets, [id]: message } })),
  clearAssetStale: (id) =>
    set((s) => {
      const staleAssets = { ...s.staleAssets };
      delete staleAssets[id];
      return { staleAssets };
    }),
  clearStaleAssets: () => set({ staleAssets: {} }),
}));
