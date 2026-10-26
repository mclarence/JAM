import { useState } from "react";
import { Copy, MoreHorizontal, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { useSettings } from "@/store/settings";
import { useTemplates } from "@/store/templates";

export function TemplateList() {
  const { templates, selectedId, defaultTemplateId, create, duplicate, rename, remove, select, setDefault } = useTemplates();
  const labelDefaults = useSettings((s) => s.labelDefaults);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const commitRename = () => {
    if (renaming && draft.trim()) rename(renaming, draft.trim());
    setRenaming(null);
  };

  return (
    <div className="flex w-44 shrink-0 flex-col border-r xl:w-60">
      <div className="flex items-center justify-between border-b p-3">
        <span className="text-sm font-medium">Templates</span>
        <Button size="sm" variant="outline" onClick={() => create(labelDefaults)}>
          <Plus /> New
        </Button>
      </div>
      <div className="flex-1 overflow-auto p-2">
        {templates.length === 0 && <p className="p-2 text-sm text-muted-foreground">No templates yet.</p>}
        {templates.map((t) => (
          <div
            key={t.id}
            className={cn(
              "group flex items-center gap-1 rounded-md border-l-2 px-2 py-1.5 text-sm",
              selectedId === t.id ? "border-primary bg-accent" : "border-transparent hover:bg-accent/50",
            )}
          >
            {renaming === t.id ? (
              <Input
                autoFocus
                value={draft}
                className="h-7"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => select(t.id)}
                onDoubleClick={() => {
                  setRenaming(t.id);
                  setDraft(t.name);
                }}
              >
                <span className="truncate">{t.name}</span>
                {defaultTemplateId === t.id && <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-500" />}
              </button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="iconSm" className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100" aria-label="Template actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => {
                    setRenaming(t.id);
                    setDraft(t.name);
                  }}
                >
                  <Pencil /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => duplicate(t.id)}>
                  <Copy /> Duplicate
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDefault(t.id)} disabled={defaultTemplateId === t.id}>
                  <Star /> Set as default
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => remove(t.id)}>
                  <Trash2 /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </div>
    </div>
  );
}
