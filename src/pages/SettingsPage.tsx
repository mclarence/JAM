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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-8">
      <PageHeader title="Settings" description="Connection, data source, Rules, status colours, label defaults and sync." />
      <Tabs
        value={settingsTab}
        onValueChange={(v) => navigate("settings", v as SettingsTab)}
        orientation="vertical"
        className="flex min-h-0 flex-1 gap-6"
      >
        <TabsList
          aria-label="Settings categories"
          className="h-full w-56 shrink-0 flex-col items-stretch justify-start gap-1 self-stretch overflow-y-auto rounded-none border-r bg-transparent px-0 py-1 pr-4 text-left"
        >
          <div role="presentation" className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Connection
          </div>
          <TabsTrigger value="connection" className="h-9 w-full justify-start border-l-2 border-transparent px-3 data-[state=active]:border-primary data-[state=active]:bg-accent data-[state=active]:shadow-none">
            API Connection
          </TabsTrigger>

          <div role="presentation" className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Workspace
          </div>
          <TabsTrigger value="schema" className="h-9 w-full justify-start border-l-2 border-transparent px-3 data-[state=active]:border-primary data-[state=active]:bg-accent data-[state=active]:shadow-none">
            Schema &amp; Object Type
          </TabsTrigger>
          <TabsTrigger value="assetTag" className="h-9 w-full justify-start border-l-2 border-transparent px-3 data-[state=active]:border-primary data-[state=active]:bg-accent data-[state=active]:shadow-none">
            Asset Tag
          </TabsTrigger>
          <TabsTrigger value="deletion" className="h-9 w-full justify-start border-l-2 border-transparent px-3 data-[state=active]:border-primary data-[state=active]:bg-accent data-[state=active]:shadow-none">
            Deletion
          </TabsTrigger>
          <TabsTrigger value="reference" className="h-9 w-full justify-start border-l-2 border-transparent px-3 data-[state=active]:border-primary data-[state=active]:bg-accent data-[state=active]:shadow-none">
            Reference Fields
          </TabsTrigger>
          <TabsTrigger value="status" className="h-9 w-full justify-start border-l-2 border-transparent px-3 data-[state=active]:border-primary data-[state=active]:bg-accent data-[state=active]:shadow-none">
            Status Colours
          </TabsTrigger>
          <TabsTrigger value="rules" className="h-9 w-full justify-start border-l-2 border-transparent px-3 data-[state=active]:border-primary data-[state=active]:bg-accent data-[state=active]:shadow-none">
            Rules
          </TabsTrigger>

          <div role="presentation" className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Labels
          </div>
          <TabsTrigger value="labels" className="h-9 w-full justify-start border-l-2 border-transparent px-3 data-[state=active]:border-primary data-[state=active]:bg-accent data-[state=active]:shadow-none">
            Label Defaults
          </TabsTrigger>

          <div role="presentation" className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Data
          </div>
          <TabsTrigger value="backup" className="h-9 w-full justify-start border-l-2 border-transparent px-3 data-[state=active]:border-primary data-[state=active]:bg-accent data-[state=active]:shadow-none">
            Import / Export
          </TabsTrigger>

          <div role="presentation" className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Sync
          </div>
          <TabsTrigger value="sync" className="h-9 w-full justify-start border-l-2 border-transparent px-3 data-[state=active]:border-primary data-[state=active]:bg-accent data-[state=active]:shadow-none">
            Sync Settings
          </TabsTrigger>

          <div role="presentation" className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Updates
          </div>
          <TabsTrigger value="updates" className="h-9 w-full justify-start border-l-2 border-transparent px-3 data-[state=active]:border-primary data-[state=active]:bg-accent data-[state=active]:shadow-none">
            Update Preferences
          </TabsTrigger>
        </TabsList>
        <TabsContent value="connection" className="m-0 min-w-0 flex-1 overflow-y-auto">
          <ConnectionTab />
        </TabsContent>
        <TabsContent value="schema" className="m-0 min-w-0 flex-1 overflow-y-auto">
          <SchemaTab />
        </TabsContent>
        <TabsContent value="assetTag" className="m-0 min-w-0 flex-1 overflow-y-auto">
          <AssetTagTab />
        </TabsContent>
        <TabsContent value="deletion" className="m-0 min-w-0 flex-1 overflow-y-auto">
          <DeletionTab />
        </TabsContent>
        <TabsContent value="reference" className="m-0 min-w-0 flex-1 overflow-y-auto">
          <ReferenceDisplayTab />
        </TabsContent>
        <TabsContent value="status" className="m-0 min-w-0 flex-1 overflow-y-auto">
          <StatusColorsTab />
        </TabsContent>
        <TabsContent value="rules" className="m-0 min-w-0 flex-1 overflow-y-auto">
          <RulesTab />
        </TabsContent>
        <TabsContent value="labels" className="m-0 min-w-0 flex-1 overflow-y-auto">
          <LabelDefaultsTab />
        </TabsContent>
        <TabsContent value="backup" className="m-0 min-w-0 flex-1 overflow-y-auto">
          <BackupTab />
        </TabsContent>
        <TabsContent value="sync" className="m-0 min-w-0 flex-1 overflow-y-auto">
          <SyncTab />
        </TabsContent>
        <TabsContent value="updates" className="m-0 min-w-0 flex-1 overflow-y-auto">
          <UpdatesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
