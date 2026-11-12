import { expect, test, type Page } from "@playwright/test";

const fixture = "/tests/browser/fixtures/exportAssets.html?mode=presets";
const presets = [
  { id: "a", name: "First", aql: '"Room" = "Lab"' },
  { id: "b", name: "Second", aql: '"Room" = "Office"' },
  { id: "c", name: "Third", aql: '"Name" LIKE "Device"' },
];
const chipIds = (page: Page) => page.locator("[data-preset-id]").evaluateAll((chips) => chips.map((chip) => chip.getAttribute("data-preset-id")));

async function startDrag(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true });
  await button.hover();
  const box = await button.boundingBox();
  if (!box) throw new Error(`Missing preset ${name}`);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 10, point.y, { steps: 3 });
}

async function finishDrag(page: Page) {
  await page.mouse.up();
  // dnd-kit retains its post-drag click blocker for 50ms.
  await page.waitForTimeout(60);
}

async function openActions(page: Page, name: string) {
  await page.getByRole("button", { name: `Actions for preset ${name}` }).press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((saved) => {
    if (!localStorage.getItem("settings")) {
      localStorage.setItem("settings", JSON.stringify({ state: { aqlPresets: saved }, version: 1 }));
    }
  }, presets);
  await page.goto(fixture);
  await expect(page.locator("[data-preset-id]")).toHaveCount(3);
});

test("drags chips in both directions without applying a filter and persists on reload", async ({ page }) => {
  const aql = page.getByPlaceholder("AQL filter,", { exact: false });
  await page.getByRole("button", { name: "Second", exact: true }).click();
  await expect(aql).toHaveValue(presets[1].aql);
  await startDrag(page, "First");
  const target = await page.getByRole("button", { name: "Third", exact: true }).boundingBox();
  if (!target) throw new Error("Missing target preset");
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
  await finishDrag(page);
  await expect.poll(() => chipIds(page)).toEqual(["b", "c", "a"]);
  await expect(aql).toHaveValue(presets[1].aql);

  await startDrag(page, "First");
  const first = await page.getByRole("button", { name: "Second", exact: true }).boundingBox();
  if (!first) throw new Error("Missing target preset");
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2, { steps: 10 });
  await finishDrag(page);
  await expect.poll(() => chipIds(page)).toEqual(["a", "b", "c"]);
  await expect(aql).toHaveValue(presets[1].aql);
  await openActions(page, "Third");
  await page.getByRole("menuitem", { name: "Move earlier" }).press("Enter");
  await expect.poll(() => chipIds(page)).toEqual(["a", "c", "b"]);
  await page.reload();
  await expect.poll(() => chipIds(page)).toEqual(["a", "c", "b"]);
});

test("accessible moves preserve activation and cancelled or outside drops do not reorder", async ({ page }) => {
  const aql = page.getByPlaceholder("AQL filter,", { exact: false });
  await openActions(page, "First");
  await expect(page.getByRole("menuitem", { name: "Move earlier" })).toBeDisabled();
  await page.getByRole("menuitem", { name: "Move later" }).press("Enter");
  await expect.poll(() => chipIds(page)).toEqual(["b", "a", "c"]);
  await expect(aql).toHaveValue("");
  await page.getByRole("button", { name: "First", exact: true }).click();
  await expect(aql).toHaveValue(presets[0].aql);
  await page.getByRole("button", { name: "First", exact: true }).click();
  await expect(aql).toHaveValue("");

  await startDrag(page, "First");
  await page.keyboard.press("Escape");
  await finishDrag(page);
  await expect.poll(() => chipIds(page)).toEqual(["b", "a", "c"]);
  await startDrag(page, "First");
  await page.mouse.move(1000, 600, { steps: 10 });
  await finishDrag(page);
  await expect.poll(() => chipIds(page)).toEqual(["b", "a", "c"]);
  await expect(aql).toHaveValue("");
  await openActions(page, "Second");
  await page.getByRole("menuitem", { name: "Delete", exact: true }).press("Enter");
  await expect.poll(() => chipIds(page)).toEqual(["a", "c"]);
});

test("keeps chips compact and stable while their actions menu is used", async ({ page }) => {
  const chip = page.locator('[data-preset-id="a"]');
  const trailingWidth = await chip.evaluate((element) => {
    const label = element.querySelector("button");
    if (!label) throw new Error("Missing preset label");
    return element.getBoundingClientRect().right - label.getBoundingClientRect().right;
  });
  expect(trailingWidth).toBeLessThanOrEqual(28);
  const initialWidth = await chip.evaluate((element) => element.getBoundingClientRect().width);
  await chip.hover();
  await openActions(page, "First");
  expect(await chip.evaluate((element) => element.getBoundingClientRect().width)).toBe(initialWidth);
  await expect(page.getByPlaceholder("AQL filter,", { exact: false })).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Actions for preset First" })).toBeFocused();
  await openActions(page, "Third");
  await expect(page.getByRole("menuitem", { name: "Move later" })).toBeDisabled();
});
