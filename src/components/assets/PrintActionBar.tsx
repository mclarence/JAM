import { useState } from "react";
import { BookmarkPlus, ChevronDown, Download, Eye, Loader2, Pencil, Printer, Star, Trash2, X } from "lucide-react";
import type { AssetObject, ObjectTypeAttribute } from "@/api/types";
import { PrintDialog } from "@/components/labels/PrintDialog";
import { printLabels } from "@/components/labels/print";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/overlays";
import { Label } from "@/components/ui/primitives";
import { selectedKeysToAql } from "@/lib/aql";
import { notify } from "@/lib/notify";
import { useSettings } from "@/store/settings";
import { useTemplates } from "@/store/templates";
import { useUi } from "@/store/ui";

export function PrintActionBar({
  selected,
  attributes,
  totalMatching,
  onSelectAllMatching,
  selectingAll,
  onClear,
  onBatchEdit,
  onExport,
  exportDisabled,
  onDelete,
  deleteDisabledReason,
}: {
  selected: AssetObject[];
  attributes: ObjectTypeAttribute[];
  totalMatching?: number;
  onSelectAllMatching: () => void;
  selectingAll: boolean;
  onClear: () => void;
  onBatchEdit: () => void;
  onExport: () => void;
  exportDisabled: boolean;
  onDelete: () => void;
  /** Shown as a tooltip when deletion is unavailable. */
  deleteDisabledReason?: string;
}) {
  const { templates, defaultTemplateId } = useTemplates();
  const output = useSettings((s) => s.labelDefaults.output);
  const savePreset = useSettings((s) => s.savePreset);
  const navigate = useUi((s) => s.navigate);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetName, setPresetName] = useState("");

  const defaultTemplate = templates.find((t) => t.id === defaultTemplateId) ?? templates[0];
  const count = selected.length;
  const selectedKeys = selected.map((object) => object.objectKey);
  const selectedAql = selectedKeysToAql(selectedKeys);
  const canSavePreset = !!selectedAql && selectedKeys.every(Boolean);

  const print = async (templateId: string) => {
    const template = templates.find((t) => t.id === templateId);
    if (!template) return;
    setBusy(true);
    try {
      if (await printLabels(template, selected, attributes, output)) {
        notify.success(`Generated ${count} label${count === 1 ? "" : "s"} with "${template.name}"`);
      }
    } catch (e) {
      notify.error(e, "Label generation failed");
    } finally {
      setBusy(false);
    }
  };

  if (count === 0) return null;

  return (
    <>
      <div className="sticky bottom-0 z-20 mt-3 flex items-center gap-3 rounded-lg border bg-card px-4 py-2.5 shadow-lg">
        <span className="text-sm font-medium">{count} selected</span>
        {totalMatching !== undefined && totalMatching > count && (
          <Button variant="link" size="sm" className="h-auto px-0" disabled={selectingAll} onClick={onSelectAllMatching}>
            {selectingAll && <Loader2 className="animate-spin" />}
            Select all {totalMatching.toLocaleString()} matching
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onClear}>
          <X /> Clear
        </Button>
        <div className="flex-1" />

        <Button variant="outline" onClick={onExport} disabled={exportDisabled}>
          <Download /> Export selected
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            setPresetName("");
            setSavingPreset(true);
          }}
          disabled={!canSavePreset || selectingAll}
        >
          <BookmarkPlus /> Save selected as filter
        </Button>
        <Button variant="outline" onClick={onBatchEdit}>
          <Pencil /> Update {count}
        </Button>
        <span title={deleteDisabledReason}>
          <Button variant="outline" className="text-destructive hover:text-destructive" disabled={!!deleteDisabledReason} onClick={onDelete}>
            <Trash2 /> Delete {count}
          </Button>
        </span>

        {templates.length === 0 ? (
          <Button onClick={() => navigate("templates")}>
            <Printer /> Create a label template
          </Button>
        ) : (
          <div className="flex">
            <Button className="rounded-r-none" disabled={busy} onClick={() => defaultTemplate && print(defaultTemplate.id)}>
              {busy ? <Loader2 className="animate-spin" /> : <Printer />}
              Print {count} Label{count === 1 ? "" : "s"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button className="rounded-l-none border-l border-primary-foreground/20 px-2" disabled={busy} aria-label="More print options">
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>Print with template</DropdownMenuLabel>
                {templates.map((t) => (
                  <DropdownMenuItem key={t.id} onSelect={() => print(t.id)}>
                    <span className="flex-1 truncate">{t.name}</span>
                    {t.id === defaultTemplate?.id && <Star className="text-amber-500" />}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setPreview(defaultTemplate?.id ?? null)}>
                  <Eye /> Preview &amp; options…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
      <PrintDialog
        open={preview !== null}
        onOpenChange={(o) => !o && setPreview(null)}
        objects={selected}
        attributes={attributes}
        templateId={preview}
      />
      <Dialog open={savingPreset} onOpenChange={setSavingPreset}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save selected assets as filter</DialogTitle>
            <DialogDescription>This preset matches the selected assets by their keys.</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const name = presetName.trim();
              if (!name || !selectedAql || !selectedKeys.every(Boolean)) return;
              savePreset(name, selectedAql);
              setPresetName("");
              setSavingPreset(false);
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="selected-filter-name">Name</Label>
              <Input
                id="selected-filter-name"
                autoFocus
                value={presetName}
                onChange={(event) => setPresetName(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={!presetName.trim() || !canSavePreset || selectingAll}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
