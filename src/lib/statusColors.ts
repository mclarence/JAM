export const COLOR_KEYS = [
  "green",
  "emerald",
  "yellow",
  "amber",
  "orange",
  "red",
  "rose",
  "blue",
  "sky",
  "indigo",
  "violet",
  "purple",
  "pink",
  "gray",
] as const;

export type ColorKey = (typeof COLOR_KEYS)[number];

// Literal class strings so Tailwind can detect them.
export const BADGE_CLASSES: Record<ColorKey, string> = {
  green: "border-green-500/30 bg-green-500/15 text-green-700 dark:text-green-300",
  emerald: "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  yellow: "border-yellow-500/40 bg-yellow-400/20 text-yellow-800 dark:text-yellow-300",
  amber: "border-amber-500/40 bg-amber-400/20 text-amber-800 dark:text-amber-300",
  orange: "border-orange-500/30 bg-orange-500/15 text-orange-700 dark:text-orange-300",
  red: "border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-300",
  rose: "border-rose-500/30 bg-rose-500/15 text-rose-700 dark:text-rose-300",
  blue: "border-blue-500/30 bg-blue-500/15 text-blue-700 dark:text-blue-300",
  sky: "border-sky-500/30 bg-sky-500/15 text-sky-700 dark:text-sky-300",
  indigo: "border-indigo-500/30 bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  violet: "border-violet-500/30 bg-violet-500/15 text-violet-700 dark:text-violet-300",
  purple: "border-purple-500/30 bg-purple-500/15 text-purple-700 dark:text-purple-300",
  pink: "border-pink-500/30 bg-pink-500/15 text-pink-700 dark:text-pink-300",
  gray: "border-zinc-500/30 bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
};

export const SWATCH_CLASSES: Record<ColorKey, string> = {
  green: "bg-green-500",
  emerald: "bg-emerald-500",
  yellow: "bg-yellow-400",
  amber: "bg-amber-500",
  orange: "bg-orange-500",
  red: "bg-red-500",
  rose: "bg-rose-500",
  blue: "bg-blue-500",
  sky: "bg-sky-500",
  indigo: "bg-indigo-500",
  violet: "bg-violet-500",
  purple: "bg-purple-500",
  pink: "bg-pink-500",
  gray: "bg-zinc-500",
};

export const DEFAULT_STATUS_COLORS: Record<string, ColorKey> = {
  active: "green",
  "in use": "green",
  "in repair": "yellow",
  maintenance: "yellow",
  "in maintenance": "yellow",
  decommissioned: "red",
  retired: "red",
  "in stock": "gray",
};

export function categoryColor(category?: number): ColorKey {
  if (category === 1) return "green";
  if (category === 2) return "yellow";
  if (category === 0) return "red";
  return "gray";
}

export function resolveStatusColor(
  name: string,
  category: number | undefined,
  overrides: Record<string, ColorKey>,
): ColorKey {
  return overrides[name.trim().toLowerCase()] ?? categoryColor(category);
}
