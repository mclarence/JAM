//! Compiles a validated report specification to SQL over the local reporting database.
//!
//! Multi-valued fields (attributes, referenced objects) are filtered with EXISTS so filters never duplicate rows.
//! Aggregates first collapse to one row per (record, group) before measuring, so grouping by a multi-valued field
//! counts a record once in each group it belongs to and never twice in the same group.

use std::collections::HashMap;

use chrono::Duration;
use chrono_tz::Tz;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde::Serialize;
use serde_json::{json, Value};

use super::db::db_err;
use super::model::{catalogue, find, Entity, FieldDef, FieldType, GroupBy, Join, Measure, Mode, Node, QuerySpec, Sort, Src};
use super::time::{local_day, local_midnight_ms, parse_day, parse_tz, relative_start, Unit};
use crate::error::{AppError, AppResult};

pub const MAX_GROUP_BY: usize = 2;
pub const MAX_MEASURES: usize = 8;
pub const MAX_COLUMNS: usize = 50;
pub const MAX_LIST: usize = 1000;
pub const MAX_NODES: usize = 100;
pub const MAX_DEPTH: usize = 5;
pub const MAX_GROUPS: usize = 50_000;
/// Internal operator used to compute a chart's "Other" bucket; rejected in user input.
pub const OTHER_OP: &str = "__other";

fn invalid<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Invalid(msg.into()))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub ctype: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bucket: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "fn")]
    pub func: Option<String>,
}

fn type_name(t: FieldType) -> &'static str {
    match t {
        FieldType::Text => "text",
        FieldType::Number => "number",
        FieldType::Date => "date",
        FieldType::Datetime => "datetime",
        FieldType::Boolean => "boolean",
        FieldType::Ref => "ref",
        FieldType::Enum => "enum",
    }
}

pub struct Compiler<'a> {
    ds: i64,
    entity: Entity,
    tz: Tz,
    tz_name: String,
    now_ms: i64,
    fields: &'a [FieldDef],
    params: Vec<SqlValue>,
}

fn sql_str(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn json_to_sql(v: &Value) -> AppResult<SqlValue> {
    match v {
        Value::String(s) => Ok(SqlValue::Text(s.clone())),
        Value::Number(n) => Ok(n.as_i64().map(SqlValue::Integer).unwrap_or_else(|| SqlValue::Real(n.as_f64().unwrap_or(0.0)))),
        Value::Bool(b) => Ok(SqlValue::Text(b.to_string())),
        _ => invalid("Filter values must be text or numbers."),
    }
}

impl<'a> Compiler<'a> {
    pub fn new(ds: i64, entity: Entity, tz_name: &str, now_ms: i64, fields: &'a [FieldDef]) -> AppResult<Self> {
        let tz = parse_tz(tz_name)?;
        Ok(Self { ds, entity, tz, tz_name: tz_name.to_string(), now_ms, fields, params: vec![] })
    }

    fn owner(&self) -> &'static str {
        match self.entity {
            Entity::Assets => "o.object_id",
            Entity::Events => "e.object_id",
        }
    }

    pub fn rid(&self) -> &'static str {
        match self.entity {
            Entity::Assets => "o.rowid",
            Entity::Events => "e.rowid",
        }
    }

    pub fn from(&self) -> String {
        match self.entity {
            Entity::Assets => "FROM objects o".into(),
            Entity::Events => "FROM events e JOIN members m ON m.ds_id = e.ds_id AND m.object_id = e.object_id \
                 LEFT JOIN objects o ON o.ds_id = e.ds_id AND o.object_id = e.object_id"
                .into(),
        }
    }

    fn sub(&self, src: &Src) -> Option<(String, String)> {
        match src {
            Src::Scalar { .. } => None,
            Src::Attr { id, col } => Some((
                format!("FROM attr_values v WHERE v.ds_id = {} AND v.object_id = {} AND v.attr_id = {}", self.ds, self.owner(), sql_str(id)),
                format!("v.{col}"),
            )),
            Src::Refs { side, .. } => Some((
                format!(
                    "FROM event_refs r WHERE r.ds_id = e.ds_id AND r.object_id = e.object_id AND r.history_id = e.history_id AND r.side = '{side}'{}",
                    src.event_constraint()
                ),
                "r.ref_key".into(),
            )),
        }
    }

    fn push(&mut self, v: SqlValue) -> &'static str {
        self.params.push(v);
        "?"
    }

    fn text(value: &Value) -> AppResult<String> {
        match value {
            Value::String(s) if s.len() <= 1000 => Ok(s.clone()),
            Value::Number(n) => Ok(n.to_string()),
            _ => invalid("Enter a value for each filter."),
        }
    }

    fn list(value: &Value) -> AppResult<Vec<Value>> {
        match value {
            Value::Array(items) if !items.is_empty() && items.len() <= MAX_LIST => {
                if items.iter().all(|v| v.is_string() || v.is_number()) {
                    Ok(items.clone())
                } else {
                    invalid("Filter lists may only contain text or numbers.")
                }
            }
            Value::Array(items) if items.is_empty() => invalid("Choose at least one value for each filter."),
            _ => invalid(format!("Choose at most {MAX_LIST} values per filter.")),
        }
    }

    fn number(value: &Value) -> AppResult<f64> {
        match value {
            Value::Number(n) => n.as_f64().ok_or(()).or_else(|_| invalid("Invalid number.")),
            Value::String(s) => s.trim().parse::<f64>().or_else(|_| invalid(format!("\"{s}\" is not a number."))),
            _ => invalid("Enter a number."),
        }
    }

    fn day_arg(value: &Value) -> AppResult<chrono::NaiveDate> {
        match value {
            Value::String(s) => parse_day(s),
            _ => invalid("Choose a date."),
        }
    }

    /// Half-open [lo, hi) bounds as ms (datetime) or YYYY-MM-DD (date-only).
    fn date_bounds(&self, op: &str, value: &Value, date_only: bool) -> AppResult<(Option<SqlValue>, Option<SqlValue>)> {
        let today = local_day(self.tz, self.now_ms).expect("current time is valid");
        let (lo, hi) = match op {
            "last" => {
                let amount = value.get("amount").and_then(Value::as_u64).filter(|a| (1..=3650).contains(a));
                let Some(amount) = amount else { return invalid("Enter how many days, weeks or months (1–3650).") };
                let unit = Unit::parse(value.get("unit").and_then(Value::as_str).unwrap_or(""))?;
                (Some(relative_start(today, amount as u32, unit)), Some(today + Duration::days(1)))
            }
            "between" => {
                let from = value.get("from").filter(|v| !v.is_null()).map(Self::day_arg).transpose()?;
                let to = value.get("to").filter(|v| !v.is_null()).map(Self::day_arg).transpose()?;
                if from.is_none() && to.is_none() {
                    return invalid("Choose a start or end date.");
                }
                if let (Some(f), Some(t)) = (from, to) {
                    if f > t {
                        return invalid("The start date must be on or before the end date.");
                    }
                }
                (from, to.map(|t| t + Duration::days(1)))
            }
            "on" => {
                let d = Self::day_arg(value)?;
                (Some(d), Some(d + Duration::days(1)))
            }
            "before" => (None, Some(Self::day_arg(value)?)),
            "after" => (Some(Self::day_arg(value)? + Duration::days(1)), None),
            _ => unreachable!(),
        };
        let conv = |d: chrono::NaiveDate| {
            if date_only {
                SqlValue::Text(d.format("%Y-%m-%d").to_string())
            } else {
                SqlValue::Integer(local_midnight_ms(self.tz, d))
            }
        };
        Ok((lo.map(conv), hi.map(conv)))
    }

    /// Predicate on a single column value, for operators that match when a value satisfies them.
    fn positive(&mut self, f: &FieldDef, op: &str, value: &Value, col: &str) -> AppResult<String> {
        let ci = matches!(f.ftype, FieldType::Text);
        Ok(match op {
            "eq" | "neq" if f.ftype == FieldType::Number => format!("{col} = {}", self.push(SqlValue::Real(Self::number(value)?))),
            "eq" | "neq" => format!("rpt_lower({col}) = {}", self.push(SqlValue::Text(Self::text(value)?.to_lowercase()))),
            "contains" | "notContains" => {
                let needle = Self::text(value)?.to_lowercase();
                if needle.is_empty() {
                    return invalid("Enter text to search for.");
                }
                format!("instr(rpt_lower({col}), {}) > 0", self.push(SqlValue::Text(needle)))
            }
            "startsWith" => {
                let prefix = Self::text(value)?.to_lowercase();
                let n = prefix.chars().count();
                format!("substr(rpt_lower({col}), 1, {n}) = {}", self.push(SqlValue::Text(prefix)))
            }
            "in" | "notIn" => {
                let items = Self::list(value)?;
                let mut marks = Vec::with_capacity(items.len());
                for item in &items {
                    let v = if ci { SqlValue::Text(Self::text(item)?.to_lowercase()) } else { json_to_sql(item)? };
                    marks.push(self.push(v));
                }
                let lhs = if ci { format!("rpt_lower({col})") } else { col.to_string() };
                format!("{lhs} IN ({})", marks.join(", "))
            }
            "gt" | "gte" | "lt" | "lte" => {
                let sym = match op {
                    "gt" => ">",
                    "gte" => ">=",
                    "lt" => "<",
                    _ => "<=",
                };
                format!("{col} {sym} {}", self.push(SqlValue::Real(Self::number(value)?)))
            }
            "between" if f.ftype == FieldType::Number => {
                let min = value.get("min").filter(|v| !v.is_null()).map(Self::number).transpose()?;
                let max = value.get("max").filter(|v| !v.is_null()).map(Self::number).transpose()?;
                let mut parts = vec![format!("{col} IS NOT NULL")];
                if let Some(m) = min {
                    parts.push(format!("{col} >= {}", self.push(SqlValue::Real(m))));
                }
                if let Some(m) = max {
                    parts.push(format!("{col} <= {}", self.push(SqlValue::Real(m))));
                }
                if min.is_none() && max.is_none() {
                    return invalid("Enter a minimum or maximum.");
                }
                parts.join(" AND ")
            }
            "last" | "between" | "on" | "before" | "after" => {
                let (lo, hi) = self.date_bounds(op, value, f.ftype == FieldType::Date)?;
                let mut parts = vec![format!("{col} IS NOT NULL")];
                if let Some(lo) = lo {
                    parts.push(format!("{col} >= {}", self.push(lo)));
                }
                if let Some(hi) = hi {
                    parts.push(format!("{col} < {}", self.push(hi)));
                }
                parts.join(" AND ")
            }
            "isTrue" => format!("rpt_lower({col}) = 'true'"),
            "isFalse" => format!("rpt_lower({col}) = 'false'"),
            _ => return invalid(format!("Unsupported operator \"{op}\".")),
        })
    }

    fn other_keys(&mut self, value: &Value, col: &str) -> AppResult<String> {
        let keys = value.get("keys").and_then(Value::as_array).cloned().unwrap_or_default();
        if keys.is_empty() {
            return Ok(format!("{col} IS NOT NULL"));
        }
        let mut marks = Vec::new();
        for k in &keys {
            marks.push(self.push(json_to_sql(k)?));
        }
        Ok(format!("{col} IS NOT NULL AND {col} NOT IN ({})", marks.join(", ")))
    }

    fn condition(&mut self, field: &str, op: &str, value: &Value, internal: bool) -> AppResult<String> {
        let f = find(self.fields, field)?.clone();
        if op == OTHER_OP {
            if !internal {
                return invalid("Unsupported operator.");
            }
            let include_null = value.get("includeNull").and_then(Value::as_bool).unwrap_or(false);
            return Ok(match (self.sub(&f.src), &f.src) {
                (Some((from, col)), _) => {
                    let p = self.other_keys(value, &col)?;
                    let none = if include_null { format!(" OR NOT EXISTS (SELECT 1 {from} AND {col} IS NOT NULL)") } else { String::new() };
                    format!("(EXISTS (SELECT 1 {from} AND {p}){none})")
                }
                (None, Src::Scalar { key, .. }) => {
                    let p = self.other_keys(value, key)?;
                    let none = if include_null { format!(" OR {key} IS NULL") } else { String::new() };
                    format!("(({p}){none})")
                }
                _ => unreachable!(),
            });
        }
        if !f.operators.contains(&op) {
            return invalid(format!("\"{}\" does not support this filter.", f.label));
        }
        let negative = matches!(op, "neq" | "notContains" | "notIn");
        if let (Src::Refs { side, .. }, "in") = (&f.src, op) {
            // A semi-join on the event key lets SQLite start from the few matching references instead of every event.
            let p = self.positive(&f, op, value, "r.ref_key")?;
            return Ok(format!(
                "((e.ds_id, e.object_id, e.history_id) IN (SELECT r.ds_id, r.object_id, r.history_id FROM event_refs r WHERE r.ds_id = {} AND r.side = '{side}' AND {p}){})",
                self.ds, f.src.event_constraint()
            ));
        }
        match (self.sub(&f.src), &f.src) {
            (Some((from, col)), _) => Ok(match op {
                "empty" => format!("NOT EXISTS (SELECT 1 {from} AND {col} IS NOT NULL AND {col} <> '')"),
                "notEmpty" => format!("EXISTS (SELECT 1 {from} AND {col} IS NOT NULL AND {col} <> '')"),
                _ => {
                    let p = self.positive(&f, op, value, &col)?;
                    if negative {
                        format!("NOT EXISTS (SELECT 1 {from} AND {p})")
                    } else {
                        format!("EXISTS (SELECT 1 {from} AND {p})")
                    }
                }
            }),
            (None, Src::Scalar { key, .. }) => Ok(match op {
                "empty" => format!("({key} IS NULL OR {key} = '')"),
                "notEmpty" => format!("({key} IS NOT NULL AND {key} <> '')"),
                _ => {
                    let p = self.positive(&f, op, value, key)?;
                    if negative {
                        format!("({key} IS NULL OR NOT ({p}))")
                    } else {
                        format!("({p})")
                    }
                }
            }),
            _ => unreachable!(),
        }
    }

    fn node(&mut self, node: &Node, depth: usize, count: &mut usize, internal: bool) -> AppResult<Option<String>> {
        *count += 1;
        if depth > MAX_DEPTH || *count > MAX_NODES {
            return invalid("The filter is too complex.");
        }
        match node {
            Node::Condition { field, op, value } => self.condition(field, op, value, internal).map(Some),
            Node::Group { join, children } => {
                let mut parts = Vec::new();
                for child in children {
                    if let Some(p) = self.node(child, depth + 1, count, internal)? {
                        parts.push(p);
                    }
                }
                if parts.is_empty() {
                    return Ok(None);
                }
                let sep = if *join == Join::And { " AND " } else { " OR " };
                Ok(Some(format!("({})", parts.join(sep))))
            }
        }
    }

    /// WHERE clause (without the keyword) and its parameters.
    pub fn where_clause(&mut self, spec: &QuerySpec, extra: Option<&Node>) -> AppResult<(String, Vec<SqlValue>)> {
        self.params.clear();
        let ds = self.ds;
        let mut parts = match self.entity {
            Entity::Assets => vec![format!("o.ds_id = {ds}")],
            Entity::Events => {
                let mut p = vec![format!("e.ds_id = {ds}"), "m.history_state <> 'denied'".to_string()];
                if !spec.include_unavailable {
                    p.push("o.object_id IS NOT NULL".into());
                }
                p
            }
        };
        if !spec.include_soft_deleted {
            for marker in &spec.soft_delete {
                if !model_digits(&marker.type_id) || !model_digits(&marker.attribute_id) || marker.value.is_empty() {
                    return invalid("Invalid deletion marker.");
                }
                let mark = self.push(SqlValue::Text(marker.value.to_lowercase()));
                parts.push(format!(
                    "NOT (o.type_id = {} AND EXISTS (SELECT 1 FROM attr_values sd WHERE sd.ds_id = {ds} AND sd.object_id = o.object_id \
                     AND sd.attr_id = {} AND rpt_lower(COALESCE(sd.raw, sd.display)) = {mark}))",
                    sql_str(&marker.type_id),
                    sql_str(&marker.attribute_id)
                ));
            }
        }
        let mut count = 0;
        if let Some(p) = self.node(&spec.filter, 0, &mut count, false)? {
            parts.push(p);
        }
        if let Some(extra) = extra {
            if let Some(p) = self.node(extra, 0, &mut 0, true)? {
                parts.push(p);
            }
        }
        Ok((parts.join(" AND "), std::mem::take(&mut self.params)))
    }

    /// Value shown for a field in a detail row, and the expression used to sort by it.
    fn display(&self, f: &FieldDef) -> (String, String) {
        match &f.src {
            Src::Scalar { display, .. } => {
                let sort = if matches!(f.ftype, FieldType::Text | FieldType::Enum) { format!("{display} COLLATE NOCASE") } else { display.clone() };
                (display.clone(), sort)
            }
            Src::Attr { id, col } => {
                let from = format!(
                    "FROM attr_values v WHERE v.ds_id = {} AND v.object_id = {} AND v.attr_id = {}",
                    self.ds,
                    self.owner(),
                    sql_str(id)
                );
                if matches!(f.ftype, FieldType::Number | FieldType::Date | FieldType::Datetime) {
                    let e = format!("(SELECT v.{col} {from} ORDER BY v.seq LIMIT 1)");
                    (e.clone(), e)
                } else {
                    let item = if f.ftype == FieldType::Ref {
                        "COALESCE(NULLIF(v.display, ''), v.ref_key, v.raw)"
                    } else {
                        "COALESCE(v.display, v.raw)"
                    };
                    let e = format!("(SELECT group_concat({item}, '; ' ORDER BY v.seq) {from})");
                    (e.clone(), format!("{e} COLLATE NOCASE"))
                }
            }
            Src::Refs { side, .. } => {
                let e = format!(
                    "(SELECT group_concat(COALESCE(NULLIF(l.label, ''), r.ref_key), '; ' ORDER BY r.ref_key) \
                     FROM event_refs r LEFT JOIN ref_labels l ON l.ds_id = r.ds_id AND l.ref_key = r.ref_key \
                     WHERE r.ds_id = e.ds_id AND r.object_id = e.object_id AND r.history_id = e.history_id AND r.side = '{side}'{})",
                    f.src.event_constraint()
                );
                (e.clone(), format!("{e} COLLATE NOCASE"))
            }
        }
    }

    /// (join clause, key expression, label expression) for a grouping.
    fn dimension(&self, g: &GroupBy, i: usize) -> AppResult<(String, String, String)> {
        let f = find(self.fields, &g.field)?;
        let unit = match (&g.bucket, f.ftype.is_time()) {
            (Some(b), true) => Some(Unit::parse(b)?),
            (None, true) => return invalid(format!("Choose day, week or month to group by \"{}\".", f.label)),
            (Some(_), false) => return invalid(format!("\"{}\" is not a date.", f.label)),
            (None, false) => None,
        };
        let unit_name = match unit {
            Some(Unit::Day) => "day",
            Some(Unit::Week) => "week",
            Some(Unit::Month) => "month",
            None => "",
        };
        let bucket = |expr: &str| match f.ftype {
            FieldType::Date => format!("rpt_bucket_day({expr}, '{unit_name}')"),
            _ => format!("rpt_bucket({expr}, '{unit_name}', {})", sql_str(&self.tz_name)),
        };
        let g_alias = format!("g{i}");
        Ok(match &f.src {
            Src::Scalar { key, display } => {
                if unit.is_some() {
                    let b = bucket(key);
                    (String::new(), b.clone(), b)
                } else {
                    (String::new(), key.clone(), display.clone())
                }
            }
            Src::Attr { id, col } => {
                let join = format!(
                    " LEFT JOIN attr_values {g_alias} ON {g_alias}.ds_id = {} AND {g_alias}.object_id = {} AND {g_alias}.attr_id = {}",
                    self.ds,
                    self.owner(),
                    sql_str(id)
                );
                let key = format!("{g_alias}.{col}");
                if unit.is_some() {
                    let b = bucket(&key);
                    (join, b.clone(), b)
                } else {
                    let label = if f.ftype == FieldType::Ref {
                        format!("COALESCE(NULLIF({g_alias}.display, ''), {g_alias}.ref_key)")
                    } else {
                        format!("COALESCE({g_alias}.display, {g_alias}.raw)")
                    };
                    (join, key, label)
                }
            }
            Src::Refs { side, .. } => (
                format!(
                    " LEFT JOIN event_refs {g_alias} ON {g_alias}.ds_id = e.ds_id AND {g_alias}.object_id = e.object_id \
                     AND {g_alias}.history_id = e.history_id AND {g_alias}.side = '{side}'{}",
                    f.src.event_constraint()
                ),
                format!("{g_alias}.ref_key"),
                format!(
                    "COALESCE((SELECT l.label FROM ref_labels l WHERE l.ds_id = {} AND l.ref_key = {g_alias}.ref_key), {g_alias}.ref_key)",
                    self.ds
                ),
            ),
        })
    }
}

pub fn model_digits(s: &str) -> bool {
    !s.is_empty() && s.len() <= 18 && s.bytes().all(|b| b.is_ascii_digit())
}

pub fn sql_to_json(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) if f.is_finite() => json!(f),
        ValueRef::Real(_) => Value::Null,
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(_) => Value::Null,
    }
}

fn default_columns(entity: Entity) -> Vec<String> {
    let list: &[&str] = match entity {
        Entity::Assets => &["asset.key", "asset.label", "asset.type", "asset.updated"],
        Entity::Events => &[
            "event.created",
            "asset.key",
            "asset.label",
            "event.attribute",
            "event.operation",
            "event.oldValue",
            "event.newValue",
            "event.actor",
        ],
    };
    list.iter().map(|s| s.to_string()).collect()
}

/// A prepared detail listing: re-executed per page so very large histories are never held in memory.
#[derive(Clone)]
pub struct DetailPlan {
    pub columns: Vec<Column>,
    select: Vec<String>,
    sorts: HashMap<String, String>,
    rid: String,
    from: String,
    where_sql: String,
    params: Vec<SqlValue>,
    pub default_sort: Sort,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AggRow {
    pub keys: Vec<Value>,
    pub labels: Vec<Value>,
    pub values: Vec<Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AggResult {
    pub dimensions: Vec<Column>,
    pub measures: Vec<Column>,
    pub rows: Vec<AggRow>,
    pub totals: Vec<Value>,
    pub truncated: bool,
}

fn measure_label(m: &Measure, f: Option<&FieldDef>) -> String {
    if let Some(l) = m.label.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
        return l.chars().take(100).collect();
    }
    let name = f.map(|f| f.label.as_str()).unwrap_or("");
    match m.func.as_str() {
        "count" => "Count".into(),
        "countValues" => format!("Count with {name}"),
        "distinct" => format!("Distinct {name}"),
        "sum" => format!("Sum of {name}"),
        "avg" => format!("Average {name}"),
        _ => m.func.clone(),
    }
}

pub fn validate_spec(spec: &QuerySpec) -> AppResult<()> {
    if spec.v != 1 {
        return invalid("This report was created by a newer version of JAM.");
    }
    match spec.mode {
        Mode::Detail => {
            if spec.columns.len() > MAX_COLUMNS {
                return invalid(format!("Choose at most {MAX_COLUMNS} columns."));
            }
        }
        Mode::Aggregate => {
            if spec.group_by.len() > MAX_GROUP_BY {
                return invalid(format!("Group by at most {MAX_GROUP_BY} fields."));
            }
            if spec.measures.is_empty() || spec.measures.len() > MAX_MEASURES {
                return invalid(format!("Choose between 1 and {MAX_MEASURES} measures."));
            }
            let mut ids = std::collections::HashSet::new();
            for m in &spec.measures {
                if m.id.is_empty() || m.id.len() > 64 || !ids.insert(&m.id) {
                    return invalid("Each measure needs a unique id.");
                }
            }
        }
    }
    Ok(())
}

pub fn plan_detail(conn: &Connection, ds: i64, spec: &QuerySpec, now_ms: i64) -> AppResult<DetailPlan> {
    validate_spec(spec)?;
    let fields = catalogue(conn, ds, spec.entity)?;
    let mut c = Compiler::new(ds, spec.entity, &spec.timezone, now_ms, &fields)?;
    let (where_sql, params) = c.where_clause(spec, None)?;
    let ids = if spec.columns.is_empty() { default_columns(spec.entity) } else { spec.columns.clone() };
    let mut columns = Vec::new();
    let mut select = Vec::new();
    let mut sorts = HashMap::new();
    for id in ids {
        if columns.iter().any(|c: &Column| c.id == id) {
            continue;
        }
        let f = find(&fields, &id)?;
        let (expr, sort) = c.display(f);
        columns.push(Column { id: id.clone(), label: f.label.clone(), ctype: type_name(f.ftype), field: Some(id.clone()), bucket: None, func: None });
        select.push(expr);
        sorts.insert(id, sort);
    }
    let default_sort = match spec.entity {
        Entity::Events => Sort { column: "event.created".into(), desc: true },
        Entity::Assets => Sort { column: "asset.key".into(), desc: false },
    };
    if !sorts.contains_key(&default_sort.column) {
        let f = find(&fields, &default_sort.column)?;
        sorts.insert(default_sort.column.clone(), c.display(f).1);
    }
    Ok(DetailPlan { columns, select, sorts, rid: c.rid().into(), from: c.from(), where_sql, params, default_sort })
}

impl DetailPlan {
    pub fn count(&self, conn: &Connection) -> AppResult<i64> {
        let sql = format!("SELECT COUNT(*) {} WHERE {}", self.from, self.where_sql);
        conn.query_row(&sql, params_from_iter(self.params.iter()), |r| r.get(0)).map_err(db_err)
    }

    fn order(&self, sort: Option<&Sort>) -> AppResult<String> {
        let sort = sort.unwrap_or(&self.default_sort);
        let expr = self.sorts.get(&sort.column).ok_or_else(|| AppError::Invalid("Sort by a column shown in the report.".into()))?;
        let dir = if sort.desc { "DESC" } else { "ASC" };
        // NULLs last in both directions, then a stable tiebreaker so pages never overlap.
        Ok(format!("ORDER BY ({expr}) IS NULL, {expr} {dir}, {} {dir}", self.rid))
    }

    fn sql(&self, sort: Option<&Sort>, paged: bool) -> AppResult<String> {
        let limit = if paged { " LIMIT ? OFFSET ?" } else { "" };
        Ok(format!("SELECT {} {} WHERE {} {}{limit}", self.select.join(", "), self.from, self.where_sql, self.order(sort)?))
    }

    pub fn page(&self, conn: &Connection, sort: Option<&Sort>, offset: i64, limit: i64) -> AppResult<Vec<Vec<Value>>> {
        let sql = self.sql(sort, true)?;
        let mut params = self.params.clone();
        params.push(SqlValue::Integer(limit));
        params.push(SqlValue::Integer(offset));
        let mut stmt = conn.prepare(&sql).map_err(db_err)?;
        let n = self.select.len();
        let rows = stmt
            .query_map(params_from_iter(params.iter()), |r| (0..n).map(|i| r.get_ref(i).map(sql_to_json)).collect::<Result<Vec<_>, _>>())
            .map_err(db_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
    }

    /// Visits every row in order without materialising the result.
    pub fn each(&self, conn: &Connection, sort: Option<&Sort>, mut f: impl FnMut(Vec<Value>) -> AppResult<()>) -> AppResult<()> {
        let sql = self.sql(sort, false)?;
        let mut stmt = conn.prepare(&sql).map_err(db_err)?;
        let mut rows = stmt.query(params_from_iter(self.params.iter())).map_err(db_err)?;
        let n = self.select.len();
        while let Some(r) = rows.next().map_err(db_err)? {
            let row = (0..n).map(|i| r.get_ref(i).map(sql_to_json)).collect::<Result<Vec<_>, _>>().map_err(db_err)?;
            f(row)?;
        }
        Ok(())
    }
}

struct MeasurePlan {
    row_expr: Option<String>,
    outer: String,
    /// Distinct count over a multi-valued field: computed in its own query.
    separate: Option<(String, String)>,
}

fn measure_plan(c: &Compiler, m: &Measure, idx: usize) -> AppResult<(MeasurePlan, Column)> {
    let col = |f: Option<&FieldDef>| Column {
        id: format!("m:{}", m.id),
        label: measure_label(m, f),
        ctype: "number",
        field: m.field.clone(),
        bucket: None,
        func: Some(m.func.clone()),
    };
    if m.func == "count" {
        return Ok((MeasurePlan { row_expr: None, outer: "COUNT(*)".into(), separate: None }, col(None)));
    }
    let field_id = m.field.as_deref().ok_or_else(|| AppError::Invalid("Choose a field for each measure.".into()))?;
    let f = find(c.fields, field_id)?;
    if !f.measures.contains(&m.func.as_str()) {
        return invalid(format!("\"{}\" cannot be measured with {}.", f.label, m.func));
    }
    let mv = format!("m{idx}");
    let plan = match (&f.src, m.func.as_str()) {
        (Src::Scalar { key, .. }, "countValues") => MeasurePlan {
            row_expr: Some(format!("CASE WHEN {key} IS NOT NULL AND {key} <> '' THEN 1 END")),
            outer: format!("COUNT({mv})"),
            separate: None,
        },
        (Src::Scalar { key, .. }, "distinct") => MeasurePlan { row_expr: Some(key.clone()), outer: format!("COUNT(DISTINCT {mv})"), separate: None },
        (Src::Scalar { key, .. }, func) => {
            MeasurePlan { row_expr: Some(key.clone()), outer: format!("{}({mv})", if func == "sum" { "SUM" } else { "AVG" }), separate: None }
        }
        (src, func) => {
            let (from, colx) = c.sub(src).expect("multi-valued source");
            match func {
                "countValues" => MeasurePlan {
                    row_expr: Some(format!("CASE WHEN EXISTS (SELECT 1 {from} AND {colx} IS NOT NULL AND {colx} <> '') THEN 1 END")),
                    outer: format!("COUNT({mv})"),
                    separate: None,
                },
                "sum" | "avg" => MeasurePlan {
                    row_expr: Some(format!("(SELECT SUM({colx}) {from})")),
                    outer: format!("{}({mv})", if func == "sum" { "SUM" } else { "AVG" }),
                    separate: None,
                },
                _ => {
                    let join = match src {
                        Src::Attr { id, col } => (
                            format!(
                                " JOIN attr_values dv ON dv.ds_id = {} AND dv.object_id = {} AND dv.attr_id = {}",
                                c.ds,
                                c.owner(),
                                sql_str(id)
                            ),
                            format!("dv.{col}"),
                        ),
                        Src::Refs { side, .. } => (
                            format!(
                                " JOIN event_refs dv ON dv.ds_id = e.ds_id AND dv.object_id = e.object_id AND dv.history_id = e.history_id AND dv.side = '{side}'{}",
                                src.event_constraint()
                            ),
                            "dv.ref_key".into(),
                        ),
                        Src::Scalar { .. } => unreachable!(),
                    };
                    MeasurePlan { row_expr: None, outer: String::new(), separate: Some(join) }
                }
            }
        }
    };
    Ok((plan, col(Some(f))))
}

fn key_of(v: &[Value]) -> String {
    serde_json::to_string(v).unwrap_or_default()
}

/// Runs an aggregate report. `extra` adds an internal condition (used for a chart's "Other" bucket).
pub fn run_aggregate(conn: &Connection, ds: i64, spec: &QuerySpec, now_ms: i64, extra: Option<&Node>, with_totals: bool) -> AppResult<AggResult> {
    validate_spec(spec)?;
    let fields = catalogue(conn, ds, spec.entity)?;
    let mut c = Compiler::new(ds, spec.entity, &spec.timezone, now_ms, &fields)?;
    let (where_sql, params) = c.where_clause(spec, extra)?;

    let mut dims = Vec::new();
    let mut joins = String::new();
    let mut keys = Vec::new();
    let mut labels = Vec::new();
    for (i, g) in spec.group_by.iter().enumerate() {
        let f = find(&fields, &g.field)?;
        let (join, key, label) = c.dimension(g, i)?;
        joins.push_str(&join);
        keys.push(key);
        labels.push(label);
        let ctype = if g.bucket.is_some() { "bucket" } else { type_name(f.ftype) };
        dims.push(Column { id: format!("d{i}"), label: f.label.clone(), ctype, field: Some(g.field.clone()), bucket: g.bucket.clone(), func: None });
    }

    let mut plans = Vec::new();
    let mut measures = Vec::new();
    for (i, m) in spec.measures.iter().enumerate() {
        let (p, col) = measure_plan(&c, m, i)?;
        plans.push(p);
        measures.push(col);
    }

    let from = c.from();
    let rid = c.rid();
    let run = |dim_count: usize, joins: &str| -> AppResult<(Vec<AggRow>, bool)> {
        let mut inner = vec![format!("{rid} AS rid")];
        for i in 0..dim_count {
            inner.push(format!("{} AS k{i}", keys[i]));
            inner.push(format!("MAX({}) AS l{i}", labels[i]));
        }
        for (i, p) in plans.iter().enumerate() {
            if let Some(e) = &p.row_expr {
                inner.push(format!("MAX({e}) AS m{i}"));
            }
        }
        let inner_group: Vec<String> = std::iter::once("rid".to_string()).chain((0..dim_count).map(|i| format!("k{i}"))).collect();
        let mut outer: Vec<String> = Vec::new();
        for i in 0..dim_count {
            outer.push(format!("k{i}"));
            outer.push(format!("MAX(l{i})"));
        }
        for p in &plans {
            outer.push(if p.separate.is_some() { "NULL".into() } else { p.outer.clone() });
        }
        let group = if dim_count > 0 { format!(" GROUP BY {}", (0..dim_count).map(|i| format!("k{i}")).collect::<Vec<_>>().join(", ")) } else { String::new() };
        let sql = format!(
            "SELECT {} FROM (SELECT {} {from}{joins} WHERE {where_sql} GROUP BY {}){group} ORDER BY COUNT(*) DESC LIMIT {}",
            outer.join(", "),
            inner.join(", "),
            inner_group.join(", "),
            MAX_GROUPS + 1
        );
        let mut stmt = conn.prepare(&sql).map_err(db_err)?;
        let width = dim_count * 2 + plans.len();
        let mut rows: Vec<AggRow> = stmt
            .query_map(params_from_iter(params.iter()), |r| {
                let vals = (0..width).map(|i| r.get_ref(i).map(sql_to_json)).collect::<Result<Vec<_>, _>>()?;
                let mut keys = Vec::new();
                let mut labels = Vec::new();
                for i in 0..dim_count {
                    keys.push(vals[i * 2].clone());
                    labels.push(vals[i * 2 + 1].clone());
                }
                Ok(AggRow { keys, labels, values: vals[dim_count * 2..].to_vec() })
            })
            .map_err(db_err)?
            .collect::<Result<_, _>>()
            .map_err(db_err)?;
        let truncated = rows.len() > MAX_GROUPS;
        rows.truncate(MAX_GROUPS);

        for (i, p) in plans.iter().enumerate() {
            let Some((join, col)) = &p.separate else { continue };
            let key_cols: Vec<String> = (0..dim_count).map(|d| format!("{} AS k{d}", keys[d])).collect();
            let select = key_cols.into_iter().chain(std::iter::once(format!("COUNT(DISTINCT {col})"))).collect::<Vec<_>>().join(", ");
            let sql = format!("SELECT {select} {from}{joins}{join} WHERE {where_sql}{group}");
            let mut stmt = conn.prepare(&sql).map_err(db_err)?;
            let found: HashMap<String, Value> = stmt
                .query_map(params_from_iter(params.iter()), |r| {
                    let ks = (0..dim_count).map(|d| r.get_ref(d).map(sql_to_json)).collect::<Result<Vec<_>, _>>()?;
                    Ok((key_of(&ks), r.get_ref(dim_count).map(sql_to_json)?))
                })
                .map_err(db_err)?
                .collect::<Result<_, _>>()
                .map_err(db_err)?;
            for row in rows.iter_mut() {
                row.values[i] = found.get(&key_of(&row.keys)).cloned().unwrap_or(json!(0));
            }
        }
        Ok((rows, truncated))
    };

    let (rows, truncated) = run(spec.group_by.len(), &joins)?;
    let totals = if spec.group_by.is_empty() {
        rows.first().map(|r| r.values.clone()).unwrap_or_default()
    } else if with_totals {
        run(0, "")?.0.first().map(|r| r.values.clone()).unwrap_or_default()
    } else {
        vec![]
    };
    let rows = if spec.group_by.is_empty() { vec![] } else { rows };
    Ok(AggResult { dimensions: dims, measures, rows, totals, truncated })
}

fn cmp_json(a: &Value, b: &Value) -> std::cmp::Ordering {
    use std::cmp::Ordering::*;
    match (a, b) {
        (Value::Null, Value::Null) => Equal,
        (Value::Null, _) => Greater,
        (_, Value::Null) => Less,
        (Value::Number(x), Value::Number(y)) => x.as_f64().partial_cmp(&y.as_f64()).unwrap_or(Equal),
        (Value::String(x), Value::String(y)) => x.to_lowercase().cmp(&y.to_lowercase()),
        _ => a.to_string().cmp(&b.to_string()),
    }
}

/// Sorts aggregate rows by a dimension ("d0") or measure ("m:<id>") column. Empty values sort last.
pub fn sort_rows(result: &AggResult, rows: &mut [AggRow], sort: Option<&Sort>) {
    let default = match result.dimensions.first() {
        Some(d) if d.ctype == "bucket" => Sort { column: "d0".into(), desc: false },
        _ => Sort { column: result.measures.first().map(|m| m.id.clone()).unwrap_or_default(), desc: true },
    };
    let sort = sort.unwrap_or(&default);
    let pick = |r: &AggRow| -> Value {
        if let Some(i) = sort.column.strip_prefix('d').and_then(|i| i.parse::<usize>().ok()) {
            let d = result.dimensions.get(i);
            let use_key = d.is_some_and(|d| d.ctype == "bucket" || d.ctype == "number");
            return if use_key { r.keys.get(i).cloned() } else { r.labels.get(i).cloned() }.unwrap_or(Value::Null);
        }
        result.measures.iter().position(|m| m.id == sort.column).and_then(|i| r.values.get(i).cloned()).unwrap_or(Value::Null)
    };
    rows.sort_by(|a, b| {
        let (x, y) = (pick(a), pick(b));
        let ord = match (&x, &y) {
            (Value::Null, _) | (_, Value::Null) => cmp_json(&x, &y),
            _ if sort.desc => cmp_json(&y, &x),
            _ => cmp_json(&x, &y),
        };
        ord.then_with(|| cmp_json(&Value::Array(a.labels.clone()), &Value::Array(b.labels.clone())))
    });
}
