//! Local reporting database. One SQLite file per Jira site, workspace and account, so data collected under one
//! account is never shown to another.

use std::path::Path;

use rusqlite::functions::FunctionFlags;
use rusqlite::{params, Connection, OptionalExtension};

use super::time::{bucket_label, local_day, parse_day, parse_tz, Unit};
use crate::error::{AppError, AppResult};

const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS datasets (
  ds_id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  data_version INTEGER NOT NULL DEFAULT 0,
  norm_hash TEXT,
  scope_hash TEXT,
  last_refresh_ms INTEGER,
  last_full_ms INTEGER,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS types (ds_id INTEGER NOT NULL, type_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (ds_id, type_id));
CREATE TABLE IF NOT EXISTS attrs (
  ds_id INTEGER NOT NULL, attr_id TEXT NOT NULL, type_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
  PRIMARY KEY (ds_id, attr_id)
);
CREATE TABLE IF NOT EXISTS objects (
  ds_id INTEGER NOT NULL, object_id TEXT NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL, type_id TEXT NOT NULL,
  created_ms INTEGER, updated_ms INTEGER, updated_raw TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (ds_id, object_id)
);
CREATE INDEX IF NOT EXISTS objects_key ON objects (ds_id, key);
CREATE TABLE IF NOT EXISTS attr_values (
  ds_id INTEGER NOT NULL, object_id TEXT NOT NULL, attr_id TEXT NOT NULL, seq INTEGER NOT NULL,
  raw TEXT, display TEXT, num REAL, ms INTEGER, day TEXT, ref_key TEXT
);
CREATE INDEX IF NOT EXISTS attr_values_object ON attr_values (ds_id, object_id, attr_id);
CREATE INDEX IF NOT EXISTS attr_values_attr ON attr_values (ds_id, attr_id, raw);
CREATE INDEX IF NOT EXISTS attr_values_ref ON attr_values (ds_id, attr_id, ref_key);
CREATE TABLE IF NOT EXISTS objects_stage (
  ds_id INTEGER NOT NULL, object_id TEXT NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL, type_id TEXT NOT NULL,
  created_ms INTEGER, updated_ms INTEGER, updated_raw TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (ds_id, object_id)
);
CREATE TABLE IF NOT EXISTS attr_values_stage (
  ds_id INTEGER NOT NULL, object_id TEXT NOT NULL, attr_id TEXT NOT NULL, seq INTEGER NOT NULL,
  raw TEXT, display TEXT, num REAL, ms INTEGER, day TEXT, ref_key TEXT, ref_label TEXT
);
CREATE INDEX IF NOT EXISTS attr_values_stage_object ON attr_values_stage (ds_id, object_id);
CREATE TABLE IF NOT EXISTS members (
  ds_id INTEGER NOT NULL, object_id TEXT NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL, type_id TEXT NOT NULL,
  present INTEGER NOT NULL DEFAULT 1,
  history_state TEXT NOT NULL DEFAULT 'pending',
  history_updated TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (ds_id, object_id)
);
CREATE TABLE IF NOT EXISTS history_stage (
  ds_id INTEGER NOT NULL, object_id TEXT NOT NULL, state TEXT NOT NULL, updated_raw TEXT NOT NULL, entries TEXT,
  PRIMARY KEY (ds_id, object_id)
);
CREATE TABLE IF NOT EXISTS events (
  ds_id INTEGER NOT NULL, object_id TEXT NOT NULL, history_id TEXT NOT NULL,
  created_ms INTEGER, kind INTEGER NOT NULL DEFAULT -1, affected TEXT NOT NULL DEFAULT '',
  old_raw TEXT NOT NULL DEFAULT '', new_raw TEXT NOT NULL DEFAULT '',
  actor_key TEXT, actor_name TEXT,
  attr_id TEXT, attr_name TEXT NOT NULL DEFAULT '', operation TEXT NOT NULL DEFAULT 'other',
  resolution TEXT NOT NULL DEFAULT 'resolved', norm INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ds_id, object_id, history_id)
);
CREATE INDEX IF NOT EXISTS events_created ON events (ds_id, created_ms);
CREATE INDEX IF NOT EXISTS events_attr ON events (ds_id, attr_id, created_ms);
CREATE TABLE IF NOT EXISTS event_refs (
  ds_id INTEGER NOT NULL, object_id TEXT NOT NULL, history_id TEXT NOT NULL, side TEXT NOT NULL, ref_key TEXT NOT NULL
);
-- Covering per-event index; ref_key is included so EXISTS filters never fall back to scanning every event for a key.
DROP INDEX IF EXISTS event_refs_event;
CREATE INDEX IF NOT EXISTS event_refs_lookup ON event_refs (ds_id, object_id, history_id, side, ref_key);
CREATE INDEX IF NOT EXISTS event_refs_key ON event_refs (ds_id, side, ref_key);
CREATE TABLE IF NOT EXISTS ref_labels (ds_id INTEGER NOT NULL, ref_key TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY (ds_id, ref_key));
"#;

pub fn open(path: &Path) -> AppResult<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let conn = Connection::open(path).map_err(db_err)?;
    setup(&conn)?;
    Ok(conn)
}

#[cfg(test)]
pub fn open_memory() -> AppResult<Connection> {
    let conn = Connection::open_in_memory().map_err(db_err)?;
    setup(&conn)?;
    Ok(conn)
}

fn setup(conn: &Connection) -> AppResult<()> {
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF; PRAGMA temp_store = MEMORY;")
        .map_err(db_err)?;
    let version: Option<i64> = conn
        .query_row("SELECT v FROM meta WHERE k = 'schema'", [], |r| r.get::<_, String>(0))
        .optional()
        .unwrap_or(None)
        .and_then(|v| v.parse().ok());
    if version.is_some_and(|v| v > SCHEMA_VERSION) {
        return Err(AppError::Invalid("The report database was created by a newer version of JAM. Clear report data to continue.".into()));
    }
    conn.execute_batch(SCHEMA).map_err(db_err)?;
    conn.execute("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', ?1)", params![SCHEMA_VERSION.to_string()])
        .map_err(db_err)?;
    register_functions(conn)?;
    Ok(())
}

/// Refreshes planner statistics so filters on large histories pick selective indexes.
pub fn optimize(conn: &Connection) -> AppResult<()> {
    conn.execute_batch("PRAGMA analysis_limit = 1000; PRAGMA optimize = 0x10002;").map_err(db_err)
}

pub fn db_err(e: rusqlite::Error) -> AppError {
    AppError::Io(format!("Report database error: {e}"))
}

fn register_functions(conn: &Connection) -> AppResult<()> {
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    conn.create_scalar_function("rpt_lower", 1, flags, |ctx| {
        Ok(ctx.get::<Option<String>>(0)?.map(|s| s.to_lowercase()))
    })
    .map_err(db_err)?;
    // rpt_bucket(ms, unit, tz): local calendar period of a UTC instant.
    conn.create_scalar_function("rpt_bucket", 3, flags, |ctx| {
        let Some(ms) = ctx.get::<Option<i64>>(0)? else { return Ok(None) };
        let unit = Unit::parse(&ctx.get::<String>(1)?).map_err(|e| rusqlite::Error::UserFunctionError(e.to_string().into()))?;
        let tz = parse_tz(&ctx.get::<String>(2)?).map_err(|e| rusqlite::Error::UserFunctionError(e.to_string().into()))?;
        Ok(local_day(tz, ms).map(|d| bucket_label(d, unit)))
    })
    .map_err(db_err)?;
    // rpt_bucket_day(day, unit): period of a date-only value; no timezone applies.
    conn.create_scalar_function("rpt_bucket_day", 2, flags, |ctx| {
        let Some(day) = ctx.get::<Option<String>>(0)? else { return Ok(None) };
        let unit = Unit::parse(&ctx.get::<String>(1)?).map_err(|e| rusqlite::Error::UserFunctionError(e.to_string().into()))?;
        Ok(parse_day(&day).ok().map(|d| bucket_label(d, unit)))
    })
    .map_err(db_err)?;
    Ok(())
}

/// Integer id for a dataset UUID, created on first use.
pub fn dataset_id(conn: &Connection, uid: &str) -> AppResult<i64> {
    conn.execute("INSERT OR IGNORE INTO datasets (uid) VALUES (?1)", params![uid]).map_err(db_err)?;
    conn.query_row("SELECT ds_id FROM datasets WHERE uid = ?1", params![uid], |r| r.get(0)).map_err(db_err)
}

pub fn existing_dataset_id(conn: &Connection, uid: &str) -> AppResult<Option<i64>> {
    conn.query_row("SELECT ds_id FROM datasets WHERE uid = ?1", params![uid], |r| r.get(0)).optional().map_err(db_err)
}

pub fn data_version(conn: &Connection, ds: i64) -> AppResult<i64> {
    conn.query_row("SELECT data_version FROM datasets WHERE ds_id = ?1", params![ds], |r| r.get(0)).map_err(db_err)
}

const DATASET_TABLES: [&str; 11] = [
    "types",
    "attrs",
    "objects",
    "attr_values",
    "objects_stage",
    "attr_values_stage",
    "members",
    "history_stage",
    "events",
    "event_refs",
    "ref_labels",
];

pub fn clear_dataset(conn: &mut Connection, ds: i64) -> AppResult<()> {
    let tx = conn.transaction().map_err(db_err)?;
    for table in DATASET_TABLES {
        tx.execute(&format!("DELETE FROM {table} WHERE ds_id = ?1"), params![ds]).map_err(db_err)?;
    }
    tx.execute("DELETE FROM datasets WHERE ds_id = ?1", params![ds]).map_err(db_err)?;
    tx.commit().map_err(db_err)
}
