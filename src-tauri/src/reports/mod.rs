//! Reporting engine: a local SQLite store filled from Jira on explicit refresh, and a metadata-driven query
//! builder over it. Running, paging, charting and exporting reports never call Jira.

pub mod collect;
pub mod db;
pub mod export;
pub mod model;
pub mod normalize;
pub mod query;
pub mod time;

#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use self::collect::{Estimate, Fetch, Progress, Settings, Summary, Tuning};
use self::db::{data_version, db_err, existing_dataset_id};
use self::model::{catalogue, find, Dataset, Entity, FieldDef, FieldOption, Mode, Node, QuerySpec, Sort, Src};
use self::query::{AggResult, AggRow, Column, DetailPlan, OTHER_OP};
use crate::connection::AppState;
use crate::error::{AppError, AppResult};
use crate::http::{Failure, Principal};

pub fn hash_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    digest.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

const MAX_RUNS: usize = 16;
const MAX_PAGE: i64 = 500;
const MAX_CHART_TOP: usize = 50;
const MAX_CHART_POINTS: usize = 1000;
const MAX_CHART_ROWS: usize = 5000;

/// Separate connections so a long report query never blocks collection writes (SQLite WAL allows both).
#[derive(Clone)]
struct Db {
    read: Arc<Mutex<Connection>>,
    write: Arc<Mutex<Connection>>,
}

enum RunKind {
    Detail { plan: DetailPlan, total: i64 },
    Aggregate(AggResult),
}

struct Run {
    namespace: String,
    ds: i64,
    version: i64,
    spec: QuerySpec,
    now_ms: i64,
    kind: RunKind,
}

#[derive(Default)]
pub struct ReportsState {
    dbs: Mutex<HashMap<String, Db>>,
    runs: Mutex<VecDeque<(String, Arc<Run>)>>,
    refresh: Mutex<Option<(String, Arc<AtomicBool>)>>,
}

fn principal(state: &AppState) -> AppResult<Principal> {
    let c = state.current()?;
    Ok(Principal { cloud_id: c.cloud_id, workspace_id: c.workspace_id, email: c.email.to_lowercase() })
}

fn namespace(p: &Principal) -> String {
    hash_hex(&format!("{}\u{0}{}\u{0}{}", p.cloud_id, p.workspace_id, p.email))
}

fn check_dataset(dataset: &Dataset, p: &Principal) -> AppResult<()> {
    dataset.validate()?;
    if dataset.cloud_id != p.cloud_id || dataset.workspace_id != p.workspace_id {
        return Err(AppError::Invalid("This data source belongs to a different Jira workspace.".into()));
    }
    Ok(())
}

impl ReportsState {
    fn db(&self, app: &AppHandle, ns: &str) -> AppResult<Db> {
        let mut dbs = self.dbs.lock().expect("reports lock");
        if let Some(db) = dbs.get(ns) {
            return Ok(db.clone());
        }
        let dir = app.path().app_data_dir().map_err(|e| AppError::Io(e.to_string()))?.join("reports");
        let path = dir.join(format!("{ns}.sqlite3"));
        let write = db::open(&path)?;
        let read = db::open(&path)?;
        let db = Db { read: Arc::new(Mutex::new(read)), write: Arc::new(Mutex::new(write)) };
        dbs.insert(ns.to_string(), db.clone());
        Ok(db)
    }

    fn store_run(&self, run: Run) -> String {
        let id = hash_hex(&format!("{}{}", time::now_ms(), rand_suffix()));
        let mut runs = self.runs.lock().expect("reports lock");
        runs.push_back((id.clone(), Arc::new(run)));
        while runs.len() > MAX_RUNS {
            runs.pop_front();
        }
        id
    }

    fn run(&self, id: &str) -> AppResult<Arc<Run>> {
        self.runs
            .lock()
            .expect("reports lock")
            .iter()
            .find(|(r, _)| r == id)
            .map(|(_, r)| r.clone())
            .ok_or(AppError::Stale)
    }

    fn forget_runs(&self, ns: &str) {
        self.runs.lock().expect("reports lock").retain(|(_, r)| r.namespace != ns);
    }
}

fn rand_suffix() -> String {
    let mut b = [0u8; 8];
    let _ = getrandom::fill(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| AppError::Io(format!("Report task failed: {e}")))?
}

/// Context for commands that act on one data source of the connected account.
fn open(app: &AppHandle, dataset: &Dataset) -> AppResult<(String, Db, Principal)> {
    let state = app.state::<AppState>();
    let p = principal(&state)?;
    check_dataset(dataset, &p)?;
    let ns = namespace(&p);
    let db = app.state::<ReportsState>().db(app, &ns)?;
    Ok((ns, db, p))
}

#[derive(Clone)]
struct JiraFetch {
    app: AppHandle,
    principal: Principal,
}

impl Fetch for JiraFetch {
    fn send(
        &self,
        method: &'static str,
        path: String,
        query: Vec<(String, String)>,
        body: Option<Value>,
    ) -> impl std::future::Future<Output = Result<Value, Failure>> + Send {
        let app = self.app.clone();
        let principal = self.principal.clone();
        async move {
            let state = app.state::<AppState>();
            crate::http::send(&state, Some(&principal), method, &path, Some(&query), body.as_ref()).await
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub collected: bool,
    pub last_refresh_ms: Option<i64>,
    pub last_full_ms: Option<i64>,
    pub last_error: Option<String>,
    pub assets: i64,
    pub unavailable_assets: i64,
    pub events: i64,
    pub histories_failed: i64,
    pub histories_denied: i64,
    pub histories_missing: i64,
    pub unresolved_events: i64,
    pub scope_changed: bool,
    pub resumable: i64,
    pub refreshing: bool,
    pub data_version: i64,
    pub full_cooldown_ms: i64,
}

fn status_of(conn: &Connection, dataset: &Dataset, refreshing: bool) -> AppResult<Status> {
    let Some(ds) = existing_dataset_id(conn, &dataset.id)? else {
        return Ok(Status {
            collected: false,
            last_refresh_ms: None,
            last_full_ms: None,
            last_error: None,
            assets: 0,
            unavailable_assets: 0,
            events: 0,
            histories_failed: 0,
            histories_denied: 0,
            histories_missing: 0,
            unresolved_events: 0,
            scope_changed: false,
            resumable: 0,
            refreshing,
            data_version: 0,
            full_cooldown_ms: 0,
        });
    };
    let (last_refresh_ms, last_full_ms, last_error, scope_hash, version): (Option<i64>, Option<i64>, Option<String>, Option<String>, i64) = conn
        .query_row(
            "SELECT last_refresh_ms, last_full_ms, last_error, scope_hash, data_version FROM datasets WHERE ds_id = ?1",
            params![ds],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .map_err(db_err)?;
    let count = |sql: &str| -> AppResult<i64> { conn.query_row(sql, params![ds], |r| r.get(0)).map_err(db_err) };
    Ok(Status {
        collected: last_refresh_ms.is_some(),
        last_refresh_ms,
        last_full_ms,
        last_error,
        assets: count("SELECT COUNT(*) FROM objects WHERE ds_id = ?1")?,
        unavailable_assets: count("SELECT COUNT(*) FROM members WHERE ds_id = ?1 AND present = 0")?,
        events: count("SELECT COUNT(*) FROM events WHERE ds_id = ?1")?,
        histories_failed: count("SELECT COUNT(*) FROM members WHERE ds_id = ?1 AND present = 1 AND history_state = 'failed'")?,
        histories_denied: count("SELECT COUNT(*) FROM members WHERE ds_id = ?1 AND history_state = 'denied'")?,
        histories_missing: count("SELECT COUNT(*) FROM members WHERE ds_id = ?1 AND history_state = 'missing'")?,
        unresolved_events: count("SELECT COUNT(*) FROM events WHERE ds_id = ?1 AND resolution = 'unresolved'")?,
        scope_changed: scope_hash.is_some_and(|h| h != dataset.scope_hash()),
        resumable: count("SELECT COUNT(*) FROM history_stage WHERE ds_id = ?1 AND state <> 'failed'")?,
        refreshing,
        data_version: version,
        full_cooldown_ms: last_full_ms.map(|l| (l + collect::FULL_COOLDOWN_MS - time::now_ms()).max(0)).unwrap_or(0),
    })
}

fn is_refreshing(app: &AppHandle, dataset_id: &str) -> bool {
    app.state::<ReportsState>().refresh.lock().expect("reports lock").as_ref().is_some_and(|(id, _)| id == dataset_id)
}

#[tauri::command]
pub async fn reports_status(app: AppHandle, dataset: Dataset) -> AppResult<Status> {
    let (_, db, _) = open(&app, &dataset)?;
    let refreshing = is_refreshing(&app, &dataset.id);
    blocking(move || status_of(&db.read.lock().expect("report db lock"), &dataset, refreshing)).await
}

#[tauri::command]
pub async fn reports_fields(app: AppHandle, dataset: Dataset, entity: Entity) -> AppResult<Vec<FieldDef>> {
    let (_, db, _) = open(&app, &dataset)?;
    blocking(move || {
        let conn = db.read.lock().expect("report db lock");
        let ds = existing_dataset_id(&conn, &dataset.id)?.unwrap_or(-1);
        catalogue(&conn, ds, entity)
    })
    .await
}

#[tauri::command]
pub async fn reports_estimate(app: AppHandle, dataset: Dataset, settings: Settings) -> AppResult<Estimate> {
    settings.validate()?;
    let (_, db, principal) = open(&app, &dataset)?;
    let fetch = JiraFetch { app: app.clone(), principal };
    collect::estimate(&db.write, &dataset, settings, fetch, time::now_ms()).await
}

#[tauri::command]
pub async fn reports_refresh(app: AppHandle, dataset: Dataset, full: bool, settings: Settings, on_progress: Channel<Progress>) -> AppResult<Summary> {
    let (ns, db, principal) = open(&app, &dataset)?;
    let reports = app.state::<ReportsState>();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut slot = reports.refresh.lock().expect("reports lock");
        if slot.is_some() {
            return Err(AppError::Invalid("Another data source is refreshing. Wait for it to finish or cancel it.".into()));
        }
        *slot = Some((dataset.id.clone(), cancel.clone()));
    }
    let fetch = JiraFetch { app: app.clone(), principal };
    let progress = move |p: Progress| {
        let _ = on_progress.send(p);
    };
    let result = collect::refresh(db.write.clone(), &dataset, full, settings, fetch, cancel, Tuning::default(), &progress, time::now_ms()).await;
    *reports.refresh.lock().expect("reports lock") = None;
    if result.is_ok() {
        reports.forget_runs(&ns);
    }
    result
}

#[tauri::command]
pub fn reports_cancel(reports: State<'_, ReportsState>) {
    if let Some((_, cancel)) = reports.refresh.lock().expect("reports lock").as_ref() {
        cancel.store(true, Ordering::Relaxed);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Warning {
    pub code: &'static str,
    pub message: String,
}

fn warnings(spec: &QuerySpec, status: &Status) -> Vec<Warning> {
    let mut out = Vec::new();
    if !status.collected {
        out.push(Warning { code: "notCollected", message: "No data has been collected for this data source yet. Refresh it first.".into() });
        return out;
    }
    if status.scope_changed {
        out.push(Warning {
            code: "scopeChanged",
            message: "The object types or scope filter changed since the last refresh. Refresh to apply them.".into(),
        });
    }
    if spec.entity == Entity::Events {
        if status.histories_failed > 0 {
            out.push(Warning {
                code: "historyFailed",
                message: format!("History could not be fetched for {} asset(s); their changes are missing. Refresh to retry.", status.histories_failed),
            });
        }
        if status.histories_denied > 0 {
            out.push(Warning {
                code: "historyDenied",
                message: format!("Jira permissions hide the history of {} asset(s); they are excluded.", status.histories_denied),
            });
        }
    }
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub run_id: String,
    pub mode: Mode,
    pub data_version: i64,
    pub generated_ms: i64,
    pub last_refresh_ms: Option<i64>,
    pub columns: Vec<Column>,
    pub total: i64,
    pub rows: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aggregate: Option<AggMeta>,
    pub warnings: Vec<Warning>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AggMeta {
    pub dimensions: Vec<Column>,
    pub measures: Vec<Column>,
    pub totals: Vec<Value>,
    pub truncated: bool,
}

#[tauri::command]
pub async fn reports_run(app: AppHandle, dataset: Dataset, spec: QuerySpec, page_size: i64, sort: Option<Sort>) -> AppResult<RunResult> {
    let (ns, db, _) = open(&app, &dataset)?;
    let refreshing = is_refreshing(&app, &dataset.id);
    let page_size = page_size.clamp(1, MAX_PAGE);
    let sort = sort.or_else(|| spec.sort.clone());
    let (run, result) = blocking(move || {
        let ds = {
            let mut w = db.write.lock().expect("report db lock");
            let ds = db::dataset_id(&w, &dataset.id)?;
            if !refreshing {
                collect::renormalize_if_needed(&mut w, ds, &dataset)?;
            }
            ds
        };
        let conn = db.read.lock().expect("report db lock");
        let status = status_of(&conn, &dataset, refreshing)?;
        let warnings = warnings(&spec, &status);
        let now = time::now_ms();
        let version = data_version(&conn, ds)?;
        let (kind, columns, total, rows, aggregate) = match spec.mode {
            Mode::Detail => {
                let plan = query::plan_detail(&conn, ds, &spec, now)?;
                let total = plan.count(&conn)?;
                let rows = plan.page(&conn, sort.as_ref(), 0, page_size)?;
                let columns = plan.columns.clone();
                (RunKind::Detail { plan, total }, columns, total, json!(rows), None)
            }
            Mode::Aggregate => {
                let result = query::run_aggregate(&conn, ds, &spec, now, None, true)?;
                let mut rows = result.rows.clone();
                query::sort_rows(&result, &mut rows, sort.as_ref());
                let first: Vec<AggRow> = rows.into_iter().take(page_size as usize).collect();
                let meta = AggMeta {
                    dimensions: result.dimensions.clone(),
                    measures: result.measures.clone(),
                    totals: result.totals.clone(),
                    truncated: result.truncated,
                };
                let columns = result.dimensions.iter().chain(&result.measures).cloned().collect();
                let total = result.rows.len() as i64;
                (RunKind::Aggregate(result), columns, total, json!(first), Some(meta))
            }
        };
        let mut warnings = warnings;
        if aggregate.as_ref().is_some_and(|a| a.truncated) {
            warnings.push(Warning { code: "truncated", message: format!("Only the largest {} groups are shown.", query::MAX_GROUPS) });
        }
        let run = Run { namespace: ns, ds, version, spec, now_ms: now, kind };
        let result = RunResult {
            run_id: String::new(),
            mode: run.spec.mode,
            data_version: version,
            generated_ms: now,
            last_refresh_ms: status.last_refresh_ms,
            columns,
            total,
            rows,
            aggregate,
            warnings,
        };
        Ok((run, result))
    })
    .await?;
    let run_id = app.state::<ReportsState>().store_run(run);
    Ok(RunResult { run_id, ..result })
}

/// Fails with `Stale` if the data changed since the run, so pages never mix two versions.
fn current_run(app: &AppHandle, run_id: &str) -> AppResult<(Arc<Run>, Db)> {
    let reports = app.state::<ReportsState>();
    let run = reports.run(run_id)?;
    let p = principal(&app.state::<AppState>())?;
    if namespace(&p) != run.namespace {
        return Err(AppError::Stale);
    }
    let db = reports.db(app, &run.namespace)?;
    let version = data_version(&db.read.lock().expect("report db lock"), run.ds)?;
    if version != run.version {
        return Err(AppError::Stale);
    }
    Ok((run, db))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub total: i64,
    pub rows: Value,
}

#[tauri::command]
pub async fn reports_page(app: AppHandle, run_id: String, offset: i64, limit: i64, sort: Option<Sort>) -> AppResult<Page> {
    let (run, db) = current_run(&app, &run_id)?;
    let offset = offset.max(0);
    let limit = limit.clamp(1, MAX_PAGE);
    blocking(move || match &run.kind {
        RunKind::Detail { plan, total } => {
            let rows = plan.page(&db.read.lock().expect("report db lock"), sort.as_ref(), offset, limit)?;
            Ok(Page { total: *total, rows: json!(rows) })
        }
        RunKind::Aggregate(result) => {
            let mut rows = result.rows.clone();
            query::sort_rows(result, &mut rows, sort.as_ref());
            let page: Vec<AggRow> = rows.into_iter().skip(offset as usize).take(limit as usize).collect();
            Ok(Page { total: result.rows.len() as i64, rows: json!(page) })
        }
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chart {
    pub rows: Vec<AggRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub other: Option<Vec<Value>>,
    pub other_groups: usize,
    pub truncated: bool,
}

#[tauri::command]
pub async fn reports_chart(app: AppHandle, run_id: String, measure: usize, top: usize) -> AppResult<Chart> {
    let (run, db) = current_run(&app, &run_id)?;
    let top = top.clamp(1, MAX_CHART_TOP);
    blocking(move || {
        let RunKind::Aggregate(result) = &run.kind else {
            return Err(AppError::Invalid("Charts need a summary (grouped) report.".into()));
        };
        let measure_id = result.measures.get(measure).map(|m| m.id.clone()).ok_or_else(|| AppError::Invalid("Unknown measure.".into()))?;
        let mut rows = result.rows.clone();
        let time_dim = result.dimensions.first().is_some_and(|d| d.ctype == "bucket");
        if time_dim {
            query::sort_rows(result, &mut rows, Some(&Sort { column: "d0".into(), desc: false }));
            let truncated = rows.len() > MAX_CHART_POINTS && result.dimensions.len() == 1;
            if truncated {
                rows = rows.split_off(rows.len() - MAX_CHART_POINTS);
            }
            let truncated = truncated || rows.len() > MAX_CHART_ROWS;
            rows.truncate(MAX_CHART_ROWS);
            return Ok(Chart { rows, other: None, other_groups: 0, truncated });
        }
        query::sort_rows(result, &mut rows, Some(&Sort { column: measure_id, desc: true }));
        if result.dimensions.len() != 1 {
            let truncated = rows.len() > MAX_CHART_ROWS;
            rows.truncate(MAX_CHART_ROWS);
            return Ok(Chart { rows, other: None, other_groups: 0, truncated });
        }
        if rows.len() <= top {
            return Ok(Chart { rows, other: None, other_groups: 0, truncated: false });
        }
        let other_groups = rows.len() - top;
        rows.truncate(top);
        // "Other" is measured again over the remaining records: summing group values would double count records
        // that belong to several groups and is wrong for averages and distinct counts.
        let include_null = !rows.iter().any(|r| r.keys.first().is_some_and(Value::is_null));
        let keys: Vec<Value> = rows.iter().filter_map(|r| r.keys.first().cloned()).filter(|k| !k.is_null()).collect();
        let mut spec = run.spec.clone();
        let field = spec.group_by[0].field.clone();
        spec.group_by.clear();
        let extra = Node::Condition { field, op: OTHER_OP.into(), value: json!({ "keys": keys, "includeNull": include_null }) };
        let conn = db.read.lock().expect("report db lock");
        let other = query::run_aggregate(&conn, run.ds, &spec, run.now_ms, Some(&extra), false)?;
        Ok(Chart { rows, other: Some(other.totals), other_groups, truncated: false })
    })
    .await
}

#[tauri::command]
pub async fn reports_export(app: AppHandle, run_id: String, path: String, format: export::Format, name: String, sort: Option<Sort>) -> AppResult<u64> {
    let path = export::check_path(&path, format)?;
    let (run, db) = current_run(&app, &run_id)?;
    blocking(move || {
        let tz = time::parse_tz(&run.spec.timezone)?;
        let name: String = name.chars().take(200).collect();
        let meta = export::Meta { name: &name, tz, generated_ms: time::now_ms() };
        match &run.kind {
            RunKind::Detail { plan, .. } => export::write_detail(&db.read.lock().expect("report db lock"), plan, sort.as_ref(), &path, format, &meta),
            RunKind::Aggregate(result) => {
                let mut rows = result.rows.clone();
                query::sort_rows(result, &mut rows, sort.as_ref());
                export::write_aggregate(result, &rows, &path, format, &meta)
            }
        }
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldValue {
    pub value: Value,
    pub label: String,
    pub count: i64,
}

fn field_values(conn: &Connection, ds: i64, entity: Entity, f: &FieldDef, search: &str, limit: i64) -> AppResult<Vec<FieldValue>> {
    if !f.options.is_empty() {
        let s = search.to_lowercase();
        return Ok(f
            .options
            .iter()
            .filter(|o: &&FieldOption| s.is_empty() || o.label.to_lowercase().contains(&s))
            .map(|o| FieldValue { value: json!(o.value), label: o.label.clone(), count: 0 })
            .collect());
    }
    let (sql, uses_search): (String, bool) = match (&f.src, f.id.as_str()) {
        (Src::Scalar { .. }, "asset.key") => (
            format!(
                "SELECT key, label, 1 FROM {} WHERE ds_id = ?1 AND (?2 = '' OR instr(rpt_lower(key), ?2) > 0 OR instr(rpt_lower(label), ?2) > 0)
                 ORDER BY key LIMIT ?3",
                if entity == Entity::Events { "members" } else { "objects" }
            ),
            true,
        ),
        (Src::Scalar { .. }, "asset.type") => ("SELECT type_id, name, 0 FROM types WHERE ds_id = ?1 AND (?2 = '' OR instr(rpt_lower(name), ?2) > 0) ORDER BY name LIMIT ?3".into(), true),
        (Src::Scalar { .. }, "event.attribute") => (
            "SELECT COALESCE(attr_id, 'name:' || affected), MAX(attr_name), COUNT(*) FROM events WHERE ds_id = ?1 AND affected <> ''
             AND (?2 = '' OR instr(rpt_lower(attr_name), ?2) > 0) GROUP BY 1 ORDER BY 3 DESC LIMIT ?3"
                .into(),
            true,
        ),
        (Src::Scalar { .. }, "event.actor") => (
            "SELECT actor_key, MAX(actor_name), COUNT(*) FROM events WHERE ds_id = ?1 AND actor_key IS NOT NULL
             AND (?2 = '' OR instr(rpt_lower(actor_name), ?2) > 0) GROUP BY actor_key ORDER BY 3 DESC LIMIT ?3"
                .into(),
            true,
        ),
        (Src::Attr { id, col }, _) => {
            let key = if *col == "ref_key" { "ref_key" } else { "raw" };
            (
                format!(
                    "SELECT {key}, MAX(COALESCE(display, raw)), COUNT(*) FROM attr_values WHERE ds_id = ?1 AND attr_id = '{id}' AND {key} IS NOT NULL
                     AND (?2 = '' OR instr(rpt_lower(COALESCE(display, raw)), ?2) > 0 OR instr(rpt_lower({key}), ?2) > 0)
                     GROUP BY {key} ORDER BY 3 DESC LIMIT ?3"
                ),
                true,
            )
        }
        (Src::Refs { side, .. }, _) => (
            format!(
                "SELECT r.ref_key, COALESCE(MAX(l.label), r.ref_key), COUNT(*) FROM event_refs r
                 LEFT JOIN ref_labels l ON l.ds_id = r.ds_id AND l.ref_key = r.ref_key
                 JOIN events e ON e.ds_id = r.ds_id AND e.object_id = r.object_id AND e.history_id = r.history_id
                 WHERE r.ds_id = ?1 AND r.side = '{side}'{} AND (?2 = '' OR instr(rpt_lower(r.ref_key), ?2) > 0 OR instr(rpt_lower(l.label), ?2) > 0)
                 GROUP BY r.ref_key ORDER BY 3 DESC LIMIT ?3",
                f.src.event_constraint()
            ),
            true,
        ),
        _ => return Ok(vec![]),
    };
    let _ = uses_search;
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let rows = stmt
        .query_map(params![ds, search.to_lowercase(), limit], |r| {
            Ok(FieldValue {
                value: query::sql_to_json(r.get_ref(0)?),
                label: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                count: r.get(2)?,
            })
        })
        .map_err(db_err)?;
    rows.collect::<Result<_, _>>().map_err(db_err)
}

#[tauri::command]
pub async fn reports_field_values(app: AppHandle, dataset: Dataset, entity: Entity, field: String, search: String, limit: i64) -> AppResult<Vec<FieldValue>> {
    let (_, db, _) = open(&app, &dataset)?;
    blocking(move || {
        let conn = db.read.lock().expect("report db lock");
        let Some(ds) = existing_dataset_id(&conn, &dataset.id)? else { return Ok(vec![]) };
        let fields = catalogue(&conn, ds, entity)?;
        let f = find(&fields, &field)?;
        let search: String = search.chars().take(200).collect();
        field_values(&conn, ds, entity, f, search.trim(), limit.clamp(1, 200))
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedValue {
    pub attribute_id: String,
    pub attribute_name: String,
    pub raw: String,
    pub count: i64,
    /// An object whose name matches exactly and uniquely; shown for confirmation, never applied automatically.
    pub suggestion: Option<FieldOption>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnknownAttribute {
    pub name: String,
    pub count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unresolved {
    pub values: Vec<UnresolvedValue>,
    pub attributes: Vec<UnknownAttribute>,
}

fn unresolved(conn: &Connection, ds: i64, dataset: &Dataset) -> AppResult<Unresolved> {
    let mut counts: BTreeMap<(String, String), (String, i64)> = BTreeMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT attr_id, MAX(attr_name), old_raw, new_raw, COUNT(*) FROM events
                 WHERE ds_id = ?1 AND resolution = 'unresolved' AND attr_id IS NOT NULL GROUP BY attr_id, old_raw, new_raw LIMIT 20000",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![ds], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, i64>(4)?)))
            .map_err(db_err)?;
        for row in rows {
            let (attr, name, old, new, n) = row.map_err(db_err)?;
            let mapping = dataset.value_mappings.get(&attr);
            for raw in [old, new] {
                for token in normalize::unresolved_tokens(&raw, mapping) {
                    if token.is_empty() {
                        continue;
                    }
                    let e = counts.entry((attr.clone(), token)).or_insert((name.clone(), 0));
                    e.1 += n;
                }
            }
        }
    }
    let mut values: Vec<UnresolvedValue> = counts
        .into_iter()
        .map(|((attribute_id, raw), (attribute_name, count))| UnresolvedValue { attribute_id, attribute_name, raw, count, suggestion: None })
        .collect();
    values.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.raw.cmp(&b.raw)));
    values.truncate(500);
    let mut stmt = conn.prepare("SELECT ref_key, label FROM ref_labels WHERE ds_id = ?1 AND ref_key NOT LIKE 'label:%' AND rpt_lower(label) = ?2 LIMIT 2").map_err(db_err)?;
    for v in values.iter_mut() {
        let found: Vec<(String, String)> = stmt
            .query_map(params![ds, v.raw.to_lowercase()], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(db_err)?
            .collect::<Result<_, _>>()
            .map_err(db_err)?;
        if let [(key, label)] = found.as_slice() {
            v.suggestion = Some(FieldOption { value: key.clone(), label: label.clone() });
        }
    }
    let mut stmt = conn
        .prepare("SELECT affected, COUNT(*) FROM events WHERE ds_id = ?1 AND attr_id IS NULL AND affected <> '' GROUP BY affected ORDER BY 2 DESC LIMIT 200")
        .map_err(db_err)?;
    let attributes = stmt
        .query_map(params![ds], |r| Ok(UnknownAttribute { name: r.get(0)?, count: r.get(1)? }))
        .map_err(db_err)?
        .collect::<Result<_, _>>()
        .map_err(db_err)?;
    Ok(Unresolved { values, attributes })
}

#[tauri::command]
pub async fn reports_unresolved(app: AppHandle, dataset: Dataset) -> AppResult<Unresolved> {
    let (_, db, _) = open(&app, &dataset)?;
    let refreshing = is_refreshing(&app, &dataset.id);
    blocking(move || {
        let ds = {
            let mut w = db.write.lock().expect("report db lock");
            let Some(ds) = existing_dataset_id(&w, &dataset.id)? else { return Ok(Unresolved { values: vec![], attributes: vec![] }) };
            if !refreshing {
                collect::renormalize_if_needed(&mut w, ds, &dataset)?;
            }
            ds
        };
        unresolved(&db.read.lock().expect("report db lock"), ds, &dataset)
    })
    .await
}

/// Deletes collected data for one data source, or every data source of the connected account.
#[tauri::command]
pub async fn reports_clear(app: AppHandle, dataset_id: Option<String>) -> AppResult<()> {
    let p = principal(&app.state::<AppState>())?;
    let ns = namespace(&p);
    let reports = app.state::<ReportsState>();
    if reports.refresh.lock().expect("reports lock").is_some() {
        return Err(AppError::Invalid("Cancel the running refresh before clearing report data.".into()));
    }
    let db = reports.db(&app, &ns)?;
    reports.forget_runs(&ns);
    blocking(move || {
        let mut conn = db.write.lock().expect("report db lock");
        let ids: Vec<i64> = match dataset_id {
            Some(uid) => existing_dataset_id(&conn, &uid)?.into_iter().collect(),
            None => {
                let mut stmt = conn.prepare("SELECT ds_id FROM datasets").map_err(db_err)?;
                let ids = stmt.query_map([], |r| r.get(0)).map_err(db_err)?.collect::<Result<_, _>>().map_err(db_err)?;
                ids
            }
        };
        for ds in ids {
            db::clear_dataset(&mut conn, ds)?;
        }
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;").map_err(db_err)?;
        Ok(())
    })
    .await
}

/// Called by tests and the perf harness: everything a command does except the Tauri plumbing.
#[cfg(test)]
pub(crate) fn run_spec(conn: &mut Connection, dataset: &Dataset, spec: &QuerySpec, now_ms: i64) -> AppResult<Value> {
    let ds = db::dataset_id(conn, &dataset.id)?;
    collect::renormalize_if_needed(conn, ds, dataset)?;
    match spec.mode {
        Mode::Detail => {
            let plan = query::plan_detail(conn, ds, spec, now_ms)?;
            let total = plan.count(conn)?;
            let rows = plan.page(conn, None, 0, MAX_PAGE)?;
            Ok(json!({ "total": total, "rows": rows }))
        }
        Mode::Aggregate => {
            let r = query::run_aggregate(conn, ds, spec, now_ms, None, true)?;
            let mut rows = r.rows.clone();
            query::sort_rows(&r, &mut rows, None);
            Ok(json!({ "rows": rows, "totals": r.totals }))
        }
    }
}

#[cfg(test)]
pub(crate) fn status_for_test(conn: &Connection, dataset: &Dataset) -> AppResult<Status> {
    status_of(conn, dataset, false)
}
