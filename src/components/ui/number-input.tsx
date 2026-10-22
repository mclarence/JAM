import { useEffect, useState } from "react";
import { Input } from "./input";

/** Number input that keeps a text draft while typing and commits valid numbers. */
export function NumberInput({
  value,
  onCommit,
  min,
  max,
  step = "any",
  className,
  ...rest
}: {
  value: number;
  onCommit: (n: number) => void;
  min?: number;
  max?: number;
  step?: number | "any";
  className?: string;
  "aria-label"?: string;
  id?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [value, focused]);

  const commit = (text: string) => {
    let n = Number(text);
    if (text.trim() === "" || Number.isNaN(n)) return;
    if (min !== undefined) n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
    onCommit(n);
  };

  return (
    <Input
      {...rest}
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      className={className}
      value={draft}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit(draft);
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        commit(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}
