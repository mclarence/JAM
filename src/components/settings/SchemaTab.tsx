import { useConnection, useObjectTypes, useSchemas } from "@/api/queries";
import { Label, Skeleton } from "@/components/ui/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSettings } from "@/store/settings";

export function SchemaTab() {
  const connection = useConnection();
  const { schemaId, objectTypeId, setSchema, setObjectType } = useSettings();
  const schemas = useSchemas();
  const types = useObjectTypes(schemaId);

  if (!connection.data) {
    return <p className="text-sm text-muted-foreground">Connect to JIRA Assets first (Connection tab).</p>;
  }

  return (
    <div className="grid max-w-xl gap-6">
      <div className="grid gap-2">
        <Label>Primary schema</Label>
        {schemas.isLoading ? (
          <Skeleton className="h-9" />
        ) : (
          <Select value={schemaId ?? ""} onValueChange={(v) => setSchema(v)}>
            <SelectTrigger>
              <SelectValue placeholder="Select a schema" />
            </SelectTrigger>
            <SelectContent>
              {schemas.data?.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name} <span className="text-muted-foreground">({s.objectSchemaKey})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <div className="grid gap-2">
        <Label>Primary object type</Label>
        {schemaId && types.isLoading ? (
          <Skeleton className="h-9" />
        ) : (
          <Select value={objectTypeId ?? ""} onValueChange={(v) => setObjectType(v)} disabled={!schemaId}>
            <SelectTrigger>
              <SelectValue placeholder={schemaId ? "Select an object type" : "Select a schema first"} />
            </SelectTrigger>
            <SelectContent>
              {types.data
                ?.filter((t) => !t.abstractObjectType)
                .map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
}
