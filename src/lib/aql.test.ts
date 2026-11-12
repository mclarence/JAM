import { describe, expect, it } from "vitest";
import { AttrType, DefaultType, type ObjectTypeAttribute } from "@/api/types";
import { buildAssetsQuery, listFilterAttributes, listFilterToAql, parseListFilter, SEARCH_KEY, selectedKeysToAql } from "./aql";

describe("list filters", () => {
  it("parses distinct trimmed lines without splitting commas or internal tabs", () => {
    expect(parseListFilter("  A,1 \r\nB\tC\rA,1\n\n  a,1  ")).toEqual(["A,1", "B\tC", "a,1"]);
    expect(parseListFilter(" \r\n\t")).toEqual([]);
  });

  it("escapes fields and values, grouping alternatives within the object query", () => {
    const filter = listFilterToAql('Serial "number"', ['a"b', "c\\d"], "exact");
    expect(filter).toBe('("Serial \\"number\\"" = "a\\"b" OR "Serial \\"number\\"" = "c\\\\d")');
    expect(buildAssetsQuery({ objectTypeId: "12", rawAql: filter }).where)
      .toBe(`objectTypeId = 12 AND (${filter})`);
    expect(listFilterToAql(SEARCH_KEY, ["DEV-1", "DEV-2"], "contains"))
      .toBe('(Key LIKE "DEV-1" OR Key LIKE "DEV-2")');
    expect(() => listFilterToAql(SEARCH_KEY, [], "exact")).toThrow();
  });

  it("builds an escaped Key membership filter and rejects an empty selection", () => {
    expect(selectedKeysToAql(["DEV-1", 'DEV "2"\\A'])).toBe('Key IN ("DEV-1", "DEV \\"2\\"\\\\A")');
    expect(selectedKeysToAql([])).toBeNull();
  });

  it("offers only visible text-like fields other than Key", () => {
    const attrs: ObjectTypeAttribute[] = [
      { id: "text", name: "Serial", type: AttrType.Default, defaultType: { id: DefaultType.Text, name: "Text" } },
      { id: "select", name: "Model", type: AttrType.Default, defaultType: { id: DefaultType.Select, name: "Select" } },
      { id: "key", name: "Key", type: AttrType.Default, defaultType: { id: DefaultType.Text, name: "Text" } },
      { id: "area", name: "Notes", type: AttrType.Default, defaultType: { id: DefaultType.Textarea, name: "Textarea" } },
      { id: "hidden", name: "Hidden", type: AttrType.Default, hidden: true, defaultType: { id: DefaultType.Text, name: "Text" } },
      { id: "number", name: "Number", type: AttrType.Default, defaultType: { id: DefaultType.Integer, name: "Integer" } },
      { id: "reference", name: "Owner", type: AttrType.User },
    ];
    expect(listFilterAttributes(attrs).map((attr) => attr.id)).toEqual(["text", "select"]);
  });
});
