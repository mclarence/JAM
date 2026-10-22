import { create } from "zustand";

export type Page = "dashboard" | "assets" | "templates" | "settings";
export type SettingsTab = "connection" | "schema" | "assetTag" | "status" | "labels" | "backup";

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
  rawAql: string;
  editing: EditingCell | null;
  detailObjectId: string | null;
  notifications: Notification[];
  unread: number;
  searchFocusTick: number;

  navigate: (page: Page, settingsTab?: SettingsTab) => void;
  toggleSidebar: () => void;
  setSearch: (search: string) => void;
  setSearchField: (field: string) => void;
  setRawAql: (aql: string) => void;
  setEditing: (cell: EditingCell | null) => void;
  openDetail: (objectId: string | null) => void;
  pushNotification: (n: Omit<Notification, "id" | "at">) => void;
  markRead: () => void;
  clearNotifications: () => void;
  focusSearch: () => void;
}

export const useUi = create<UiState>((set) => ({
  page: "assets",
  settingsTab: "connection",
  sidebarCollapsed: false,
  search: "",
  searchField: "__all__",
  rawAql: "",
  editing: null,
  detailObjectId: null,
  notifications: [],
  unread: 0,
  searchFocusTick: 0,

  navigate: (page, settingsTab) => set((s) => ({ page, settingsTab: settingsTab ?? s.settingsTab })),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSearch: (search) => set({ search }),
  setSearchField: (searchField) => set({ searchField }),
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
}));
