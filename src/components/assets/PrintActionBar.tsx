import { useState } from "react";
import { ChevronDown, Eye, Loader2, Printer, Star, X } from "lucide-react";
import type { AssetObject, ObjectTypeAttribute } from "@/api/types";
import { PrintDialog } from "@/components/labels/PrintDialog";
import { printLabels } from "@/components/labels/print";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/overlays";
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
}: {
  selected: AssetObject[];
  attributes: ObjectTypeAttribute[];
  totalMatching?: number;
  onSelectAllMatching: () => void;
  selectingAll: boolean;
  onClear: () => void;
}) {
  const { templates, defaultTemplateId } = useTemplates();
  const output = useSettings((s) => s.labelDefaults.output);
  const navigate = useUi((s) => s.navigate);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  const defaultTemplate = templates.find((t) => t.id === defaultTemplateId) ?? templates[0];
  const count = selected.length;

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
    </>
  );
}
