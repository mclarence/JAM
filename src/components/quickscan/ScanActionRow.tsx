import { Trash2 } from "lucide-react";
import type { ObjectTypeAttribute, StatusType } from "@/api/types";
import { toLocalDateTime } from "@/components/assets/CellEditor";
import { ReferencePicker } from "@/components/assets/ReferencePicker";
import { StatusBadge } from "@/components/assets/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { editorKind, selectOptions } from "@/lib/attributes";
import type { ScanAction, ScanMode } from "@/store/quickScan";

interface Props {
  action: ScanAction;
  attrs: ObjectTypeAttribute[];
  statuses: StatusType[];
  onChange: (patch: Partial<ScanAction>) => void;
  onRemove: () => void;
}

export function ScanActionRow({ action, attrs, statuses, onChange, onRemove }: Props) {
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

  return (
    <div className="flex items-center gap-2">
      <Select value={action.attrId} onValueChange={pickAttr}>
        <SelectTrigger className="h-9 w-56">
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
      <Select value={action.mode} onValueChange={(v) => onChange({ mode: v as ScanMode })}>
        <SelectTrigger className="h-9 w-36">
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
      <div className="min-w-0 flex-1">
        {attr && action.mode === "set" && <ValueControl attr={attr} kind={kind} action={action} statuses={statuses} onChange={onChange} />}
      </div>
      <Button variant="ghost" size="icon" aria-label="Remove field" onClick={onRemove}>
        <Trash2 />
      </Button>
    </div>
  );
}

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
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ValueControl({
  attr,
  kind,
  action,
  statuses,
  onChange,
}: {
  attr: ObjectTypeAttribute;
  kind: ReturnType<typeof editorKind>;
  action: ScanAction;
  statuses: StatusType[];
  onChange: (patch: Partial<ScanAction>) => void;
}) {
  const set = (value: string, display = value) => onChange({ value, display });

  switch (kind) {
    case "status": {
      const allowed = attr.typeValueMulti?.length ? statuses.filter((s) => attr.typeValueMulti!.includes(s.id)) : statuses;
      return (
        <ChoiceSelect
          value={action.value}
          options={allowed.map((s) => ({ value: s.id, display: s.name, label: <StatusBadge name={s.name} category={s.category} /> }))}
          onPick={set}
        />
      );
    }
    case "select":
      return <ChoiceSelect value={action.value} options={selectOptions(attr).map((o) => ({ value: o, display: o, label: o }))} onPick={set} />;
    case "boolean":
      return (
        <ChoiceSelect
          value={action.value}
          options={[
            { value: "true", display: "Yes", label: "Yes" },
            { value: "false", display: "No", label: "No" },
          ]}
          onPick={set}
        />
      );
    case "reference":
      return (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className="h-9 w-full justify-start font-normal">
              <span className="truncate">{action.display || <span className="text-muted-foreground">Choose an object…</span>}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0">
            <ReferencePicker attr={attr} onPick={(r) => set(r.objectKey, r.label)} />
          </PopoverContent>
        </Popover>
      );
    case "integer":
      return <Input type="number" step="1" value={action.value} onChange={(e) => set(e.target.value.trim())} />;
    case "double":
      return <Input type="number" step="any" value={action.value} onChange={(e) => set(e.target.value.trim())} />;
    case "date":
      return <Input type="date" value={action.value.slice(0, 10)} onChange={(e) => set(e.target.value)} />;
    case "datetime":
      return (
        <Input
          type="datetime-local"
          value={toLocalDateTime(action.value)}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return set("");
            set(new Date(v).toISOString(), v.replace("T", " "));
          }}
        />
      );
    default:
      return <Input value={action.value} placeholder="Value" onChange={(e) => set(e.target.value)} />;
  }
}
