import { expect, test, type Page } from "@playwright/test";
import type {} from "./fixtures/reports";

const fixture = "/tests/browser/fixtures/reports.html";
const calls = (page: Page, command: string) =>
  page.evaluate((c) => window.reportsFixture.calls.filter((x) => x.command === c).map((x) => x.payload), command);

async function addFilter(page: Page, field: string) {
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByRole("option", { name: field, exact: true }).click();
}

test("builds, runs, charts, exports and saves a student borrowing report without contacting Jira", async ({ page }) => {
  await page.goto(fixture);
  await expect(page.getByRole("combobox", { name: "Data source" })).toHaveText("Student laptops");
  const run = page.getByRole("button", { name: "Run", exact: true });
  await expect(run).toBeEnabled();

  // Borrower = Jane, change type = assigned or reassigned.
  await addFilter(page, "New objects");
  await page.getByRole("option", { name: /Jane Student/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "New objects is any of Jane Student" })).toBeVisible();
  await addFilter(page, "Change type");
  await page.getByRole("option", { name: "Assigned", exact: true }).click();
  await page.getByRole("option", { name: "Reassigned", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Change type is any of Assigned, Reassigned" })).toBeVisible();

  // Count per week.
  await page.getByRole("button", { name: "Grouping", exact: true }).click();
  await page.getByRole("option", { name: "Changed at", exact: true }).click();
  await page.getByRole("combobox", { name: "Interval" }).click();
  await page.getByRole("option", { name: "Week (Mon)" }).click();
  await page.getByRole("textbox", { name: "Report name" }).fill("Jane borrowing");
  await run.click();

  const table = page.getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(4);
  await expect(table.getByRole("row").nth(1)).toContainText(/Week of Jan 5, 2026\s*2/);
  await expect(table.getByRole("row").nth(3)).toContainText(/Week of Jan 19, 2026\s*1/);
  const [spec] = await page.evaluate(() => window.reportsFixture.specs);
  expect(spec).toMatchObject({
    entity: "events",
    mode: "aggregate",
    groupBy: [{ field: "event.created", bucket: "week" }],
    measures: [{ id: "count", fn: "count" }],
    softDelete: [],
    filter: { kind: "group", join: "and", children: [
      { kind: "condition", field: "event.newObject", op: "in", value: ["STU-1"] },
      { kind: "condition", field: "event.operation", op: "in", value: ["assigned", "reassigned"] },
    ] },
  });

  // Sorting is done by the engine, not in the browser.
  await table.getByRole("button", { name: "Records" }).click();
  await expect(table.getByRole("columnheader", { name: "Records" })).toHaveAttribute("aria-sort", "descending");
  await expect.poll(() => calls(page, "reports_page")).toContainEqual(expect.objectContaining({ sort: { column: "m:count", desc: true }, offset: 0 }));
  await expect(table.getByRole("row").nth(1)).toContainText(/2$/);

  // Visuals: breakdowns are refused for time series with a reason; line and KPI render.
  const tabs = page.getByRole("tablist", { name: "Visualization" });
  await expect(tabs.getByRole("tab", { name: "Breakdown (pie)" })).toHaveAttribute("aria-disabled", "true");
  await tabs.getByRole("tab", { name: "KPI cards" }).click();
  await expect(page.getByText("Records", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("4", { exact: true }).first()).toBeVisible();
  await tabs.getByRole("tab", { name: "Line chart" }).click();
  await expect(page.locator("svg.recharts-surface .recharts-line")).toHaveCount(1);
  expect((await calls(page, "reports_chart"))[0]).toMatchObject({ measure: 0, top: 10 });

  // Exports cover every row through the engine; the summary renders the live chart into a PDF.
  await page.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: "CSV" }).click();
  await expect.poll(() => calls(page, "reports_export")).toEqual([expect.objectContaining({ path: "/fixture/report.csv", format: "csv", name: "Jane borrowing" })]);
  await page.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: "Open printable summary" }).click();
  await expect.poll(async () => ((await calls(page, "open_pdf"))[0]?.dataB64 as string | undefined)?.length ?? 0).toBeGreaterThan(1000);

  // Saving keeps the query and the chosen view, never the results.
  await expect(page.getByText("Unsaved")).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Unsaved")).toHaveCount(0);
  const [saved] = await page.evaluate(() => window.reportsFixture.reports());
  expect(saved).toMatchObject({ name: "Jane borrowing", sourceId: "src-1", view: { visual: "line" }, spec: { groupBy: [{ field: "event.created", bucket: "week" }] } });
  expect(saved.spec).not.toHaveProperty("softDelete");
  await expect(page.getByRole("button", { name: "Jane borrowing" }).first()).toBeVisible();

  const network = (await page.evaluate(() => window.reportsFixture.calls.map((c) => c.command))).filter((c) => c === "reports_refresh" || c === "reports_estimate");
  expect(network).toEqual([]);
});

test("collects data only after an estimate and an explicit start", async ({ page }) => {
  await page.goto(`${fixture}?collected=no`);
  const run = page.getByRole("button", { name: "Run", exact: true });
  await expect(run).toBeDisabled();
  await expect(run).toHaveAttribute("title", /Refresh the data source/);

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: 'Refresh "Student laptops"' });
  await dialog.getByRole("button", { name: "Check what to fetch" }).click();
  await expect(dialog.getByText(/3 assets in scope\. About 6 Jira requests/)).toBeVisible();
  await expect(dialog.getByText(/First refresh/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Full refresh" })).toBeDisabled();
  expect(await page.evaluate(() => window.reportsFixture.refreshes)).toEqual([]);

  await dialog.getByRole("button", { name: "Start refresh" }).click();
  await expect.poll(() => page.evaluate(() => window.reportsFixture.refreshes)).toEqual([{ full: false, settings: { concurrency: 4, requestsPerSecond: 5 } }]);
  await page.keyboard.press("Escape");
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(2);
});

test("groups historical students separately from current assignments", async ({ page }) => {
  await page.goto(`${fixture}?labels=yes`);
  await expect(page.getByText(/Use historical attributes/)).toBeVisible();
  await page.getByRole("button", { name: "Grouping", exact: true }).click();
  await expect(page.getByRole("option", { name: "Assigned to student (current)", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "Assigned to student (added)", exact: true }).click();
  await addFilter(page, "Assigned to student (added)");
  await page.getByRole("combobox", { name: "Operator" }).click();
  await page.getByRole("option", { name: "is not empty", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  const table = page.getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(5);
  for (const student of ["Jane Student", "Sam Learner", "Lee Pupil", "Unmatched Student"]) {
    await expect(table.getByRole("cell", { name: student, exact: true })).toBeVisible();
  }
  await page.getByRole("tab", { name: "Bar chart", exact: true }).click();
  await expect(page.locator("svg.recharts-surface")).toBeVisible();
  await expect(page.locator("svg.recharts-surface")).toContainText("Unmatched Student");
  await expect(page.locator("svg.recharts-surface")).not.toContainText("label:11:");
  const [spec] = await page.evaluate(() => window.reportsFixture.specs);
  expect(spec.groupBy).toEqual([{ field: "event.attr:11:added" }]);
  expect(spec.filter).toMatchObject({ children: [{ field: "event.attr:11:added", op: "notEmpty" }] });
});
