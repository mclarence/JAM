import { expect, test } from "@playwright/test";
import type {} from "./fixtures/syncSelection";

const fixture = "/tests/browser/fixtures/syncSelection.html";

test("category choices require confirmation, support keyboard input, and can pause sync", async ({ page }) => {
  await page.goto(fixture);
  const columns = page.getByRole("checkbox", { name: "Columns (visibility, order and desktop widths)", exact: true });
  await expect(page.getByRole("checkbox")).toHaveCount(13);
  await expect(columns).toBeChecked();
  await expect(page.getByText("Sync is paused until you confirm", { exact: false })).toBeVisible();
  await columns.focus();
  await page.keyboard.press("Space");
  await expect(columns).not.toBeChecked();
  await page.getByRole("button", { name: "Confirm sync choices", exact: true }).click();
  expect(await page.evaluate(() => window.syncSelectionFixture.selections[0])).not.toContain("columns");
  await page.getByRole("button", { name: "Clear all", exact: true }).click();
  await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Save sync choices", exact: true }).click();
  await expect(page.getByText("Settings sync is paused: no categories", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => window.syncSelectionFixture.selections.at(-1))).toEqual([]);
});

test("review requires explicit choices and invalidates choices when the review changes", async ({ page }) => {
  await page.goto(fixture);
  await page.evaluate(() => window.syncSelectionFixture.review());
  const confirm = page.getByRole("button", { name: "Confirm and sync selected settings", exact: true });
  await expect(confirm).toBeDisabled();
  await page.getByRole("radio", { name: /Use synced version/ }).check();
  await expect(confirm).toBeEnabled();
  await page.evaluate(() => window.syncSelectionFixture.refreshReview());
  await expect(confirm).toBeDisabled();
  await expect(page.getByText('{"hidden":["new-desktop"]}', { exact: true })).toBeVisible();
  await page.getByRole("radio", { name: /Use synced version/ }).check();
  await confirm.click();
  expect(await page.evaluate(() => window.syncSelectionFixture.confirmations)).toEqual([{ "shared|columns:c:w:42": "v2" }]);
});

test("cancelling review does not confirm settings", async ({ page }) => {
  await page.goto(fixture);
  await page.evaluate(() => window.syncSelectionFixture.review());
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await page.evaluate(() => window.syncSelectionFixture.confirmations)).toEqual([]);
  await expect(page.getByText("Settings sync is paused: no categories", { exact: false })).toBeVisible();
});
