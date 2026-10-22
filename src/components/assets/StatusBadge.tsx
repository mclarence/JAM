import { Badge } from "@/components/ui/badge";
import { BADGE_CLASSES, resolveStatusColor, type ColorKey } from "@/lib/statusColors";
import { cn } from "@/lib/utils";
import { useSettings } from "@/store/settings";

export function StatusBadge({
  name,
  category,
  color,
  className,
}: {
  name: string;
  category?: number;
  color?: ColorKey;
  className?: string;
}) {
  const overrides = useSettings((s) => s.statusColors);
  const key = color ?? resolveStatusColor(name, category, overrides);
  return (
    <Badge variant="outline" className={cn(BADGE_CLASSES[key], className)}>
      <span className="mr-1.5 size-1.5 rounded-full bg-current opacity-80" />
      {name}
    </Badge>
  );
}
