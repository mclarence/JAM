import { beforeEach, expect, it } from "vitest";
import { useSettings } from "./settings";

const presets = [
  { id: "a", name: "First", aql: "first" },
  { id: "b", name: "Second", aql: "second" },
  { id: "c", name: "Third", aql: "third" },
];
const ids = () => useSettings.getState().aqlPresets.map((p) => p.id);

beforeEach(() => {
  localStorage.clear();
  useSettings.setState({ aqlPresets: [...presets] });
});

it("inserts presets in both directions and restores the saved order", async () => {
  useSettings.getState().movePreset("a", "c");
  expect(ids()).toEqual(["b", "c", "a"]);
  useSettings.getState().movePreset("a", "b");
  expect(useSettings.getState().aqlPresets).toEqual(presets);
  useSettings.getState().movePreset("c", "a");
  const saved = localStorage.getItem("settings");
  expect(saved).not.toBeNull();
  useSettings.setState({ aqlPresets: [] });
  localStorage.setItem("settings", saved!);
  await useSettings.persist.rehydrate();
  expect(ids()).toEqual(["c", "a", "b"]);
});

it("keeps remaining order on delete and appends new presets after a move", () => {
  useSettings.getState().movePreset("c", "a");
  useSettings.getState().deletePreset("a");
  useSettings.getState().savePreset("Fourth", "fourth");
  expect(useSettings.getState().aqlPresets.map((p) => p.name)).toEqual(["Third", "Second", "Fourth"]);
});

it("ignores obsolete targets, obsolete sources and unchanged positions", () => {
  const before = useSettings.getState().aqlPresets;
  useSettings.getState().movePreset("a", "missing");
  useSettings.getState().movePreset("missing", "b");
  useSettings.getState().movePreset("a", "a");
  expect(useSettings.getState().aqlPresets).toBe(before);
});
