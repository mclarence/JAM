import { lazy, Suspense, useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Loader2 } from "lucide-react";
import { useGlobalHotkeys } from "@/hooks/useGlobalHotkeys";
import { useAutoUpdate } from "@/hooks/useAutoUpdate";
import { useQuickScan } from "@/store/quickScan";
import { useReports } from "@/store/reports";
import { useSettings } from "@/store/settings";
import { startSync } from "@/store/sync";
import { useTemplates } from "@/store/templates";
import { useUi } from "@/store/ui";
import { useUpdater } from "@/store/updater";
import { Sidebar } from "@/components/layout/Sidebar";
import { TitleBar } from "@/components/layout/TitleBar";
import { DashboardPage } from "@/pages/DashboardPage";
import { AssetsPage } from "@/pages/AssetsPage";
import { QuickScanPage } from "@/pages/QuickScanPage";
import { TemplatesPage } from "@/pages/TemplatesPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { UpdateNotesDialog } from "@/components/updates/UpdateNotesDialog";

// Charts and the report builder load on first use.
const ReportsPage = lazy(() => import("@/pages/ReportsPage").then((m) => ({ default: m.ReportsPage })));

const PERSISTED = [useSettings, useTemplates, useQuickScan, useUpdater, useReports] as const;

function usePersistedStoresReady() {
  const check = () => PERSISTED.every((store) => store.persist.hasHydrated());
  const [ready, setReady] = useState(check);
  useEffect(() => {
    const unsubs = PERSISTED.map((store) => store.persist.onFinishHydration(() => setReady(check())));
    setReady(check());
    return () => unsubs.forEach((u) => u());
  }, []);
  return ready;
}

export default function App() {
  useGlobalHotkeys();
  useAutoUpdate();
  const page = useUi((s) => s.page);
  const ready = usePersistedStoresReady();

  useEffect(() => {
    // Sync compares against the stored settings, so it must not start before they have loaded.
    if (ready) startSync();
  }, [ready]);

  useEffect(() => {
    if (ready && isTauri()) void useUpdater.getState().initialize();
  }, [ready]);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1199px)");
    const sync = () => mq.matches && useUi.getState().setSidebarCollapsed(true);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {ready && page === "dashboard" && <DashboardPage />}
          {ready && page === "assets" && <AssetsPage />}
          {ready && page === "quickscan" && <QuickScanPage />}
          {ready && page === "templates" && <TemplatesPage />}
          {ready && page === "reports" && (
            <Suspense fallback={<Loader2 className="m-auto size-5 animate-spin text-muted-foreground" />}>
              <ReportsPage />
            </Suspense>
          )}
          {ready && page === "settings" && <SettingsPage />}
        </main>
      </div>
      {ready && <UpdateNotesDialog />}
    </div>
  );
}
