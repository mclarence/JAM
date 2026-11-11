# Reports: architecture and extension guide

Reports are built from a **local SQLite copy** of the selected Jira Assets data. Running, paging, sorting, charting and exporting a report never contacts Jira; only an explicit **Refresh** does. This guide explains how the pieces fit together and how to add new data, filters, measures and visuals.

## Overview

```
Jira Assets ──(Refresh only)──▶ collect.rs ──▶ reports/<workspace>.sqlite3
                                                    │
 Builder UI ──QuerySpec──▶ reports_run ──▶ query.rs (validated, parameterised SQL)
     ▲                                              │
     └──── Results: table (reports_page) · KPI · charts (reports_chart) · export (reports_export)
```

| Layer | Files | Responsibility |
| --- | --- | --- |
| Collection | `src-tauri/src/reports/collect.rs`, `normalize.rs` | Incremental, rate-limited fetch of inventory and attribute history for a data source; resumable checkpoints |
| Storage | `src-tauri/src/reports/db.rs` | Schema, indexes, staging tables published atomically; one database per Jira workspace in the app data folder (`reports/`) |
| Field catalogue | `src-tauri/src/reports/model.rs` | `FieldDef`s for each entity: type, operators, measures, and how to read the value (`Src`) |
| Query engine | `src-tauri/src/reports/query.rs`, `time.rs` | Compiles a `QuerySpec` (filters, grouping, measures, sort) to SQL; time zones and week/month buckets |
| Commands | `src-tauri/src/reports/mod.rs`, `export.rs` | Tauri commands, cached runs (`runId`), paging, charts, CSV/JSON export |
| Contracts | `src/lib/reports/types.ts`, `src/api/reports.ts` | TypeScript mirror of the Rust types and typed command wrappers |
| Saved reports | `src/lib/reports/model.ts`, `src/store/reports.ts` | Validation of saved/synced/imported records; persisted sources, reports and device-local name matches |
| UI | `src/pages/ReportsPage.tsx`, `src/components/reports/*` | Builder, filter editor, results, refresh and name-matching dialogs |
| Visuals | `src/lib/reports/visuals.ts`, `src/components/reports/visuals.tsx`, `print.ts` | Which views suit a result, Recharts rendering, printable PDF summary |

The UI is metadata-driven: everything it offers comes from `reports_fields`. Nothing in the frontend is specific to a workflow such as borrowing; a "student borrowing count" is just a saved `QuerySpec`:

```jsonc
{
  "v": 1, "entity": "events", "mode": "aggregate", "timezone": "Australia/Sydney",
  "filter": { "kind": "group", "join": "and", "children": [
    { "kind": "condition", "field": "event.newObject", "op": "in", "value": ["STU-12"] },
    { "kind": "condition", "field": "event.operation", "op": "in", "value": ["assigned", "reassigned"] },
    { "kind": "condition", "field": "event.created", "op": "last", "value": { "amount": 3, "unit": "month" } }
  ] },
  "groupBy": [{ "field": "event.created", "bucket": "week" }],
  "measures": [{ "id": "count", "fn": "count" }]
}
```

## Concepts

- **Data source** (`ReportSource`): up to 20 object types plus an optional scope AQL. Only assets matching the scope are collected. `attributeAliases` maps an attribute ID to its former names, so history recorded before a rename is still matched.
- **Entities**: `assets` (one row per asset with current values) and `events` (one row per attribute change from the history log).
- **Fields**: `asset.*` built-ins, `attr:<attributeId>` for every collected attribute, and `event.*` for history. References display their object label, falling back to the recorded historical name. Label-only history is included in filtering, grouping, counts, charts and exports without matching. Such names are grouped by their exact recorded text within the attribute, not guessed to be a particular object. Optional device-local mappings ("Match names") can link these names to a known object key; the known object's label is preferred, with the recorded name as fallback. Bare keys are displayed only when no label is available. Plain comma-containing names are preserved intact unless explicit keyed or mapped entries establish a list.
- **Historical versus current attributes**: in History reports, `attr:<attributeId>` fields are labelled "(current)" and always read the asset's latest collected values. Reference attributes also expose `event.attr:<attributeId>:added`, `:removed`, `:old` and `:new` under **Historical attributes**, labelled "(added)", "(removed)", "(previous)" and "(new)". These read only the references recorded in a change to that specific attribute. For borrowing counts, group by **Assigned to student (added)** and filter that field to **is not empty**, together with your date range. This includes past borrowers rather than grouping all historical activity under current students; returns and unrelated attribute changes do not count. Matching historical names is optional, not a prerequisite for inclusion. Existing saved reports keep their current-value semantics until you explicitly change their fields; no Jira refresh is needed to use these fields on already-collected history. Cached events are automatically re-normalized locally when the normalization version changes.
- **Modes**: `detail` (rows and chosen columns, paged by the engine) and `aggregate` (up to 2 groupings and 8 measures). Time groupings use day, week (Monday start) or month buckets in the report's IANA time zone.
- **Runs**: `reports_run` returns the first page and a `runId`. Later pages, sorts, charts and exports reuse the cached run. If the data changes (refresh or name matching), the engine answers with the `stale` error kind and the UI re-runs once.

## Adding things

### A field on an existing entity

Add a `FieldDef` in `catalogue()` (`model.rs`). For a single column value, use `scalar(id, label, category, type, keySql, displaySql, picker)`. `keySql` is compared, grouped and counted; `displaySql` is shown. Operators and measures follow the `FieldType` automatically. Set `options` for a fixed choice list (enum fields), or `picker: true` to let the filter editor search values from local data (`reports_field_values`; add a special case in `field_values` in `mod.rs` if the value is not a plain column).

No frontend change is needed: the builder, filter chips, grouping, measures, table formatting and chart labels are all driven by the catalogue.

### A data source / entity

1. Collect and store the data: add tables in `db.rs` (with indexes for the filters you expect) and populate them in `collect.rs` inside the staging/publish flow, so a refresh never exposes half-written data.
2. Add the variant to `Entity` in `model.rs` and the TypeScript `Entity` union in `types.ts`, plus a label in `ENTITY_LABELS` (`src/lib/reports/model.ts`) and the `parseSpec` entity check.
3. In `query.rs`, give the entity a base `FROM` clause and owner alias (see `Compiler::owner`/`sub`), default detail columns (`default_columns`) and default sort.
4. Add its fields in `catalogue()`.
5. Add Rust tests in `tests.rs` for filtering, grouping and paging on the new entity.

### A filter operator

1. Add the operator to `FieldType::operators()` for the types that support it.
2. Compile it in `Compiler::positive` (or `date_bounds` for date operators) in `query.rs`. **Always bind values as parameters** (`self.push(...)`); never format user input into SQL.
3. Add a label in `OPERATOR_LABELS` and, if it needs a new kind of value, a `ValueKind` with its default, validation (`conditionProblem`), description (`describeCondition`) and editor (`ConditionForm` in `FilterEditor.tsx`).

Negated operators (`neq`, `notIn`, `notContains`) are compiled as the negation of the positive form, including for multi-valued fields, so they mean "no value matches".

### A measure

1. Add the function name to `FieldType::measures()` for the types that support it (or handle it like `count`, which needs no field).
2. Add a `MeasurePlan` in `measure_plan()` (`query.rs`) and a label in `measure_label()`.
3. Add it to `MeasureFn` in `types.ts`, `MEASURE_LABELS` and `MEASURE_FNS` in `model.ts`. If shares of it do not add up to a whole, leave it out of the pie-chart rule in `visuals.ts`.

### A visualization

1. Add the id to `VISUALS` in `src/lib/reports/model.ts`.
2. Add a `VisualRule` to `VISUAL_RULES` in `src/lib/reports/visuals.ts`. `unsupported(ctx)` returns a reason shown on the disabled tab; reports are never rewritten to fit a chart.
3. Render it: charts go in `renderChart` (`src/components/reports/visuals.tsx`) using Recharts and the shaped `{data, series}` from `shapeChart`; other views get a branch in `Results.tsx`. Use `PALETTE` hex colours so the printable summary can copy the SVG into the PDF.

## Limits and performance

- Up to 20 object types per source, 100 filter nodes nested 5 deep, 1000 values per list filter, 2 groupings, 8 measures and 50 detail columns. The same limits are enforced in Rust and in `parseSpec`, so synced or imported reports cannot bypass them.
- Detail results are paged by the engine (100 rows per page); aggregates keep at most 50,000 groups and flag truncation. Charts draw at most 50 groups (the rest are combined into a re-measured "Other"), or 1000 time points.
- History events are indexed for the common report shapes (time range, attribute, referenced object). With 1 million events, counting one student's borrowing over 90 days takes about 0.6 s, and grouping all students by week over 3 months about 4 s.

## Refresh and privacy

- Jira is contacted only when the user starts a refresh after reviewing an estimate. Refreshes are incremental: inventory is re-read (paged), but history is only fetched for new assets, assets whose `updated` time changed, and assets whose history previously failed. A full refresh refetches all history and is limited to once an hour.
- Requests are limited to 4 concurrent and 5 per second by default (adjustable from 1–8 and 0.2–20 per second), honour `Retry-After`, and back off on HTTP 429/5xx. An interrupted refresh resumes from saved checkpoints.
- Collected data stays on the device until the user clears it (Refresh dialog → Clear local data, or deleting the data source). It is never synced or included in settings backups.
- Report templates and data source definitions can sync between computers in the opt-in **Report templates and data sources** category (desktop scope; iOS never receives them). Name matches and results are device-local. Deleting a data source on another computer removes its definition here, but local collected data is only removed when deleted on this computer.
