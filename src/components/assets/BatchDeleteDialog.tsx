import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { publishDeletions, refreshAfterDeletion } from "@/api/deleteMutation";
import { captureMutationContext } from "@/api/mutationCache";
import { qk } from "@/api/queryKeys";
import type { AssetObject, ConnectionInfo } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { deleteAssets, type DeleteFailure } from "@/lib/deleteAsset";
import { deletionSummary, type DeletionConfig } from "@/lib/deletion";
import { notify } from "@/lib/notify";
import { sameConnection } from "@/lib/ruleMutations";

const LARGE_BATCH = 100;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  objects: AssetObject[];
  typeId: string;
  config: DeletionConfig;
  connection: ConnectionInfo;
}

export function BatchDeleteDialog({ open, onOpenChange, ...rest }: Props) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => (o || !busy) && onOpenChange(o)}>
      <DialogContent className="flex max-w-xl flex-col gap-0 overflow-hidden p-0" aria-describedby={undefined}
        onEscapeKeyDown={(event) => busy && event.preventDefault()} onPointerDownOutside={(event) => busy && event.preventDefault()}>
        {/* Mounted only while open so each confirmation starts fresh. */}
        {open && <BatchDeleteForm {...rest} onBusyChange={setBusy} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function BatchDeleteForm({ objects, typeId, config, connection, onBusyChange, onClose }:
  Omit<Props, "open" | "onOpenChange"> & { onBusyChange: (busy: boolean) => void; onClose: () => void }) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<"confirm" | "running" | "failed">("confirm");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [failures, setFailures] = useState<DeleteFailure[]>([]);
  const [deleted, setDeleted] = useState(0);
  const count = objects.length;
  const soft = config.method === "soft";

  const run = async (list: AssetObject[]) => {
    setPhase("running");
    onBusyChange(true);
    setProgress({ done: 0, total: list.length });
    const contextCurrent = captureMutationContext(qc);
    const isCurrent = () => contextCurrent() && sameConnection(qc.getQueryData(qk.connection), connection);
    const result = await deleteAssets({
      objects: list, typeId, config, connection, isCurrent,
      onProgress: (done) => setProgress({ done, total: list.length }),
    });
    const published = await publishDeletions(qc, result.deleted.map((object) => object.id), isCurrent);
    onBusyChange(false);
    if (!published) {
      notify.info("Deletion ran on the previous workspace. The current workspace was not changed.");
      onClose();
      return;
    }
    if (result.deleted.length) {
      refreshAfterDeletion(qc).catch((error) => notify.error(error, "Deletion succeeded, but lists could not be refreshed"));
    }
    const total = deleted + result.deleted.length;
    setDeleted(total);
    setFailures(result.failures);
    if (!result.failures.length) {
      notify.success(`${soft ? "Soft deleted" : "Permanently deleted"} ${total} asset${total === 1 ? "" : "s"}`);
      onClose();
      return;
    }
    notify.error(`${result.failures.length} of ${list.length} deletion${list.length === 1 ? "" : "s"} failed`);
    setPhase("failed");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b p-6 pr-12">
        <DialogTitle>
          {soft ? "Soft delete" : "Permanently delete"} {count} asset{count === 1 ? "" : "s"}?
        </DialogTitle>
        <DialogDescription className="mt-1.5">
          {phase === "confirm" ? deletionSummary(config, count)
            : phase === "running" ? "Deleting assets…" : `${deleted} deleted, ${failures.length} failed.`}
        </DialogDescription>
      </div>

      {phase === "running" && (
        <div className="grid gap-3 p-6">
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-destructive transition-[width]"
              style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
          </div>
          <p className="text-sm text-muted-foreground">{progress.done} of {progress.total} done</p>
        </div>
      )}

      {phase === "failed" && (
        <ul className="grid max-h-80 gap-2 overflow-auto p-6 text-sm">
          {failures.map(({ object, error }) => (
            <li key={object.id} className="grid gap-0.5">
              <span className="font-medium">{object.objectKey} {object.label && `· ${object.label}`}</span>
              <span className="text-destructive">{error}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between gap-4 border-t p-4">
        <p className="text-sm text-muted-foreground">
          {phase === "confirm" && count > LARGE_BATCH && "This sends many requests and may take a while."}
        </p>
        <div className="flex gap-2">
          {phase === "confirm" && (
            <>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button variant="destructive" disabled={!count} onClick={() => void run(objects)}>
                Delete {count} asset{count === 1 ? "" : "s"}
              </Button>
            </>
          )}
          {phase === "running" && (
            <Button variant="destructive" disabled>
              <Loader2 className="animate-spin" /> Deleting…
            </Button>
          )}
          {phase === "failed" && (
            <>
              <Button variant="outline" onClick={onClose}>Close</Button>
              <Button variant="destructive" onClick={() => void run(failures.map((f) => f.object))}>Retry failed</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
