import { PageHeader } from "@/components/layout/PageHeader";
import { ConnectionTab } from "@/components/settings/ConnectionTab";
import { LabelDefaultsTab } from "@/components/settings/LabelDefaultsTab";
import { SchemaTab } from "@/components/settings/SchemaTab";
import { StatusColorsTab } from "@/components/settings/StatusColorsTab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlays";
import { useUi, type SettingsTab } from "@/store/ui";

export function SettingsPage() {
  const { settingsTab, navigate } = useUi();
  return (
    <div className="flex-1 overflow-auto p-8">
      <PageHeader title="Settings" description="Connection, data source, status colours and label defaults." />
      <Tabs value={settingsTab} onValueChange={(v) => navigate("settings", v as SettingsTab)}>
        <TabsList>
          <TabsTrigger value="connection">API Connection</TabsTrigger>
          <TabsTrigger value="schema">Schema &amp; Object Type</TabsTrigger>
          <TabsTrigger value="status">Status Colours</TabsTrigger>
          <TabsTrigger value="labels">Label Defaults</TabsTrigger>
        </TabsList>
        <TabsContent value="connection">
          <ConnectionTab />
        </TabsContent>
        <TabsContent value="schema">
          <SchemaTab />
        </TabsContent>
        <TabsContent value="status">
          <StatusColorsTab />
        </TabsContent>
        <TabsContent value="labels">
          <LabelDefaultsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
