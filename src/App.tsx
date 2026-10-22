import { useEffect, useState } from "react";
import { useGlobalHotkeys } from "@/hooks/useGlobalHotkeys";
import { useSettings } from "@/store/settings";
import { useTemplates } from "@/store/templates";
import { useUi } from "@/store/ui";
import { Sidebar } from "@/components/layout/Sidebar";
import { TitleBar } from "@/components/layout/TitleBar";
import { DashboardPage } from "@/pages/DashboardPage";
import { AssetsPage } from "@/pages/AssetsPage";
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
  const page = useUi((s) => s.page);
  const ready = usePersistedStoresReady();

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {ready && page === "dashboard" && <DashboardPage />}
          {ready && page === "assets" && <AssetsPage />}
          {ready && page === "templates" && <TemplatesPage />}
          {ready && page === "settings" && <SettingsPage />}
        </main>
      </div>
    </div>
  );
}
