import { useState } from "react";
import type { ObjectAttributeValue, ObjectTypeAttribute, StatusType } from "@/api/types";
import { Input, Textarea } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/overlays";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { editorInitialValue, editorKind, selectOptions } from "@/lib/attributes";
import { ReferencePicker } from "./ReferencePicker";
import { StatusBadge } from "./StatusBadge";

const NONE = "__none";

export interface CellEditorProps {
  attr: ObjectTypeAttribute;
  values: ObjectAttributeValue[];
  statuses: StatusType[];
  onCommit: (value: string, optimistic: ObjectAttributeValue[]) => void;
  onCancel: () => void;
}

export function toLocalDateTime(iso: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CellEditor({ attr, values, statuses, onCommit, onCancel }: CellEditorProps) {
  const kind = editorKind(attr);
  const initial = editorInitialValue(attr, values);
  const required = (attr.minimumCardinality ?? 0) > 0;

  const commitPlain = (value: string, display = value) => {
    if (value === initial) return onCancel();
    onCommit(value, value === "" ? [] : [{ value, displayValue: display }]);
  };

  switch (kind) {
    case "status": {
      const allowed = attr.typeValueMulti?.length
        ? statuses.filter((s) => attr.typeValueMulti!.includes(s.id))
        : statuses;
      return (
        <ChoiceEditor
          initial={initial}
          required={required}
          options={allowed.map((s) => ({ value: s.id, label: <StatusBadge name={s.name} category={s.category} /> }))}
          onCancel={onCancel}
          onChoose={(id) => {
            if (id === "") return commitPlain("");
            const s = allowed.find((x) => x.id === id)!;
            onCommit(id, [{ value: id, displayValue: s.name, status: s }]);
          }}
        />
      );
    }
    case "select":
      return (
        <ChoiceEditor
          initial={initial}
          required={required}
          options={selectOptions(attr).map((o) => ({ value: o, label: o }))}
          onCancel={onCancel}
          onChoose={(v) => commitPlain(v)}
        />
      );
    case "boolean":
      return (
        <ChoiceEditor
          initial={initial}
          required={required}
          options={[
            { value: "true", label: "Yes" },
            { value: "false", label: "No" },
          ]}
          onCancel={onCancel}
          onChoose={(v) => commitPlain(v)}
        />
      );
    case "reference":
      return (
        <Popover open onOpenChange={(open) => !open && onCancel()}>
          <PopoverAnchor className="absolute inset-0" />
          <PopoverContent className="w-auto p-0" onEscapeKeyDown={onCancel}>
            <ReferencePicker
              attr={attr}
              onClear={required ? undefined : () => commitPlain("")}
              onPick={(r) =>
                r.objectKey === initial
                  ? onCancel()
                  : onCommit(r.objectKey, [
                      { value: r.objectKey, displayValue: r.label, referencedObject: { ...r } },
                    ])
              }
            />
          </PopoverContent>
        </Popover>
      );
    case "textarea":
      return <TextEditor multiline initial={initial} onCommit={commitPlain} onCancel={onCancel} />;
    case "integer":
      return <TextEditor type="number" step="1" initial={initial} onCommit={commitPlain} onCancel={onCancel} />;
    case "double":
      return <TextEditor type="number" step="any" initial={initial} onCommit={commitPlain} onCancel={onCancel} />;
    case "date":
      return <TextEditor type="date" initial={initial.slice(0, 10)} onCommit={commitPlain} onCancel={onCancel} />;
    case "datetime":
      return (
        <TextEditor
          type="datetime-local"
          initial={toLocalDateTime(initial)}
          onCommit={(v) => commitPlain(v ? new Date(v).toISOString() : "", v.replace("T", " "))}
          onCancel={onCancel}
        />
      );
    case "readonly":
      return null;
    default:
      return <TextEditor initial={initial} onCommit={commitPlain} onCancel={onCancel} />;
  }
}

function TextEditor({
  initial,
  onCommit,
  onCancel,
  multiline,
  type = "text",
  step,
}: {
  initial: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
  multiline?: boolean;
  type?: string;
  step?: string;
}) {
  const [value, setValue] = useState(initial);
  const [done, setDone] = useState(false);
  const finish = (commit: boolean) => {
    if (done) return;
    setDone(true);
    if (commit) onCommit(value.trim());
    else onCancel();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    } else if (e.key === "Enter" && (!multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      finish(true);
    }
  };

  if (multiline) {
    return (
      <Textarea
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => finish(true)}
        className="absolute inset-x-0 top-0 z-20 min-h-24 bg-background shadow-lg"
      />
    );
  }
  return (
    <Input
      autoFocus
      type={type}
      step={step}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
      className="h-full rounded-none border-0 bg-background ring-2 ring-ring"
    />
  );
}

function ChoiceEditor({
  initial,
  required,
  options,
  onChoose,
  onCancel,
}: {
  initial: string;
  required: boolean;
  options: { value: string; label: React.ReactNode }[];
  onChoose: (value: string) => void;
  onCancel: () => void;
}) {
  return (
    <Select
      defaultOpen
      value={initial || undefined}
      onValueChange={(v) => {
        const next = v === NONE ? "" : v;
        if (next === initial) onCancel();
        else onChoose(next);
      }}
      onOpenChange={(open) => {
        // Closing without a change cancels; a change has already been handled by onValueChange.
        if (!open) setTimeout(onCancel, 0);
      }}
    >
      <SelectTrigger className="h-full rounded-none border-0 bg-background ring-2 ring-ring">
        <SelectValue placeholder="—" />
      </SelectTrigger>
      <SelectContent>
        {!required && <SelectItem value={NONE}>(none)</SelectItem>}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
