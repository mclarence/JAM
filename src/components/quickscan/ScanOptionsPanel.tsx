import { useState } from "react";
import { PanelLeftClose, Plus, Save, Trash2 } from "lucide-react";
import type { ObjectTypeAttribute, StatusType } from "@/api/types";
import { ScanActionRow } from "@/components/quickscan/ScanActionRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { Card, Checkbox, Label } from "@/components/ui/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SEARCH_KEY } from "@/lib/aql";
import type { ScanAction, ScanConfig, ScanPreset } from "@/store/quickScan";

interface Props {
  config: ScanConfig;
  presets: ScanPreset[];
  activePreset?: ScanPreset;
  modified: boolean;
  lookupOptions: ObjectTypeAttribute[];
  actionOptions: ObjectTypeAttribute[];
  statuses: StatusType[];
  incomplete: boolean;
  onConfigChange: (patch: Partial<ScanConfig>) => void;
  onUpdateAction: (id: string, patch: Partial<ScanAction>) => void;
  onAddAction: () => void;
  onLoadPreset: (id: string) => void;
  onSavePreset: (name: string) => void;
  onUpdatePreset: (id: string) => void;
  onDeletePreset: (id: string) => void;
  onClose: () => void;
}

export function ScanOptionsPanel({
  config,
  presets,
  activePreset,
  modified,
  lookupOptions,
  actionOptions,
  statuses,
  incomplete,
  onConfigChange,
  onUpdateAction,
  onAddAction,
  onLoadPreset,
  onSavePreset,
  onUpdatePreset,
  onDeletePreset,
  onClose,
}: Props) {
  const [saveOpen, setSaveOpen] = useState(false);
  const [presetName, setPresetName] = useState("");

  const save = () => {
    if (!presetName.trim()) return;
    onSavePreset(presetName.trim());
    setSaveOpen(false);
  };

  return (
    <Card className="flex max-h-[28rem] min-h-0 flex-col overflow-hidden lg:max-h-none">
      <div className="flex items-center justify-between border-b py-2 pl-4 pr-2">
        <h2 className="font-medium">Scan options</h2>
        <Button variant="ghost" size="icon" aria-label="Hide options" onClick={onClose}>
          <PanelLeftClose />
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto p-4">
        <section className="grid gap-2">
          <Label>Preset</Label>
          <Select value={activePreset?.id} onValueChange={onLoadPreset} disabled={presets.length === 0}>
            <SelectTrigger className="h-9 w-full">
              <SelectValue placeholder={presets.length ? "Load a preset…" : "No presets saved"} />
            </SelectTrigger>
            <SelectContent>
              {presets.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex flex-wrap items-center gap-2">
            {activePreset && modified && (
              <Button variant="outline" size="sm" onClick={() => onUpdatePreset(activePreset.id)}>
                <Save /> Update
              </Button>
            )}
            <Popover
              open={saveOpen}
              onOpenChange={(open) => {
                setSaveOpen(open);
                if (open) setPresetName("");
              }}
            >
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" disabled={config.actions.length === 0}>
                  <Plus /> Save as new
                </Button>
              </PopoverTrigger>
              <PopoverContent className="grid w-72 gap-2">
                <Label htmlFor="preset-name">Preset name</Label>
                <Input
                  id="preset-name"
                  autoFocus
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && save()}
                  placeholder="e.g. Return to stock"
                />
                <Button size="sm" disabled={!presetName.trim()} onClick={save}>
                  Save
                </Button>
              </PopoverContent>
            </Popover>
            {activePreset && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete preset ${activePreset.name}`}
                onClick={() => onDeletePreset(activePreset.id)}
              >
                <Trash2 />
              </Button>
            )}
          </div>
        </section>

        <section className="grid gap-2">
          <Label>Match the scanned value against any of</Label>
          {[{ id: SEARCH_KEY, name: "Key" }, ...lookupOptions].map((o) => {
            const checked = config.lookups.includes(o.id);
            return (
              <label key={o.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={checked}
                  // At least one field must stay selected.
                  disabled={checked && config.lookups.length === 1}
                  onCheckedChange={(on) =>
                    onConfigChange({ lookups: on ? [...config.lookups, o.id] : config.lookups.filter((l) => l !== o.id) })
                  }
                />
                {o.name}
              </label>
            );
          })}
        </section>

        <section className="grid gap-2">
          <Label>Fields to update on each scan</Label>
          {config.actions.map((a) => (
            <ScanActionRow
              key={a.id}
              stacked
              action={a}
              attrs={actionOptions}
              statuses={statuses}
              onChange={(patch) => onUpdateAction(a.id, patch)}
              onRemove={() => onConfigChange({ actions: config.actions.filter((x) => x.id !== a.id) })}
            />
          ))}
          <div>
            <Button variant="outline" size="sm" onClick={onAddAction} disabled={actionOptions.length === 0}>
              <Plus /> Add field
            </Button>
          </div>
          {incomplete && (
            <p className="text-xs text-amber-600">Choose a value for every "Set to" field before scanning.</p>
          )}
        </section>
      </div>
    </Card>
  );
}
