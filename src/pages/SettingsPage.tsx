import { PageHeader } from "@/components/layout/PageHeader";
import { AssetTagTab } from "@/components/settings/AssetTagTab";
import { BackupTab } from "@/components/settings/BackupTab";
import { ConnectionTab } from "@/components/settings/ConnectionTab";
import { LabelDefaultsTab } from "@/components/settings/LabelDefaultsTab";
import { ReferenceDisplayTab } from "@/components/settings/ReferenceDisplayTab";
import { RulesTab } from "@/components/settings/RulesTab";
import { SchemaTab } from "@/components/settings/SchemaTab";
import { StatusColorsTab } from "@/components/settings/StatusColorsTab";
import { SyncTab } from "@/components/settings/SyncTab";
import { UpdatesTab } from "@/components/settings/UpdatesTab";
import { DeletionTab } from "@/components/settings/DeletionTab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlays";
import { useUi, type SettingsTab } from "@/store/ui";

export function SettingsPage() {
  const { settingsTab, navigate } = useUi();
  return (
    <div className="flex-1 overflow-auto p-8">
      <PageHeader title="Settings" description="Connection, data source, Rules, status colours, label defaults and sync." />
      <Tabs value={settingsTab} onValueChange={(v) => navigate("settings", v as SettingsTab)}>
        <TabsList>
          <TabsTrigger value="connection">API Connection</TabsTrigger>
          <TabsTrigger value="schema">Schema &amp; Object Type</TabsTrigger>
          <TabsTrigger value="assetTag">Asset Tag</TabsTrigger>
          <TabsTrigger value="deletion">Deletion</TabsTrigger>
          <TabsTrigger value="reference">Reference Fields</TabsTrigger>
          <TabsTrigger value="status">Status Colours</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="labels">Label Defaults</TabsTrigger>
          <TabsTrigger value="backup">Import / Export</TabsTrigger>
          <TabsTrigger value="sync">Sync</TabsTrigger>
          <TabsTrigger value="updates">Updates</TabsTrigger>
        </TabsList>
        <TabsContent value="connection">
          <ConnectionTab />
        </TabsContent>
        <TabsContent value="schema">
          <SchemaTab />
        </TabsContent>
        <TabsContent value="assetTag">
          <AssetTagTab />
        </TabsContent>
        <TabsContent value="deletion">
          <DeletionTab />
        </TabsContent>
        <TabsContent value="reference">
          <ReferenceDisplayTab />
        </TabsContent>
        <TabsContent value="status">
          <StatusColorsTab />
        </TabsContent>
        <TabsContent value="rules">
          <RulesTab />
        </TabsContent>
        <TabsContent value="labels">
          <LabelDefaultsTab />
        </TabsContent>
        <TabsContent value="backup">
          <BackupTab />
        </TabsContent>
        <TabsContent value="sync">
          <SyncTab />
        </TabsContent>
        <TabsContent value="updates">
          <UpdatesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
