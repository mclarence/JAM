import { useAttributes, useConnection } from "@/api/queries";
import { AttrType } from "@/api/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { sortAttributes } from "@/lib/attributes";
import { useSettings } from "@/store/settings";

const KEY = "__key";

function ReferenceRow({ typeId, name }: { typeId: string; name: string }) {
  const attrs = useAttributes(typeId);
  const value = useSettings((s) => s.referenceDisplay[typeId]);
  const setReferenceDisplay = useSettings((s) => s.setReferenceDisplay);
  const options = sortAttributes(attrs.data ?? []).filter((a) => !a.hidden && a.type !== AttrType.ObjectReference);

  return (
    <div className="flex items-center gap-4 px-4 py-2">
      <span className="flex-1 truncate text-sm">{name}</span>
      <Select value={value ?? KEY} onValueChange={(v) => setReferenceDisplay(typeId, v === KEY ? null : v)}>
        <SelectTrigger className="w-64">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={KEY}>Object key (default)</SelectItem>
          {options.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function ReferenceDisplayTab() {
  const connection = useConnection();
  const objectTypeId = useSettings((s) => s.objectTypeId);
  const attrs = useAttributes(objectTypeId);

  if (!connection.data) {
    return <p className="text-sm text-muted-foreground">Connect to JIRA Assets first (Connection tab).</p>;
  }
  if (!objectTypeId) {
    return <p className="text-sm text-muted-foreground">Select a primary object type first (Schema tab).</p>;
  }

  const types = new Map<string, string>();
  for (const a of attrs.data ?? []) {
    if (a.type === AttrType.ObjectReference && a.referenceObjectTypeId) {
      types.set(a.referenceObjectTypeId, a.referenceObjectType?.name ?? a.name);
    }
  }

  return (
    <div className="grid max-w-3xl gap-6">
      <p className="text-sm text-muted-foreground">
        Choose which attribute is shown next to the name when picking a referenced object, such as an employee&apos;s
        email instead of their key. Searching always matches the key and all text attributes.
      </p>
      <div className="divide-y rounded-lg border">
        {[...types].map(([id, name]) => (
          <ReferenceRow key={id} typeId={id} name={name} />
        ))}
        {types.size === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            {attrs.isLoading ? "Loading…" : "The primary object type has no reference attributes."}
          </p>
        )}
      </div>
    </div>
  );
}
