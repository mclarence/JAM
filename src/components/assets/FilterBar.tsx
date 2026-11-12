import { useEffect, useRef, useState } from "react";
import { DndContext, MouseSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { ArrowLeft, ArrowRight, BookmarkPlus, Code2, Filter, ListFilter, MoreHorizontal, Plus, Trash2, X } from "lucide-react";
import type { ObjectTypeAttribute } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/overlays";
import { Label } from "@/components/ui/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FILTER_OPERATORS, isTextarea, listFilterAttributes, listFilterToAql, parseListFilter, rulesToAql, SEARCH_KEY, type FilterOperator, type FilterRule } from "@/lib/aql";
import { cn } from "@/lib/utils";
import { useSettings, type AqlPreset } from "@/store/settings";
import { useUi } from "@/store/ui";

export function FilterBar({ attributes, error }: { attributes: ObjectTypeAttribute[]; error?: string | null }) {
  const { rawAql, setRawAql } = useUi();
  const [draft, setDraft] = useState(rawAql);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setDraft((d) => (d === rawAql ? d : rawAql));
  }, [rawAql]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const applyAql = (aql: string, replaceSearch = false) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setDraft(aql);
    if (replaceSearch) useUi.getState().replaceAssetFilter(aql);
    else setRawAql(aql);
  };

  return (
    <div className="mb-3 grid gap-1">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Code2 className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={draft}
            onChange={(e) => {
              const next = e.target.value;
              const previous = useUi.getState().rawAql;
              setDraft(next);
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(() => {
                if (useUi.getState().rawAql === previous) setRawAql(next);
                timer.current = null;
              }, 300);
            }}
            placeholder={'AQL filter, e.g. "Status" = "In Use" AND "Location" LIKE "Sydney"'}
            className={cn("pl-8 pr-8 font-mono text-xs", error && "border-destructive focus-visible:ring-destructive")}
            spellCheck={false}
          />
          {draft && (
            <button
              type="button"
              aria-label="Clear AQL"
              onClick={() => applyAql("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <ListFilterDialog attributes={attributes} onApply={(aql) => applyAql(aql, true)} />
        <FilterBuilder attributes={attributes.filter((a) => !isTextarea(a))} onApply={applyAql} />
      </div>
      <Presets current={rawAql} onApply={applyAql} />
      {error && <p className="px-1 text-xs text-destructive select-text">{error}</p>}
    </div>
  );
}

function ListFilterDialog({ attributes, onApply }: { attributes: ObjectTypeAttribute[]; onApply: (aql: string) => void }) {
  const [open, setOpen] = useState(false);
  const [field, setField] = useState(SEARCH_KEY);
  const [mode, setMode] = useState<"exact" | "contains">("exact");
  const [input, setInput] = useState("");
  const fields = listFilterAttributes(attributes);
  const selected = fields.find((attr) => attr.id === field);
  const values = parseListFilter(input);
  const validField = field === SEARCH_KEY || !!selected;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <ListFilter /> Paste list
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Filter by list</DialogTitle>
          <DialogDescription>Paste one value per line. Applying replaces the current search and AQL filter.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-2">
            <Label htmlFor="list-filter-field">Field</Label>
            <Select value={field} onValueChange={setField}>
              <SelectTrigger id="list-filter-field"><SelectValue placeholder="Choose a field" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={SEARCH_KEY}>Key</SelectItem>
                {fields.map((attr) => <SelectItem key={attr.id} value={attr.id}>{attr.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="list-filter-mode">Match</Label>
            <Select value={mode} onValueChange={(value) => setMode(value === "contains" ? "contains" : "exact")}>
              <SelectTrigger id="list-filter-mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="exact">Exact</SelectItem>
                <SelectItem value="contains">Contains</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="list-filter-values">Values</Label>
            <Textarea id="list-filter-values" rows={8} value={input} onChange={(event) => setInput(event.target.value)} placeholder={"Value 1\nValue 2"} />
            <p className="text-xs text-muted-foreground" aria-live="polite">{values.length.toLocaleString()} distinct values</p>
            {!validField && <p role="alert" className="text-xs text-destructive">Choose a field available on this object type.</p>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={!validField || values.length === 0} onClick={() => {
            onApply(listFilterToAql(field === SEARCH_KEY ? SEARCH_KEY : selected!.name, values, mode));
            setOpen(false);
          }}>Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FilterBuilder({ attributes, onApply }: { attributes: ObjectTypeAttribute[]; onApply: (aql: string) => void }) {
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<FilterRule[]>([]);
  const newRule = (): FilterRule => ({ id: crypto.randomUUID(), attrName: attributes[0]?.name ?? "", operator: "=", value: "" });
  const patch = (id: string, p: Partial<FilterRule>) => setRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o && rules.length === 0) setRules([newRule()]);
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Filter /> Filter builder
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[640px]">
        <div className="grid gap-3">
          <p className="text-sm font-medium">Match all of the following</p>
          {rules.map((r) => {
            const op = FILTER_OPERATORS.find((o) => o.value === r.operator);
            return (
              <div key={r.id} className="flex items-center gap-2">
                <Select value={r.attrName} onValueChange={(v) => patch(r.id, { attrName: v })}>
                  <SelectTrigger className="w-48">
                    <SelectValue placeholder="Attribute" />
                  </SelectTrigger>
                  <SelectContent>
                    {attributes.map((a) => (
                      <SelectItem key={a.id} value={a.name}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={r.operator} onValueChange={(v) => patch(r.id, { operator: v as FilterOperator })}>
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FILTER_OPERATORS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  className="flex-1"
                  value={r.value}
                  disabled={!op?.needsValue}
                  onChange={(e) => patch(r.id, { value: e.target.value })}
                  placeholder="Value"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove rule"
                  onClick={() => setRules((rs) => rs.filter((x) => x.id !== r.id))}
                >
                  <Trash2 />
                </Button>
              </div>
            );
          })}
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" size="sm" onClick={() => setRules((rs) => [...rs, newRule()])}>
              <Plus /> Add rule
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setRules([])}>
                Clear
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  onApply(rulesToAql(rules));
                  setOpen(false);
                }}
              >
                Apply
              </Button>
            </div>
          </div>
          {rules.length > 0 && (
            <code className="block rounded bg-muted px-2 py-1 text-xs break-all select-text">{rulesToAql(rules) || "—"}</code>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PresetChip({ preset, active, earlierId, laterId, onApply }: {
  preset: AqlPreset;
  active: boolean;
  earlierId?: string;
  laterId?: string;
  onApply: (aql: string) => void;
}) {
  const { deletePreset, movePreset } = useSettings();
  const drag = useDraggable({ id: preset.id });
  const drop = useDroppable({ id: preset.id });
  return (
    <div
      ref={(element) => { drag.setNodeRef(element); drop.setNodeRef(element); }}
      data-preset-id={preset.id}
      style={{ transform: drag.transform ? `translate3d(${drag.transform.x}px, 0, 0)` : undefined }}
      className={cn(
        "relative flex h-7 shrink-0 items-center rounded-full border text-xs transition-colors",
        active ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-accent",
        drag.isDragging && "z-20 opacity-80 shadow-md",
        drop.isOver && !drag.isDragging && "ring-2 ring-primary",
      )}
    >
      <button
        ref={drag.setActivatorNodeRef}
        {...drag.attributes}
        {...drag.listeners}
        type="button"
        title={preset.aql}
        aria-pressed={active}
        className="max-w-48 cursor-grab truncate py-1 pl-3 pr-1 active:cursor-grabbing"
        onClick={() => onApply(active ? "" : preset.aql)}
      >
        {preset.name}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Actions for preset ${preset.name}`}
            className="flex h-full shrink-0 items-center rounded-r-full pl-1 pr-2 opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MoreHorizontal className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={!earlierId} onSelect={() => { if (earlierId) movePreset(preset.id, earlierId); }}>
            <ArrowLeft /> Move earlier
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!laterId} onSelect={() => { if (laterId) movePreset(preset.id, laterId); }}>
            <ArrowRight /> Move later
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive" onSelect={() => deletePreset(preset.id)}>
            <Trash2 /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function Presets({ current, onApply }: { current: string; onApply: (aql: string) => void }) {
  const { aqlPresets, savePreset, movePreset } = useSettings();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");

  const normalized = current.trim();
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && typeof active.id === "string" && typeof over.id === "string") movePreset(active.id, over.id);
  };

  return (
    <>
      <DndContext sensors={sensors} onDragEnd={onDragEnd} autoScroll={{ threshold: { x: 0.2, y: 0 } }}
        accessibility={{ screenReaderInstructions: { draggable: "Drag to reorder this preset, or tab to its actions menu for Move earlier and Move later." } }}>
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 rounded-full px-3 text-xs"
            disabled={!normalized}
            onClick={() => setSaving(true)}
          >
            <BookmarkPlus /> Save filter
          </Button>
          {aqlPresets.map((p, index) => {
            const active = !!normalized && p.aql.trim() === normalized;
            return (
              <PresetChip key={p.id} preset={p} active={active} earlierId={aqlPresets[index - 1]?.id}
                laterId={aqlPresets[index + 1]?.id} onApply={onApply} />
            );
          })}
          {aqlPresets.length === 0 && (
            <span className="text-xs text-muted-foreground">Saved filters appear here as one-click chips.</span>
          )}
        </div>
      </DndContext>

      <Dialog open={saving} onOpenChange={setSaving}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save AQL preset</DialogTitle>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              savePreset(name.trim(), current);
              setName("");
              setSaving(false);
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="preset-name">Name</Label>
              <Input id="preset-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <code className="rounded bg-muted px-2 py-1 text-xs break-all">{current}</code>
            <DialogFooter>
              <Button type="submit" disabled={!name.trim()}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
