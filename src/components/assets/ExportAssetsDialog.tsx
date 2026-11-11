import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Loader2 } from "lucide-react";
import type { ConnectionInfo, ObjectTypeAttribute } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { exportFileName, saveAssetExport, skippedExportWarning } from "@/lib/assetExport";
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
  const [warning, setWarning] = useState<string>();
  const [awaitingSave, setAwaitingSave] = useState(false);
  const confirmSave = useRef<((proceed: boolean) => void) | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => {
    controller.current?.abort();
    confirmSave.current?.(false);
  }, []);

  const close = () => {
    controller.current?.abort();
    confirmSave.current?.(false);
    props.onClose();
  };
  const run = async () => {
    const operation = new AbortController();
    controller.current = operation;
    setBusy(true);
    setCount(0);
    setError(undefined);
    setWarning(undefined);
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
        save({ defaultPath, filters: [{ name: "CSV", extensions: ["csv"] }] }), async (summary) => {
          if (!summary.skippedIds.length) return true;
          setWarning(skippedExportWarning(summary));
          setAwaitingSave(true);
          const proceed = await new Promise<boolean>((resolve) => { confirmSave.current = resolve; });
          confirmSave.current = null;
          setAwaitingSave(false);
          return proceed;
        });
      if (operation.signal.aborted) return;
      if (saved !== null) {
        if (saved.skippedIds.length) {
          notify.info(`Exported ${saved.count.toLocaleString()} assets. ${skippedExportWarning(saved)}`);
        } else {
          notify.success(`Exported ${saved.count.toLocaleString()} assets`);
        }
        props.onClose();
      } else setWarning(undefined);
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
        <fieldset disabled={busy} className="grid min-w-0 gap-3">
          <div className="grid min-w-0 gap-1.5">
            <Label htmlFor="export-assets-scope">Assets</Label>
            <Select value={scope} onValueChange={setScope} disabled={busy}>
              <SelectTrigger id="export-assets-scope"><SelectValue /></SelectTrigger>
              <SelectContent className="max-w-[var(--radix-select-content-available-width)]">
                <SelectItem value="selected" disabled={!props.selectedIds.length}>
                  Selected assets ({props.selectedIds.length})
                </SelectItem>
                <SelectItem value="all">All matching results, across all pages</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid min-w-0 gap-1.5">
            <Label htmlFor="export-assets-columns">Attributes</Label>
            <Select value={columns} onValueChange={setColumns} disabled={busy}>
              <SelectTrigger id="export-assets-columns"><SelectValue /></SelectTrigger>
              <SelectContent className="max-w-[var(--radix-select-content-available-width)]">
                <SelectItem value="visible">Visible columns ({props.visibleColumns.length})</SelectItem>
                <SelectItem value="all">All available attributes ({props.allColumns.length})</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </fieldset>
        {columns === "visible" && !props.visibleColumns.length && (
          <p role="status" className="text-sm">No visible columns. Choose all attributes or show columns first.</p>
        )}
        <p className="text-xs text-muted-foreground">
          Text is preserved exactly. Spreadsheets may execute formula-like text; only open trusted data.
          Both export scopes use Jira AQL search data and may reflect search-index lag.
          All search pages must succeed. Missing selected assets are skipped with a warning.
        </p>
        {busy && <p role="status" aria-live="polite" className="text-sm">Prepared {count.toLocaleString()} assets…</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {warning && <p role="alert" className="text-sm">{warning}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={close}>{busy ? "Cancel export" : "Cancel"}</Button>
          <Button disabled={(busy && !awaitingSave) || !(columns === "visible" ? props.visibleColumns : props.allColumns).length}
            onClick={() => awaitingSave ? confirmSave.current?.(true) : void run()}>
            {busy && !awaitingSave && <Loader2 className="animate-spin" />}{awaitingSave ? "Continue to save" : error ? "Retry export" : "Export CSV"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
