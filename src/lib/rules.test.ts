import { describe, expect, it } from "vitest";
import { AttrType, DefaultType, type AssetObject, type ObjectAttributeIn, type ObjectTypeAttribute, type StatusType } from "@/api/types";
import { applicableRules, parseRules, planRules, validateRule, type Rule, type RuleOperation } from "./rules";

const scope = { cloudId: "cloud", workspaceId: "workspace", objectTypeId: "type" };
const attributes: ObjectTypeAttribute[] = [
  { id: "employee", name: "Assigned to Employee", type: AttrType.ObjectReference, maximumCardinality: 1 },
  { id: "student", name: "Assigned to Student", type: AttrType.ObjectReference, maximumCardinality: 1 },
  { id: "room", name: "Room", type: AttrType.ObjectReference, maximumCardinality: 1 },
  { id: "status", name: "Status", type: AttrType.Status, maximumCardinality: 1 },
  { id: "flag", name: "Flag", type: AttrType.Default, defaultType: { id: DefaultType.Boolean, name: "Boolean" } },
  { id: "count", name: "Count", type: AttrType.Default, defaultType: { id: DefaultType.Integer, name: "Integer" } },
  { id: "date", name: "Date", type: AttrType.Default, defaultType: { id: DefaultType.Date, name: "Date" } },
  { id: "time", name: "Time", type: AttrType.Default, defaultType: { id: DefaultType.DateTime, name: "DateTime" } },
  { id: "text", name: "Text", type: AttrType.Default },
  { id: "choice", name: "Choice", type: AttrType.Default, defaultType: { id: DefaultType.Select, name: "Select" }, options: "One,Two" },
  { id: "members", name: "Members", type: AttrType.ObjectReference, maximumCardinality: -1 },
];
const statuses: StatusType[] = [
  { id: "active", name: "Active", category: 1 },
  { id: "inactive", name: "Inactive", category: 0 },
  { id: "retired", name: "Retired", category: 0 },
];
const status = (raw: string) => ({ raw, display: raw });
const change = (id: string, value: string): ObjectAttributeIn => ({
  objectTypeAttributeId: id,
  objectAttributeValues: value ? [{ value }] : [],
});
const object: AssetObject = {
  id: "asset",
  objectKey: "ASSET-1",
  label: "Asset",
  objectType: { id: "type", name: "Asset", objectSchemaId: "schema" },
  created: "",
  updated: "",
  attributes: [
    { objectTypeAttributeId: "status", objectAttributeValues: [{ status: statuses[1] }] },
    { objectTypeAttributeId: "flag", objectAttributeValues: [{ value: "false" }] },
    { objectTypeAttributeId: "count", objectAttributeValues: [{ value: "0" }] },
    { objectTypeAttributeId: "date", objectAttributeValues: [{ value: "2025-01-02" }] },
    { objectTypeAttributeId: "time", objectAttributeValues: [{ value: "2025-01-02T00:00:00.000Z" }] },
    {
      objectTypeAttributeId: "members",
      objectAttributeValues: [
        { value: "10", referencedObject: { id: "10", objectKey: "EMP-10", label: "Alex" } },
        { value: "11", referencedObject: { id: "11", objectKey: "EMP-11", label: "Sam" } },
      ],
    },
  ],
};

function rule(patch: Partial<Rule> = {}): Rule {
  return {
    id: "rule",
    name: "Activate when assigned",
    enabled: true,
    ...scope,
    schemaId: "schema",
    operations: ["edit", "batch", "scan"],
    watchedAttributeIds: ["employee", "student", "room"],
    match: "any",
    conditions: ["employee", "student", "room"].map((attributeId) => ({ id: attributeId, attributeId, operator: "isSet" })),
    actions: [{ id: "action", attributeId: "status", mode: "set", value: status("active") }],
    ...patch,
  };
}

function plan(rules: Rule[], changes: ObjectAttributeIn[], operation: RuleOperation = "edit", baseline: AssetObject | undefined = object) {
  return planRules({ rules, scope, operation, baseline, changes, attributes, statuses });
}

describe("Rules", () => {
  it("applies the assignment example with any and all conditions", () => {
    const any = plan([rule()], [change("room", "ROOM-1")]);
    expect(any.payload).toEqual([change("room", "ROOM-1"), change("status", "active")]);
    expect(any.applied.map((action) => action.ruleName)).toEqual(["Activate when assigned"]);
    const all = plan([rule({ match: "all" })], [change("room", "ROOM-1")]);
    expect(all.payload).toEqual([change("room", "ROOM-1")]);
  });

  it("only evaluates enabled rules for their workspace, type, and chosen operation", () => {
    const candidates = [
      rule({ id: "disabled", enabled: false }),
      rule({ id: "workspace", workspaceId: "other" }),
      rule({ id: "cloud", cloudId: "other" }),
      rule({ id: "type", objectTypeId: "other" }),
      rule({ id: "create", operations: ["create"] }),
      rule({ id: "edit", operations: ["edit"] }),
    ];
    expect(applicableRules(candidates, scope, "edit").map((item) => item.id)).toEqual(["edit"]);
    expect(plan(candidates, [change("room", "ROOM-1")], "scan").applied).toEqual([]);
    expect(plan(candidates, [change("room", "ROOM-1")], "create", undefined).applied[0]?.ruleId).toBe("create");
  });

  it("treats a reference ID and key as the same value and ignores unrelated changes", () => {
    const baseline: AssetObject = {
      ...object,
      attributes: [...object.attributes, {
        objectTypeAttributeId: "room",
        objectAttributeValues: [{ value: "20", referencedObject: { id: "20", objectKey: "ROOM-20", label: "Lab" } }],
      }],
    };
    expect(plan([rule()], [change("room", "ROOM-20")], "edit", baseline).payload).toEqual([]);
    expect(plan([rule()], [change("count", "3")], "edit", baseline).applied).toEqual([]);
  });

  it("recognizes explicit clears, false and zero as real values", () => {
    const baseline: AssetObject = { ...object, attributes: [...object.attributes, { objectTypeAttributeId: "room", objectAttributeValues: [{ value: "ROOM-1" }] }] };
    const config = rule({
      match: "all",
      conditions: [
        { id: "empty", attributeId: "room", operator: "isEmpty" },
        { id: "false", attributeId: "flag", operator: "isSet" },
        { id: "zero", attributeId: "count", operator: "isSet" },
      ],
    });
    expect(plan([config], [change("room", "")], "edit", baseline).payload).toEqual([change("room", ""), change("status", "active")]);
  });

  it("checks equality against typed multi-value members and not-equals against empty fields", () => {
    const config = rule({
      match: "all",
      conditions: [
        { id: "member", attributeId: "members", operator: "equals", value: { raw: "EMP-10", display: "Alex", referenceId: "10" } },
        { id: "empty", attributeId: "employee", operator: "notEquals", value: { raw: "EMP-12", display: "Pat", referenceId: "12" } },
      ],
    });
    expect(plan([config], [change("room", "ROOM-1")]).applied).toHaveLength(1);
  });

  it("normalizes numbers, dates and datetime instants when deciding whether a field changed", () => {
    for (const [id, value] of [["count", "00"], ["date", "2025-01-02"], ["time", "2025-01-02T11:00:00+11:00"]]) {
      const config = rule({ watchedAttributeIds: [id] });
      expect(plan([config], [change(id, value)]).payload).toEqual([]);
    }
  });

  it("evaluates once against manual changes and applies matching rules in order", () => {
    const first = rule({ id: "first" });
    const later = rule({ id: "later", actions: [{ id: "second-action", attributeId: "status", value: status("retired") }] });
    const chained = rule({
      id: "chain",
      conditions: [{ id: "test", attributeId: "status", operator: "equals", value: status("active") }],
      actions: [{ id: "other", attributeId: "count", value: { raw: "8", display: "8" } }],
    });
    const result = plan([first, later, chained], [change("room", "ROOM-1"), change("status", "inactive")]);
    expect(result.payload).toEqual([change("room", "ROOM-1"), change("status", "retired")]);
    expect(result.applied.map((action) => action.ruleId)).toEqual(["later"]);
  });

  it("rejects invalid applicable rules without blocking other scopes", () => {
    const missing = rule({ watchedAttributeIds: ["deleted"] });
    expect(() => plan([missing], [change("room", "ROOM-1")])).toThrow('Rule "Activate when assigned": Watched attribute deleted');
    expect(plan([{ ...missing, enabled: false }], [change("room", "ROOM-1")]).payload).toEqual([change("room", "ROOM-1")]);
    expect(validateRule(rule({ actions: [{ id: "bad", attributeId: "status", value: status("deleted") }] }), attributes, statuses))
      .toContain("no longer accepts that status");
    expect(validateRule(rule({ actions: [{ id: "bad", attributeId: "members", value: { raw: "EMP-10", display: "Alex", referenceId: "10" } }] }), attributes, statuses))
      .toContain("editable single-valued");
  });

  it("rejects malformed or partial imports instead of silently dropping rule components", () => {
    expect(parseRules([rule()])).toEqual([rule()]);
    expect(() => parseRules([{ ...rule(), conditions: [{ id: "x", attributeId: "room", operator: "equals" }] }])).toThrow();
    expect(() => parseRules([rule(), rule()])).toThrow("duplicate ID");
    expect(() => parseRules([{ ...rule(), operations: ["unknown"] }])).toThrow("malformed");
  });

  it.each([
    ["text", "Hello"], ["status", "inactive"], ["employee", "EMP-10"], ["flag", "false"],
    ["count", "0"], ["date", "2025-01-02"], ["time", "2025-01-02T00:00:00Z"], ["choice", "One"],
  ])("clears a populated %s with an empty value array", (attributeId, value) => {
    const baseline = {
      ...object,
      attributes: [...object.attributes.filter((item) => item.objectTypeAttributeId !== attributeId), {
        objectTypeAttributeId: attributeId, objectAttributeValues: [{ value }],
      }],
    };
    const clear = rule({ actions: [{ id: "clear", attributeId, mode: "clear" }] });
    const result = plan([clear], [change("room", "ROOM-1")], "edit", baseline);
    expect(result.payload).toEqual([change("room", "ROOM-1"), change(attributeId, "")]);
    expect(result.applied).toEqual([{ ruleId: clear.id, ruleName: clear.name, attributeId, mode: "clear" }]);
  });

  it("omits already-empty update clears, including when they override a manual set", () => {
    const clear = rule({ actions: [{ id: "clear", attributeId: "employee", mode: "clear" }] });
    for (const manual of [[], [change("employee", "EMP-10")]]) {
      const result = plan([clear], [change("room", "ROOM-1"), ...manual]);
      expect(result.payload).toEqual([change("room", "ROOM-1")]);
      expect(result.applied).toEqual([]);
    }
  });

  it("preserves mixed actions, manual overrides, ordering and non-chaining", () => {
    const clear = rule({ id: "clear", actions: [
      { id: "clear-status", attributeId: "status", mode: "clear" },
      { id: "set-count", attributeId: "count", mode: "set", value: { raw: "8", display: "8" } },
    ] });
    const chain = rule({
      id: "chain", conditions: [{ id: "empty", attributeId: "status", operator: "isEmpty" }],
      actions: [{ id: "set-text", attributeId: "text", mode: "set", value: { raw: "Chained", display: "" } }],
    });
    expect(plan([rule(), clear, chain], [change("room", "ROOM-1"), change("status", "retired")]).payload)
      .toEqual([change("room", "ROOM-1"), change("status", ""), change("count", "8")]);
    expect(plan([clear, rule()], [change("room", "ROOM-1")]).payload)
      .toEqual([change("room", "ROOM-1"), change("status", "active"), change("count", "8")]);
  });

  it("preserves explicit creation clears with or without a manually supplied target", () => {
    const clear = rule({ operations: ["create"], actions: [{ id: "clear", attributeId: "status", mode: "clear" }] });
    for (const manual of [[], [change("status", "active")]]) {
      const result = planRules({ rules: [clear], scope, operation: "create", changes: [change("room", "ROOM-1"), ...manual], attributes, statuses });
      expect(result.payload).toEqual([change("room", "ROOM-1"), change("status", "")]);
      expect(result.applied[0]?.mode).toBe("clear");
    }
  });

  it.each([
    { minimumCardinality: 1 }, { editable: false }, { hidden: true }, { maximumCardinality: -1 },
  ])("rejects a clear when current metadata disallows its target: %j", (patch) => {
    const clear = rule({ actions: [{ id: "clear", attributeId: "status", mode: "clear" }] });
    const current = attributes.map((attribute) => attribute.id === "status" ? { ...attribute, ...patch } : attribute);
    expect(() => planRules({ rules: [clear], scope, operation: "edit", baseline: object, changes: [change("room", "ROOM-1")], attributes: current, statuses }))
      .toThrow(`Rule "${clear.name}"`);
    if ("minimumCardinality" in patch) expect(validateRule(clear, current, statuses)).toContain("required and cannot be cleared");
  });

  it("defaults legacy actions to set and strictly parses clear action data", () => {
    const legacy = { ...rule(), actions: [{ id: "action", attributeId: "status", value: status("active") }] };
    expect(parseRules([legacy])).toEqual([rule()]);
    const clear = rule({ actions: [{ id: "clear", attributeId: "status", mode: "clear" }] });
    expect(parseRules(JSON.parse(JSON.stringify([clear])))).toEqual([clear]);
    for (const action of [
      { mode: "other" }, { mode: null }, { mode: "set" }, { mode: "set", value: { raw: "", display: "" } },
      { mode: "clear", value: status("active") }, { mode: "clear", value: null },
    ]) {
      expect(() => parseRules([{ ...rule(), actions: [{ id: "bad", attributeId: "status", ...action }] }])).toThrow();
    }
  });
});
