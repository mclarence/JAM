import { expect, test, type Locator, type Page } from "@playwright/test";
import type {} from "./fixtures/exportAssets";

const fixture = "/tests/browser/fixtures/exportAssets.html";
const dialog = (page: Page) => page.getByRole("dialog", { name: "Export assets" });
const field = (page: Page, name: "Assets" | "Attributes") =>
  dialog(page).getByRole("combobox", { name, exact: true });

async function choose(page: Page, name: "Assets" | "Attributes", option: string) {
  const trigger = field(page, name);
  await trigger.click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(trigger).toBeFocused();
}

async function visualStyles(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      border: style.borderColor,
      color: style.color,
      radius: style.borderRadius,
      shadow: style.boxShadow,
    };
  });
}

test("both desktop export entry points retain their selection defaults", async ({ page }) => {
  await page.goto(`${fixture}?mode=assets`);
  const exportButton = page.getByRole("button", { name: "Export", exact: true });
  await expect(exportButton).toBeEnabled();
  await exportButton.click();
  await expect(field(page, "Assets")).toHaveText("All matching results, across all pages");
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();

  const firstRow = page.getByRole("checkbox", { name: "Select row", exact: true }).first();
  await firstRow.click();
  await page.getByRole("button", { name: "Export selected", exact: true }).click();
  await expect(field(page, "Assets")).toHaveText("Selected assets (1)");
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(firstRow).toBeChecked();
});

test("defaults export the selected assets and visible columns", async ({ page }) => {
  await page.goto(fixture);
  await expect(field(page, "Assets")).toHaveText("Selected assets (1)");
  await expect(field(page, "Attributes")).toHaveText("Visible columns (1)");
  await dialog(page).getByRole("button", { name: "Export CSV" }).click();
  await expect(dialog(page)).toHaveCount(0);

  expect(await page.evaluate(() => ({
    searches: window.exportFixture.searches,
    requestedIds: window.exportFixture.requestedIds,
    writes: window.exportFixture.writes,
    saveDialogCount: window.exportFixture.saveDialogs.length,
  }))).toEqual({
    searches: [{ query: "objectId IN (2) ORDER BY Key ASC", startAt: 0 }],
    requestedIds: [],
    writes: [{ path: "/fixture/assets.csv", content: "\uFEFFName\r\nDevice 2\r\n" }],
    saveDialogCount: 1,
  });
});

test("pointer and keyboard choices export all matching assets and attributes", async ({ page }) => {
  await page.goto(fixture);
  await choose(page, "Assets", "All matching results, across all pages");

  const attributes = field(page, "Attributes");
  await attributes.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(page.getByRole("option", { name: "Visible columns (1)" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByRole("option", { name: "All available attributes (2)" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(attributes).toHaveText("All available attributes (2)");
  await expect(attributes).toBeFocused();

  await dialog(page).getByRole("button", { name: "Export CSV" }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => ({
    searches: window.exportFixture.searches,
    requestedIds: window.exportFixture.requestedIds,
    writes: window.exportFixture.writes,
  }))).toEqual({
    searches: [{ query: 'objectTypeId = 1 ORDER BY "Name" ASC', startAt: 0 }],
    requestedIds: [],
    writes: [{ path: "/fixture/assets.csv", content: "\uFEFFName,Room\r\nDevice 1,Lab\r\nDevice 2,Office\r\n" }],
  });
});

test("selected assets can be exported with all attributes", async ({ page }) => {
  await page.goto(fixture);
  await choose(page, "Assets", "All matching results, across all pages");
  await choose(page, "Assets", "Selected assets (1)");
  await choose(page, "Attributes", "All available attributes (2)");
  await choose(page, "Attributes", "Visible columns (1)");
  await choose(page, "Attributes", "All available attributes (2)");
  await dialog(page).getByRole("button", { name: "Export CSV" }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => ({
    searches: window.exportFixture.searches,
    requestedIds: window.exportFixture.requestedIds,
    writes: window.exportFixture.writes,
  }))).toEqual({
    searches: [{ query: "objectId IN (2) ORDER BY Key ASC", startAt: 0 }],
    requestedIds: [],
    writes: [{ path: "/fixture/assets.csv", content: "\uFEFFName,Room\r\nDevice 2,Office\r\n" }],
  });
});

test("all matching assets can be exported with visible columns only", async ({ page }) => {
  await page.goto(fixture);
  await choose(page, "Assets", "All matching results, across all pages");
  await dialog(page).getByRole("button", { name: "Export CSV" }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => ({
    searches: window.exportFixture.searches,
    requestedIds: window.exportFixture.requestedIds,
    writes: window.exportFixture.writes,
  }))).toEqual({
    searches: [{ query: 'objectTypeId = 1 ORDER BY "Name" ASC', startAt: 0 }],
    requestedIds: [],
    writes: [{ path: "/fixture/assets.csv", content: "\uFEFFName\r\nDevice 1\r\nDevice 2\r\n" }],
  });
});

test("selected assets are unavailable when the selection is empty", async ({ page }) => {
  await page.goto(`${fixture}?selected=none`);
  await expect(field(page, "Assets")).toHaveText("All matching results, across all pages");
  await field(page, "Assets").click();
  await expect(page.getByRole("option", { name: "Selected assets (0)" })).toBeDisabled();
  await expect(page.getByRole("option", { name: "All matching results, across all pages" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeVisible();
  await expect(field(page, "Assets")).toBeFocused();
});

test("empty column choices preserve the warning and export availability", async ({ page }) => {
  await page.goto(`${fixture}?visible=none`);
  await expect(field(page, "Attributes")).toHaveText("Visible columns (0)");
  await expect(dialog(page).getByRole("status")).toContainText("No visible columns");
  await expect(dialog(page).getByRole("button", { name: "Export CSV" })).toBeDisabled();
  await choose(page, "Attributes", "All available attributes (2)");
  await expect(dialog(page).getByRole("status")).toHaveCount(0);
  await expect(dialog(page).getByRole("button", { name: "Export CSV" })).toBeEnabled();

  await page.goto(`${fixture}?attributes=none`);
  await expect(dialog(page).getByRole("button", { name: "Export CSV" })).toBeDisabled();
  await choose(page, "Attributes", "All available attributes (0)");
  await expect(dialog(page).getByRole("button", { name: "Export CSV" })).toBeDisabled();
});

test("both dropdowns stay disabled during an export and cancellation prevents saving", async ({ page }) => {
  await page.goto(fixture);
  await page.evaluate(() => window.exportFixture.pauseRead());
  await dialog(page).getByRole("button", { name: "Export CSV" }).click();
  await expect(dialog(page).getByRole("button", { name: "Cancel export" })).toBeVisible();
  await expect(field(page, "Assets")).toBeDisabled();
  await expect(field(page, "Attributes")).toBeDisabled();
  await expect(dialog(page).getByRole("button", { name: "Export CSV" })).toBeDisabled();

  await dialog(page).getByRole("button", { name: "Cancel export" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await page.evaluate(async () => {
    window.exportFixture.resumeRead();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(await page.evaluate(() => ({
    requestedIds: window.exportFixture.requestedIds,
    returnedIds: window.exportFixture.returnedIds,
    saveDialogCount: window.exportFixture.saveDialogs.length,
    writes: window.exportFixture.writes,
  }))).toEqual({ requestedIds: [], returnedIds: ["2"], saveDialogCount: 0, writes: [] });
});

test("a failed export re-enables the controls and can be retried", async ({ page }) => {
  await page.goto(fixture);
  await choose(page, "Attributes", "All available attributes (2)");
  await page.evaluate(() => window.exportFixture.failNextRead());
  await dialog(page).getByRole("button", { name: "Export CSV" }).click();
  await expect(dialog(page).getByRole("alert")).toHaveText("Fixture fetch failed");
  await expect(field(page, "Assets")).toBeEnabled();
  await expect(field(page, "Attributes")).toBeEnabled();
  await expect(field(page, "Attributes")).toHaveText("All available attributes (2)");
  await dialog(page).getByRole("button", { name: "Retry export" }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => ({
    requestedIds: window.exportFixture.requestedIds,
    writes: window.exportFixture.writes,
  }))).toEqual({
    requestedIds: [],
    writes: [{ path: "/fixture/assets.csv", content: "\uFEFFName,Room\r\nDevice 2,Office\r\n" }],
  });
});

test("cancelling the save dialog leaves the export choices unchanged", async ({ page }) => {
  await page.goto(fixture);
  await page.evaluate(() => window.exportFixture.setSavePath(null));
  await dialog(page).getByRole("button", { name: "Export CSV" }).click();
  await expect.poll(() => page.evaluate(() => window.exportFixture.saveDialogs.length)).toBe(1);
  await expect(dialog(page).getByRole("button", { name: "Export CSV" })).toBeEnabled();
  await expect(field(page, "Assets")).toHaveText("Selected assets (1)");
  await expect(field(page, "Attributes")).toHaveText("Visible columns (1)");
  expect(await page.evaluate(() => window.exportFixture.writes)).toEqual([]);
});

test("missing selections show a warning before saving and completion retains skipped counts", async ({ page }) => {
  await page.goto(`${fixture}?selected=missing`);
  await dialog(page).getByRole("button", { name: "Export CSV" }).click();
  await expect(dialog(page).getByRole("alert")).toHaveText("Skipped 1 selected assets: 1 not returned by search; 0 matched deletion markers.");
  expect(await page.evaluate(() => window.exportFixture.saveDialogs.length)).toBe(0);
  await dialog(page).getByRole("button", { name: "Continue to save" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByText("Exported 1 assets. Skipped 1 selected assets: 1 not returned by search; 0 matched deletion markers.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => ({
    requestedIds: window.exportFixture.requestedIds,
    writes: window.exportFixture.writes,
  }))).toEqual({ requestedIds: [], writes: [{ path: "/fixture/assets.csv", content: "\uFEFFName\r\nDevice 2\r\n" }] });
});

test("save cancellation clears skipped warnings and retry requires a fresh confirmation", async ({ page }) => {
  await page.goto(`${fixture}?selected=missing`);
  await page.evaluate(() => window.exportFixture.setSavePath(null));
  await dialog(page).getByRole("button", { name: "Export CSV" }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("Skipped 1");
  await dialog(page).getByRole("button", { name: "Continue to save" }).click();
  await expect(dialog(page).getByRole("alert")).toHaveCount(0);
  await expect(dialog(page).getByRole("button", { name: "Export CSV" })).toBeEnabled();
  await dialog(page).getByRole("button", { name: "Export CSV" }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("Skipped 1");
  expect(await page.evaluate(() => window.exportFixture.saveDialogs.length)).toBe(1);
  await dialog(page).getByRole("button", { name: "Cancel export" }).click();
  expect(await page.evaluate(() => window.exportFixture.writes)).toEqual([]);
});

for (const theme of ["light", "dark"] as const) {
  test(`dropdowns match the shared ${theme} style and fit narrow windows`, async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto(`${fixture}?theme=${theme}`);
    const reference = page.getByTestId("reference-trigger");
    const assets = field(page, "Assets");
    const attributes = field(page, "Attributes");
    await dialog(page).getByRole("button", { name: "Cancel", exact: true }).focus();
    expect(await visualStyles(assets)).toEqual(await visualStyles(reference));
    expect(await visualStyles(attributes)).toEqual(await visualStyles(reference));

    await assets.click();
    const menuStyles = await visualStyles(page.getByRole("listbox"));
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeVisible();
    await expect(assets).toBeFocused();
    await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
    await reference.click();
    expect(menuStyles).toEqual(await visualStyles(page.getByRole("listbox")));

    await page.setViewportSize({ width: 296, height: 743 });
    await page.goto(`${fixture}?theme=${theme}`);
    const dimensions = await dialog(page).evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
    for (const [name, option] of [
      ["Assets", "All matching results, across all pages"],
      ["Attributes", "All available attributes (2)"],
    ] as const) {
      await field(page, name).click();
      const menu = page.getByRole("listbox");
      await expect(menu).toBeVisible();
      const bounds = await menu.boundingBox();
      if (!bounds) throw new Error("Missing dropdown bounds");
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(296);
      await page.getByRole("option", { name: option, exact: true }).click();
      await expect(field(page, name)).toHaveText(option);
    }
  });
}
