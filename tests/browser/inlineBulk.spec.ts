import { expect, test, type Page } from "@playwright/test";
import type {} from "./fixtures/inlineBulk";

const cell = (page: Page, id: number, attribute: string) =>
  page.locator(`[data-asset-cell="${id}"][data-attribute="${attribute}"]`);
const highlighted = (page: Page) => page.locator('[data-highlighted="true"]');

async function open(page: Page, mac = false) {
  await page.addInitScript((isMac) => {
    Object.defineProperty(navigator, "userAgent", { value: isMac ? "Macintosh" : "Windows NT" });
  }, mac);
  await page.goto("/tests/browser/fixtures/inlineBulk.html");
  await expect(cell(page, 0, "room")).toBeVisible();
}

async function drag(page: Page, from: number, to: number, attribute: string, modifier = "Control") {
  const start = await cell(page, from, attribute).boundingBox();
  const end = await cell(page, to, attribute).boundingBox();
  if (!start || !end) throw new Error("Missing drag cells");
  await page.keyboard.down(modifier);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up(modifier);
}

test("Ctrl-drag adds disjoint ranges without editing; checkbox selection stays independent", async ({ page }) => {
  await open(page);
  await drag(page, 1, 3, "student");
  await expect(highlighted(page)).toHaveCount(3);
  await drag(page, 6, 5, "student");
  await expect(highlighted(page)).toHaveCount(5);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  expect(await page.evaluate(() => window.bulkFixture.writes)).toEqual([]);
  await cell(page, 0, "name").click();
  await expect(highlighted(page)).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Select row", exact: true }).first().click();
  await drag(page, 1, 2, "room");
  await expect(page.getByRole("checkbox", { name: "Select row", exact: true }).first()).toBeChecked();
  await expect(highlighted(page)).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(highlighted(page)).toHaveCount(0);
});

test("Cmd-drag on macOS and switching columns retains only one attribute", async ({ page }) => {
  await open(page, true);
  await drag(page, 0, 2, "student", "Meta");
  await expect(highlighted(page)).toHaveCount(3);
  await drag(page, 3, 4, "room", "Meta");
  await expect(highlighted(page)).toHaveCount(2);
  await expect(page.locator('[data-highlighted="true"][data-attribute="student"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.bulkFixture.writes)).toEqual([]);
});

test("same-as-anchor text commits to the selected rows only and skips unchanged rows", async ({ page }) => {
  await open(page);
  await drag(page, 0, 2, "room");
  await cell(page, 0, "room").dblclick();
  await expect(cell(page, 0, "room").getByRole("textbox")).toHaveValue("Lab");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "1 updated, 2 unchanged" })).toBeVisible();
  expect(await page.evaluate(() => window.bulkFixture.writes)).toEqual([
    { id: "1", body: { objectTypeId: "1", attributes: [{ objectTypeAttributeId: "room", objectAttributeValues: [{ value: "Lab" }] }] } },
  ]);
});

test("an unchanged single-cell edit and an Escape-cancelled bulk edit write nothing", async ({ page }) => {
  await open(page);
  await cell(page, 0, "room").dblclick();
  await page.keyboard.press("Enter");
  await drag(page, 0, 2, "room");
  await cell(page, 0, "room").dblclick();
  await cell(page, 0, "room").getByRole("textbox").fill("Do not save");
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => window.bulkFixture.writes)).toEqual([]);
});

test("noncontiguous highlighted cells, not checked rows, are the exact edit targets", async ({ page }) => {
  await open(page);
  await page.getByRole("checkbox", { name: "Select row", exact: true }).nth(7).click();
  await drag(page, 0, 1, "room");
  await drag(page, 4, 5, "room");
  await cell(page, 5, "room").dblclick();
  await cell(page, 5, "room").getByRole("textbox").fill("Shared");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "4 updated, 0 unchanged" })).toBeVisible();
  expect(await page.evaluate(() => window.bulkFixture.writes.map((write) => write.id))).toEqual(["0", "1", "4", "5"]);
  expect(await page.evaluate(() => window.bulkFixture.writes.every((write) =>
    write.body.attributes.length === 1 && write.body.attributes[0].objectTypeAttributeId === "room"))).toBe(true);
});

test("the existing checkbox batch dialog still updates only its checked assets", async ({ page }) => {
  await open(page);
  await page.getByRole("checkbox", { name: "Select row", exact: true }).first().click();
  await page.getByRole("button", { name: "Update 1", exact: true }).click();
  await page.getByRole("button", { name: "Add attribute" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("Renamed");
  await page.getByRole("button", { name: "Apply to 1 asset" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.bulkFixture.writes)).toEqual([
    { id: "0", body: { objectTypeId: "1", attributes: [{ objectTypeAttributeId: "name", objectAttributeValues: [{ value: "Renamed" }] }] } },
  ]);
});

test("clear optional student references even when the anchor is already empty", async ({ page }) => {
  await open(page);
  await drag(page, 0, 2, "student");
  await cell(page, 0, "student").dblclick();
  await page.getByRole("option", { name: "Clear value" }).click();
  await expect(page.getByRole("status").filter({ hasText: "1 updated, 2 unchanged" })).toBeVisible();
  expect(await page.evaluate(() => window.bulkFixture.writes)).toEqual([
    { id: "1", body: { objectTypeId: "1", attributes: [{ objectTypeAttributeId: "student", objectAttributeValues: [] }] } },
  ]);
});

test("selecting a reference equal to the anchor still updates other highlighted cells and runs batch rules", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.bulkFixture.enableRule());
  await drag(page, 1, 2, "student");
  await cell(page, 1, "student").dblclick();
  await page.getByRole("option", { name: /Sam/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "1 updated, 1 unchanged" })).toBeVisible();
  expect(await page.evaluate(() => window.bulkFixture.writes)).toEqual([
    { id: "2", body: { objectTypeId: "1", attributes: [
      { objectTypeAttributeId: "student", objectAttributeValues: [{ value: "ST-1" }] },
      { objectTypeAttributeId: "status", objectAttributeValues: [{ value: "active" }] },
    ] } },
  ]);
});

test("choice editors can explicitly choose the anchor's current option", async ({ page }) => {
  await open(page);
  await drag(page, 0, 1, "choice");
  await cell(page, 0, "choice").dblclick();
  await page.getByRole("option", { name: "One", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "1 updated, 1 unchanged" })).toBeVisible();
  expect(await page.evaluate(() => window.bulkFixture.writes.map((write) => write.id))).toEqual(["1"]);
});

test("dismissed choice and reference editors never submit a bulk value", async ({ page }) => {
  await open(page);
  await drag(page, 0, 1, "choice");
  await cell(page, 0, "choice").dblclick();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("option")).toHaveCount(0);
  await drag(page, 0, 1, "student");
  await cell(page, 0, "student").dblclick();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("option")).toHaveCount(0);
  expect(await page.evaluate(() => window.bulkFixture.writes)).toEqual([]);
});

test("partial failures are reported and only failed targets are retried", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.bulkFixture.hideUpdated();
    window.bulkFixture.failIds.add("1");
  });
  await drag(page, 0, 2, "room");
  await cell(page, 0, "room").dblclick();
  await cell(page, 0, "room").getByRole("textbox").fill("New room");
  await page.keyboard.press("Enter");
  await expect(page.getByText("DEV-1: Fixture permission denied")).toBeVisible();
  await page.evaluate(() => window.bulkFixture.failIds.clear());
  await page.getByRole("button", { name: "Retry failed" }).click();
  await expect(page.getByRole("status").filter({ hasText: "3 updated, 0 unchanged, 0 failed" })).toBeVisible();
  expect(await page.evaluate(() => window.bulkFixture.writes.map((write) => write.id))).toEqual(["0", "1", "2", "1"]);
});

test("stale targets block the complete selection instead of silently editing a subset", async ({ page }) => {
  await open(page);
  await drag(page, 0, 2, "room");
  await page.evaluate(() => window.bulkFixture.markStale("1"));
  await cell(page, 0, "room").dblclick();
  await expect(cell(page, 0, "room").getByRole("textbox")).toHaveCount(0);
  expect(await page.evaluate(() => window.bulkFixture.writes)).toEqual([]);
});

test("required attributes cannot be cleared in a bulk commit", async ({ page }) => {
  await open(page);
  await drag(page, 0, 2, "room");
  await cell(page, 0, "room").dblclick();
  await cell(page, 0, "room").getByRole("textbox").fill("");
  await page.keyboard.press("Enter");
  await expect(cell(page, 0, "room").getByRole("textbox")).toHaveCount(0);
  expect(await page.evaluate(() => window.bulkFixture.writes)).toEqual([]);
});

test("query changes clear highlighting immediately", async ({ page }) => {
  await open(page);
  await drag(page, 0, 2, "room");
  await page.evaluate(() => window.bulkFixture.setSearch("changed"));
  await expect(highlighted(page)).toHaveCount(0);
});

test("sorting clears highlighting", async ({ page }) => {
  await open(page);
  await drag(page, 0, 2, "room");
  await page.locator("button").filter({ hasText: /^Room$/ }).click();
  await expect(highlighted(page)).toHaveCount(0);
});

test("a changed table context disables failed-only retry", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.bulkFixture.failIds.add("1"));
  await drag(page, 0, 2, "room");
  await cell(page, 0, "room").dblclick();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Retry failed" })).toBeEnabled();
  await page.evaluate(() => window.bulkFixture.setSearch("another"));
  await expect(page.getByRole("button", { name: "Retry failed" })).toBeDisabled();
});

test("hiding the selected column clears highlights and read-only columns cannot be selected", async ({ page }) => {
  await open(page);
  await drag(page, 0, 2, "student");
  await page.evaluate(() => window.bulkFixture.hideStudent());
  await expect(highlighted(page)).toHaveCount(0);
  await drag(page, 0, 2, "key");
  await expect(highlighted(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.bulkFixture.writes)).toEqual([]);
});

test("edge dragging selects across recycled virtual rows without saving on release", async ({ page }) => {
  await open(page);
  const start = await cell(page, 0, "room").boundingBox();
  if (!start) throw new Error("Missing start cell");
  const grid = page.locator("div.overflow-auto.rounded-lg.border");
  const box = await grid.boundingBox();
  if (!box) throw new Error("Missing grid");
  await page.keyboard.down("Control");
  await page.mouse.move(start.x + 30, start.y + 18);
  await page.mouse.down();
  await page.mouse.move(start.x + 30, box.y + box.height - 2, { steps: 5 });
  await expect.poll(() => grid.evaluate((element) => element.scrollTop)).toBeGreaterThan(1000);
  await page.mouse.up();
  await page.keyboard.up("Control");
  await expect(page.getByRole("status").filter({ hasText: /cells highlighted in Room/ })).toBeVisible();
  expect(await page.evaluate(() => window.bulkFixture.writes)).toEqual([]);
});
