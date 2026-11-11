import { useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Loader2, X } from "lucide-react";
import { reportsApi } from "@/api/reports";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useDebounce } from "@/hooks/useDebounce";
import type { Dataset, Entity, FieldDef, FieldType } from "@/lib/reports/types";
import { LIMITS } from "@/lib/reports/types";
import { recordedReferenceLabel } from "@/lib/reports/format";
import { cn } from "@/lib/utils";
import { reportKeys } from "./state";

/** Display labels seen for stored keys (e.g. object key → name), so chips and summaries stay readable. */
export const valueLabels = new Map<string, string>();

const TYPE_LABELS: Record<FieldType, string> = {
  text: "Text", number: "Number", date: "Date", datetime: "Date & time", boolean: "Yes/no", ref: "Object", enum: "Choice",
};

/** Searchable field list grouped by category. */
export function FieldPicker({
  fields,
  onPick,
  children,
  filter,
  selected,
}: {
  fields: FieldDef[];
  onPick: (field: FieldDef) => void;
  children: ReactNode;
  filter?: (f: FieldDef) => boolean;
  selected?: string;
}) {
  const [open, setOpen] = useState(false);
  const picked = useRef(false);
  const groups = useMemo(() => {
    const map = new Map<string, FieldDef[]>();
    for (const f of fields) {
      if (filter && !filter(f)) continue;
      const list = map.get(f.category) ?? [];
      list.push(f);
      map.set(f.category, list);
    }
    return [...map];
  }, [fields, filter]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        className="w-72 p-0"
        align="start"
        onCloseAutoFocus={(e) => {
          // After a pick, focus belongs to whatever the pick opened (e.g. the new filter's editor).
          if (picked.current) e.preventDefault();
          picked.current = false;
        }}
      >
        <Command>
          <CommandInput autoFocus placeholder="Search fields…" />
          <CommandList>
            <CommandEmpty>No matching fields.</CommandEmpty>
            {groups.map(([category, list]) => (
              <CommandGroup key={category} heading={category}>
                {list.map((f) => (
                  <CommandItem
                    key={f.id}
                    value={`${f.label} ${f.category} ${f.id}`}
                    onSelect={() => {
                      picked.current = true;
                      onPick(f);
                      setOpen(false);
                    }}
                  >
                    <span className="flex-1 truncate">{f.label}</span>
                    {selected === f.id && <Check className="size-4" />}
                    <span aria-hidden className="text-[10px] uppercase text-muted-foreground">{TYPE_LABELS[f.type] ?? f.type}{f.multi ? " · list" : ""}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Multi-value editor for in/notIn. Uses fixed options, the local report database, or free text. */
export function ValueList({
  dataset,
  entity,
  field,
  version,
  value,
  onChange,
}: {
  dataset: Dataset;
  entity: Entity;
  field: FieldDef;
  version: number;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [term, setTerm] = useState("");
  const debounced = useDebounce(term, 250);
  const fixed = field.options;
  const suggestions = useQuery({
    queryKey: reportKeys.values(dataset.id, entity, field.id, debounced, version),
    queryFn: async () => {
      const list = await reportsApi.fieldValues(dataset, entity, field.id, debounced, 50);
      for (const v of list) valueLabels.set(v.value, v.label);
      return list;
    },
    enabled: !fixed && field.picker,
    staleTime: 60_000,
  });
  const selected = new Set(value);
  const toggle = (v: string, label?: string) => {
    if (label) valueLabels.set(v, label);
    if (selected.has(v)) onChange(value.filter((x) => x !== v));
    else if (value.length < LIMITS.list) onChange([...value, v]);
  };
  const label = (v: string) => fixed?.find((o) => o.value === v)?.label ?? valueLabels.get(v) ?? (field.type === "ref" ? recordedReferenceLabel(v) : v);

  const chips = value.length > 0 && (
    <div className="flex max-h-24 flex-wrap gap-1 overflow-auto">
      {value.map((v) => (
        <Badge key={v} variant="secondary" className="gap-1">
          <span className="max-w-48 truncate">{label(v)}</span>
          <button type="button" aria-label={`Remove ${label(v)}`} onClick={() => toggle(v)}>
            <X className="size-3" />
          </button>
        </Badge>
      ))}
    </div>
  );

  if (!fixed && !field.picker) {
    const add = () => {
      const t = term.trim();
      if (t && !selected.has(t)) toggle(t);
      setTerm("");
    };
    return (
      <div className="grid gap-2">
        {chips}
        <Input
          value={term}
          placeholder="Type a value and press Enter"
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
        />
      </div>
    );
  }

  const options = fixed
    ? fixed.filter((o) => o.label.toLowerCase().includes(term.toLowerCase())).map((o) => ({ ...o, count: null as number | null }))
    : (suggestions.data ?? []).map((o) => ({ ...o, count: o.count as number | null }));

  return (
    <div className="grid gap-2">
      {chips}
      <Command shouldFilter={false} className="rounded-md border">
        <CommandInput value={term} onValueChange={setTerm} placeholder="Search values in collected data…" />
        <CommandList className="max-h-56">
          {suggestions.isFetching && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Searching…
            </div>
          )}
          {suggestions.isError && <p className="p-3 text-xs text-destructive">{suggestions.error.message}</p>}
          {!suggestions.isFetching && <CommandEmpty>No values found. Refresh the data source if this is new.</CommandEmpty>}
          {options.map((o) => (
            <CommandItem key={o.value} value={o.value} onSelect={() => toggle(o.value, o.label)}>
              <Check className={cn("size-4", selected.has(o.value) ? "opacity-100" : "opacity-0")} />
              <span className="flex-1 truncate">{o.label}</span>
              {o.count !== null && <span className="text-xs tabular-nums text-muted-foreground">{o.count.toLocaleString()}</span>}
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </div>
  );
}
