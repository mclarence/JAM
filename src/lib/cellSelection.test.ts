import { describe, expect, it } from "vitest";
import { beginCellRange, extendCellRange, pruneCellSelection } from "./cellSelection";

const rows = ["a", "b", "c", "d", "e"];

describe("column-scoped cell selection", () => {
  it("selects inclusive forward and backward ranges", () => {
    const range = beginCellRange(null, "student", "d");
    expect(extendCellRange(range, rows, "b")).toEqual({ attrId: "student", ids: ["b", "c", "d"] });
    expect(extendCellRange(range, rows, "e").ids).toEqual(["d", "e"]);
  });
  it("adds ranges and contracts only the active range", () => {
    const range = beginCellRange({ attrId: "student", ids: ["a"] }, "student", "c");
    expect(extendCellRange(range, rows, "e").ids).toEqual(["a", "c", "d", "e"]);
    expect(extendCellRange(range, rows, "c").ids).toEqual(["a", "c"]);
  });
  it("starts over when the column changes and supports a single cell", () => {
    const range = beginCellRange({ attrId: "student", ids: ["a", "b"] }, "room", "d");
    expect(extendCellRange(range, rows, "d")).toEqual({ attrId: "room", ids: ["d"] });
  });
  it("deduplicates overlapping ranges and prunes missing assets", () => {
    const range = beginCellRange({ attrId: "student", ids: ["b", "c"] }, "student", "c");
    const selection = extendCellRange(range, rows, "d");
    expect(selection.ids).toEqual(["b", "c", "d"]);
    expect(pruneCellSelection(selection, ["c", "d", "e"])?.ids).toEqual(["c", "d"]);
    expect(pruneCellSelection(selection, [])).toBeNull();
  });
});
