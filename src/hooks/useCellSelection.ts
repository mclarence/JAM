import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { beginCellRange, extendCellRange, pruneCellSelection, type CellRange, type CellSelection } from "@/lib/cellSelection";
import { isMac } from "@/lib/utils";

interface Options {
  scrollRef: RefObject<HTMLDivElement | null>;
  rowIds: string[];
  attributeIds: string[];
  context: string;
  disabled: boolean;
  rowHeight: number;
  onClear: () => void;
}

export function useCellSelection(options: Options) {
  const [selection, setSelection] = useState<CellSelection | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const selected = useRef(selection);
  selected.current = selection;
  const gesture = useRef<{ range: CellRange; pointerId: number; y: number; endId: string; rowIds: string[] } | null>(null);
  const frame = useRef<number | null>(null);

  const stop = () => {
    gesture.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };
  const clear = () => {
    stop();
    selected.current = null;
    setSelection(null);
    latest.current.onClear();
  };
  const update = () => {
    const active = gesture.current;
    const { scrollRef, rowIds, rowHeight } = latest.current;
    const element = scrollRef.current;
    if (!active || !element || !rowIds.length) return;
    const rect = element.getBoundingClientRect();
    const index = Math.max(0, Math.min(rowIds.length - 1,
      Math.floor((element.scrollTop + active.y - rect.top - rowHeight) / rowHeight)));
    if (active.endId === rowIds[index] && active.rowIds === rowIds) return;
    active.endId = rowIds[index];
    active.rowIds = rowIds;
    const next = extendCellRange(active.range, rowIds, rowIds[index]);
    selected.current = next;
    setSelection(next);
  };
  const tick = () => {
    const active = gesture.current;
    const element = latest.current.scrollRef.current;
    if (!active || !element) return;
    const rect = element.getBoundingClientRect();
    const top = rect.top + latest.current.rowHeight + 24;
    const bottom = rect.bottom - 24;
    if (active.y < top) element.scrollTop -= Math.min(18, (top - active.y) / 3);
    else if (active.y > bottom) element.scrollTop += Math.min(18, (active.y - bottom) / 3);
    update();
    frame.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (gesture.current?.pointerId !== event.pointerId) return;
      gesture.current.y = event.clientY;
      event.preventDefault();
    };
    const end = (event: PointerEvent) => {
      if (gesture.current?.pointerId === event.pointerId) {
        if (event.type === "pointerup") {
          gesture.current.y = event.clientY;
          update();
        }
        stop();
      }
    };
    const outside = (event: PointerEvent) => {
      if (latest.current.disabled) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-cell-selection-controls]")) return;
      const cell = target?.closest<HTMLElement>("[data-asset-cell]");
      if (cell && latest.current.scrollRef.current?.contains(cell)) {
        const modifier = isMac ? event.metaKey : event.ctrlKey;
        if (modifier || (cell.dataset.attribute === selected.current?.attrId &&
          selected.current?.ids.includes(cell.dataset.assetCell ?? ""))) return;
      }
      if (selected.current) clear();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !latest.current.disabled) clear();
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("lostpointercapture", end);
    window.addEventListener("blur", stop);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key);
    return () => {
      stop();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("lostpointercapture", end);
      window.removeEventListener("blur", stop);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", key);
    };
  }, []);

  useEffect(() => { clear(); }, [options.context]);
  useEffect(() => {
    const current = selected.current;
    if (!current) return;
    if (!options.attributeIds.includes(current.attrId)) {
      clear();
      return;
    }
    const next = pruneCellSelection(current, options.rowIds);
    if (!next || next.ids.length !== current.ids.length) {
      stop();
      selected.current = next;
      setSelection(next);
      latest.current.onClear();
    }
  }, [options.rowIds, options.attributeIds]);

  const begin = (event: ReactPointerEvent, attrId: string, id: string) => {
    if (latest.current.disabled || event.button !== 0 || !(isMac ? event.metaKey : event.ctrlKey)) return;
    event.preventDefault();
    event.stopPropagation();
    const range = beginCellRange(selected.current, attrId, id);
    stop();
    gesture.current = {
      range, pointerId: event.pointerId, y: event.clientY, endId: id, rowIds: latest.current.rowIds,
    };
    const next = extendCellRange(range, latest.current.rowIds, id);
    selected.current = next;
    setSelection(next);
    frame.current = requestAnimationFrame(tick);
  };
  return { selection, begin, clear, dragging: () => gesture.current !== null };
}
