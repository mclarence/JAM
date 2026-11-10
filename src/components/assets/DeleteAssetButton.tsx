import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";
import { useConnection } from "@/api/queries";
import { publishDeletions, refreshAfterDeletion } from "@/api/deleteMutation";
import { captureMutationContext } from "@/api/mutationCache";
import { qk } from "@/api/queryKeys";
import type { AssetObject } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { deleteAsset } from "@/lib/deleteAsset";
import { deletionScope, deletionSummary, type DeletionConfig } from "@/lib/deletion";
import { sameConnection } from "@/lib/ruleMutations";
import { notify } from "@/lib/notify";
import { useSettings } from "@/store/settings";

export function DeleteAssetButton({ object, disabled }: { object: AssetObject; disabled?: boolean }) {
  const qc = useQueryClient();
  const connection = useConnection().data;
  const configs = useSettings((s) => s.deletions);
  const config = connection ? configs[deletionScope(connection, object.objectType.id)] : undefined;
  const [confirmed, setConfirmed] = useState<DeletionConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    if (!connection || !confirmed || busy) return;
    setBusy(true);
    setError(null);
    const contextCurrent = captureMutationContext(qc);
    const isCurrent = () => contextCurrent() && sameConnection(qc.getQueryData(qk.connection), connection);
    try {
      await deleteAsset({ object, config: confirmed, connection, isCurrent });
      if (!await publishDeletions(qc, [object.id], isCurrent)) {
        notify.info("Deletion succeeded on the previous workspace. The current workspace was not changed.");
        setConfirmed(null);
        return;
      }
      setConfirmed(null);
      notify.success(confirmed.method === "soft" ? "Asset soft deleted" : "Asset permanently deleted");
      try {
        await refreshAfterDeletion(qc);
      } catch (refreshError) {
        notify.error(refreshError, "Deletion succeeded, but lists could not be refreshed");
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button className="mt-3" size="sm" variant="destructive" disabled={disabled || busy || !config}
        title={!config ? "Configure deletion in Settings → Deletion first" : undefined}
        onClick={() => { setError(null); setConfirmed(config!); }}>
        <Trash2 className="mr-2 size-4" /> Delete asset
      </Button>
      <Dialog open={!!confirmed} onOpenChange={(open) => { if (!open && !busy) setConfirmed(null); }}>
        <DialogContent onEscapeKeyDown={(event) => busy && event.preventDefault()} onPointerDownOutside={(event) => busy && event.preventDefault()}>
          <DialogTitle>{confirmed?.method === "soft" ? "Soft delete asset?" : "Permanently delete asset?"}</DialogTitle>
          <DialogDescription>
            {object.label} ({object.objectKey}). {confirmed && deletionSummary(confirmed)}
          </DialogDescription>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmed(null)}>Cancel</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
              {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
              {busy ? "Deleting…" : "Delete asset"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
