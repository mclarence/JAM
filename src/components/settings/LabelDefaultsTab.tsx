import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatUnit, toMm, type Unit } from "@/components/labels/model";
import { useSettings, type PdfOutput } from "@/store/settings";
import { useTemplates } from "@/store/templates";

export function LabelDefaultsTab() {
  const { labelDefaults, setLabelDefaults } = useSettings();
  const { templates, defaultTemplateId, setDefault } = useTemplates();
  const unit = labelDefaults.unit;

  return (
    <div className="grid max-w-xl gap-6">
      <div className="grid gap-2">
        <Label>Default print template</Label>
        <Select value={defaultTemplateId ?? ""} onValueChange={setDefault} disabled={templates.length === 0}>
          <SelectTrigger>
            <SelectValue placeholder="No templates yet" />
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

      <div className="grid gap-2">
        <Label>Default unit for new templates</Label>
        <Select value={unit} onValueChange={(v) => setLabelDefaults({ unit: v as Unit })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mm">Millimetres (mm)</SelectItem>
            <SelectItem value="in">Inches (in)</SelectItem>
            <SelectItem value="px">Pixels (px @ 96 dpi)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-2">
          <Label>Default label width ({unit})</Label>
          <NumberInput
            min={0}
            value={formatUnit(labelDefaults.width, unit)}
            onCommit={(n) => setLabelDefaults({ width: toMm(n, unit) })}
          />
        </div>
        <div className="grid gap-2">
          <Label>Default label height ({unit})</Label>
          <NumberInput
            min={0}
            value={formatUnit(labelDefaults.height, unit)}
            onCommit={(n) => setLabelDefaults({ height: toMm(n, unit) })}
          />
        </div>
      </div>

      <div className="grid gap-2">
        <Label>Print action</Label>
        <Select value={labelDefaults.output} onValueChange={(v) => setLabelDefaults({ output: v as PdfOutput })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open PDF in system viewer for printing</SelectItem>
            <SelectItem value="save">Save PDF to a file</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
