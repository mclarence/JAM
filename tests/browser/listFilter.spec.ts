import { expect, test, type Page } from "@playwright/test";
import type {} from "./fixtures/exportAssets";

const fixture = "/tests/browser/fixtures/exportAssets.html?mode=list";
const dialog = (page: Page) => page.getByRole("dialog", { name: "Filter by list" });

async function choose(page: Page, field: string, value: string) {
  await dialog(page).getByRole("combobox", { name: field }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
}

test("applies a list across pages, counts, exports and saved filters", async ({ page }) => {
  await page.goto(fixture);
  await expect(page.getByRole("button", { name: "Paste list" })).toBeVisible();
  await page.getByRole("button", { name: "Paste list" }).click();
  await expect(dialog(page).getByRole("button", { name: "Apply" })).toBeDisabled();
  await choose(page, "Field", "Room");
  await dialog(page).getByLabel("Values").fill(" Lab \nOffice\nLab\n\n");
  await expect(dialog(page).getByText("2 distinct values")).toBeVisible();
  await dialog(page).getByRole("button", { name: "Cancel" }).click();

  await page.evaluate(() => window.exportFixture.setSearch("unrelated"));
  await page.waitForTimeout(350);
  const rawAql = page.getByPlaceholder("AQL filter,", { exact: false });
  await rawAql.fill('"Room" = "old draft"');
  await page.getByRole("button", { name: "Paste list" }).click();
  await dialog(page).getByRole("button", { name: "Apply" }).click();
  const expression = '("Room" = "Lab" OR "Room" = "Office")';
  await expect(rawAql).toHaveValue(expression);
  await expect.poll(() => page.evaluate(() => window.exportFixture.currentSearch())).toBe("");
  await page.waitForTimeout(400);
  await expect(rawAql).toHaveValue(expression);
  await expect(page.getByText("Showing 2 Devices objects", { exact: false })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.exportFixture.searches.some((s) => s.startAt === 1))).toBe(true);
  const queries = await page.evaluate(() => ({
    searches: window.exportFixture.searches,
    counts: window.exportFixture.counts,
  }));
  expect(queries.searches.some((s) => s.query.includes(expression) && s.startAt === 1)).toBe(true);
  expect(queries.counts.some((query) => query.includes(expression))).toBe(true);
  expect(queries.searches.at(-1)?.query).not.toContain("unrelated");

  await page.getByRole("button", { name: "Save filter" }).click();
  await page.getByRole("dialog", { name: "Save AQL preset" }).getByLabel("Name").fill("Rooms");
  await page.getByRole("dialog", { name: "Save AQL preset" }).getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Clear AQL" }).click();
  await page.getByRole("button", { name: "Rooms", exact: true }).click();
  await expect(rawAql).toHaveValue(expression);
  await expect(page.getByRole("button", { name: "Export", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("dialog", { name: "Export assets" }).getByRole("button", { name: "Export CSV" }).click();
  await expect.poll(() => page.evaluate(() => window.exportFixture.writes.length)).toBe(1);
  expect((await page.evaluate(() => window.exportFixture.searches)).at(-1)?.query).toContain(expression);
});

test("supports contains and reports Jira errors without showing old rows", async ({ page }) => {
  await page.goto(fixture);
  await page.getByRole("button", { name: "Paste list" }).click();
  await choose(page, "Field", "Room");
  await choose(page, "Match", "Contains");
  await dialog(page).getByLabel("Values").fill("Lab");
  await dialog(page).getByRole("button", { name: "Apply" }).click();
  await expect(page.getByPlaceholder("AQL filter,", { exact: false })).toHaveValue('("Room" LIKE "Lab")');
  await expect(page.getByText("Showing 1 Devices objects", { exact: false })).toBeVisible();
  await expect(page.getByText("Device 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Device 2", { exact: true })).toHaveCount(0);

  await page.evaluate(() => window.exportFixture.setListError("Jira rejected this query"));
  await page.getByRole("button", { name: "Paste list" }).click();
  await dialog(page).getByLabel("Values").fill("Different");
  await dialog(page).getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("Jira rejected this query")).toBeVisible();
  await expect(page.getByText("Device 1", { exact: true })).toHaveCount(0);
  await expect(page.getByText("No objects match")).toHaveCount(0);
});

test("does not restore an old select-all result after applying a new list", async ({ page }) => {
  await page.goto(`${fixture}&pausePage=1`);
  await page.getByRole("checkbox", { name: "Select row", exact: true }).first().check();
  await page.getByRole("button", { name: "Select all 2 matching" }).click();
  await page.getByRole("button", { name: "Paste list" }).click();
  await choose(page, "Field", "Room");
  await dialog(page).getByLabel("Values").fill("Lab");
  await dialog(page).getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("Showing 1 Devices objects", { exact: false })).toBeVisible();
  await page.evaluate(() => window.exportFixture.resumePage());
  await expect.poll(() => page.evaluate(() => window.exportFixture.completedPages.includes(1))).toBe(true);
  await expect(page.getByRole("checkbox", { name: "Select row", exact: true })).not.toBeChecked();
  await expect(page.getByText("selected", { exact: false })).toHaveCount(0);
});
