import { useState } from "react";
import type { ObjectTypeAttribute, StatusType } from "@/api/types";
import { toLocalDateTime } from "@/components/assets/CellEditor";
import { ReferencePicker } from "@/components/assets/ReferencePicker";
import { StatusBadge } from "@/components/assets/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { selectOptions, type EditorKind } from "@/lib/attributes";

function ChoiceSelect({
  value,
  options,
  onPick,
}: {
  value: string;
  options: { value: string; label: React.ReactNode; display: string }[];
  onPick: (value: string, display: string) => void;
}) {
  return (
    <Select value={value || undefined} onValueChange={(v) => onPick(v, options.find((o) => o.value === v)?.display ?? v)}>
      <SelectTrigger className="h-9">
        <SelectValue placeholder="Choose a value" />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function AttributeValueInput({
  attr, kind, value, display, statuses, onChange,
}: {
  attr: ObjectTypeAttribute;
  kind: EditorKind;
  value: string;
  display: string;
  statuses: StatusType[];
  onChange: (value: string, display: string, referenceId?: string) => void;
}) {
  const [referenceOpen, setReferenceOpen] = useState(false);
  const set = (next: string, shown = next, referenceId?: string) => onChange(next, shown, referenceId);
  switch (kind) {
    case "status": {
      const allowed = attr.typeValueMulti?.length ? statuses.filter((status) => attr.typeValueMulti?.includes(status.id)) : statuses;
      return (
        <ChoiceSelect
          value={value}
          options={allowed.map((status) => ({ value: status.id, display: status.name, label: <StatusBadge name={status.name} category={status.category} /> }))}
          onPick={set}
        />
      );
    }
    case "select":
      return <ChoiceSelect value={value} options={selectOptions(attr).map((option) => ({ value: option, display: option, label: option }))} onPick={set} />;
    case "boolean":
      return <ChoiceSelect value={value} options={[
        { value: "true", display: "Yes", label: "Yes" },
        { value: "false", display: "No", label: "No" },
      ]} onPick={set} />;
    case "reference":
      return (
        <Popover open={referenceOpen} onOpenChange={setReferenceOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" className="h-9 w-full justify-start font-normal">
              <span className="truncate">{display || <span className="text-muted-foreground">Choose an object…</span>}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0">
            <ReferencePicker attr={attr} onPick={(object) => {
              set(object.objectKey, object.label, object.id);
              setReferenceOpen(false);
            }} />
          </PopoverContent>
        </Popover>
      );
    case "integer":
      return <Input aria-label={`${attr.name} value`} type="number" step="1" value={value} onChange={(event) => set(event.target.value.trim())} />;
    case "double":
      return <Input aria-label={`${attr.name} value`} type="number" step="any" value={value} onChange={(event) => set(event.target.value.trim())} />;
    case "date":
      return <Input aria-label={`${attr.name} value`} type="date" value={value.slice(0, 10)} onChange={(event) => set(event.target.value)} />;
    case "datetime":
      return (
        <Input
          aria-label={`${attr.name} value`}
          type="datetime-local"
          value={toLocalDateTime(value)}
          onChange={(event) => {
            const next = event.target.value;
            if (!next) return set("");
            set(new Date(next).toISOString(), next.replace("T", " "));
          }}
        />
      );
    default:
      return <Input aria-label={`${attr.name} value`} value={value} placeholder="Value" onChange={(event) => set(event.target.value)} />;
  }
}
