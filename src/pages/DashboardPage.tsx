import { useQueries } from "@tanstack/react-query";
import { Database, PlugZap, Server } from "lucide-react";
import { assetsApi } from "@/api/assets";
import { qk, useAttributes, useConnection, useObjectTypes, useStatusTypes, useTotalCount } from "@/api/queries";
import { AttrType } from "@/api/types";
import { StatusBadge } from "@/components/assets/StatusBadge";
import { EmptyState, PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, Skeleton } from "@/components/ui/primitives";
import { aqlAttr, aqlString } from "@/lib/aql";
import { SWATCH_CLASSES, resolveStatusColor } from "@/lib/statusColors";
import { cn } from "@/lib/utils";
import { useSettings } from "@/store/settings";
import { useUi } from "@/store/ui";

export function DashboardPage() {
  const connection = useConnection();
  const { schemaId, objectTypeId, statusColors } = useSettings();
  const { navigate, setRawAql } = useUi();
  const types = useObjectTypes(schemaId);
  const attrs = useAttributes(objectTypeId);
  const statuses = useStatusTypes(schemaId);

  const base = objectTypeId ? `objectTypeId = ${Number(objectTypeId)}` : null;
  const total = useTotalCount(base);
  const statusAttr = attrs.data?.find((a) => a.type === AttrType.Status);
  const allowed = statusAttr?.typeValueMulti?.length
    ? (statuses.data ?? []).filter((s) => statusAttr.typeValueMulti!.includes(s.id))
    : (statuses.data ?? []);

  const counts = useQueries({
    queries: allowed.map((s) => {
      const aql = `${base} AND ${aqlAttr(statusAttr?.name ?? "Status")} = ${aqlString(s.name)}`;
      return {
        queryKey: qk.count(aql),
        queryFn: () => assetsApi.countObjects(aql),
        enabled: !!base && !!statusAttr,
      };
    }),
  });

  if (!connection.isLoading && !connection.data) {
    return (
      <div className="flex-1 overflow-auto p-8">
        <PageHeader title="Dashboard" />
        <EmptyState icon={<PlugZap />} title="Not connected">
          <Button onClick={() => navigate("settings", "connection")}>Connect to JIRA Assets</Button>
        </EmptyState>
      </div>
    );
  }
  if (!objectTypeId) {
    return (
      <div className="flex-1 overflow-auto p-8">
        <PageHeader title="Dashboard" />
        <EmptyState icon={<Database />} title="No object type selected">
          <Button onClick={() => navigate("settings", "schema")}>Select schema</Button>
        </EmptyState>
      </div>
    );
  }

  const typeName = types.data?.find((t) => t.id === objectTypeId)?.name ?? "";

  return (
    <div className="flex-1 overflow-auto p-8">
      <PageHeader title="Dashboard" description={`Overview of ${typeName} objects`} />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
        <Card className="p-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Server className="size-4" /> Total {typeName}
          </div>
          <div className="mt-2 text-3xl font-semibold">
            {total.data !== undefined ? total.data.toLocaleString() : <Skeleton className="h-9 w-24" />}
          </div>
        </Card>
        {statusAttr &&
          allowed.map((s, i) => {
            const color = resolveStatusColor(s.name, s.category, statusColors);
            const count = counts[i]?.data;
            return (
              <button
                key={s.id}
                type="button"
                className="text-left"
                onClick={() => {
                  setRawAql(`${aqlAttr(statusAttr.name)} = ${aqlString(s.name)}`);
                  navigate("assets");
                }}
              >
                <Card className="p-5 transition-colors hover:bg-accent/50">
                  <StatusBadge name={s.name} category={s.category} />
                  <div className="mt-3 text-3xl font-semibold">
                    {count !== undefined ? count.toLocaleString() : <Skeleton className="h-9 w-16" />}
                  </div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn("h-full", SWATCH_CLASSES[color])}
                      style={{ width: total.data && count !== undefined ? `${(count / total.data) * 100}%` : 0 }}
                    />
                  </div>
                </Card>
              </button>
            );
          })}
      </div>
    </div>
  );
}
