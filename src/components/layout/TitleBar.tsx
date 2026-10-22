import { useEffect, useMemo, useRef } from "react";
import { Bell, Moon, Search, Settings, Sun, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/primitives";
import { Popover, PopoverContent, PopoverTrigger, Tooltip } from "@/components/ui/overlays";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAttributes } from "@/api/queries";
import { sortAttributes } from "@/lib/attributes";
import { SEARCH_ALL, SEARCH_KEY, isTextarea } from "@/lib/aql";
import { cn, isMac, modKey } from "@/lib/utils";
import { useSettings } from "@/store/settings";
import { useThemeStore } from "@/store/theme";
import { useUi } from "@/store/ui";
import { WindowControls } from "./WindowControls";

export function TitleBar() {
  const { search, setSearch, searchField, setSearchField, page, navigate, searchFocusTick } = useUi();
  const { resolved, toggle } = useThemeStore();
  const objectTypeId = useSettings((s) => s.objectTypeId);
  const attrsQuery = useAttributes(objectTypeId);
  // The built-in "Key" option already covers the object's Key attribute.
  const attributes = useMemo(
    () =>
      sortAttributes(attrsQuery.data ?? []).filter(
        (a) => !a.hidden && !isTextarea(a) && a.name.trim().toLowerCase() !== "key",
      ),
    [attrsQuery.data],
  );
  const activeField =
    searchField === SEARCH_KEY || attributes.some((a) => a.id === searchField) ? searchField : SEARCH_ALL;
  const fieldLabel =
    activeField === SEARCH_ALL
      ? "all fields"
      : activeField === SEARCH_KEY
        ? "Key"
        : (attributes.find((a) => a.id === activeField)?.name ?? "all fields");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchFocusTick === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [searchFocusTick]);

  return (
    <header
      data-tauri-drag-region
      className={cn("flex h-11 shrink-0 items-center gap-3 border-b bg-sidebar pr-0", isMac ? "pl-20" : "pl-3")}
    >
      <div data-tauri-drag-region className="flex w-52 shrink-0 items-center gap-2 text-sm font-semibold">
        <span data-tauri-drag-region className="truncate">
          JIRA Assets Manager
        </span>
      </div>

      <div data-tauri-drag-region className="flex flex-1 justify-center">
        <div className="flex w-full max-w-xl items-center gap-2">
          <Select value={activeField} onValueChange={setSearchField}>
            <SelectTrigger className="h-8 w-40 shrink-0 bg-background" aria-label="Search field">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SEARCH_ALL}>All fields</SelectItem>
              <SelectItem value={SEARCH_KEY}>Key</SelectItem>
              {attributes.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                if (page !== "assets") navigate("assets");
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearch("");
                  e.currentTarget.blur();
                }
              }}
              placeholder={`Search ${fieldLabel}`}
              className="h-8 bg-background pl-8 pr-20"
            />
            <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
              {search && (
                <button type="button" aria-label="Clear search" onClick={() => setSearch("")} className="text-muted-foreground hover:text-foreground">
                  <X className="size-3.5" />
                </button>
              )}
              <Kbd>{modKey} F</Kbd>
            </div>
          </div>
        </div>
      </div>

      <div className="flex h-full items-center gap-1">
        <Tooltip content={resolved === "dark" ? "Light mode" : "Dark mode"}>
          <Button variant="ghost" size="iconSm" onClick={toggle} aria-label="Toggle theme">
            {resolved === "dark" ? <Sun /> : <Moon />}
          </Button>
        </Tooltip>
        <Notifications />
        <Tooltip content={`Settings (${modKey} ,)`}>
          <Button variant="ghost" size="iconSm" onClick={() => navigate("settings")} aria-label="Settings">
            <Settings />
          </Button>
        </Tooltip>
        {!isMac && <div className="mx-1 h-5 w-px bg-border" />}
        {!isMac && <WindowControls />}
        {isMac && <div className="w-2" />}
      </div>
    </header>
  );
}

function Notifications() {
  const { notifications, unread, markRead, clearNotifications } = useUi();
  return (
    <Popover onOpenChange={(open) => open && markRead()}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="iconSm" aria-label="Notifications" className="relative">
          <Bell />
          {unread > 0 && (
            <span className="absolute right-1 top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-600 px-0.5 text-[9px] font-bold text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">Notifications</span>
          {notifications.length > 0 && (
            <Button variant="ghost" size="sm" onClick={clearNotifications}>
              Clear
            </Button>
          )}
        </div>
        <div className="max-h-80 overflow-auto">
          {notifications.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">No notifications</p>
          ) : (
            notifications.map((n) => (
              <div key={n.id} className="border-b px-3 py-2 text-sm last:border-0">
                <div className="flex items-start gap-2">
                  <span
                    className={cn(
                      "mt-1.5 size-2 shrink-0 rounded-full",
                      n.level === "error" ? "bg-red-500" : n.level === "success" ? "bg-green-500" : "bg-blue-500",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="break-words select-text">{n.message}</p>
                    <p className="text-xs text-muted-foreground">{new Date(n.at).toLocaleTimeString()}</p>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
