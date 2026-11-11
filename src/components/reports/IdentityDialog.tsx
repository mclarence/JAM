import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Undo2, UserSearch } from "lucide-react";
import { reportsApi } from "@/api/reports";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { useDebounce } from "@/hooks/useDebounce";
import type { ReportSource } from "@/lib/reports/model";
import type { Dataset, FieldOption } from "@/lib/reports/types";
import { useReports } from "@/store/reports";
import { normKey, reportKeys, useDataset, useReportStatus } from "./state";

const OBJECT_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/**
 * Change history stores people and assets as display text. Text that matches no collected object is listed here so
 * the user can say which object it means. Suggestions are never applied without confirmation.
 */
export function IdentityDialog({ source, onClose }: { source: ReportSource; onClose: () => void }) {
  const qc = useQueryClient();
  const dataset = useDataset(source)!;
  const status = useReportStatus(dataset);
  const stored = useReports((s) => s.mappings[source.id]);
  const mappings = stored ?? {};
  const setMapping = useReports((s) => s.setMapping);
  const unresolved = useQuery({
    queryKey: reportKeys.unresolved(source.id, status.data?.dataVersion ?? 0, normKey(dataset)),
    queryFn: () => reportsApi.unresolved(dataset),
  });
  const mapped = Object.entries(mappings).flatMap(([attrId, m]) => Object.entries(m).map(([raw, key]) => ({ attrId, raw, key })));

  const apply = (attrId: string, raw: string, key: string | null) => {
    setMapping(source.id, attrId, raw, key);
    void qc.invalidateQueries({ queryKey: reportKeys.all });
  };

  const values = unresolved.data?.values ?? [];
  const attrs = unresolved.data?.attributes ?? [];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-auto">
        <DialogHeader>
          <DialogTitle>Match names in history</DialogTitle>
          <DialogDescription>
            Recorded names are already included in reports without matching. Optionally link a name to a known object to combine its history with keyed references.
            Matches are stored only on this computer.
          </DialogDescription>
        </DialogHeader>

        {unresolved.isLoading && <Loader2 className="size-4 animate-spin" />}
        {unresolved.isError && <p className="text-sm text-destructive">{unresolved.error.message}</p>}
        {unresolved.data && values.length === 0 && <p className="text-sm text-muted-foreground">Every name in the collected history is matched.</p>}

        {values.length > 0 && (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1 font-medium">Attribute</th>
                <th className="py-1 font-medium">Name in history</th>
                <th className="py-1 text-right font-medium">Changes</th>
                <th className="py-1 font-medium" />
              </tr>
            </thead>
            <tbody>
              {values.map((v) => (
                <tr key={`${v.attributeId}|${v.raw}`} className="border-t">
                  <td className="py-1.5 pr-2 text-muted-foreground">{v.attributeName}</td>
                  <td className="py-1.5 pr-2 font-medium">{v.raw}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{v.count.toLocaleString()}</td>
                  <td className="py-1.5 text-right">
                    <div className="flex justify-end gap-1">
                      {v.suggestion && (
                        <Button size="sm" variant="outline" title="Confirm this match" onClick={() => apply(v.attributeId, v.raw, v.suggestion!.value)}>
                          <Check /> {v.suggestion.label} ({v.suggestion.value})
                        </Button>
                      )}
                      <ObjectPicker dataset={dataset} attributeId={v.attributeId} initial={v.raw} onPick={(o) => apply(v.attributeId, v.raw, o.value)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {values.length >= 500 && <p className="text-xs text-muted-foreground">Showing the 500 most frequent names. Match these and more appear.</p>}

        {attrs.length > 0 && (
          <div className="grid gap-1 rounded-md border p-3 text-xs">
            <p className="font-medium">Changes to attributes not found in the data source</p>
            <p className="text-muted-foreground">
              These names match no current attribute, usually because it was renamed or deleted. Add the old name to the data source's "Earlier attribute names".
            </p>
            <p>{attrs.map((a) => `${a.name} (${a.count.toLocaleString()})`).join(", ")}</p>
          </div>
        )}

        {mapped.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Matched names ({mapped.length})</summary>
            <ul className="mt-2 grid gap-1">
              {mapped.map((m) => (
                <li key={`${m.attrId}|${m.raw}`} className="flex items-center gap-2">
                  <span className="flex-1">
                    "{m.raw}" → {m.key}
                  </span>
                  <Button size="iconSm" variant="ghost" aria-label={`Undo match for ${m.raw}`} onClick={() => apply(m.attrId, m.raw, null)}>
                    <Undo2 />
                  </Button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Searches objects known in the local data: this attribute's current values and objects seen in history. */
function ObjectPicker({ dataset, attributeId, initial, onPick }: { dataset: Dataset; attributeId: string; initial: string; onPick: (o: FieldOption) => void }) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState(initial);
  const debounced = useDebounce(term, 250);
  const results = useQuery({
    queryKey: ["reports", "identity", dataset.id, attributeId, debounced],
    enabled: open,
    queryFn: async () => {
      const lists = await Promise.allSettled([
        reportsApi.fieldValues(dataset, "assets", `attr:${attributeId}`, debounced, 30),
        reportsApi.fieldValues(dataset, "events", "event.newObject", debounced, 30),
      ]);
      const seen = new Map<string, FieldOption>();
      for (const l of lists) if (l.status === "fulfilled") for (const v of l.value) if (OBJECT_KEY.test(v.value) && !seen.has(v.value)) seen.set(v.value, { value: v.value, label: v.label });
      return [...seen.values()];
    },
  });
  const typedKey = term.trim().toUpperCase();
  const canUseTyped = OBJECT_KEY.test(typedKey) && !results.data?.some((o) => o.value === typedKey);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost">
          <UserSearch /> Choose…
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <Command shouldFilter={false}>
          <CommandInput autoFocus value={term} onValueChange={setTerm} placeholder="Search by name or key…" />
          <CommandList>
            {results.isFetching && <div className="px-3 py-2 text-xs text-muted-foreground">Searching…</div>}
            {!results.isFetching && !canUseTyped && <CommandEmpty>No matching objects in the collected data. Type an object key, e.g. STU-123.</CommandEmpty>}
            {canUseTyped && (
              <CommandItem
                value={`key:${typedKey}`}
                onSelect={() => {
                  onPick({ value: typedKey, label: typedKey });
                  setOpen(false);
                }}
              >
                Use object key {typedKey}
              </CommandItem>
            )}
            {(results.data ?? []).map((o) => (
              <CommandItem
                key={o.value}
                value={o.value}
                onSelect={() => {
                  onPick(o);
                  setOpen(false);
                }}
              >
                <span className="flex-1 truncate">{o.label}</span>
                <span className="text-xs text-muted-foreground">{o.value}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
