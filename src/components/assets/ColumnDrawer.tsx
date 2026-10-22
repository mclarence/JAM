import { Columns3, RotateCcw } from "lucide-react";
import type { ObjectTypeAttribute } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/dialog";
import { Checkbox, Label } from "@/components/ui/primitives";

export function ColumnDrawer({
  attributes,
  hidden,
  onChange,
  onReset,
}: {
  attributes: ObjectTypeAttribute[];
  hidden: Set<string>;
  onChange: (hidden: Set<string>) => void;
  onReset: () => void;
}) {
  const toggle = (id: string, visible: boolean) => {
    const next = new Set(hidden);
    if (visible) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <Columns3 /> Columns
        </Button>
      </SheetTrigger>
      <SheetContent className="w-80 p-6">
        <div>
          <SheetTitle>Columns</SheetTitle>
          <SheetDescription>Choose which attributes appear in the grid.</SheetDescription>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => onChange(new Set())}>
            Show all
          </Button>
          <Button variant="outline" size="sm" onClick={() => onChange(new Set(attributes.filter((a) => !a.label).map((a) => a.id)))}>
            Hide all
          </Button>
          <Button variant="ghost" size="sm" onClick={onReset}>
            <RotateCcw /> Reset
          </Button>
        </div>
        <div className="-mx-2 flex-1 overflow-auto">
          {attributes.map((a) => (
            <Label
              key={a.id}
              className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 font-normal hover:bg-accent"
            >
              <Checkbox checked={!hidden.has(a.id)} onCheckedChange={(v) => toggle(a.id, !!v)} />
              <span className="truncate">{a.name}</span>
              {a.system && <span className="ml-auto text-xs text-muted-foreground">system</span>}
            </Label>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
