import { LayoutDashboard, PanelLeftClose, PanelLeftOpen, Server, Settings, Tag, type LucideIcon } from "lucide-react";
import { useConnection } from "@/api/queries";
import { Tooltip } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { useUi, type Page } from "@/store/ui";

const NAV: { page: Page; label: string; icon: LucideIcon }[] = [
  { page: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { page: "assets", label: "Assets", icon: Server },
  { page: "templates", label: "Label Templates", icon: Tag },
  { page: "settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const { page, navigate, sidebarCollapsed, toggleSidebar } = useUi();
  const connection = useConnection();

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col border-r bg-sidebar transition-[width] duration-200",
        sidebarCollapsed ? "w-14" : "w-60",
      )}
    >
      <nav className="flex flex-1 flex-col gap-1 p-2">
        {NAV.map(({ page: p, label, icon: Icon }) => {
          const active = page === p;
          const item = (
            <button
              key={p}
              type="button"
              onClick={() => navigate(p)}
              className={cn(
                "flex h-9 items-center gap-3 rounded-md border-l-2 px-3 text-sm transition-colors",
                active
                  ? "border-primary bg-accent font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              {!sidebarCollapsed && <span className="truncate">{label}</span>}
            </button>
          );
          return sidebarCollapsed ? (
            <Tooltip key={p} content={label}>
              {item}
            </Tooltip>
          ) : (
            item
          );
        })}
      </nav>
      <div className="flex items-center gap-2 border-t p-2">
        {!sidebarCollapsed && (
          <div className="flex min-w-0 flex-1 items-center gap-2 px-1 text-xs text-muted-foreground">
            <span className={cn("size-2 shrink-0 rounded-full", connection.data ? "bg-green-500" : "bg-zinc-400")} />
            <span className="truncate">
              {connection.data ? new URL(connection.data.siteUrl).host : "Not connected"}
            </span>
          </div>
        )}
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="mx-auto rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {sidebarCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </button>
      </div>
    </aside>
  );
}
