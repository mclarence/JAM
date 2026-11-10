import { useState } from "react";
import { useAttributes, useConnection, useStatusTypes } from "@/api/queries";
import { AttrType, type ConnectionInfo } from "@/api/types";
import { AttributeValueInput } from "@/components/assets/AttributeValueInput";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { editorKind, sortAttributes } from "@/lib/attributes";
import { deletionScope, isMarkerAttribute, validateDeletion, type DeletionConfig, type DeletionField } from "@/lib/deletion";
import { notify } from "@/lib/notify";
import { ruleActionAttributes } from "@/lib/rules";
import { useSettings } from "@/store/settings";

export function DeletionTab() {
  const connection = useConnection().data;
  const typeId = useSettings((s) => s.objectTypeId);
  const configs = useSettings((s) => s.deletions);
  if (!connection) return <p className="text-sm text-muted-foreground">Connect to Jira Assets first.</p>;
  if (!typeId) return <p className="text-sm text-muted-foreground">Select an object type in Schema &amp; Object Type first.</p>;
  const scope = deletionScope(connection, typeId);
  return <DeletionEditor key={`${scope}:${JSON.stringify(configs[scope])}`} connection={connection} typeId={typeId} saved={configs[scope]} />;
}

function DeletionEditor({ connection, typeId, saved }: { connection: ConnectionInfo; typeId: string; saved?: DeletionConfig }) {
  const attrs = useAttributes(typeId);
  const schemaId = useSettings((s) => s.schemaId);
  const statuses = useStatusTypes(schemaId);
  const setDeletion = useSettings((s) => s.setDeletion);
  const [draft, setDraft] = useState<DeletionConfig>(saved ?? { method: "soft" });
  const markerAttr = attrs.data?.find((a) => a.id === draft.marker?.attributeId);
  const extraAttr = attrs.data?.find((a) => a.id === draft.additional?.attributeId);
  const config = draft.method === "soft" && draft.marker && markerAttr
    ? { ...draft, marker: { ...draft.marker, attributeName: markerAttr.name } } : draft;
  const problem = validateDeletion(config, attrs.data ?? [], statuses.data ?? []);
  const choose = (field: "marker" | "additional", id: string) => {
    const attr = attrs.data?.find((a) => a.id === id);
    const value: DeletionField | undefined = attr ? {
      attributeId: attr.id, attributeName: attr.name, value: { raw: "", display: "" },
    } : undefined;
    setDraft((current) => ({
      ...current, [field]: value,
      ...(field === "marker" && current.additional?.attributeId === id ? { additional: undefined } : {}),
    }));
  };
  const valueInput = (field: "marker" | "additional") => {
    const attr = field === "marker" ? markerAttr : extraAttr;
    const selected = draft[field];
    return attr && selected ? <AttributeValueInput
      attr={attr} kind={editorKind(attr)} value={selected.value.raw} display={selected.value.display}
      statuses={statuses.data ?? []}
      onChange={(raw, display, referenceId) => setDraft((current) => ({
        ...current, [field]: { ...selected, value: { raw, display, ...(referenceId ? { referenceId } : {}) } },
      }))}
    /> : null;
  };
  return (
    <div className="grid max-w-xl gap-5">
      <p className="text-sm text-muted-foreground">
        Applies only to this Jira workspace and selected object type. Deletion is unavailable until you save a method.
      </p>
      <div className="grid gap-2">
        <Label>Deletion method</Label>
        <Select value={draft.method} onValueChange={(method: "permanent" | "soft") => setDraft((current) => ({
          ...current, method, ...(method === "permanent" ? { marker: saved?.marker, additional: saved?.additional } : {}),
        }))}>
          <SelectTrigger aria-label="Deletion method"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="soft">Soft delete — update attributes and hide</SelectItem>
            <SelectItem value="permanent">Permanently delete from Jira</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {draft.method === "permanent" ? (
        <p className="text-sm text-destructive">
          Permanent deletion cannot be undone. Jira object-delete permission (and token scopes) is required.
          Permission errors are reported; the app never falls back to soft delete.
          Existing soft-delete markers remain hidden.
        </p>
      ) : (
        <>
          <div className="grid gap-2">
            <Label>Required deletion marker</Label>
            <Select value={draft.marker?.attributeId || undefined} onValueChange={(id) => choose("marker", id)}>
              <SelectTrigger aria-label="Deletion marker attribute"><SelectValue placeholder="Choose a text or select attribute" /></SelectTrigger>
              <SelectContent>
                {sortAttributes(attrs.data ?? []).filter(isMarkerAttribute).map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {valueInput("marker")}
            <p className="text-xs text-muted-foreground">
              Objects equal to this value are excluded from lists, counts, searches and exports.
              Example: Asset Tag = DELETED. Changing the marker can reveal objects marked with the previous value.
            </p>
          </div>
          <div className="grid gap-2">
            <Label>Additional update (optional)</Label>
            <Select value={draft.additional?.attributeId ?? "__none__"} onValueChange={(id) => choose("additional", id)}>
              <SelectTrigger aria-label="Additional deletion attribute"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No additional update</SelectItem>
                {sortAttributes(ruleActionAttributes(attrs.data ?? [])).filter((a) => a.id !== draft.marker?.attributeId)
                  .map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {valueInput("additional")}
            <p className="text-xs text-muted-foreground">Choose any supported editable attribute, for example Status = Retired. Edit rules do not run during deletion.</p>
          </div>
          {attrs.isError && <p role="alert" className="text-sm text-destructive">Could not load attributes: {attrs.error.message}</p>}
          {extraAttr?.type === AttrType.Status && statuses.isError &&
            <p role="alert" className="text-sm text-destructive">Could not load statuses: {statuses.error.message}</p>}
          {problem && <p role="alert" className="text-sm text-destructive">{problem}</p>}
        </>
      )}
      <Button className="justify-self-start" disabled={!!problem || (draft.method === "soft" && !attrs.isSuccess)} onClick={() => {
        setDeletion(deletionScope(connection, typeId), config);
        notify.success("Deletion settings saved");
      }}>Save deletion settings</Button>
    </div>
  );
}
