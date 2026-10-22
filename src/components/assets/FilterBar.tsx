import { useEffect, useState } from "react";
import { BookmarkPlus, Code2, Filter, Plus, Trash2, X } from "lucide-react";
import type { ObjectTypeAttribute } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/overlays";
import { Label } from "@/components/ui/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDebounce } from "@/hooks/useDebounce";
import { FILTER_OPERATORS, isTextarea, rulesToAql, type FilterOperator, type FilterRule } from "@/lib/aql";
import { cn } from "@/lib/utils";
import { useSettings } from "@/store/settings";
import { useUi } from "@/store/ui";

export function FilterBar({ attributes, error }: { attributes: ObjectTypeAttribute[]; error?: string | null }) {
  const { rawAql, setRawAql } = useUi();
  const [draft, setDraft] = useState(rawAql);
  const debounced = useDebounce(draft, 300);

  useEffect(() => {
    if (debounced !== useUi.getState().rawAql) setRawAql(debounced);
  }, [debounced, setRawAql]);

  useEffect(() => {
    setDraft((d) => (d === rawAql ? d : rawAql));
  }, [rawAql]);

  return (
    <div className="mb-3 grid gap-1">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Code2 className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={'AQL filter, e.g. "Status" = "In Use" AND "Location" LIKE "Sydney"'}
            className={cn("pl-8 pr-8 font-mono text-xs", error && "border-destructive focus-visible:ring-destructive")}
            spellCheck={false}
          />
          {draft && (
            <button
              type="button"
              aria-label="Clear AQL"
              onClick={() => {
                setDraft("");
                setRawAql("");
              }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <FilterBuilder attributes={attributes.filter((a) => !isTextarea(a))} onApply={(aql) => setRawAql(aql)} />
      </div>
      <Presets current={rawAql} onApply={setRawAql} />
      {error && <p className="px-1 text-xs text-destructive select-text">{error}</p>}
    </div>
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

function Presets({ current, onApply }: { current: string; onApply: (aql: string) => void }) {
  const { aqlPresets, savePreset, deletePreset } = useSettings();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");

  const normalized = current.trim();

  return (
    <>
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
        {aqlPresets.map((p) => {
          const active = !!normalized && p.aql.trim() === normalized;
          return (
            <div
              key={p.id}
              className={cn(
                "group flex h-7 shrink-0 items-center rounded-full border text-xs transition-colors",
                active ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-accent",
              )}
            >
              <button
                type="button"
                title={p.aql}
                aria-pressed={active}
                className="max-w-48 truncate py-1 pl-3 pr-2 group-hover:pr-1"
                onClick={() => onApply(active ? "" : p.aql)}
              >
                {p.name}
              </button>
              <button
                type="button"
                aria-label={`Delete preset ${p.name}`}
                className="hidden pr-2 opacity-70 hover:opacity-100 group-hover:block"
                onClick={() => deletePreset(p.id)}
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}
        {aqlPresets.length === 0 && (
          <span className="text-xs text-muted-foreground">Saved filters appear here as one-click chips.</span>
        )}
      </div>

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
