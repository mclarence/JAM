import { useMemo } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label, Switch } from "@/components/ui/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/overlays";
import { BUCKET_LABELS, ENTITY_LABELS, MEASURE_LABELS, newSpec, type SavedSpec } from "@/lib/reports/model";
import type { Bucket, Dataset, Entity, FieldDef, GroupNode, Measure, MeasureFn } from "@/lib/reports/types";
import { LIMITS } from "@/lib/reports/types";
import { FieldPicker } from "./FieldPicker";
import { FilterEditor } from "./FilterEditor";

const isTime = (f?: FieldDef) => f?.type === "date" || f?.type === "datetime";

let timeZones: string[] | null = null;
function allTimeZones() {
  if (!timeZones) {
    try {
      timeZones = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
    } catch {
      timeZones = ["UTC"];
    }
  }
  return timeZones;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2 border-b p-4 last:border-b-0">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

export function Builder({
  spec,
  onChange,
  dataset,
  fields,
  version,
}: {
  spec: SavedSpec;
  onChange: (fn: (s: SavedSpec) => SavedSpec) => void;
  dataset: Dataset;
  fields: FieldDef[];
  version: number;
}) {
  const byId = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields]);
  const groupBy = spec.groupBy ?? [];
  const measures = spec.measures ?? [];
  const columns = spec.columns ?? [];

  const setEntity = (entity: Entity) =>
    onChange((s) => ({ ...newSpec(entity), timezone: s.timezone, mode: s.mode, includeUnavailable: s.includeUnavailable, includeSoftDeleted: s.includeSoftDeleted }));

  return (
    <div className="flex flex-col">
      <Section title="Data">
        <Select value={spec.entity} onValueChange={(v) => setEntity(v as Entity)}>
          <SelectTrigger aria-label="Records">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(ENTITY_LABELS) as Entity[]).map((e) => (
              <SelectItem key={e} value={e}>
                {ENTITY_LABELS[e]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {spec.entity === "events"
            ? "One record per attribute change. Use historical attributes (added/new/previous/removed) for values recorded in that change; current attributes show today's values. For borrowing counts, group by the historical attribute (added) and filter it to not empty."
            : "One record per asset, with its current attribute values."}
        </p>
        <Tabs value={spec.mode} onValueChange={(m) => onChange((s) => ({ ...s, mode: m as SavedSpec["mode"], sort: undefined }))}>
          <TabsList className="w-full">
            <TabsTrigger value="aggregate" className="flex-1">Summary</TabsTrigger>
            <TabsTrigger value="detail" className="flex-1">Detail rows</TabsTrigger>
          </TabsList>
        </Tabs>
      </Section>

      <Section title="Filters">
        <FilterEditor
          value={spec.filter as GroupNode}
          onChange={(filter) => onChange((s) => ({ ...s, filter }))}
          dataset={dataset}
          entity={spec.entity}
          fields={byId}
          version={version}
        />
      </Section>

      {spec.mode === "aggregate" ? (
        <>
          <Section title="Group by" hint={groupBy.length === 0 ? "No grouping: one row of totals." : undefined}>
            {groupBy.map((g, i) => {
              const f = byId.get(g.field);
              return (
                <div key={i} className="flex items-center gap-2">
                  <FieldPicker
                    fields={fields}
                    selected={g.field}
                    onPick={(nf) =>
                      onChange((s) => {
                        const list = [...(s.groupBy ?? [])];
                        list[i] = { field: nf.id, ...(isTime(nf) ? { bucket: g.bucket ?? "month" } : {}) };
                        return { ...s, groupBy: list, sort: undefined };
                      })
                    }
                  >
                    <Button variant="outline" size="sm" className="min-w-0 flex-1 justify-start truncate">
                      {f?.label ?? <span className="text-destructive">Missing field</span>}
                    </Button>
                  </FieldPicker>
                  {isTime(f) && (
                    <Select
                      value={g.bucket ?? "month"}
                      onValueChange={(b) =>
                        onChange((s) => ({ ...s, groupBy: (s.groupBy ?? []).map((x, j) => (j === i ? { ...x, bucket: b as Bucket } : x)) }))
                      }
                    >
                      <SelectTrigger className="h-8 w-32" aria-label="Interval">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(BUCKET_LABELS) as Bucket[]).map((b) => (
                          <SelectItem key={b} value={b}>
                            {BUCKET_LABELS[b]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Button
                    size="iconSm"
                    variant="ghost"
                    aria-label="Remove grouping"
                    onClick={() => onChange((s) => ({ ...s, groupBy: (s.groupBy ?? []).filter((_, j) => j !== i), sort: undefined }))}
                  >
                    <X />
                  </Button>
                </div>
              );
            })}
            {groupBy.length < LIMITS.groupBy && (
              <FieldPicker
                fields={fields}
                onPick={(f) => onChange((s) => ({ ...s, groupBy: [...(s.groupBy ?? []), { field: f.id, ...(isTime(f) ? { bucket: "month" as Bucket } : {}) }], sort: undefined }))}
              >
                <Button size="sm" variant="outline" className="w-fit border-dashed">
                  <Plus /> Grouping
                </Button>
              </FieldPicker>
            )}
          </Section>

          <Section title="Measures">
            {measures.map((m, i) => (
              <MeasureRow
                key={m.id}
                measure={m}
                fields={fields}
                byId={byId}
                canRemove={measures.length > 1}
                onChange={(nm) => onChange((s) => ({ ...s, measures: (s.measures ?? []).map((x, j) => (j === i ? nm : x)) }))}
                onRemove={() => onChange((s) => ({ ...s, measures: (s.measures ?? []).filter((_, j) => j !== i), sort: undefined }))}
              />
            ))}
            {measures.length < LIMITS.measures && (
              <Button
                size="sm"
                variant="outline"
                className="w-fit border-dashed"
                onClick={() =>
                  onChange((s) => {
                    const ids = new Set((s.measures ?? []).map((m) => m.id));
                    let n = ids.size + 1;
                    while (ids.has(`m${n}`)) n++;
                    return { ...s, measures: [...(s.measures ?? []), { id: `m${n}`, fn: "count" }] };
                  })
                }
              >
                <Plus /> Measure
              </Button>
            )}
          </Section>
        </>
      ) : (
        <Section title="Columns" hint={columns.length === 0 ? "Using the default columns. Add columns to choose your own." : undefined}>
          {columns.map((id, i) => (
            <div key={id} className="flex items-center gap-1 text-sm">
              <span className={byId.has(id) ? "flex-1 truncate" : "flex-1 truncate text-destructive"}>{byId.get(id)?.label ?? `Missing field (${id})`}</span>
              <Button size="iconSm" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => onChange((s) => ({ ...s, columns: move(s.columns ?? [], i, -1) }))}>
                <ArrowUp />
              </Button>
              <Button
                size="iconSm"
                variant="ghost"
                aria-label="Move down"
                disabled={i === columns.length - 1}
                onClick={() => onChange((s) => ({ ...s, columns: move(s.columns ?? [], i, 1) }))}
              >
                <ArrowDown />
              </Button>
              <Button size="iconSm" variant="ghost" aria-label="Remove column" onClick={() => onChange((s) => ({ ...s, columns: (s.columns ?? []).filter((c) => c !== id), sort: undefined }))}>
                <X />
              </Button>
            </div>
          ))}
          {columns.length < LIMITS.columns && (
            <FieldPicker fields={fields} filter={(f) => !columns.includes(f.id)} onPick={(f) => onChange((s) => ({ ...s, columns: [...(s.columns ?? []), f.id] }))}>
              <Button size="sm" variant="outline" className="w-fit border-dashed">
                <Plus /> Column
              </Button>
            </FieldPicker>
          )}
        </Section>
      )}

      <Section title="Options">
        <div className="grid gap-1">
          <Label htmlFor="report-tz" className="text-xs">Time zone (for date filters and grouping)</Label>
          <Input id="report-tz" list="report-tz-list" value={spec.timezone} onChange={(e) => onChange((s) => ({ ...s, timezone: e.target.value }))} />
          <datalist id="report-tz-list">
            {allTimeZones().map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
        </div>
        <label className="flex items-center justify-between gap-2 text-sm">
          Include assets no longer in Jira or out of scope
          <Switch checked={spec.includeUnavailable ?? true} onCheckedChange={(v) => onChange((s) => ({ ...s, includeUnavailable: v }))} />
        </label>
        <label className="flex items-center justify-between gap-2 text-sm">
          Include soft-deleted assets
          <Switch checked={spec.includeSoftDeleted ?? false} onCheckedChange={(v) => onChange((s) => ({ ...s, includeSoftDeleted: v }))} />
        </label>
      </Section>
    </div>
  );
}

function move<T>(list: T[], i: number, by: number) {
  const next = [...list];
  const [item] = next.splice(i, 1);
  next.splice(i + by, 0, item);
  return next;
}

function MeasureRow({
  measure,
  fields,
  byId,
  canRemove,
  onChange,
  onRemove,
}: {
  measure: Measure;
  fields: FieldDef[];
  byId: Map<string, FieldDef>;
  canRemove: boolean;
  onChange: (m: Measure) => void;
  onRemove: () => void;
}) {
  const field = measure.field ? byId.get(measure.field) : undefined;
  const setFn = (fn: MeasureFn) => {
    if (fn === "count") return onChange({ id: measure.id, fn, label: measure.label });
    const keep = field?.measures.includes(fn) ? measure.field : undefined;
    onChange({ ...measure, fn, field: keep });
  };
  return (
    <div className="grid gap-1.5 rounded-md border p-2">
      <div className="flex items-center gap-2">
        <Select value={measure.fn} onValueChange={(v) => setFn(v as MeasureFn)}>
          <SelectTrigger className="h-8 flex-1" aria-label="Measure">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(MEASURE_LABELS) as MeasureFn[]).map((fn) => (
              <SelectItem key={fn} value={fn}>
                {MEASURE_LABELS[fn]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {canRemove && (
          <Button size="iconSm" variant="ghost" aria-label="Remove measure" onClick={onRemove}>
            <X />
          </Button>
        )}
      </div>
      {measure.fn !== "count" && (
        <FieldPicker fields={fields} filter={(f) => f.measures.includes(measure.fn)} selected={measure.field} onPick={(f) => onChange({ ...measure, field: f.id })}>
          <Button variant="outline" size="sm" className="justify-start truncate">
            {field?.label ?? <span className="text-muted-foreground">{measure.field ? "Missing field" : "Choose a field…"}</span>}
          </Button>
        </FieldPicker>
      )}
      <Input
        className="h-8"
        placeholder="Label (optional)"
        maxLength={100}
        value={measure.label ?? ""}
        onChange={(e) => onChange({ ...measure, label: e.target.value || undefined })}
      />
    </div>
  );
}

/** Problems that would make the engine reject the spec, phrased for the builder. */
export function specProblem(spec: SavedSpec, fields: Map<string, FieldDef>): string | null {
  if (!spec.timezone.trim()) return "Choose a time zone.";
  if (spec.mode === "aggregate") {
    for (const g of spec.groupBy ?? []) {
      if (!fields.has(g.field)) return "A grouping uses a field that is not in this data source.";
    }
    for (const m of spec.measures ?? []) {
      if (m.fn !== "count" && !m.field) return `Choose a field for "${MEASURE_LABELS[m.fn]}".`;
      if (m.field && !fields.get(m.field)?.measures.includes(m.fn)) return `"${fields.get(m.field)?.label ?? m.field}" cannot be used for "${MEASURE_LABELS[m.fn]}".`;
    }
  } else {
    for (const c of spec.columns ?? []) if (!fields.has(c)) return "A column uses a field that is not in this data source.";
  }
  return null;
}
