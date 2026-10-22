import { Toaster as Sonner } from "sonner";
import { useThemeStore } from "@/store/theme";

export function Toaster() {
  const resolved = useThemeStore((s) => s.resolved);
  return <Sonner theme={resolved} richColors closeButton position="bottom-right" />;
}
