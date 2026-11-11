import { assetsApi, isLast, PAGE_SIZE, selectedExportQuery, validateExportPage } from "@/api/assets";
import { connectionApi, fileApi } from "@/api/client";
import type { AssetObject, ConnectionInfo, ObjectTypeAttribute } from "@/api/types";
import { AttrType, DefaultType } from "@/api/types";
import { displayValue } from "@/lib/attributes";
import { sameConnection } from "@/lib/ruleMutations";
import { isSoftDeleted } from "@/lib/deletion";
import { useSettings } from "@/store/settings";

export function csvRecord(cells: string[]): string {
  return cells.map((cell) => /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell).join(",") + "\r\n";
}

export function assetCsvRow(object: AssetObject, columns: ObjectTypeAttribute[]): string {
  return csvRecord(columns.map((attr) => {
    const attribute = object.attributes.find((a) => a.objectTypeAttributeId === attr.id);
    if (attribute) {
      return attribute.objectAttributeValues.map((value) =>
        attr.type === AttrType.Default && [DefaultType.Integer, DefaultType.Double, DefaultType.Boolean, DefaultType.Date, DefaultType.DateTime]
          .some((type) => type === attr.defaultType?.id)
          ? value.value ?? displayValue(value)
          : displayValue(value),
      ).join(", ");
    }
    if (attr.system) {
      switch (attr.name.toLowerCase()) {
        case "key": return object.objectKey;
        case "created": return object.created;
        case "updated": return object.updated;
      }
    }
    return attr.label ? object.label : "";
  }));
}

export interface ExportInput {
  aql: string;
  typeId: string;
  selectedIds?: string[];
  columns: ObjectTypeAttribute[];
  connection: ConnectionInfo;
  signal: AbortSignal;
  onProgress: (count: number) => void;
}

export async function checkExportContext(input: Pick<ExportInput, "signal" | "connection">) {
  input.signal.throwIfAborted();
  if (!sameConnection(await connectionApi.get(), input.connection)) {
    throw new Error("The connection changed. Retry the export on the current workspace.");
  }
  input.signal.throwIfAborted();
}

export interface ExportSummary {
  count: number;
  skippedIds: string[];
  missingIds: string[];
}

export interface PreparedAssetExport extends ExportSummary {
  csv: string;
}

export function skippedExportWarning(result: ExportSummary): string {
  const missing = result.missingIds.length;
  const deleted = result.skippedIds.length - missing;
  return `Skipped ${result.skippedIds.length.toLocaleString()} selected assets: ${missing.toLocaleString()} not returned by search; ${deleted.toLocaleString()} matched deletion markers.`;
}

export async function prepareAssetExport(input: ExportInput): Promise<PreparedAssetExport> {
  if (!input.columns.length) throw new Error("Choose at least one column to export.");
  const chunks = ["\uFEFF" + csvRecord(input.columns.map((attr) => attr.name))];
  const skippedIds: string[] = [];
  const missingIds: string[] = [];
  let count = 0;
  const append = (object: AssetObject) => {
    input.signal.throwIfAborted();
    if (isSoftDeleted(object, useSettings.getState().deletions, input.connection)) {
      if (input.selectedIds) skippedIds.push(object.id);
      return;
    }
    chunks.push(assetCsvRow(object, input.columns));
    input.onProgress(++count);
  };
  const validateType = (object: AssetObject) => {
    if (object.objectType.id !== input.typeId) {
      throw new Error("An exported asset no longer belongs to the selected object type. Retry the export.");
    }
  };
  const fetchPages = async (query: string, selected: boolean, receive: (object: AssetObject) => void) => {
    const seen = new Set<string>();
    let start = 0;
    for (;;) {
      await checkExportContext(input);
      const page = await assetsApi.searchExportObjects(query, start, selected);
      await checkExportContext(input);
      validateExportPage(page, start);
      const previousCount = seen.size;
      for (const object of page.values) {
        input.signal.throwIfAborted();
        validateType(object);
        if (!seen.has(object.id)) {
          receive(object);
          seen.add(object.id);
        }
      }
      if (isLast(page)) break;
      if (seen.size === previousCount) throw new Error("Export pagination stopped making progress. Retry the export.");
      start = page.startAt + page.values.length;
    }
  };
  if (input.selectedIds) {
    const ids = [...new Set(input.selectedIds)];
    // Validate the entire selection before making any requests.
    for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) selectedExportQuery(ids.slice(offset, offset + PAGE_SIZE));
    for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) {
      const batch = ids.slice(offset, offset + PAGE_SIZE);
      const requested = new Set(batch);
      const objects = new Map<string, AssetObject>();
      await fetchPages(selectedExportQuery(batch), true, (object) => {
        if (!requested.has(object.id)) throw new Error("The export response included an unexpected selected asset.");
        objects.set(object.id, object);
      });
      for (const id of batch) {
        const object = objects.get(id);
        if (object) append(object);
        else {
          skippedIds.push(id);
          missingIds.push(id);
        }
      }
    }
  } else {
    await fetchPages(input.aql, false, append);
  }
  await checkExportContext(input);
  const summary = { count, skippedIds, missingIds };
  if (!count) throw new Error(`No exportable assets match this export. Adjust the filters or selection.${skippedIds.length ? ` ${skippedExportWarning(summary)}` : ""}`);
  return { csv: chunks.join(""), ...summary };
}

export async function saveAssetExport(
  input: ExportInput,
  defaultPath: string,
  choosePath: (defaultPath: string) => Promise<string | null>,
  beforeSave?: (summary: ExportSummary) => Promise<boolean>,
): Promise<ExportSummary | null> {
  const result = await prepareAssetExport(input);
  if (beforeSave && !await beforeSave(result)) return null;
  await checkExportContext(input);
  const path = await choosePath(defaultPath);
  await checkExportContext(input);
  if (!path) return null;
  await fileApi.saveCsv(path, result.csv);
  return { count: result.count, skippedIds: result.skippedIds, missingIds: result.missingIds };
}

export function exportFileName(typeName: string): string {
  const stem = typeName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "assets";
  return `${stem}-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
}
