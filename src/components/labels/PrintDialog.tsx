import { useMemo, useState } from "react";
import { FileDown, Loader2, Printer } from "lucide-react";
import type { AssetObject, ObjectTypeAttribute } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { notify } from "@/lib/notify";
import { useSettings } from "@/store/settings";
import { useTemplates } from "@/store/templates";
import { buildPages, PageSvg, printLabels } from "./print";

const PREVIEW_PAGES = 4;

export function PrintDialog({
  open,
  onOpenChange,
  objects,
  attributes,
  templateId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  objects: AssetObject[];
  attributes: ObjectTypeAttribute[];
  templateId: string | null;
}) {
  const templates = useTemplates((s) => s.templates);
  const output = useSettings((s) => s.labelDefaults.output);
  const [selected, setSelected] = useState<string | null>(templateId);
  const [startOffset, setStartOffset] = useState(0);
  const [busy, setBusy] = useState<"open" | "save" | null>(null);

  const [lastTemplateId, setLastTemplateId] = useState(templateId);
  if (templateId !== lastTemplateId) {
    setLastTemplateId(templateId);
    setSelected(templateId);
  }

  const template = templates.find((t) => t.id === selected) ?? null;
  const perPage = template?.layout.mode === "sheet" ? template.layout.columns * template.layout.rows : 1;
  const pages = useMemo(
    () => (template ? buildPages(template, objects, startOffset) : []),
    [template, objects, startOffset],
  );

  const run = async (mode: "open" | "save") => {
    if (!template) return;
    setBusy(mode);
    try {
      const done = await printLabels(template, objects, attributes, mode, startOffset);
      if (done) {
        notify.success(mode === "open" ? "PDF opened in your system viewer" : "PDF saved");
        onOpenChange(false);
      }
    } catch (e) {
      notify.error(e, "Label generation failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Print {objects.length} label{objects.length === 1 ? "" : "s"}</DialogTitle>
          <DialogDescription>
            Output is a vector PDF sized exactly to the label or sheet; print it at 100% / "Actual size".
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end gap-4">
          <div className="grid min-w-64 gap-2">
            <Label>Template</Label>
            <Select value={selected ?? ""} onValueChange={setSelected}>
              <SelectTrigger>
                <SelectValue placeholder="Select a template" />
              </SelectTrigger>
              <SelectContent>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {template?.layout.mode === "sheet" && (
            <div className="grid w-40 gap-2">
              <Label>Start at label #</Label>
              <NumberInput
                min={1}
                max={perPage}
                step={1}
                value={startOffset + 1}
                onCommit={(n) => setStartOffset(Math.round(n) - 1)}
              />
            </div>
          )}
          <p className="pb-2 text-sm text-muted-foreground">
            {pages.length} page{pages.length === 1 ? "" : "s"}
            {template && ` · ${template.width}×${template.height} mm label`}
          </p>
        </div>

        <div className="flex max-h-[50vh] flex-wrap items-start gap-4 overflow-auto rounded-md border bg-muted/40 p-4">
          {template ? (
            pages.slice(0, PREVIEW_PAGES).map((p, i) => (
              <div
                key={i}
                className="shrink-0 overflow-hidden shadow-md ring-1 ring-black/10 [&>svg]:h-auto [&>svg]:w-full"
                style={{ width: Math.min(260, Math.max(120, p.width * 1.6)) }}
              >
                <PageSvg page={p} template={template} attributes={attributes} />
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">Create a label template first.</p>
          )}
          {pages.length > PREVIEW_PAGES && (
            <p className="self-center text-sm text-muted-foreground">+ {pages.length - PREVIEW_PAGES} more pages</p>
          )}
        </div>

        <DialogFooter>
          <Button variant={output === "save" ? "default" : "outline"} disabled={!template || !!busy} onClick={() => run("save")}>
            {busy === "save" ? <Loader2 className="animate-spin" /> : <FileDown />} Save PDF
          </Button>
          <Button variant={output === "open" ? "default" : "outline"} disabled={!template || !!busy} onClick={() => run("open")}>
            {busy === "open" ? <Loader2 className="animate-spin" /> : <Printer />} Print
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
