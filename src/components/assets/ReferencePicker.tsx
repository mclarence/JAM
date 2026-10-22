import { useState } from "react";
import { Loader2, X } from "lucide-react";
import { useReferenceSearch } from "@/api/queries";
import type { ObjectTypeAttribute } from "@/api/types";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useDebounce } from "@/hooks/useDebounce";

export interface PickedReference {
  id: string;
  objectKey: string;
  label: string;
}

/** Debounced, server-side search of objects of the attribute's referenced type. */
export function ReferencePicker({
  attr,
  onPick,
  onClear,
}: {
  attr: ObjectTypeAttribute;
  onPick: (ref: PickedReference) => void;
  onClear?: () => void;
}) {
  const [term, setTerm] = useState("");
  const debounced = useDebounce(term, 300);
  const results = useReferenceSearch(attr.referenceObjectTypeId, debounced);

  return (
    <Command shouldFilter={false} className="w-80">
      <CommandInput
        autoFocus
        value={term}
        onValueChange={setTerm}
        placeholder={`Search ${attr.referenceObjectType?.name ?? attr.name}…`}
      />
      <CommandList>
        {results.isFetching && (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Searching…
          </div>
        )}
        {!results.isFetching && <CommandEmpty>No matches.</CommandEmpty>}
        {onClear && (
          <CommandGroup>
            <CommandItem value="__clear" onSelect={onClear}>
              <X className="size-4" /> Clear value
            </CommandItem>
          </CommandGroup>
        )}
        <CommandGroup heading="Objects">
          {results.data?.map((o) => (
            <CommandItem
              key={o.id}
              value={o.id}
              onSelect={() => onPick({ id: o.id, objectKey: o.objectKey, label: o.label })}
            >
              <span className="truncate">{o.label}</span>
              <span className="ml-auto text-xs text-muted-foreground">{o.objectKey}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
