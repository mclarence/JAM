import { Check, Minus } from "lucide-react";
import { AttrType, DefaultType, type ObjectAttributeValue, type ObjectTypeAttribute } from "@/api/types";
import { displayValue } from "@/lib/attributes";
import { StatusBadge } from "./StatusBadge";

export function AttributeValue({ attr, values }: { attr: ObjectTypeAttribute; values: ObjectAttributeValue[] }) {
  if (values.length === 0) return <span className="text-muted-foreground/60">—</span>;

  if (attr.type === AttrType.Status) {
    return (
      <span className="flex flex-wrap gap-1">
        {values.map((v, i) => (
          <StatusBadge key={i} name={v.status?.name ?? displayValue(v)} category={v.status?.category} />
        ))}
      </span>
    );
  }

  if (attr.type === AttrType.ObjectReference) {
    return (
      <span className="flex min-w-0 flex-wrap gap-1">
        {values.map((v, i) => (
          <span key={i} className="truncate rounded border bg-muted/50 px-1.5 py-0.5 text-xs" title={v.referencedObject?.objectKey}>
            {displayValue(v)}
          </span>
        ))}
      </span>
    );
  }

  if (attr.type === AttrType.Default && attr.defaultType?.id === DefaultType.Boolean) {
    return values[0].value === "true" ? (
      <Check className="size-4 text-green-600 dark:text-green-400" />
    ) : (
      <Minus className="size-4 text-muted-foreground" />
    );
  }

  return <span className="truncate">{values.map(displayValue).join(", ")}</span>;
}
