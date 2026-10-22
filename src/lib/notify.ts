import { toast } from "sonner";
import { ApiError } from "@/api/client";
import { useUi } from "@/store/ui";

function describe(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.kind) {
      case "unauthorized":
        return `Authentication failed: ${e.message}`;
      case "network":
        return `Network error: ${e.message}`;
      default:
        return e.message;
    }
  }
  return e instanceof Error ? e.message : String(e);
}

export const notify = {
  /** `id` collapses repeated errors from the same source into one toast. */
  error(e: unknown, title?: string, id?: string) {
    const message = title ? `${title}: ${describe(e)}` : describe(e);
    toast.error(message, id ? { id } : undefined);
    const last = useUi.getState().notifications[0];
    if (last?.message !== message) useUi.getState().pushNotification({ level: "error", message });
  },
  success(message: string) {
    toast.success(message);
    useUi.getState().pushNotification({ level: "success", message });
  },
  info(message: string) {
    toast(message);
    useUi.getState().pushNotification({ level: "info", message });
  },
};
