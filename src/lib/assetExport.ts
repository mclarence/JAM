import { assetsApi, getCompleteObject, isLast } from "@/api/assets";
import { connectionApi, fileApi } from "@/api/client";
import type { AssetObject, ConnectionInfo, ObjectTypeAttribute } from "@/api/types";
import { AttrType, DefaultType } from "@/api/types";
import { displayValue } from "@/lib/attributes";
import { sameConnection } from "@/lib/ruleMutations";

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

export async function prepareAssetExport(input: ExportInput): Promise<{ csv: string; count: number }> {
  if (!input.columns.length) throw new Error("Choose at least one column to export.");
  const chunks = ["\uFEFF" + csvRecord(input.columns.map((attr) => attr.name))];
  const seen = new Set<string>();
  let count = 0;
  const append = async (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    await checkExportContext(input);
    const object = await getCompleteObject(id);
    await checkExportContext(input);
    if (object.objectType.id !== input.typeId) {
      throw new Error("An exported asset no longer belongs to the selected object type. Retry the export.");
    }
    chunks.push(assetCsvRow(object, input.columns));
    input.onProgress(++count);
  };
  if (input.selectedIds) {
    for (const id of input.selectedIds) await append(id);
  } else {
    let start = 0;
    for (;;) {
      await checkExportContext(input);
      const page = await assetsApi.searchObjects(input.aql, start);
      await checkExportContext(input);
      if (page.startAt !== start || (!page.values.length && !isLast(page))) {
        throw new Error("The server returned an incomplete export page. Retry the export.");
      }
      const previousCount = count;
      for (const object of page.values) await append(object.id);
      if (isLast(page)) break;
      if (count === previousCount) throw new Error("Export pagination stopped making progress. Retry the export.");
      start = page.startAt + page.values.length;
    }
  }
  await checkExportContext(input);
  if (!count) throw new Error("No assets match this export. Adjust the filters or selection.");
  return { csv: chunks.join(""), count };
}

export async function saveAssetExport(
  input: ExportInput,
  defaultPath: string,
  choosePath: (defaultPath: string) => Promise<string | null>,
): Promise<number | null> {
  const result = await prepareAssetExport(input);
  const path = await choosePath(defaultPath);
  await checkExportContext(input);
  if (!path) return null;
  await fileApi.saveCsv(path, result.csv);
  return result.count;
}

export function exportFileName(typeName: string): string {
  const stem = typeName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "assets";
  return `${stem}-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
}
