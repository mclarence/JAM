import { toast } from "sonner";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { updaterApi, type UpdateChannel, type UpdateInfo } from "@/api/client";
import { notify } from "@/lib/notify";
import { fileStorage } from "./persist";

export type UpdateStatus = "idle" | "checking" | "downloading" | "ready" | "error";

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

  setChannel: (channel: UpdateChannel) => void;
  setAutoCheck: (autoCheck: boolean) => void;
  /** Checks the selected channel and downloads any newer build in the background. */
  checkAndDownload: (opts?: { silent?: boolean }) => Promise<void>;
  install: () => Promise<void>;
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

      setChannel: (channel) => {
        if (channel === get().channel) return;
        toast.dismiss(READY_TOAST_ID);
        set({ channel, status: "idle", available: null, progress: null, error: null });
      },
      setAutoCheck: (autoCheck) => set({ autoCheck }),

      checkAndDownload: async ({ silent = false } = {}) => {
        const { status, channel } = get();
        if (status === "checking" || status === "downloading" || status === "ready") return;
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
          set({ status: "downloading", available: found, progress: { downloaded: 0, total: null } });
          await updaterApi.download((downloaded, total) => {
            if (get().channel === channel) set({ progress: { downloaded, total } });
          });
          if (get().channel !== channel) return;
          set({ status: "ready", progress: null });
          notify.info(`Update ${found.version} downloaded. Restart to install it.`);
          toast(`Update ${found.version} is ready`, {
            id: READY_TOAST_ID,
            duration: Infinity,
            action: { label: "Restart to update", onClick: () => void get().install() },
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          set({ status: "error", error: message, progress: null });
          if (!silent) notify.error(e, "Update failed");
        }
      },

      install: async () => {
        try {
          await updaterApi.install();
        } catch (e) {
          set({ status: "error", error: e instanceof Error ? e.message : String(e) });
          notify.error(e, "Could not install the update");
        }
      },
    }),
    {
      name: "updater",
      storage: fileStorage("updater.json"),
      version: 1,
      partialize: (s) => ({ channel: s.channel, autoCheck: s.autoCheck }),
    },
  ),
);
