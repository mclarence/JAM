import { expect, test } from "@playwright/test";
import type {} from "./fixtures/updateNotes";

const fixture = "/tests/browser/fixtures/updateNotes.html";

test("notes render safely during download and can be reopened when ready", async ({ page }) => {
  let imageRequested = false;
  await page.route("https://example.invalid/**", async (route) => {
    imageRequested = true;
    await route.abort();
  });
  await page.goto(fixture);
  await page.evaluate(() => window.updateNotesFixture.available());
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Improvements" })).toBeVisible();
  await expect(dialog.getByRole("listitem")).toHaveCount(2);
  await expect(dialog.getByRole("link", { name: "Full release" })).toHaveAttribute("href", "https://example.invalid/release");
  await expect(dialog.getByRole("link", { name: "Unsafe link" })).toHaveCount(0);
  await expect(dialog.locator("script, img")).toHaveCount(0);
  expect(imageRequested).toBe(false);
  await expect(dialog.getByText("Downloading update: 50%")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Restart to update" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Later" }).click();
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => window.updateNotesFixture.ready());
  await page.getByRole("button", { name: "View release notes" }).click();
  await expect(dialog.getByRole("button", { name: "Restart to update" })).toBeEnabled();
});

test("What's New works offline and stays dismissed after reload", async ({ page, context }) => {
  await page.goto(fixture);
  await page.evaluate(() => window.updateNotesFixture.installed());
  await context.setOffline(true);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "What's New - 1.2.0" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Restart to update" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Done" }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("updater")!).state.pendingInstall)).toBeNull();
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("missing notes show an explicit message without blocking a ready update", async ({ page }) => {
  await page.goto(fixture);
  await page.evaluate(() => { window.updateNotesFixture.available(" \n "); window.updateNotesFixture.ready(); });
  await expect(page.getByText("No release notes were provided for this update.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Restart to update" })).toBeEnabled();
});
