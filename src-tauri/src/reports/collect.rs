//! Collects report data from Jira. This is the only part of reporting that calls Jira, and it runs only when the
//! user explicitly refreshes a data source. Requests are rate limited, honour Retry-After, and every fetched
//! history is checkpointed so a cancelled or failed refresh resumes without repeating work. Collected data becomes
//! visible to reports in one transaction at the end, so reports never see a half-finished refresh.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::task::JoinSet;
use tokio::time::Instant;

use super::db::{self, data_version, dataset_id, db_err};
use super::model::Dataset;
use super::normalize::{normalize, AttrRow, RawEvent, Resolver};
use super::time::{parse_date_value, parse_timestamp};
use crate::error::{AppError, AppResult};
use crate::http::Failure;

pub const PAGE_SIZE: u64 = 100;
const MAX_PAGES: u64 = 20_000;
const MAX_THROTTLED_IN_A_ROW: u32 = 8;
const MAX_FAILED_IN_A_ROW: u32 = 10;
const RETRIES: u32 = 3;
pub const FULL_COOLDOWN_MS: i64 = 60 * 60 * 1000;

pub trait Fetch: Clone + Send + Sync + 'static {
    fn send(&self, method: &'static str, path: String, query: Vec<(String, String)>, body: Option<Value>) -> impl Future<Output = Result<Value, Failure>> + Send;
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub concurrency: u32,
    pub requests_per_second: f64,
}

impl Settings {
    pub fn validate(&self) -> AppResult<()> {
        if !(1..=8).contains(&self.concurrency) || !(0.2..=20.0).contains(&self.requests_per_second) {
            return Err(AppError::Invalid("Use 1–8 parallel requests and 0.2–20 requests per second.".into()));
        }
        Ok(())
    }
}

/// Timing knobs, separate so tests run without real delays.
#[derive(Clone, Copy)]
pub struct Tuning {
    pub backoff: Duration,
}

impl Default for Tuning {
    fn default() -> Self {
        Self { backoff: Duration::from_secs(2) }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: &'static str,
    pub done: u64,
    pub total: u64,
    pub requests: u64,
    pub throttled: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub assets: u64,
    pub histories_fetched: u64,
    pub histories_reused: u64,
    pub histories_failed: u64,
    pub histories_missing: u64,
    pub histories_denied: u64,
    pub requests: u64,
    pub throttled: u64,
    pub events: u64,
    pub data_version: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub assets: u64,
    pub inventory_requests: u64,
    pub metadata_requests: u64,
    /// Histories that will certainly be fetched (first collection, full refresh, or retries).
    pub history_requests: u64,
    /// Incremental refreshes fetch only changed assets; this is the most that could be fetched.
    pub history_requests_max: u64,
    pub first_collection: bool,
    pub full_cooldown_ms: i64,
    pub concurrency: u32,
    pub requests_per_second: f64,
    pub resumable: u64,
}

struct Limiter {
    interval: Duration,
    next: tokio::sync::Mutex<Instant>,
}

impl Limiter {
    fn new(rps: f64) -> Self {
        Self { interval: Duration::from_secs_f64(1.0 / rps), next: tokio::sync::Mutex::new(Instant::now()) }
    }

    async fn acquire(&self) {
        let at = {
            let mut next = self.next.lock().await;
            let at = (*next).max(Instant::now());
            *next = at + self.interval;
            at
        };
        tokio::time::sleep_until(at).await;
    }

    /// Holds every worker back, e.g. after Jira asks to slow down.
    async fn pause(&self, d: Duration) {
        let mut next = self.next.lock().await;
        *next = (*next).max(Instant::now() + d);
    }
}

struct Shared<F: Fetch> {
    fetch: F,
    limiter: Limiter,
    cancel: Arc<AtomicBool>,
    stop: AtomicBool,
    requests: AtomicU64,
    throttled: AtomicU64,
    throttled_in_a_row: AtomicU32,
    tuning: Tuning,
}

impl<F: Fetch> Shared<F> {
    fn check_cancel(&self) -> AppResult<()> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        Ok(())
    }

    /// One request with rate limiting and retries for throttling and transient failures.
    async fn request(&self, method: &'static str, path: String, query: Vec<(String, String)>, body: Option<Value>) -> AppResult<Value> {
        let mut attempt = 0u32;
        loop {
            self.check_cancel()?;
            if self.stop.load(Ordering::Relaxed) {
                return Err(AppError::Cancelled);
            }
            self.limiter.acquire().await;
            self.requests.fetch_add(1, Ordering::Relaxed);
            match self.fetch.send(method, path.clone(), query.clone(), body.clone()).await {
                Ok(v) => {
                    self.throttled_in_a_row.store(0, Ordering::Relaxed);
                    return Ok(v);
                }
                Err(Failure { error: AppError::Http { status: 429, .. }, retry_after }) => {
                    self.throttled.fetch_add(1, Ordering::Relaxed);
                    let streak = self.throttled_in_a_row.fetch_add(1, Ordering::Relaxed) + 1;
                    if streak >= MAX_THROTTLED_IN_A_ROW {
                        return Err(AppError::Invalid(
                            "Jira kept asking JAM to slow down, so the refresh was paused. Progress was saved; try again later or lower the request rate."
                                .into(),
                        ));
                    }
                    let wait = retry_after.unwrap_or(self.tuning.backoff * 2u32.pow(streak.min(5)));
                    self.limiter.pause(wait).await;
                }
                Err(Failure { error: AppError::Http { status, message }, .. }) if status >= 500 || status == 408 => {
                    attempt += 1;
                    if attempt > RETRIES {
                        return Err(AppError::Http { status, message });
                    }
                    tokio::time::sleep(self.tuning.backoff * 2u32.pow(attempt - 1)).await;
                }
                Err(Failure { error: AppError::Network(m), .. }) => {
                    attempt += 1;
                    if attempt > RETRIES {
                        return Err(AppError::Network(m));
                    }
                    tokio::time::sleep(self.tuning.backoff * 2u32.pow(attempt - 1)).await;
                }
                Err(f) => return Err(f.error),
            }
        }
    }
}

fn is_fatal(e: &AppError) -> bool {
    matches!(
        e,
        AppError::NotConnected | AppError::Certificate(_) | AppError::ProxyAuth(_) | AppError::Cancelled | AppError::Invalid(_) | AppError::Http { status: 401, .. }
    )
}

fn str_of(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(str_of)
}

pub fn attr_kind(a: &Value) -> &'static str {
    let t = a.get("type").and_then(Value::as_i64).unwrap_or(0);
    let dt = a.get("defaultType").and_then(|d| d.get("id")).and_then(Value::as_i64).unwrap_or(-1);
    match (t, dt) {
        (0, 1) | (0, 3) => "number",
        (0, 2) => "boolean",
        (0, 4) => "date",
        (0, 6) => "datetime",
        (0, 10) => "select",
        (0, _) => "text",
        (1, _) => "ref",
        (2, _) => "user",
        (4, _) => "group",
        (7, _) => "status",
        _ => "text",
    }
}

#[derive(Default, Debug, PartialEq)]
pub struct ValueRow {
    pub raw: Option<String>,
    pub display: Option<String>,
    pub num: Option<f64>,
    pub ms: Option<i64>,
    pub day: Option<String>,
    pub ref_key: Option<String>,
    pub ref_label: Option<String>,
}

pub fn value_row(kind: &str, v: &Value) -> ValueRow {
    let value = s(v, "value");
    let shown = s(v, "displayValue");
    let mut row = ValueRow { raw: value.clone().or(shown.clone()), display: shown.clone().or(value.clone()), ..Default::default() };
    match kind {
        "ref" => {
            if let Some(r) = v.get("referencedObject") {
                row.ref_key = s(r, "objectKey");
                row.ref_label = s(r, "label");
                row.raw = row.ref_key.clone().or(row.raw);
                row.display = row.ref_label.clone().or(row.display);
            }
        }
        "user" => {
            if let Some(u) = v.get("user") {
                row.raw = s(u, "key").or(s(u, "name")).or(row.raw);
                row.display = s(u, "displayName").or(row.display);
            }
        }
        "group" => {
            if let Some(name) = v.get("group").and_then(|g| s(g, "name")) {
                row.raw = Some(name.clone());
                row.display = Some(name);
            }
        }
        "status" => {
            if let Some(name) = v.get("status").and_then(|g| s(g, "name")) {
                row.raw = Some(name.clone());
                row.display = Some(name);
            }
        }
        "number" => row.num = row.raw.as_deref().and_then(|r| r.trim().parse::<f64>().ok()).filter(|n| n.is_finite()),
        "date" => row.day = row.raw.as_deref().and_then(parse_date_value),
        "datetime" => row.ms = row.raw.as_deref().and_then(parse_timestamp),
        "boolean" => row.raw = row.raw.map(|r| r.trim().to_lowercase()),
        _ => {}
    }
    row
}

struct Meta {
    types: Vec<(String, String)>,
    attrs: Vec<(String, String, String, &'static str)>,
}

impl Meta {
    fn kinds(&self) -> HashMap<String, &'static str> {
        self.attrs.iter().map(|(id, _, _, k)| (id.clone(), *k)).collect()
    }
}

async fn metadata<F: Fetch>(sh: &Shared<F>, dataset: &Dataset) -> AppResult<Meta> {
    let mut meta = Meta { types: vec![], attrs: vec![] };
    for t in &dataset.object_type_ids {
        let ty = sh.request("GET", format!("/objecttype/{t}"), vec![], None).await?;
        meta.types.push((t.clone(), s(&ty, "name").unwrap_or_else(|| t.clone())));
        let attrs = sh.request("GET", format!("/objecttype/{t}/attributes"), vec![], None).await?;
        for a in attrs.as_array().into_iter().flatten() {
            let (Some(id), Some(name)) = (s(a, "id"), s(a, "name")) else { continue };
            meta.attrs.push((id, t.clone(), name, attr_kind(a)));
        }
    }
    Ok(meta)
}

fn stage_page(conn: &mut Connection, ds: i64, values: &[Value], kinds: &HashMap<String, &'static str>) -> AppResult<u64> {
    let tx = conn.transaction().map_err(db_err)?;
    let mut n = 0;
    {
        let mut obj = tx
            .prepare_cached(
                "INSERT OR REPLACE INTO objects_stage (ds_id, object_id, key, label, type_id, created_ms, updated_ms, updated_raw)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .map_err(db_err)?;
        let mut del = tx.prepare_cached("DELETE FROM attr_values_stage WHERE ds_id = ?1 AND object_id = ?2").map_err(db_err)?;
        let mut val = tx
            .prepare_cached(
                "INSERT INTO attr_values_stage (ds_id, object_id, attr_id, seq, raw, display, num, ms, day, ref_key, ref_label)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            )
            .map_err(db_err)?;
        for o in values {
            let (Some(id), Some(key)) = (s(o, "id"), s(o, "objectKey")) else { continue };
            let type_id = o.get("objectType").and_then(|t| s(t, "id")).unwrap_or_default();
            let updated = s(o, "updated").unwrap_or_default();
            obj.execute(params![
                ds,
                id,
                key,
                s(o, "label").unwrap_or_default(),
                type_id,
                s(o, "created").as_deref().and_then(parse_timestamp),
                parse_timestamp(&updated),
                updated
            ])
            .map_err(db_err)?;
            del.execute(params![ds, id]).map_err(db_err)?;
            for a in o.get("attributes").and_then(Value::as_array).into_iter().flatten() {
                let Some(attr_id) = s(a, "objectTypeAttributeId") else { continue };
                let kind = kinds.get(&attr_id).copied().unwrap_or("text");
                for (seq, v) in a.get("objectAttributeValues").and_then(Value::as_array).into_iter().flatten().enumerate() {
                    let r = value_row(kind, v);
                    val.execute(params![ds, id, attr_id, seq as i64, r.raw, r.display, r.num, r.ms, r.day, r.ref_key, r.ref_label])
                        .map_err(db_err)?;
                }
            }
            n += 1;
        }
    }
    tx.commit().map_err(db_err)?;
    Ok(n)
}

fn is_last(page: &Value) -> bool {
    match page.get("isLast") {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s == "true",
        _ => false,
    }
}

async fn enumerate<F: Fetch>(
    sh: &Shared<F>,
    db: &Arc<Mutex<Connection>>,
    ds: i64,
    dataset: &Dataset,
    kinds: &HashMap<String, &'static str>,
    total: u64,
    progress: &(dyn Fn(Progress) + Send + Sync),
) -> AppResult<u64> {
    {
        let conn = db.lock().expect("report db lock");
        conn.execute("DELETE FROM objects_stage WHERE ds_id = ?1", params![ds]).map_err(db_err)?;
        conn.execute("DELETE FROM attr_values_stage WHERE ds_id = ?1", params![ds]).map_err(db_err)?;
    }
    let aql = dataset.aql();
    let mut start = 0u64;
    let mut seen = 0u64;
    for _ in 0..MAX_PAGES {
        let query = vec![
            ("startAt".to_string(), start.to_string()),
            ("maxResults".to_string(), PAGE_SIZE.to_string()),
            ("includeAttributes".to_string(), "true".to_string()),
        ];
        let page = sh.request("POST", "/object/aql".into(), query, Some(json!({ "qlQuery": aql }))).await?;
        let values = page.get("values").and_then(Value::as_array).cloned().unwrap_or_default();
        let last = is_last(&page);
        if values.is_empty() {
            if last || start >= total {
                return Ok(seen);
            }
            return Err(AppError::Invalid("Jira returned an incomplete list of assets. Try the refresh again.".into()));
        }
        {
            let mut conn = db.lock().expect("report db lock");
            seen += stage_page(&mut conn, ds, &values, kinds)?;
        }
        start += values.len() as u64;
        progress(Progress {
            phase: "inventory",
            done: start.min(total.max(start)),
            total: total.max(start),
            requests: sh.requests.load(Ordering::Relaxed),
            throttled: sh.throttled.load(Ordering::Relaxed),
            message: None,
        });
        if last {
            return Ok(seen);
        }
    }
    Err(AppError::Invalid("The data source is too large. Narrow it with a scope filter.".into()))
}

/// Assets whose history must be fetched: new, changed since the last fetch, previously failed, or all on a full
/// refresh. Histories already checkpointed for the same asset version are reused.
fn plan_histories(conn: &Connection, ds: i64, full: bool) -> AppResult<(Vec<(String, String)>, u64)> {
    let mut stmt = conn
        .prepare(
            "SELECT s.object_id, s.updated_raw, m.history_state, m.history_updated, h.updated_raw
             FROM objects_stage s
             LEFT JOIN members m ON m.ds_id = s.ds_id AND m.object_id = s.object_id
             LEFT JOIN history_stage h ON h.ds_id = s.ds_id AND h.object_id = s.object_id AND h.state <> 'failed'
             WHERE s.ds_id = ?1 ORDER BY s.object_id",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![ds], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?))
        })
        .map_err(db_err)?;
    let mut fetch = Vec::new();
    let mut reused = 0;
    for row in rows {
        let (id, updated, state, history_updated, staged) = row.map_err(db_err)?;
        if staged.as_deref() == Some(updated.as_str()) {
            reused += 1;
            continue;
        }
        let needed = full
            || match state.as_deref() {
                None | Some("pending") | Some("failed") => true,
                _ => history_updated.as_deref() != Some(updated.as_str()),
            };
        if needed {
            fetch.push((id, updated));
        }
    }
    Ok((fetch, reused))
}

enum Outcome {
    Ok(Vec<Value>),
    Missing,
    Denied,
    Failed(String),
}

/// Keeps only what reports need from a history entry; actor email addresses are not stored.
fn slim_entry(e: &Value) -> Option<Value> {
    let id = s(e, "id")?;
    let actor = e.get("actor");
    Some(json!({
        "id": id,
        "created": s(e, "created"),
        "affectedAttribute": s(e, "affectedAttribute"),
        "oldValue": s(e, "oldValue"),
        "newValue": s(e, "newValue"),
        "type": e.get("type").and_then(Value::as_i64),
        "actorKey": actor.and_then(|a| s(a, "key").or(s(a, "accountId")).or(s(a, "name"))),
        "actorName": actor.and_then(|a| s(a, "displayName")),
    }))
}

async fn fetch_history<F: Fetch>(sh: Arc<Shared<F>>, id: String) -> AppResult<Outcome> {
    let query = vec![("asc".to_string(), "true".to_string())];
    match sh.request("GET", format!("/object/{id}/history"), query, None).await {
        Ok(Value::Array(entries)) => Ok(Outcome::Ok(entries.iter().filter_map(slim_entry).collect())),
        Ok(Value::Null) => Ok(Outcome::Ok(vec![])),
        Ok(_) => Ok(Outcome::Failed("Unexpected history response.".into())),
        Err(AppError::Http { status: 404, .. }) => Ok(Outcome::Missing),
        Err(AppError::Http { status: 403, .. }) => Ok(Outcome::Denied),
        Err(e) if is_fatal(&e) => Err(e),
        Err(e) => Ok(Outcome::Failed(e.to_string())),
    }
}

fn checkpoint(conn: &Connection, ds: i64, id: &str, updated: &str, outcome: &Outcome) -> AppResult<()> {
    let (state, entries) = match outcome {
        Outcome::Ok(e) => ("ok", Some(Value::Array(e.clone()).to_string())),
        Outcome::Missing => ("missing", None),
        Outcome::Denied => ("denied", None),
        Outcome::Failed(_) => ("failed", None),
    };
    conn.execute(
        "INSERT OR REPLACE INTO history_stage (ds_id, object_id, state, updated_raw, entries) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![ds, id, state, updated, entries],
    )
    .map_err(db_err)?;
    Ok(())
}

pub fn load_resolver(conn: &Connection, ds: i64, dataset: &Dataset) -> AppResult<Resolver> {
    let mut stmt = conn.prepare("SELECT attr_id, type_id, name, kind FROM attrs WHERE ds_id = ?1").map_err(db_err)?;
    let attrs = stmt
        .query_map(params![ds], |r| {
            Ok(AttrRow { id: r.get(0)?, type_id: r.get(1)?, name: r.get(2)?, is_ref: r.get::<_, String>(3)? == "ref" })
        })
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;
    Ok(Resolver::new(&attrs, &dataset.attribute_aliases, &dataset.value_mappings))
}

/// Fingerprint of everything normalisation depends on; events are re-derived when it changes.
pub fn norm_signature(conn: &Connection, ds: i64, dataset: &Dataset) -> AppResult<String> {
    let mut stmt = conn.prepare("SELECT attr_id, type_id, name, kind FROM attrs WHERE ds_id = ?1 ORDER BY attr_id").map_err(db_err)?;
    let attrs: Vec<String> = stmt
        .query_map(params![ds], |r| Ok(format!("{}|{}|{}|{}", r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))
        .map_err(db_err)?
        .collect::<Result<_, _>>()
        .map_err(db_err)?;
    Ok(super::hash_hex(&format!("{}\n{}", dataset.norm_hash(), attrs.join("\n"))))
}

fn write_event(tx: &Transaction, ds: i64, object_id: &str, type_id: &str, e: &Value, resolver: &Resolver) -> AppResult<()> {
    let Some(history_id) = s(e, "id") else { return Ok(()) };
    let affected = s(e, "affectedAttribute").unwrap_or_default();
    let old = s(e, "oldValue").unwrap_or_default();
    let new = s(e, "newValue").unwrap_or_default();
    let kind = e.get("type").and_then(Value::as_i64).unwrap_or(-1);
    let n = normalize(resolver, &RawEvent { type_id, kind, affected: &affected, old: &old, new: &new });
    tx.prepare_cached(
        "INSERT OR REPLACE INTO events (ds_id, object_id, history_id, created_ms, kind, affected, old_raw, new_raw, actor_key, actor_name,
            attr_id, attr_name, operation, resolution, norm)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
    )
    .map_err(db_err)?
    .execute(params![
        ds,
        object_id,
        history_id,
        s(e, "created").as_deref().and_then(parse_timestamp),
        kind,
        affected,
        old,
        new,
        s(e, "actorKey"),
        s(e, "actorName"),
        n.attr_id,
        n.attr_name,
        n.operation,
        if n.resolved { "resolved" } else { "unresolved" },
        super::normalize::NORM_VERSION
    ])
    .map_err(db_err)?;
    let mut ins = tx.prepare_cached("INSERT INTO event_refs (ds_id, object_id, history_id, side, ref_key) VALUES (?1, ?2, ?3, ?4, ?5)").map_err(db_err)?;
    for (side, key) in n.refs {
        ins.execute(params![ds, object_id, history_id, side, key]).map_err(db_err)?;
    }
    {
        // Current object labels are written first and take precedence over names seen in history.
        let mut label = tx.prepare_cached("INSERT OR IGNORE INTO ref_labels (ds_id, ref_key, label) VALUES (?1, ?2, ?3)").map_err(db_err)?;
        for (key, text) in n.labels {
            label.execute(params![ds, key, text]).map_err(db_err)?;
        }
    }
    Ok(())
}

/// rowid, object id, history id, type id, kind, affected attribute, old value, new value.
type StoredEvent = (i64, String, String, String, i64, String, String, String);

/// Re-derives attribute, change type and referenced objects for every stored event (no Jira requests).
pub fn renormalize(tx: &Transaction, ds: i64, resolver: &Resolver) -> AppResult<u64> {
    tx.execute("DELETE FROM event_refs WHERE ds_id = ?1", params![ds]).map_err(db_err)?;
    let mut last = 0i64;
    let mut total = 0u64;
    loop {
        let batch: Vec<StoredEvent> = {
            let mut stmt = tx
                .prepare_cached(
                    "SELECT e.rowid, e.object_id, e.history_id, COALESCE(m.type_id, ''), e.kind, e.affected, e.old_raw, e.new_raw
                     FROM events e LEFT JOIN members m ON m.ds_id = e.ds_id AND m.object_id = e.object_id
                     WHERE e.ds_id = ?1 AND e.rowid > ?2 ORDER BY e.rowid LIMIT 5000",
                )
                .map_err(db_err)?;
            let rows = stmt
                .query_map(params![ds, last], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)))
                .map_err(db_err)?;
            rows.collect::<Result<_, _>>().map_err(db_err)?
        };
        if batch.is_empty() {
            return Ok(total);
        }
        let mut upd = tx
            .prepare_cached("UPDATE events SET attr_id = ?2, attr_name = ?3, operation = ?4, resolution = ?5, norm = ?6 WHERE rowid = ?1")
            .map_err(db_err)?;
        let mut ins = tx.prepare_cached("INSERT INTO event_refs (ds_id, object_id, history_id, side, ref_key) VALUES (?1, ?2, ?3, ?4, ?5)").map_err(db_err)?;
        let mut label = tx.prepare_cached("INSERT OR IGNORE INTO ref_labels (ds_id, ref_key, label) VALUES (?1, ?2, ?3)").map_err(db_err)?;
        for (rowid, object_id, history_id, type_id, kind, affected, old, new) in batch {
            let n = normalize(resolver, &RawEvent { type_id: &type_id, kind, affected: &affected, old: &old, new: &new });
            upd.execute(params![
                rowid,
                n.attr_id,
                n.attr_name,
                n.operation,
                if n.resolved { "resolved" } else { "unresolved" },
                super::normalize::NORM_VERSION
            ])
            .map_err(db_err)?;
            for (side, key) in n.refs {
                ins.execute(params![ds, object_id, history_id, side, key]).map_err(db_err)?;
            }
            for (key, text) in n.labels {
                label.execute(params![ds, key, text]).map_err(db_err)?;
            }
            last = rowid;
            total += 1;
        }
    }
}

/// Applies changed identity mappings or attribute aliases to stored events. Returns true if anything changed.
pub fn renormalize_if_needed(conn: &mut Connection, ds: i64, dataset: &Dataset) -> AppResult<bool> {
    let sig = norm_signature(conn, ds, dataset)?;
    let stored: Option<String> = conn.query_row("SELECT norm_hash FROM datasets WHERE ds_id = ?1", params![ds], |r| r.get(0)).optional().map_err(db_err)?.flatten();
    if stored.is_none() || stored.as_deref() == Some(sig.as_str()) {
        return Ok(false);
    }
    let resolver = load_resolver(conn, ds, dataset)?;
    let tx = conn.transaction().map_err(db_err)?;
    renormalize(&tx, ds, &resolver)?;
    tx.execute("UPDATE datasets SET norm_hash = ?2, data_version = data_version + 1 WHERE ds_id = ?1", params![ds, sig]).map_err(db_err)?;
    tx.commit().map_err(db_err)?;
    Ok(true)
}

fn publish(conn: &mut Connection, ds: i64, dataset: &Dataset, meta: &Meta, full: bool, now_ms: i64, summary: &mut Summary) -> AppResult<()> {
    let tx = conn.transaction().map_err(db_err)?;
    tx.execute("DELETE FROM types WHERE ds_id = ?1", params![ds]).map_err(db_err)?;
    tx.execute("DELETE FROM attrs WHERE ds_id = ?1", params![ds]).map_err(db_err)?;
    for (id, name) in &meta.types {
        tx.execute("INSERT OR REPLACE INTO types (ds_id, type_id, name) VALUES (?1, ?2, ?3)", params![ds, id, name]).map_err(db_err)?;
    }
    for (id, type_id, name, kind) in &meta.attrs {
        tx.execute("INSERT OR REPLACE INTO attrs (ds_id, attr_id, type_id, name, kind) VALUES (?1, ?2, ?3, ?4, ?5)", params![ds, id, type_id, name, kind])
            .map_err(db_err)?;
    }
    for sql in [
        "DELETE FROM objects WHERE ds_id = ?1",
        "DELETE FROM attr_values WHERE ds_id = ?1",
        "INSERT INTO objects SELECT * FROM objects_stage WHERE ds_id = ?1",
        "INSERT INTO attr_values (ds_id, object_id, attr_id, seq, raw, display, num, ms, day, ref_key)
         SELECT ds_id, object_id, attr_id, seq, raw, display, num, ms, day, ref_key FROM attr_values_stage WHERE ds_id = ?1",
        "INSERT OR REPLACE INTO ref_labels (ds_id, ref_key, label)
         SELECT ds_id, ref_key, MAX(ref_label) FROM attr_values_stage WHERE ds_id = ?1 AND ref_key IS NOT NULL AND COALESCE(ref_label, '') <> '' GROUP BY ref_key",
        "INSERT OR REPLACE INTO ref_labels (ds_id, ref_key, label) SELECT ds_id, key, label FROM objects_stage WHERE ds_id = ?1 AND label <> ''",
        "UPDATE members SET present = 0 WHERE ds_id = ?1",
        "INSERT INTO members (ds_id, object_id, key, label, type_id, present)
         SELECT ds_id, object_id, key, label, type_id, 1 FROM objects_stage WHERE ds_id = ?1
         ON CONFLICT (ds_id, object_id) DO UPDATE SET key = excluded.key, label = excluded.label, type_id = excluded.type_id, present = 1",
    ] {
        tx.execute(sql, params![ds]).map_err(db_err)?;
    }

    let resolver = load_resolver(&tx, ds, dataset)?;
    let staged: Vec<(String, String, String, Option<String>, String)> = {
        let mut stmt = tx
            .prepare(
                "SELECT h.object_id, h.state, h.updated_raw, h.entries, COALESCE(m.type_id, '')
                 FROM history_stage h LEFT JOIN members m ON m.ds_id = h.ds_id AND m.object_id = h.object_id WHERE h.ds_id = ?1",
            )
            .map_err(db_err)?;
        let rows = stmt.query_map(params![ds], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).map_err(db_err)?;
        rows.collect::<Result<_, _>>().map_err(db_err)?
    };
    for (object_id, state, updated, entries, type_id) in staged {
        match state.as_str() {
            "ok" => {
                tx.execute("DELETE FROM events WHERE ds_id = ?1 AND object_id = ?2", params![ds, object_id]).map_err(db_err)?;
                tx.execute("DELETE FROM event_refs WHERE ds_id = ?1 AND object_id = ?2", params![ds, object_id]).map_err(db_err)?;
                let list: Vec<Value> = entries.as_deref().and_then(|e| serde_json::from_str(e).ok()).unwrap_or_default();
                let mut seen = HashSet::new();
                for e in &list {
                    if s(e, "id").is_some_and(|id| seen.insert(id)) {
                        write_event(&tx, ds, &object_id, &type_id, e, &resolver)?;
                    }
                }
            }
            "missing" => summary.histories_missing += 1,
            "denied" => summary.histories_denied += 1,
            _ => summary.histories_failed += 1,
        }
        tx.execute(
            "UPDATE members SET history_state = ?3, history_updated = CASE WHEN ?3 = 'failed' THEN history_updated ELSE ?4 END
             WHERE ds_id = ?1 AND object_id = ?2",
            params![ds, object_id, state, updated],
        )
        .map_err(db_err)?;
    }
    // Members that were never fetched successfully stay flagged for retry.
    tx.execute("UPDATE members SET history_state = 'failed' WHERE ds_id = ?1 AND present = 1 AND history_state = 'pending'", params![ds])
        .map_err(db_err)?;

    let sig = norm_signature(&tx, ds, dataset)?;
    let stored: Option<String> = tx.query_row("SELECT norm_hash FROM datasets WHERE ds_id = ?1", params![ds], |r| r.get(0)).map_err(db_err)?;
    if stored.as_deref() != Some(sig.as_str()) {
        renormalize(&tx, ds, &resolver)?;
    }
    for table in ["objects_stage", "attr_values_stage", "history_stage"] {
        tx.execute(&format!("DELETE FROM {table} WHERE ds_id = ?1"), params![ds]).map_err(db_err)?;
    }
    tx.execute(
        "UPDATE datasets SET data_version = data_version + 1, norm_hash = ?2, scope_hash = ?3, last_refresh_ms = ?4,
            last_full_ms = CASE WHEN ?5 THEN ?4 ELSE last_full_ms END, last_error = NULL WHERE ds_id = ?1",
        params![ds, sig, dataset.scope_hash(), now_ms, full],
    )
    .map_err(db_err)?;
    summary.events = tx.query_row("SELECT COUNT(*) FROM events WHERE ds_id = ?1", params![ds], |r| r.get::<_, i64>(0)).map_err(db_err)? as u64;
    tx.commit().map_err(db_err)?;
    Ok(())
}

pub fn check_cooldown(conn: &Connection, ds: i64, now_ms: i64) -> AppResult<()> {
    let last: Option<i64> = conn.query_row("SELECT last_full_ms FROM datasets WHERE ds_id = ?1", params![ds], |r| r.get(0)).optional().map_err(db_err)?.flatten();
    if let Some(last) = last {
        let left = last + FULL_COOLDOWN_MS - now_ms;
        if left > 0 {
            let minutes = (left + 59_999) / 60_000;
            return Err(AppError::Invalid(format!(
                "A full refresh ran recently. To limit load on Jira, wait {minutes} more minute(s) or run a normal refresh."
            )));
        }
    }
    Ok(())
}

pub async fn estimate<F: Fetch>(db: &Arc<Mutex<Connection>>, dataset: &Dataset, settings: Settings, fetch: F, now_ms: i64) -> AppResult<Estimate> {
    let (ds, members, retry, resumable, last_full) = {
        let conn = db.lock().expect("report db lock");
        let ds = dataset_id(&conn, &dataset.id)?;
        let members: i64 = conn.query_row("SELECT COUNT(*) FROM members WHERE ds_id = ?1 AND present = 1", params![ds], |r| r.get(0)).map_err(db_err)?;
        let retry: i64 = conn
            .query_row("SELECT COUNT(*) FROM members WHERE ds_id = ?1 AND present = 1 AND history_state IN ('pending', 'failed')", params![ds], |r| r.get(0))
            .map_err(db_err)?;
        let resumable: i64 =
            conn.query_row("SELECT COUNT(*) FROM history_stage WHERE ds_id = ?1 AND state <> 'failed'", params![ds], |r| r.get(0)).map_err(db_err)?;
        let last_full: Option<i64> = conn.query_row("SELECT last_full_ms FROM datasets WHERE ds_id = ?1", params![ds], |r| r.get(0)).map_err(db_err)?;
        (ds, members as u64, retry as u64, resumable as u64, last_full)
    };
    let _ = ds;
    let shared = Shared {
        fetch,
        limiter: Limiter::new(settings.requests_per_second),
        cancel: Arc::new(AtomicBool::new(false)),
        stop: AtomicBool::new(false),
        requests: AtomicU64::new(0),
        throttled: AtomicU64::new(0),
        throttled_in_a_row: AtomicU32::new(0),
        tuning: Tuning::default(),
    };
    let count = shared.request("POST", "/object/aql/totalcount".into(), vec![], Some(json!({ "qlQuery": dataset.aql() }))).await?;
    let assets = count.get("totalCount").and_then(Value::as_u64).unwrap_or(0);
    let first = members == 0;
    let new_assets = assets.saturating_sub(members);
    Ok(Estimate {
        assets,
        inventory_requests: assets.div_ceil(PAGE_SIZE).max(1) + 1,
        metadata_requests: dataset.object_type_ids.len() as u64 * 2,
        history_requests: if first { assets.saturating_sub(resumable) } else { retry + new_assets },
        history_requests_max: assets.saturating_sub(resumable),
        first_collection: first,
        full_cooldown_ms: last_full.map(|l| (l + FULL_COOLDOWN_MS - now_ms).max(0)).unwrap_or(0),
        concurrency: settings.concurrency,
        requests_per_second: settings.requests_per_second,
        resumable,
    })
}

#[allow(clippy::too_many_arguments)]
pub async fn refresh<F: Fetch>(
    db: Arc<Mutex<Connection>>,
    dataset: &Dataset,
    full: bool,
    settings: Settings,
    fetch: F,
    cancel: Arc<AtomicBool>,
    tuning: Tuning,
    progress: &(dyn Fn(Progress) + Send + Sync),
    now_ms: i64,
) -> AppResult<Summary> {
    settings.validate()?;
    dataset.validate()?;
    let ds = {
        let conn = db.lock().expect("report db lock");
        let ds = dataset_id(&conn, &dataset.id)?;
        if full {
            check_cooldown(&conn, ds, now_ms)?;
        }
        ds
    };
    let sh = Arc::new(Shared {
        fetch,
        limiter: Limiter::new(settings.requests_per_second),
        cancel,
        stop: AtomicBool::new(false),
        requests: AtomicU64::new(0),
        throttled: AtomicU64::new(0),
        throttled_in_a_row: AtomicU32::new(0),
        tuning,
    });
    let result = run(&sh, &db, ds, dataset, full, settings, progress, now_ms).await;
    if let Err(e) = &result {
        if !matches!(e, AppError::Cancelled) {
            let conn = db.lock().expect("report db lock");
            let _ = conn.execute("UPDATE datasets SET last_error = ?2 WHERE ds_id = ?1", params![ds, e.to_string()]);
        }
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn run<F: Fetch>(
    sh: &Arc<Shared<F>>,
    db: &Arc<Mutex<Connection>>,
    ds: i64,
    dataset: &Dataset,
    full: bool,
    settings: Settings,
    progress: &(dyn Fn(Progress) + Send + Sync),
    now_ms: i64,
) -> AppResult<Summary> {
    let report = |phase: &'static str, done: u64, total: u64| {
        progress(Progress {
            phase,
            done,
            total,
            requests: sh.requests.load(Ordering::Relaxed),
            throttled: sh.throttled.load(Ordering::Relaxed),
            message: None,
        })
    };
    report("metadata", 0, 0);
    let meta = metadata(sh, dataset).await?;
    let count = sh.request("POST", "/object/aql/totalcount".into(), vec![], Some(json!({ "qlQuery": dataset.aql() }))).await?;
    let total = count.get("totalCount").and_then(Value::as_u64).unwrap_or(0);
    report("inventory", 0, total);
    let assets = enumerate(sh, db, ds, dataset, &meta.kinds(), total, progress).await?;

    let (todo, reused) = {
        let conn = db.lock().expect("report db lock");
        plan_histories(&conn, ds, full)?
    };
    let mut summary = Summary { assets, histories_reused: reused, ..Default::default() };
    let todo_total = todo.len() as u64;
    report("history", 0, todo_total);

    let mut queue = todo.into_iter();
    let mut set: JoinSet<(String, String, AppResult<Outcome>)> = JoinSet::new();
    let mut fatal: Option<AppError> = None;
    let mut failed_in_a_row = 0u32;
    let mut done = 0u64;
    loop {
        while fatal.is_none() && set.len() < settings.concurrency as usize && !sh.cancel.load(Ordering::Relaxed) {
            let Some((id, updated)) = queue.next() else { break };
            let shared = sh.clone();
            set.spawn(async move {
                let outcome = fetch_history(shared, id.clone()).await;
                (id, updated, outcome)
            });
        }
        let Some(joined) = set.join_next().await else { break };
        let (id, updated, outcome) = joined.map_err(|e| AppError::Io(format!("Report collection task failed: {e}")))?;
        match outcome {
            Ok(outcome) => {
                failed_in_a_row = if matches!(outcome, Outcome::Failed(_)) { failed_in_a_row + 1 } else { 0 };
                if let Outcome::Failed(msg) = &outcome {
                    if failed_in_a_row >= MAX_FAILED_IN_A_ROW && fatal.is_none() {
                        fatal = Some(AppError::Invalid(format!("Too many history requests failed in a row; the refresh stopped. Last error: {msg}")));
                        sh.stop.store(true, Ordering::Relaxed);
                    }
                }
                if matches!(outcome, Outcome::Ok(_)) {
                    summary.histories_fetched += 1;
                }
                let conn = db.lock().expect("report db lock");
                checkpoint(&conn, ds, &id, &updated, &outcome)?;
            }
            Err(e) => {
                if fatal.is_none() {
                    fatal = Some(e);
                    sh.stop.store(true, Ordering::Relaxed);
                }
            }
        }
        done += 1;
        report("history", done, todo_total);
    }
    if sh.cancel.load(Ordering::Relaxed) {
        return Err(AppError::Cancelled);
    }
    if let Some(e) = fatal {
        return Err(match e {
            AppError::Cancelled => AppError::Cancelled,
            other => other,
        });
    }

    report("publishing", 0, 0);
    {
        let mut conn = db.lock().expect("report db lock");
        publish(&mut conn, ds, dataset, &meta, full, now_ms, &mut summary)?;
        summary.data_version = data_version(&conn, ds)?;
        db::optimize(&conn)?;
    }
    summary.requests = sh.requests.load(Ordering::Relaxed);
    summary.throttled = sh.throttled.load(Ordering::Relaxed);
    report("done", todo_total, todo_total);
    Ok(summary)
}

/// Test double for Jira: canned responses per path, with optional scripted failures.
#[cfg(test)]
pub mod fake {
    use super::*;
    use std::collections::BTreeMap;

    #[derive(Clone, Default)]
    pub struct FakeJira {
        pub types: Vec<(String, String, Value)>,
        pub objects: Arc<Mutex<Vec<Value>>>,
        pub histories: Arc<Mutex<BTreeMap<String, Result<Value, u16>>>>,
        /// Number of 429 responses to return before succeeding, per path.
        pub throttle: Arc<Mutex<BTreeMap<String, u32>>>,
        pub log: Arc<Mutex<Vec<String>>>,
    }

    impl Fetch for FakeJira {
        fn send(&self, method: &'static str, path: String, query: Vec<(String, String)>, _body: Option<Value>) -> impl Future<Output = Result<Value, Failure>> + Send {
            let this = self.clone();
            async move {
                this.log.lock().unwrap().push(format!("{method} {path}"));
                if let Some(n) = this.throttle.lock().unwrap().get_mut(&path) {
                    if *n > 0 {
                        *n -= 1;
                        return Err(Failure { error: AppError::Http { status: 429, message: "slow down".into() }, retry_after: Some(Duration::ZERO) });
                    }
                }
                let http = |status: u16| Failure { error: AppError::Http { status, message: format!("HTTP {status}") }, retry_after: None };
                for (id, name, attrs) in &this.types {
                    if path == format!("/objecttype/{id}") {
                        return Ok(json!({ "id": id, "name": name }));
                    }
                    if path == format!("/objecttype/{id}/attributes") {
                        return Ok(attrs.clone());
                    }
                }
                let objects = this.objects.lock().unwrap().clone();
                if path == "/object/aql/totalcount" {
                    return Ok(json!({ "totalCount": objects.len() }));
                }
                if path == "/object/aql" {
                    let get = |k: &str| query.iter().find(|(q, _)| q == k).and_then(|(_, v)| v.parse::<usize>().ok()).unwrap_or(0);
                    let (start, max) = (get("startAt"), get("maxResults"));
                    let page: Vec<Value> = objects.iter().skip(start).take(max).cloned().collect();
                    let last = start + page.len() >= objects.len();
                    return Ok(json!({ "startAt": start, "maxResults": max, "total": objects.len(), "isLast": last, "values": page }));
                }
                if let Some(id) = path.strip_prefix("/object/").and_then(|p| p.strip_suffix("/history")) {
                    return match this.histories.lock().unwrap().get(id) {
                        Some(Ok(v)) => Ok(v.clone()),
                        Some(Err(status)) => Err(http(*status)),
                        None => Ok(json!([])),
                    };
                }
                Err(http(404))
            }
        }
    }
}
