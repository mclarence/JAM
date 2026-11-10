import { expect, test } from "@playwright/test";
import type {} from "./fixtures/deletion";

const fixture = "/tests/browser/fixtures/deletion.html";

test("deletion requires explicit configuration and confirmation", async ({ page }) => {
  await page.goto(`${fixture}?unconfigured`);
  await expect(page.getByRole("button", { name: "Delete asset", exact: true })).toBeDisabled();
  await page.goto(fixture);
  await expect(page.getByTestId("asset-list")).toHaveText("Device 1");
  await page.getByRole("button", { name: "Delete asset", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Asset Tag = DELETED");
  await expect(page.getByRole("dialog")).toContainText("Room = Retired storage");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await page.evaluate(() => window.deletionFixture.writes)).toEqual([]);
  await expect(page.getByTestId("asset-list")).toHaveText("Device 1");
});

test("soft deletion waits for server success, reports failures and retries without losing the row", async ({ page }) => {
  await page.goto(fixture);
  await expect(page.getByTestId("asset-list")).toHaveText("Device 1");
  await page.evaluate(() => { window.deletionFixture.pause(); window.deletionFixture.fail("validation"); });
  await page.getByRole("button", { name: "Delete asset", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Delete asset", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Deleting…" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("asset-list")).toHaveText("Device 1");
  await page.evaluate(() => window.deletionFixture.resume());
  await expect(dialog.getByRole("alert")).toHaveText("Marker value rejected by Jira");
  await expect(page.getByTestId("asset-list")).toHaveText("Device 1");
  await dialog.getByRole("button", { name: "Delete asset", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("asset-list")).toBeEmpty();
  const writes = await page.evaluate(() => window.deletionFixture.writes);
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual({
    method: "PUT", id: "1", body: { objectTypeId: "2", attributes: [
      { objectTypeAttributeId: "10", objectAttributeValues: [{ value: "DELETED" }] },
      { objectTypeAttributeId: "11", objectAttributeValues: [{ value: "Retired storage" }] },
    ] },
  });
});

test("permanent deletion reports permission errors and never falls back to PUT", async ({ page }) => {
  await page.goto(`${fixture}?method=permanent`);
  await page.evaluate(() => window.deletionFixture.fail("permission"));
  await page.getByRole("button", { name: "Delete asset", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("cannot be undone");
  await dialog.getByRole("button", { name: "Delete asset", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Jira object-delete permission");
  await expect(page.getByTestId("asset-list")).toHaveText("Device 1");
  expect(await page.evaluate(() => window.deletionFixture.writes)).toEqual([{ method: "DELETE", id: "1" }]);
});

test("settings require a suitable marker and retain it when switching to permanent deletion", async ({ page }) => {
  await page.goto(`${fixture}?settings`);
  const save = page.getByRole("button", { name: "Save deletion settings", exact: true });
  await expect(save).toBeDisabled();
  await page.getByRole("combobox", { name: "Deletion marker attribute" }).click();
  await expect(page.getByRole("option", { name: "Notes", exact: true })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "Locked", exact: true })).toHaveCount(0);
  await page.getByRole("option", { name: "Asset Tag", exact: true }).click();
  await page.getByRole("textbox", { name: "Asset Tag value" }).fill("DELETED");
  await page.getByRole("combobox", { name: "Additional deletion attribute" }).click();
  await expect(page.getByRole("option", { name: "Asset Tag", exact: true })).toHaveCount(0);
  await page.getByRole("option", { name: "Room", exact: true }).click();
  await page.getByRole("textbox", { name: "Room value" }).fill("Retired storage");
  await save.click();
  await expect.poll(() => page.evaluate(() => window.deletionFixture.config())).toMatchObject({
    method: "soft", marker: { attributeId: "10", value: { raw: "DELETED" } },
    additional: { attributeId: "11", value: { raw: "Retired storage" } },
  });
  await page.getByRole("combobox", { name: "Deletion method" }).click();
  await page.getByRole("option", { name: "Permanently delete from Jira", exact: true }).click();
  await save.click();
  await expect.poll(() => page.evaluate(() => window.deletionFixture.config())).toMatchObject({
    method: "permanent", marker: { attributeId: "10", value: { raw: "DELETED" } },
  });
});

test("bulk deletion continues past failures, retries only the failed objects and removes deleted rows", async ({ page }) => {
  await page.goto(`${fixture}?bulk`);
  await expect(page.getByTestId("asset-list")).toHaveText("Device 1Device 2Device 3");
  await page.evaluate(() => window.deletionFixture.failOnce("2"));
  await page.getByRole("button", { name: "Delete selected" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Soft delete 3 assets?");
  await expect(dialog).toContainText("Asset Tag = DELETED");
  await expect(dialog).toContainText("hide these assets");
  await dialog.getByRole("button", { name: "Delete 3 assets" }).click();
  await expect(dialog).toContainText("2 deleted, 1 failed.");
  await expect(dialog).toContainText("Jira rejected 2");
  await expect(page.getByTestId("asset-list")).toHaveText("Device 2");
  await dialog.getByRole("button", { name: "Retry failed" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("asset-list")).toBeEmpty();
  const writes = await page.evaluate(() => window.deletionFixture.writes);
  expect(writes.map((w) => `${w.method} ${w.id}`).sort()).toEqual(["PUT 1", "PUT 2", "PUT 2", "PUT 3"]);
});
