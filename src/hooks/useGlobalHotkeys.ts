import { useEffect } from "react";
import { isMac } from "@/lib/utils";
import { useUi } from "@/store/ui";

export function useGlobalHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey) return;
      if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        useUi.getState().focusSearch();
      } else if (e.key === ",") {
        e.preventDefault();
        useUi.getState().navigate("settings");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
