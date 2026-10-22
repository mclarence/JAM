import { useAttributes, useConnection } from "@/api/queries";
import { AttrType, DefaultType } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isMultiValue, sortAttributes } from "@/lib/attributes";
import { formatTag, parseTemplate, type AssetTagConfig } from "@/lib/assetTag";
import { useSettings } from "@/store/settings";

export function AssetTagTab() {
  const connection = useConnection();
  const { objectTypeId, assetTags, setAssetTag } = useSettings();
  const attrs = useAttributes(objectTypeId);

  if (!connection.data) {
    return <p className="text-sm text-muted-foreground">Connect to JIRA Assets first (Connection tab).</p>;
  }
  if (!objectTypeId) {
    return <p className="text-sm text-muted-foreground">Select a primary object type first (Schema tab).</p>;
  }

  const config = assetTags[objectTypeId];
  const candidates = sortAttributes(attrs.data ?? []).filter(
    (a) =>
      a.type === AttrType.Default &&
      a.defaultType?.id === DefaultType.Text &&
      !a.system &&
      a.editable !== false &&
      !isMultiValue(a),
  );
  const parsed = config ? parseTemplate(config.template) : null;
  const update = (patch: Partial<AssetTagConfig>) =>
    setAssetTag(objectTypeId, { ...(config ?? { attributeId: "", template: "" }), ...patch });

  return (
    <div className="grid max-w-xl gap-6">
      <div className="grid gap-2">
        <Label>Asset tag attribute</Label>
        <Select value={config?.attributeId || undefined} onValueChange={(v) => update({ attributeId: v })}>
          <SelectTrigger>
            <SelectValue placeholder={attrs.isLoading ? "Loading…" : "Select a text attribute"} />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="asset-tag-template">Template</Label>
        <Input
          id="asset-tag-template"
          value={config?.template ?? ""}
          placeholder="SSCCXXXXX"
          onChange={(e) => update({ template: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          The last run of <code>X</code> characters is the counter, zero-padded to that many digits. All other
          characters are kept as-is.
          {parsed && (
            <>
              {" "}
              Example: <code>{formatTag(parsed, 1)}</code>, <code>{formatTag(parsed, 2)}</code>
            </>
          )}
        </p>
        {config?.template && !parsed && <p className="text-xs text-destructive">Template needs at least one X.</p>}
      </div>

      {config && (
        <div>
          <Button variant="outline" size="sm" onClick={() => setAssetTag(objectTypeId, null)}>
            Remove asset tag configuration
          </Button>
        </div>
      )}
    </div>
  );
}
