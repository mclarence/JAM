import { toast } from "sonner";
import { getVersion } from "@tauri-apps/api/app";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { updaterApi, type UpdateChannel, type UpdateInfo } from "@/api/client";
import { notify } from "@/lib/notify";
import { fileStorage, flushStores } from "./persist";

export type UpdateStatus = "idle" | "checking" | "downloading" | "ready" | "installing" | "error";

const READY_TOAST_ID = "update-ready";

interface UpdaterState {
  channel: UpdateChannel;
  autoCheck: boolean;

  status: UpdateStatus;
  /** Set once a newer build was found, and kept while it downloads and waits for a restart. */
  available: UpdateInfo | null;
  progress: { downloaded: number; total: number | null } | null;
  error: string | null;
  lastChecked: number | null;
  pendingInstall: UpdateInfo | null;
  notesDialog: "available" | "installed" | null;
  initialized: boolean;
  dismissingNotes: boolean;

  setChannel: (channel: UpdateChannel) => void;
  setAutoCheck: (autoCheck: boolean) => void;
  /** Checks the selected channel and downloads any newer build in the background. */
  checkAndDownload: (opts?: { silent?: boolean }) => Promise<void>;
  install: () => Promise<void>;
  initialize: () => Promise<void>;
  showNotes: () => void;
  dismissNotes: () => Promise<void>;
}

export const useUpdater = create<UpdaterState>()(
  persist(
    (set, get) => ({
      channel: "stable",
      autoCheck: true,

      status: "idle",
      available: null,
      progress: null,
      error: null,
      lastChecked: null,
      pendingInstall: null,
      notesDialog: null,
      initialized: false,
      dismissingNotes: false,

      setChannel: (channel) => {
        if (channel === get().channel || get().status === "installing") return;
        toast.dismiss(READY_TOAST_ID);
        set({
          channel, status: "idle", available: null, progress: null, error: null,
          notesDialog: get().notesDialog === "installed" ? "installed" : null,
        });
      },
      setAutoCheck: (autoCheck) => set({ autoCheck }),

      initialize: async () => {
        if (get().initialized) return;
        set({ initialized: true });
        try {
          const version = await getVersion();
          if (get().pendingInstall?.version === version) set({ notesDialog: "installed" });
        } catch (e) {
          notify.error(e, "Could not read the installed version");
        }
      },
      showNotes: () => {
        if (get().available && get().notesDialog !== "installed") set({ notesDialog: "available" });
      },
      dismissNotes: async () => {
        if (get().dismissingNotes) return;
        if (get().notesDialog === "installed") {
          const pendingInstall = get().pendingInstall;
          set({ pendingInstall: null, dismissingNotes: true });
          try {
            await flushStores();
          } catch (e) {
            set({ pendingInstall, dismissingNotes: false });
            notify.error(e, "Could not save release notes dismissal");
            return;
          }
          set({ notesDialog: get().available ? "available" : null, dismissingNotes: false });
        } else {
          set({ notesDialog: null });
        }
      },

      checkAndDownload: async ({ silent = false } = {}) => {
        const { status, channel } = get();
        if (status === "checking" || status === "downloading" || status === "ready" || status === "installing") return;
        set({ status: "checking", error: null });
        try {
          const found = await updaterApi.check(channel);
          // The channel may have been switched while the check was running.
          if (get().channel !== channel) return;
          set({ lastChecked: Date.now() });
          if (!found) {
            set({ status: "idle", available: null });
            return;
          }
          set({
            status: "downloading", available: found, progress: { downloaded: 0, total: null },
            notesDialog: get().notesDialog === "installed" ? "installed" : "available",
          });
          await updaterApi.download((downloaded, total) => {
            if (get().channel === channel) set({ progress: { downloaded, total } });
          });
          if (get().channel !== channel) return;
          set({ status: "ready", progress: null });
          notify.info(`Update ${found.version} downloaded. Restart to install it.`);
          toast(`Update ${found.version} is ready`, {
            id: READY_TOAST_ID,
            duration: Infinity,
            action: { label: "View release notes", onClick: () => get().showNotes() },
          });
        } catch (e) {
          if (get().channel !== channel) return;
          const message = e instanceof Error ? e.message : String(e);
          set({ status: "error", error: message, progress: null });
          if (!silent) notify.error(e, "Update failed");
        }
      },

      install: async () => {
        const { available, status } = get();
        if (status !== "ready" || !available) return;
        set({ status: "installing", pendingInstall: available, error: null });
        try {
          await flushStores();
          await updaterApi.install();
        } catch (e) {
          set({ status: "error", pendingInstall: null, error: e instanceof Error ? e.message : String(e) });
          notify.error(e, "Could not install the update");
          try {
            await flushStores();
          } catch (saveError) {
            notify.error(saveError, "Could not clear the failed update record");
          }
        }
      },
    }),
    {
      name: "updater",
      storage: fileStorage("updater.json"),
      version: 1,
      partialize: (s) => ({ channel: s.channel, autoCheck: s.autoCheck, pendingInstall: s.pendingInstall }),
    },
  ),
);
