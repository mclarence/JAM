export interface CellSelection {
  attrId: string;
  ids: string[];
}

export interface CellRange {
  attrId: string;
  anchorId: string;
  baseIds: string[];
}

export function beginCellRange(selection: CellSelection | null, attrId: string, anchorId: string): CellRange {
  return { attrId, anchorId, baseIds: selection?.attrId === attrId ? selection.ids : [] };
}

export function extendCellRange(range: CellRange, rowIds: string[], endId: string): CellSelection {
  const start = rowIds.indexOf(range.anchorId);
  const end = rowIds.indexOf(endId);
  const available = new Set(rowIds);
  const ids = range.baseIds.filter((id) => available.has(id));
  if (start >= 0 && end >= 0) ids.push(...rowIds.slice(Math.min(start, end), Math.max(start, end) + 1));
  return { attrId: range.attrId, ids: [...new Set(ids)] };
}

export function pruneCellSelection(selection: CellSelection | null, rowIds: string[]): CellSelection | null {
  if (!selection) return null;
  const available = new Set(rowIds);
  const ids = selection.ids.filter((id) => available.has(id));
  return ids.length ? { ...selection, ids } : null;
}
