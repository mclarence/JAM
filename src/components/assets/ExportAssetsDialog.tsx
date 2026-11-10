import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Loader2 } from "lucide-react";
import type { ConnectionInfo, ObjectTypeAttribute } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { exportFileName, saveAssetExport } from "@/lib/assetExport";
import { notify } from "@/lib/notify";

interface Props {
  aql: string;
  typeId: string;
  typeName: string;
  connection: ConnectionInfo;
  selectedIds: string[];
  visibleColumns: ObjectTypeAttribute[];
  allColumns: ObjectTypeAttribute[];
  onClose: () => void;
}

export function ExportAssetsDialog(props: Props) {
  const [scope, setScope] = useState(props.selectedIds.length ? "selected" : "all");
  const [columns, setColumns] = useState("visible");
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const close = () => {
    controller.current?.abort();
    props.onClose();
  };
  const run = async () => {
    const operation = new AbortController();
    controller.current = operation;
    setBusy(true);
    setCount(0);
    setError(undefined);
    try {
      const saved = await saveAssetExport({
        aql: props.aql,
        typeId: props.typeId,
        connection: props.connection,
        selectedIds: scope === "selected" ? [...props.selectedIds] : undefined,
        columns: [...(columns === "visible" ? props.visibleColumns : props.allColumns)],
        signal: operation.signal,
        onProgress: setCount,
      }, exportFileName(props.typeName), (defaultPath) =>
        save({ defaultPath, filters: [{ name: "CSV", extensions: ["csv"] }] }));
      if (operation.signal.aborted) return;
      if (saved !== null) {
        notify.success(`Exported ${saved.toLocaleString()} assets`);
        props.onClose();
      }
    } catch (e) {
      if (operation.signal.aborted) return;
      setError(e instanceof Error ? e.message : "Export failed. Try again.");
      notify.error(e, "Could not export assets");
    } finally {
      if (!operation.signal.aborted) setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogTitle>Export assets</DialogTitle>
        <DialogDescription>Save CSV without changing your selection or loaded rows.</DialogDescription>
        <fieldset disabled={busy} className="grid gap-3">
          <label className="grid gap-1 text-sm">
            Assets
            <select className="rounded border bg-background p-2" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="selected" disabled={!props.selectedIds.length}>Selected assets ({props.selectedIds.length})</option>
              <option value="all">All matching results, across all pages</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Attributes
            <select className="rounded border bg-background p-2" value={columns} onChange={(e) => setColumns(e.target.value)}>
              <option value="visible">Visible columns ({props.visibleColumns.length})</option>
              <option value="all">All available attributes ({props.allColumns.length})</option>
            </select>
          </label>
        </fieldset>
        {columns === "visible" && !props.visibleColumns.length && (
          <p role="status" className="text-sm">No visible columns. Choose all attributes or show columns first.</p>
        )}
        <p className="text-xs text-muted-foreground">
          Text is preserved exactly. Spreadsheets may execute formula-like text; only open trusted data.
          Assets may change while exporting. A file is offered only after every requested asset is read successfully.
        </p>
        {busy && <p role="status" aria-live="polite" className="text-sm">Prepared {count.toLocaleString()} assets…</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={close}>{busy ? "Cancel export" : "Cancel"}</Button>
          <Button disabled={busy || !(columns === "visible" ? props.visibleColumns : props.allColumns).length}
            onClick={() => void run()}>
            {busy && <Loader2 className="animate-spin" />}{error ? "Retry export" : "Export CSV"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
