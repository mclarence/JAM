import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import type { AssetObject, ObjectTypeAttribute, StatusType } from "@/api/types";
import { ScanActionRow } from "@/components/quickscan/ScanActionRow";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { editorKind } from "@/lib/attributes";
import { runBatch, type BatchFailure, type BatchJob } from "@/lib/batchUpdate";
import { notify } from "@/lib/notify";
import { actionAttributes, planChanges } from "@/lib/quickScan";
import type { ScanAction } from "@/store/quickScan";

const LARGE_BATCH = 100;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  objects: AssetObject[];
  attributes: ObjectTypeAttribute[];
  statuses: StatusType[];
}

export function BatchUpdateDialog({ open, onOpenChange, ...rest }: Props) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => (o || !busy) && onOpenChange(o)}>
      <DialogContent className="flex max-w-3xl flex-col gap-0 overflow-hidden p-0" aria-describedby={undefined}>
        {/* Mounted only while open so the form resets each time the dialog is opened. */}
        <BatchForm {...rest} onBusyChange={setBusy} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function BatchForm({
  objects,
  attributes,
  statuses,
  onBusyChange,
  onClose,
}: Omit<Props, "open" | "onOpenChange"> & { onBusyChange: (busy: boolean) => void; onClose: () => void }) {
  const qc = useQueryClient();
  const [actions, setActions] = useState<ScanAction[]>([]);
  const [phase, setPhase] = useState<"edit" | "running" | "failed">("edit");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [failures, setFailures] = useState<BatchFailure[]>([]);
  const [updated, setUpdated] = useState(0);

  const options = useMemo(() => actionAttributes(attributes), [attributes]);
  const used = new Set(actions.map((a) => a.attrId));
  const canAdd = options.some((a) => !used.has(a.id));
  const incomplete = actions.some((a) => a.mode === "set" && !a.value);

  const jobs = useMemo<BatchJob[]>(
    () =>
      objects.flatMap((object) => {
        const { payload } = planChanges(object, attributes, actions);
        return payload.length ? [{ object, payload }] : [];
      }),
    [objects, attributes, actions],
  );

  const updateAction = (id: string, patch: Partial<ScanAction>) =>
    setActions((as) => as.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const addAction = () => {
    const attr = options.find((a) => !used.has(a.id));
    if (!attr) return;
    const settable = editorKind(attr) !== "readonly";
    setActions((as) => [
      ...as,
      { id: crypto.randomUUID(), attrId: attr.id, mode: settable ? "set" : "clear", value: "", display: "" },
    ]);
  };

  const run = async (list: BatchJob[]) => {
    setPhase("running");
    onBusyChange(true);
    setProgress({ done: 0, total: list.length });
    const result = await runBatch(list, (done) => setProgress({ done, total: list.length }));
    onBusyChange(false);
    void qc.invalidateQueries({ queryKey: ["objects"] });
    void qc.invalidateQueries({ queryKey: ["count"] });
    void qc.invalidateQueries({ queryKey: ["object"] });
    void qc.invalidateQueries({ queryKey: ["history"] });

    const totalUpdated = updated + result.updated;
    setUpdated(totalUpdated);
    setFailures(result.failures);
    if (result.failures.length === 0) {
      notify.success(`Updated ${totalUpdated} asset${totalUpdated === 1 ? "" : "s"}`);
      onClose();
      return;
    }
    notify.error(`${result.failures.length} of ${list.length} update${list.length === 1 ? "" : "s"} failed`);
    setPhase("failed");
  };

  const count = objects.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b p-6 pr-12">
        <DialogTitle>
          Update {count} asset{count === 1 ? "" : "s"}
        </DialogTitle>
        <DialogDescription className="mt-1.5">
          {phase === "edit"
            ? "Choose the attributes to change. Each is applied to every selected asset."
            : phase === "running"
              ? "Updating assets…"
              : `${updated} updated, ${failures.length} failed.`}
        </DialogDescription>
      </div>

      {phase === "edit" && (
        <div className="grid min-h-0 flex-1 content-start gap-3 overflow-auto p-6">
          {actions.map((action) => (
            <ScanActionRow
              key={action.id}
              action={action}
              attrs={options.filter((a) => a.id === action.attrId || !used.has(a.id))}
              statuses={statuses}
              onChange={(patch) => updateAction(action.id, patch)}
              onRemove={() => setActions((as) => as.filter((a) => a.id !== action.id))}
            />
          ))}
          <div>
            <Button variant="outline" size="sm" disabled={!canAdd} onClick={addAction}>
              <Plus /> Add attribute
            </Button>
          </div>
          {options.length === 0 && (
            <p className="text-sm text-muted-foreground">This object type has no editable attributes.</p>
          )}
        </div>
      )}

      {phase === "running" && (
        <div className="grid gap-3 p-6">
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            {progress.done} of {progress.total} done
          </p>
        </div>
      )}

      {phase === "failed" && (
        <ul className="grid max-h-80 gap-2 overflow-auto p-6 text-sm">
          {failures.map(({ job, error }) => (
            <li key={job.object.id} className="grid gap-0.5">
              <span className="font-medium">
                {job.object.objectKey} {job.object.label && `· ${job.object.label}`}
              </span>
              <span className="text-destructive">{error}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between gap-4 border-t p-4">
        <p className="text-sm text-muted-foreground">
          {phase === "edit" &&
            actions.length > 0 &&
            (jobs.length === 0
              ? "None of the selected assets would change."
              : `${jobs.length} of ${count} will change${jobs.length > LARGE_BATCH ? "; this sends many requests and may take a while." : "."}`)}
        </p>
        <div className="flex gap-2">
          {phase === "edit" && (
            <>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button disabled={actions.length === 0 || incomplete || jobs.length === 0} onClick={() => run(jobs)}>
                Apply to {jobs.length} asset{jobs.length === 1 ? "" : "s"}
              </Button>
            </>
          )}
          {phase === "running" && (
            <Button disabled>
              <Loader2 className="animate-spin" /> Updating…
            </Button>
          )}
          {phase === "failed" && (
            <>
              <Button type="button" variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button onClick={() => run(failures.map((f) => f.job))}>Retry failed</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
