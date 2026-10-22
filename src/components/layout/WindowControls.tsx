import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";

const btn =
  "inline-flex h-full w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5";

/** Custom window controls for Windows/Linux (macOS keeps native traffic lights). */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    const win = getCurrentWindow();
    win.isMaximized().then(setMaximized);
    const unlisten = win.onResized(() => win.isMaximized().then(setMaximized));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  if (!isTauri()) return null;
  const win = getCurrentWindow();

  return (
    <div className="flex h-full items-stretch">
      <button type="button" className={btn} aria-label="Minimize" onClick={() => win.minimize()}>
        <Minus />
      </button>
      <button type="button" className={btn} aria-label={maximized ? "Restore" : "Maximize"} onClick={() => win.toggleMaximize()}>
        {maximized ? <Copy className="-scale-x-100" /> : <Square />}
      </button>
      <button
        type="button"
        className={cn(btn, "hover:bg-red-600 hover:text-white")}
        aria-label="Close"
        onClick={() => win.close()}
      >
        <X />
      </button>
    </div>
  );
}
