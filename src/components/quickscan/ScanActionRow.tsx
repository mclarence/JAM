import { Trash2 } from "lucide-react";
import type { ObjectTypeAttribute, StatusType } from "@/api/types";
import { AttributeValueInput } from "@/components/assets/AttributeValueInput";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { editorKind } from "@/lib/attributes";
import type { ScanAction, ScanMode } from "@/store/quickScan";

interface Props {
  action: ScanAction;
  attrs: ObjectTypeAttribute[];
  statuses: StatusType[];
  onChange: (patch: Partial<ScanAction>) => void;
  onRemove: () => void;
  /** Vertical layout for narrow containers. */
  stacked?: boolean;
}

export function ScanActionRow({ action, attrs, statuses, onChange, onRemove, stacked }: Props) {
  const attr = attrs.find((a) => a.id === action.attrId);
  const kind = attr ? editorKind(attr) : "readonly";
  const required = (attr?.minimumCardinality ?? 0) > 0;
  const modes: { value: ScanMode; label: string }[] = [];
  if (kind !== "readonly") modes.push({ value: "set", label: "Set to" });
  if (!required) modes.push({ value: "clear", label: "Clear" });
  if (kind === "date" || kind === "datetime") modes.push({ value: "now", label: "Set to now" });

  const pickAttr = (id: string) => {
    const next = attrs.find((a) => a.id === id)!;
    onChange({ attrId: id, mode: editorKind(next) === "readonly" ? "clear" : "set", value: "", display: "" });
  };

  const attrSelect = (
    <Select value={action.attrId} onValueChange={pickAttr}>
      <SelectTrigger className={stacked ? "h-9 min-w-0 flex-1" : "h-9 w-56"}>
        <SelectValue placeholder="Attribute" />
      </SelectTrigger>
      <SelectContent>
        {attrs.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  const modeSelect = (
    <Select value={action.mode} onValueChange={(v) => onChange({ mode: v as ScanMode })}>
      <SelectTrigger className={stacked ? "h-9 w-full" : "h-9 w-36"}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {modes.map((m) => (
          <SelectItem key={m.value} value={m.value}>
            {m.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  const value = attr && action.mode === "set" && (
    <AttributeValueInput
      attr={attr} kind={kind} value={action.value} display={action.display} statuses={statuses}
      onChange={(value, display) => onChange({ value, display })}
    />
  );
  const remove = (
    <Button variant="ghost" size="icon" aria-label="Remove field" onClick={onRemove}>
      <Trash2 />
    </Button>
  );

  if (stacked) {
    return (
      <div className="grid gap-2 rounded-md border p-2">
        <div className="flex items-center gap-1">
          {attrSelect}
          {remove}
        </div>
        {modeSelect}
        {value}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {attrSelect}
      {modeSelect}
      <div className="min-w-0 flex-1">{value}</div>
      {remove}
    </div>
  );
}
