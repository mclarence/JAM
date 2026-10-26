import { useEffect, useState } from "react";
import { useGlobalHotkeys } from "@/hooks/useGlobalHotkeys";
import { useAutoUpdate } from "@/hooks/useAutoUpdate";
import { useSettings } from "@/store/settings";
import { useTemplates } from "@/store/templates";
import { useUi } from "@/store/ui";
import { Sidebar } from "@/components/layout/Sidebar";
import { TitleBar } from "@/components/layout/TitleBar";
import { DashboardPage } from "@/pages/DashboardPage";
import { AssetsPage } from "@/pages/AssetsPage";
import { QuickScanPage } from "@/pages/QuickScanPage";
import { TemplatesPage } from "@/pages/TemplatesPage";
import { SettingsPage } from "@/pages/SettingsPage";

function usePersistedStoresReady() {
  const check = () => useSettings.persist.hasHydrated() && useTemplates.persist.hasHydrated();
  const [ready, setReady] = useState(check);
  useEffect(() => {
    const unsubs = [
      useSettings.persist.onFinishHydration(() => setReady(check())),
      useTemplates.persist.onFinishHydration(() => setReady(check())),
    ];
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
          {ready && page === "settings" && <SettingsPage />}
        </main>
      </div>
    </div>
  );
}
