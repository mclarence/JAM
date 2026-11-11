import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { assetsApi } from "@/api/assets";
import { useConnection, useObjectTypes, useSchemas } from "@/api/queries";
import { qk } from "@/api/queryKeys";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Checkbox, Label } from "@/components/ui/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { newId, type ReportSource } from "@/lib/reports/model";
import { LIMITS } from "@/lib/reports/types";
import { useReports } from "@/store/reports";

export function SourceDialog({ source, onClose, onSaved }: { source: ReportSource | null; onClose: () => void; onSaved?: (s: ReportSource) => void }) {
  const connection = useConnection().data ?? null;
  const saveSource = useReports((s) => s.saveSource);
  const schemas = useSchemas();
  const [schemaId, setSchemaId] = useState<string | null>(null);
  const types = useObjectTypes(schemaId ?? schemas.data?.[0]?.id ?? null);
  const [name, setName] = useState(source?.name ?? "");
  const [typeIds, setTypeIds] = useState<string[]>(source?.objectTypeIds ?? []);
  const [typeNames, setTypeNames] = useState<Record<string, string>>({});
  const [scopeAql, setScopeAql] = useState(source?.scopeAql ?? "");
  const [aliases, setAliases] = useState<[string, string][]>(
    Object.entries(source?.attributeAliases ?? {}).map(([id, names]) => [id, names.join(", ")]),
  );

  const attrQueries = useQueries({
    queries: typeIds.map((id) => ({ queryKey: qk.attributes(id), queryFn: () => assetsApi.getObjectTypeAttributes(id), staleTime: 5 * 60_000 })),
  });
  const attributes = useMemo(() => {
    const map = new Map<string, string>();
    for (const q of attrQueries) for (const a of q.data ?? []) if (!map.has(a.id)) map.set(a.id, a.name);
    return [...map].sort((a, b) => a[1].localeCompare(b[1]));
  }, [attrQueries]);

  const aqlProblem = scopeAql.length > LIMITS.scopeAql ? `Keep the scope under ${LIMITS.scopeAql} characters.` : /\border\s+by\b/i.test(scopeAql) ? "Remove ORDER BY from the scope." : null;
  const problem = !connection
    ? "Connect to Jira first."
    : !name.trim()
      ? "Enter a name."
      : typeIds.length === 0
        ? "Choose at least one object type."
        : aqlProblem;

  const toggle = (id: string, label: string, on: boolean) => {
    setTypeNames((n) => ({ ...n, [id]: label }));
    setTypeIds((ids) => (on ? (ids.length < LIMITS.types && !ids.includes(id) ? [...ids, id] : ids) : ids.filter((x) => x !== id)));
  };

  const submit = () => {
    if (problem || !connection) return;
    const attributeAliases: Record<string, string[]> = {};
    for (const [id, text] of aliases) {
      const names = text.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20);
      if (/^\d{1,18}$/.test(id) && names.length) attributeAliases[id] = names;
    }
    const saved: ReportSource = {
      id: source?.id ?? newId(),
      name: name.trim().slice(0, 200),
      cloudId: source?.cloudId ?? connection.cloudId,
      workspaceId: source?.workspaceId ?? connection.workspaceId,
      objectTypeIds: typeIds,
      scopeAql: scopeAql.trim(),
      attributeAliases,
      updatedAt: Date.now(),
    };
    saveSource(saved);
    onSaved?.(saved);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-auto">
        <DialogHeader>
          <DialogTitle>{source ? "Edit data source" : "New data source"}</DialogTitle>
          <DialogDescription>
            Choose which assets reports can use. Their inventory and change history are copied to a local database on this computer when you refresh.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="src-name">Name</Label>
            <Input id="src-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="e.g. Student laptops" />
          </div>

          <div className="grid gap-1.5">
            <Label>Object types ({typeIds.length}/{LIMITS.types})</Label>
            <Select value={schemaId ?? schemas.data?.[0]?.id ?? ""} onValueChange={setSchemaId}>
              <SelectTrigger aria-label="Schema">
                <SelectValue placeholder={schemas.isLoading ? "Loading schemas…" : "Choose a schema"} />
              </SelectTrigger>
              <SelectContent>
                {(schemas.data ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="max-h-48 overflow-auto rounded-md border p-2">
              {types.isLoading && <p className="text-sm text-muted-foreground">Loading object types…</p>}
              {types.isError && <p className="text-sm text-destructive">{types.error.message}</p>}
              {(types.data ?? []).filter((t) => !t.abstractObjectType).map((t) => (
                <label key={t.id} className="flex items-center gap-2 py-1 text-sm">
                  <Checkbox
                    checked={typeIds.includes(t.id)}
                    disabled={!typeIds.includes(t.id) && typeIds.length >= LIMITS.types}
                    onCheckedChange={(v) => toggle(t.id, t.name, v === true)}
                  />
                  <span className="flex-1">{t.name}</span>
                  {t.objectCount !== undefined && <span className="text-xs tabular-nums text-muted-foreground">{t.objectCount.toLocaleString()}</span>}
                </label>
              ))}
            </div>
            {typeIds.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Selected: {typeIds.map((id) => typeNames[id] ?? types.data?.find((t) => t.id === id)?.name ?? `type ${id}`).join(", ")}
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="src-aql">Scope (optional AQL)</Label>
            <Textarea
              id="src-aql"
              rows={2}
              value={scopeAql}
              onChange={(e) => setScopeAql(e.target.value)}
              placeholder='e.g. "Location" = "North Campus"'
              className="font-mono text-xs"
            />
            <p className={aqlProblem ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              {aqlProblem ?? "Limits which assets are collected, which reduces Jira requests. Leave empty to collect every asset of the chosen types."}
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label>Earlier attribute names (optional)</Label>
            <p className="text-xs text-muted-foreground">
              History records attribute names as they were at the time. If an attribute was renamed, list its old names so older changes are still matched.
            </p>
            {aliases.map(([id, text], i) => (
              <div key={i} className="flex items-center gap-2">
                <Select value={id} onValueChange={(v) => setAliases((a) => a.map((x, j) => (j === i ? [v, x[1]] : x)))}>
                  <SelectTrigger className="w-48" aria-label="Attribute">
                    <SelectValue placeholder="Attribute" />
                  </SelectTrigger>
                  <SelectContent>
                    {attributes.map(([aid, aname]) => (
                      <SelectItem key={aid} value={aid}>
                        {aname}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input value={text} placeholder="Old name, another old name" onChange={(e) => setAliases((a) => a.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
                <Button size="iconSm" variant="ghost" aria-label="Remove" onClick={() => setAliases((a) => a.filter((_, j) => j !== i))}>
                  <X />
                </Button>
              </div>
            ))}
            <Button size="sm" variant="outline" className="w-fit" disabled={attributes.length === 0} onClick={() => setAliases((a) => [...a, ["", ""]])}>
              <Plus /> Add renamed attribute
            </Button>
          </div>
        </div>
        <DialogFooter>
          {problem && <span className="mr-auto self-center text-xs text-muted-foreground">{problem}</span>}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!!problem}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
