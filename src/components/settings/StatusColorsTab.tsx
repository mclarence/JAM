import { useState } from "react";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { useStatusTypes } from "@/api/queries";
import { StatusBadge } from "@/components/assets/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { COLOR_KEYS, SWATCH_CLASSES, categoryColor, type ColorKey } from "@/lib/statusColors";
import { cn } from "@/lib/utils";
import { useSettings } from "@/store/settings";

const AUTO = "__auto";

function ColorSelect({ value, onChange, autoLabel }: { value: ColorKey | null; onChange: (c: ColorKey | null) => void; autoLabel?: string }) {
  return (
    <Select value={value ?? AUTO} onValueChange={(v) => onChange(v === AUTO ? null : (v as ColorKey))}>
      <SelectTrigger className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {autoLabel && <SelectItem value={AUTO}>{autoLabel}</SelectItem>}
        {COLOR_KEYS.map((c) => (
          <SelectItem key={c} value={c}>
            <span className="flex items-center gap-2 capitalize">
              <span className={cn("size-3 rounded-full", SWATCH_CLASSES[c])} />
              {c}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function StatusColorsTab() {
  const { schemaId, statusColors, setStatusColor, resetStatusColors } = useSettings();
  const statuses = useStatusTypes(schemaId);
  const [custom, setCustom] = useState("");

  const known = new Set((statuses.data ?? []).map((s) => s.name.toLowerCase()));
  const customEntries = Object.entries(statusColors).filter(([name]) => !known.has(name));

  return (
    <div className="grid max-w-3xl gap-6">
      <p className="text-sm text-muted-foreground">
        Statuses default to their JIRA category colour (Active = green, Pending = yellow, Inactive = red). Override any
        status by name below.
      </p>

      <div className="divide-y rounded-lg border">
        {(statuses.data ?? []).map((s) => {
          const override = statusColors[s.name.toLowerCase()] ?? null;
          return (
            <div key={s.id} className="flex items-center gap-4 px-4 py-2">
              <div className="w-56">
                <StatusBadge name={s.name} category={s.category} />
              </div>
              <span className="flex-1 text-xs text-muted-foreground">
                {s.objectSchemaId ? "Schema status" : "Global status"}
              </span>
              <ColorSelect
                value={override}
                onChange={(c) => setStatusColor(s.name, c)}
                autoLabel={`Auto (${categoryColor(s.category)})`}
              />
            </div>
          );
        })}
        {statuses.data?.length === 0 && <p className="p-4 text-sm text-muted-foreground">No statuses found.</p>}
      </div>

      <div className="grid gap-3">
        <h3 className="text-sm font-medium">Custom mappings</h3>
        {customEntries.map(([name, color]) => (
          <div key={name} className="flex items-center gap-4">
            <div className="w-56">
              <StatusBadge name={name} color={color} />
            </div>
            <div className="flex-1" />
            <ColorSelect value={color} onChange={(c) => c && setStatusColor(name, c)} />
            <Button variant="ghost" size="icon" aria-label="Remove mapping" onClick={() => setStatusColor(name, null)}>
              <Trash2 />
            </Button>
          </div>
        ))}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!custom.trim()) return;
            setStatusColor(custom, "blue");
            setCustom("");
          }}
        >
          <Input placeholder="Status name, e.g. On Loan" value={custom} onChange={(e) => setCustom(e.target.value)} className="max-w-xs" />
          <Button type="submit" variant="outline">
            <Plus /> Add mapping
          </Button>
        </form>
      </div>

      <div>
        <Button variant="outline" onClick={resetStatusColors}>
          <RotateCcw /> Reset to defaults
        </Button>
      </div>
    </div>
  );
}
