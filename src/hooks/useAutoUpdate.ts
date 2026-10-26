import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { useUpdater } from "@/store/updater";

const STARTUP_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Checks for updates shortly after launch and then periodically, when enabled in settings. */
export function useAutoUpdate() {
  useEffect(() => {
    if (!isTauri() || import.meta.env.DEV) return;
    let timers: number[] = [];

    const run = () => {
      const { autoCheck, checkAndDownload } = useUpdater.getState();
      if (autoCheck) void checkAndDownload({ silent: true });
    };
    const start = () => {
      timers = [window.setTimeout(run, STARTUP_DELAY_MS), window.setInterval(run, CHECK_INTERVAL_MS)];
    };

    let unsub: (() => void) | undefined;
    if (useUpdater.persist.hasHydrated()) start();
    else unsub = useUpdater.persist.onFinishHydration(start);

    return () => {
      unsub?.();
      timers.forEach((t) => {
        window.clearTimeout(t);
        window.clearInterval(t);
      });
    };
  }, []);
}
