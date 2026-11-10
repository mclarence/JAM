import { describe, expect, it } from "vitest";
import { AttrType, DefaultType, type AssetObject, type ConnectionInfo, type ObjectTypeAttribute } from "@/api/types";
import { deletionScope, excludeDeleted, isMarkerAttribute, isSoftDeleted, parseDeletionConfigs, validateDeletion, type DeletionConfig } from "./deletion";

const connection: ConnectionInfo = { cloudId: "cloud", workspaceId: "workspace", siteUrl: "https://example.invalid", email: "test@example.invalid" };
const marker: ObjectTypeAttribute = { id: "10", name: 'Asset "Tag"', type: AttrType.Default, defaultType: { id: DefaultType.Text, name: "Text" }, maximumCardinality: 1 };
const config: DeletionConfig = { method: "soft", marker: { attributeId: marker.id, attributeName: marker.name, value: { raw: 'DELETED\\ "yes"', display: "" } } };
const configs = { [deletionScope(connection, "1")]: config };

describe("deletion configuration and visibility", () => {
  it("defaults to no filtering and scopes exclusions to cloud, workspace and type", () => {
    const query = 'objectTypeId = 1 OR Key = "ASSET-2" ORDER BY Key ASC';
    expect(excludeDeleted(query, {}, connection)).toBe(query);
    expect(excludeDeleted(query, configs, { ...connection, workspaceId: "other" })).toBe(query);
    expect(excludeDeleted(query, configs, { ...connection, cloudId: "other" })).toBe(query);
    expect(excludeDeleted(query, configs, null)).toBe(query);
    const filtered = excludeDeleted(query, configs, connection);
    expect(filtered).toBe('(objectTypeId = 1 OR Key = "ASSET-2") AND (objectTypeId != 1 OR "Asset \\"Tag\\"" IS EMPTY OR "Asset \\"Tag\\"" != "DELETED\\\\ \\"yes\\"") ORDER BY Key ASC');
  });
  it("keeps the original order and ignores ORDER BY inside strings and references", () => {
    const query = '"Name" = "some ORDER BY value" AND object HAVING outboundReferences("Name" = "ORDER BY x") ORDER BY "Asset \\"Tag\\"" DESC';
    const filtered = excludeDeleted(query, configs, connection);
    expect(filtered).toContain(`(${query.slice(0, query.lastIndexOf(" ORDER BY"))}) AND `);
    expect(filtered).toMatch(/ORDER BY "Asset \\"Tag\\"" DESC$/);
    expect(excludeDeleted('"ORDER BY Name" = "x"', configs, connection)).toMatch(/^\("ORDER BY Name" = "x"\) AND /);
  });
  it("continues hiding markers after switching to permanent deletion", () => {
    const permanent = { [deletionScope(connection, "1")]: { ...config, method: "permanent" as const } };
    expect(excludeDeleted("objectTypeId = 1", permanent, connection)).toEqual(excludeDeleted("objectTypeId = 1", configs, connection));
    const object = {
      objectType: { id: "1" },
      attributes: [{ objectTypeAttributeId: marker.id, objectAttributeValues: [{ value: config.marker!.value.raw.toLowerCase() }] }],
    } as AssetObject;
    expect(isSoftDeleted(object, permanent, connection)).toBe(true);
    expect(isSoftDeleted({ ...object, objectType: { ...object.objectType, id: "2" } }, configs, connection)).toBe(false);
    expect(isSoftDeleted(object, configs, { ...connection, workspaceId: "other" })).toBe(false);
  });
  it.each([
    { type: AttrType.Status }, { type: AttrType.User }, { editable: false }, { system: true }, { hidden: true },
    { maximumCardinality: -1 }, { maximumCardinality: 2 },
    { defaultType: { id: DefaultType.Textarea, name: "" } },
    { defaultType: { id: DefaultType.Integer, name: "" } },
    { defaultType: undefined },
  ])("rejects unsuitable marker metadata: %j", (patch) => {
    expect(isMarkerAttribute({ ...marker, ...patch })).toBe(false);
    expect(validateDeletion(config, [{ ...marker, ...patch }], [])).toContain("text or select");
  });
  it("requires a nonempty marker, validates selects and prevents optional marker overwrites", () => {
    expect(validateDeletion({ method: "soft" }, [marker], [])).toContain("marker");
    expect(validateDeletion({ ...config, marker: { ...config.marker!, value: { raw: " ", display: "" } } }, [marker], [])).toContain("Choose a value");
    const select = { ...marker, defaultType: { id: DefaultType.Select, name: "" }, options: "Live,DELETED" };
    expect(validateDeletion(config, [select], [])).toContain("option");
    expect(validateDeletion({ ...config, additional: config.marker }, [marker], [])).toContain("overwrite");
    expect(validateDeletion(config, [{ ...marker, name: "Renamed" }], [])).toContain("renamed");
    expect(validateDeletion({ method: "permanent" }, [], [])).toBeNull();
  });
  it("supports any valid editable extra field, not just status", () => {
    const attr: ObjectTypeAttribute = { id: "11", name: "Count", type: 0, defaultType: { id: DefaultType.Integer, name: "" } };
    const extra = { attributeId: attr.id, attributeName: attr.name, value: { raw: "42", display: "42" } };
    expect(validateDeletion({ ...config, additional: extra }, [marker, attr], [])).toBeNull();
    expect(validateDeletion({ ...config, additional: { ...extra, value: { raw: "oops", display: "" } } }, [marker, attr], [])).toContain("integer");
    expect(validateDeletion({ ...config, additional: extra }, [marker, { ...attr, editable: false }], [])).toContain("editable");
  });
  it("strictly parses scoped backups, rejects malformed fields and preserves markers", () => {
    expect(parseDeletionConfigs(JSON.parse(JSON.stringify(configs)))).toEqual(configs);
    expect(() => parseDeletionConfigs({ [deletionScope(connection, "1")]: { method: "soft" } })).toThrow("requires a marker");
    expect(() => parseDeletionConfigs({ invalid: config })).toThrow("scope");
    expect(() => parseDeletionConfigs({ [deletionScope(connection, "1")]: { ...config, additional: config.marker } })).toThrow("overwrite");
    expect(() => parseDeletionConfigs({ [deletionScope(connection, "1")]: { ...config, marker: { ...config.marker, value: { raw: "", display: "" } } } })).toThrow("malformed");
  });
});
