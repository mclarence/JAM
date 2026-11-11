import { useEffect, useState } from "react";
import { AlertCircle, FolderPlus, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { conditionProblem, defaultCondition, defaultValue, describeCondition, OPERATOR_LABELS, valueKind } from "@/lib/reports/filters";
import type { ConditionNode, Dataset, Entity, FieldDef, FilterNode, GroupNode } from "@/lib/reports/types";
import { LIMITS } from "@/lib/reports/types";
import { cn } from "@/lib/utils";
import { FieldPicker, ValueList, valueLabels } from "./FieldPicker";

interface Ctx {
  dataset: Dataset;
  entity: Entity;
  fields: Map<string, FieldDef>;
  fieldList: FieldDef[];
  version: number;
  total: number;
}

/** Conditions just added, whose editor opens straight away. */
const fresh = new WeakSet<ConditionNode>();
const added = (field: FieldDef) => {
  const c = defaultCondition(field);
  fresh.add(c);
  return c;
};

const nodeCount = (n: FilterNode): number => (n.kind === "condition" ? 1 : 1 + n.children.reduce((s, c) => s + nodeCount(c), 0));

/** Edits the report's filter tree. The root is always an AND/OR group. */
export function FilterEditor({
  value,
  onChange,
  ...ctx
}: Omit<Ctx, "fieldList" | "total"> & { value: GroupNode; onChange: (v: GroupNode) => void }) {
  const fieldList = [...ctx.fields.values()];
  return <Group node={value} onChange={(n) => onChange(n)} depth={1} ctx={{ ...ctx, fieldList, total: nodeCount(value) }} />;
}

function Group({ node, onChange, onRemove, depth, ctx }: { node: GroupNode; onChange: (n: GroupNode) => void; onRemove?: () => void; depth: number; ctx: Ctx }) {
  const full = ctx.total >= LIMITS.nodes;
  const setChild = (i: number, child: FilterNode | null) =>
    onChange({ ...node, children: child ? node.children.map((c, j) => (j === i ? child : c)) : node.children.filter((_, j) => j !== i) });
  const toggleJoin = () => onChange({ ...node, join: node.join === "and" ? "or" : "and" });

  return (
    <div className={cn("grid gap-2", depth > 1 && "rounded-lg border border-dashed p-2")}>
      <div className="flex flex-wrap items-center gap-1.5">
        {node.children.map((child, i) => (
          <span key={i} className="contents">
            {i > 0 && (
              <button
                type="button"
                onClick={toggleJoin}
                className="rounded px-1.5 text-[11px] font-semibold uppercase text-muted-foreground hover:bg-accent"
                title="Switch between AND and OR"
              >
                {node.join}
              </button>
            )}
            {child.kind === "group" ? (
              <div className="w-full">
                <Group node={child} depth={depth + 1} ctx={ctx} onChange={(c) => setChild(i, c)} onRemove={() => setChild(i, null)} />
              </div>
            ) : (
              <ConditionChip node={child} ctx={ctx} onChange={(c) => setChild(i, c)} onRemove={() => setChild(i, null)} />
            )}
          </span>
        ))}
        <FieldPicker fields={ctx.fieldList} onPick={(f) => onChange({ ...node, children: [...node.children, added(f)] })}>
          <Button size="sm" variant="outline" className="h-7 border-dashed" disabled={full}>
            <Plus /> Filter
          </Button>
        </FieldPicker>
        {depth < LIMITS.depth && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            disabled={full}
            title="Add a nested group to mix AND and OR"
            onClick={() => onChange({ ...node, children: [...node.children, { kind: "group", join: node.join === "and" ? "or" : "and", children: [] }] })}
          >
            <FolderPlus /> Group
          </Button>
        )}
        {onRemove && (
          <Button size="iconSm" variant="ghost" aria-label="Remove group" onClick={onRemove}>
            <Trash2 />
          </Button>
        )}
      </div>
      {depth === 1 && node.children.length === 0 && <p className="text-xs text-muted-foreground">No filters: every record in the data source is included.</p>}
      {depth === 1 && full && <p className="text-xs text-muted-foreground">Filters are limited to {LIMITS.nodes} conditions and groups.</p>}
    </div>
  );
}

function ConditionChip({ node, ctx, onChange, onRemove }: { node: ConditionNode; ctx: Ctx; onChange: (n: ConditionNode) => void; onRemove: () => void }) {
  const field = ctx.fields.get(node.field);
  const problem = conditionProblem(node, field);
  const [open, setOpen] = useState(false);
  // Open a just-added condition once the field picker has closed.
  useEffect(() => {
    if (!fresh.has(node)) return;
    const id = requestAnimationFrame(() => {
      fresh.delete(node);
      setOpen(true);
    });
    return () => cancelAnimationFrame(id);
  }, [node]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <span
        className={cn(
          "inline-flex h-7 max-w-full items-center rounded-full border bg-secondary pl-2.5 text-xs",
          problem && "border-destructive/60 bg-destructive/10",
        )}
      >
        <PopoverTrigger asChild>
          <button type="button" className="flex min-w-0 items-center gap-1 truncate" title={problem ?? undefined}>
            {problem && <AlertCircle className="size-3 shrink-0 text-destructive" />}
            <span className="truncate">{describeCondition(node, field, valueLabels)}</span>
          </button>
        </PopoverTrigger>
        <button type="button" className="ml-1 rounded-full p-1 hover:bg-accent" aria-label="Remove filter" onClick={onRemove}>
          <X className="size-3" />
        </button>
      </span>
      <PopoverContent className="w-80" align="start">
        {field ? (
          <ConditionForm node={node} field={field} ctx={ctx} onChange={onChange} />
        ) : (
          <p className="text-sm text-muted-foreground">{problem}</p>
        )}
        {field && problem && <p className="mt-2 text-xs text-destructive">{problem}</p>}
      </PopoverContent>
    </Popover>
  );
}

function ConditionForm({ node, field, ctx, onChange }: { node: ConditionNode; field: FieldDef; ctx: Ctx; onChange: (n: ConditionNode) => void }) {
  const kind = valueKind(field.type, node.op);
  const v = node.value as never;
  const set = (value: unknown) => onChange({ ...node, value });

  return (
    <div className="grid gap-3">
      <div className="text-sm font-medium">{field.label}</div>
      <Select
        value={node.op}
        onValueChange={(op) => {
          const keep = valueKind(field.type, op) === kind;
          onChange({ ...node, op, value: keep ? node.value : defaultValue(field.type, op) });
        }}
      >
        <SelectTrigger aria-label="Operator">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {field.operators.map((op) => (
            <SelectItem key={op} value={op}>
              {OPERATOR_LABELS[op] ?? op}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {kind === "text" && <Input autoFocus value={(v as string) ?? ""} onChange={(e) => set(e.target.value)} placeholder="Value" />}
      {kind === "number" && <NumberInput value={(v as number) ?? 0} onCommit={set} aria-label="Value" />}
      {kind === "date" && <Input type="date" value={(v as string) ?? ""} onChange={(e) => set(e.target.value)} aria-label="Date" />}
      {kind === "list" && (
        <ValueList dataset={ctx.dataset} entity={ctx.entity} field={field} version={ctx.version} value={(v as string[]) ?? []} onChange={set} />
      )}
      {kind === "relative" && (
        <div className="flex items-center gap-2">
          <NumberInput
            className="w-24"
            min={1}
            max={3650}
            step={1}
            value={(v as { amount: number })?.amount ?? 30}
            onCommit={(amount) => set({ ...(v as object), amount: Math.round(amount) })}
            aria-label="Amount"
          />
          <Select value={(v as { unit: string })?.unit ?? "day"} onValueChange={(unit) => set({ ...(v as object), unit })}>
            <SelectTrigger aria-label="Unit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="day">days</SelectItem>
              <SelectItem value="week">weeks</SelectItem>
              <SelectItem value="month">months</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      {kind === "relative" && (
        <p className="text-xs text-muted-foreground">Includes the current day, week (from Monday) or month, in the report's time zone.</p>
      )}
      {kind === "dateRange" && (
        <div className="grid grid-cols-2 gap-2">
          <Input
            type="date"
            aria-label="From"
            value={(v as { from: string | null })?.from ?? ""}
            onChange={(e) => set({ ...(v as object), from: e.target.value || null })}
          />
          <Input
            type="date"
            aria-label="To"
            value={(v as { to: string | null })?.to ?? ""}
            onChange={(e) => set({ ...(v as object), to: e.target.value || null })}
          />
        </div>
      )}
      {kind === "numberRange" && (
        <div className="grid grid-cols-2 gap-2">
          <Input
            type="number"
            placeholder="Min"
            value={(v as { min: number | null })?.min ?? ""}
            onChange={(e) => set({ ...(v as object), min: e.target.value === "" ? null : Number(e.target.value) })}
          />
          <Input
            type="number"
            placeholder="Max"
            value={(v as { max: number | null })?.max ?? ""}
            onChange={(e) => set({ ...(v as object), max: e.target.value === "" ? null : Number(e.target.value) })}
          />
        </div>
      )}
    </div>
  );
}

/** First incomplete condition in the tree, so Run can explain what to fix. */
export function filterProblem(node: FilterNode, fields: Map<string, FieldDef>): string | null {
  if (node.kind === "condition") return conditionProblem(node, fields.get(node.field));
  for (const c of node.children) {
    const p = filterProblem(c, fields);
    if (p) return p;
  }
  return null;
}
