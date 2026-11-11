//! Report contracts shared with the UI: data source configuration, query specification and the field catalogue.
//! The catalogue is the single source of truth for which operators, groupings and measures each field supports.

use std::collections::BTreeMap;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::db::db_err;
use crate::error::{AppError, AppResult};

pub const MAX_TYPES: usize = 20;
pub const MAX_SCOPE_AQL: usize = 2000;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dataset {
    pub id: String,
    pub cloud_id: String,
    pub workspace_id: String,
    pub object_type_ids: Vec<String>,
    #[serde(default)]
    pub scope_aql: String,
    #[serde(default)]
    pub attribute_aliases: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub value_mappings: BTreeMap<String, BTreeMap<String, String>>,
}

fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.len() <= 18 && s.bytes().all(|b| b.is_ascii_digit())
}

fn order_by_outside_quotes(aql: &str) -> bool {
    let mut quoted = false;
    let mut outside = String::with_capacity(aql.len());
    let mut chars = aql.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' if quoted => {
                chars.next();
            }
            '"' => quoted = !quoted,
            _ if !quoted => outside.push(c.to_ascii_lowercase()),
            _ => {}
        }
    }
    outside.split_whitespace().collect::<Vec<_>>().windows(2).any(|w| w == ["order", "by"])
}

impl Dataset {
    pub fn validate(&self) -> AppResult<()> {
        let id_ok = !self.id.is_empty() && self.id.len() <= 64 && self.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        if !id_ok {
            return Err(AppError::Invalid("Invalid data source id.".into()));
        }
        if self.object_type_ids.is_empty() || self.object_type_ids.len() > MAX_TYPES || !self.object_type_ids.iter().all(|t| is_digits(t)) {
            return Err(AppError::Invalid(format!("Choose between 1 and {MAX_TYPES} object types.")));
        }
        if self.scope_aql.len() > MAX_SCOPE_AQL {
            return Err(AppError::Invalid("The scope filter is too long.".into()));
        }
        if order_by_outside_quotes(&self.scope_aql) {
            return Err(AppError::Invalid("The scope filter must not contain ORDER BY.".into()));
        }
        if !self.attribute_aliases.keys().chain(self.value_mappings.keys()).all(|k| is_digits(k)) {
            return Err(AppError::Invalid("Invalid attribute id in data source settings.".into()));
        }
        Ok(())
    }

    /// AQL used to enumerate the data source.
    pub fn aql(&self) -> String {
        let types = self.object_type_ids.iter().map(|t| format!("objectTypeId = {t}")).collect::<Vec<_>>().join(" OR ");
        let scope = self.scope_aql.trim();
        if scope.is_empty() {
            format!("({types})")
        } else {
            format!("({types}) AND ({scope})")
        }
    }

    pub fn scope_hash(&self) -> String {
        let mut types = self.object_type_ids.clone();
        types.sort();
        super::hash_hex(&format!("{}\u{0}{}", types.join(","), self.scope_aql.trim()))
    }

    pub fn norm_hash(&self) -> String {
        let payload = serde_json::json!([super::normalize::NORM_VERSION, self.attribute_aliases, self.value_mappings]);
        super::hash_hex(&payload.to_string())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Entity {
    Assets,
    Events,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Detail,
    Aggregate,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Node {
    Group { join: Join, children: Vec<Node> },
    Condition { field: String, op: String, #[serde(default)] value: Value },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Join {
    And,
    Or,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupBy {
    pub field: String,
    #[serde(default)]
    pub bucket: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Measure {
    pub id: String,
    #[serde(rename = "fn")]
    pub func: String,
    #[serde(default)]
    pub field: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sort {
    pub column: String,
    pub desc: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftDeleteMarker {
    pub type_id: String,
    pub attribute_id: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySpec {
    pub v: u32,
    pub entity: Entity,
    pub filter: Node,
    pub mode: Mode,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub group_by: Vec<GroupBy>,
    #[serde(default)]
    pub measures: Vec<Measure>,
    #[serde(default)]
    pub sort: Option<Sort>,
    pub timezone: String,
    #[serde(default = "yes")]
    pub include_unavailable: bool,
    #[serde(default)]
    pub include_soft_deleted: bool,
    #[serde(default)]
    pub soft_delete: Vec<SoftDeleteMarker>,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldType {
    Text,
    Number,
    Date,
    Datetime,
    Boolean,
    Ref,
    Enum,
}

impl FieldType {
    pub fn operators(self) -> &'static [&'static str] {
        match self {
            Self::Text => &["eq", "neq", "contains", "notContains", "startsWith", "in", "notIn", "empty", "notEmpty"],
            Self::Number => &["eq", "neq", "gt", "gte", "lt", "lte", "between", "empty", "notEmpty"],
            Self::Date | Self::Datetime => &["last", "between", "on", "before", "after", "empty", "notEmpty"],
            Self::Boolean => &["isTrue", "isFalse", "empty", "notEmpty"],
            Self::Ref | Self::Enum => &["in", "notIn", "empty", "notEmpty"],
        }
    }

    pub fn measures(self) -> &'static [&'static str] {
        match self {
            Self::Number => &["countValues", "distinct", "sum", "avg"],
            _ => &["countValues", "distinct"],
        }
    }

    pub fn is_time(self) -> bool {
        matches!(self, Self::Date | Self::Datetime)
    }
}

#[derive(Clone, Debug)]
pub enum Src {
    /// One value per row. `key` is compared and grouped; `display` is shown.
    Scalar { key: String, display: String },
    /// Attribute values (possibly several per asset) read from `attr_values` column `col`.
    Attr { id: String, col: &'static str },
    /// Objects referenced by a history event on one side of the change.
    Refs { side: &'static str, attribute: Option<String> },
}

impl Src {
    pub fn event_constraint(&self) -> String {
        match self {
            Self::Refs { attribute: Some(id), .. } => format!(" AND e.attr_id = '{}'", id.replace('\'', "''")),
            _ => String::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldOption {
    pub value: String,
    pub label: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldDef {
    pub id: String,
    pub label: String,
    pub category: &'static str,
    #[serde(rename = "type")]
    pub ftype: FieldType,
    pub multi: bool,
    pub operators: &'static [&'static str],
    pub measures: &'static [&'static str],
    /// Values can be listed from local data for pickers.
    pub picker: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<FieldOption>,
    #[serde(skip)]
    pub src: Src,
}

pub const OPERATIONS: [(&str, &str); 6] = [
    ("created", "Object created"),
    ("assigned", "Value added"),
    ("reassigned", "Value replaced"),
    ("cleared", "Value removed"),
    ("unchanged", "No change"),
    ("other", "Other"),
];

fn opts(list: &[(&str, &str)]) -> Vec<FieldOption> {
    list.iter().map(|(v, l)| FieldOption { value: v.to_string(), label: l.to_string() }).collect()
}

fn scalar(id: &str, label: &str, category: &'static str, ftype: FieldType, key: &str, display: &str, picker: bool) -> FieldDef {
    FieldDef {
        id: id.into(),
        label: label.into(),
        category,
        ftype,
        multi: false,
        operators: ftype.operators(),
        measures: ftype.measures(),
        picker,
        options: vec![],
        src: Src::Scalar { key: key.into(), display: display.into() },
    }
}

fn kind_type(kind: &str) -> (FieldType, &'static str) {
    match kind {
        "number" => (FieldType::Number, "num"),
        "date" => (FieldType::Date, "day"),
        "datetime" => (FieldType::Datetime, "ms"),
        "boolean" => (FieldType::Boolean, "raw"),
        "ref" => (FieldType::Ref, "ref_key"),
        _ => (FieldType::Text, "raw"),
    }
}

/// All fields available for an entity, given the attributes collected for the data source.
pub fn catalogue(conn: &Connection, ds: i64, entity: Entity) -> AppResult<Vec<FieldDef>> {
    let mut fields = Vec::new();
    let events = entity == Entity::Events;
    let (key, label, type_id) = if events {
        ("COALESCE(o.key, m.key)", "COALESCE(o.label, m.label)", "m.type_id")
    } else {
        ("o.key", "o.label", "o.type_id")
    };
    let type_name = format!("(SELECT t.name FROM types t WHERE t.ds_id = {ds} AND t.type_id = {type_id})");
    if events {
        fields.push(scalar("event.created", "Changed at", "History", FieldType::Datetime, "e.created_ms", "e.created_ms", false));
        fields.push(scalar(
            "event.attribute",
            "Changed attribute",
            "History",
            FieldType::Enum,
            "COALESCE(e.attr_id, 'name:' || e.affected)",
            "e.attr_name",
            true,
        ));
        let mut op = scalar("event.operation", "Change type", "History", FieldType::Enum, "e.operation", "e.operation", false);
        op.options = opts(&OPERATIONS);
        fields.push(op);
        fields.push(scalar("event.actor", "Changed by", "History", FieldType::Enum, "e.actor_key", "e.actor_name", true));
        fields.push(scalar("event.oldValue", "Previous value", "History", FieldType::Text, "e.old_raw", "e.old_raw", false));
        fields.push(scalar("event.newValue", "New value", "History", FieldType::Text, "e.new_raw", "e.new_raw", false));
        for (side, label) in [
            ("added", "Object added"),
            ("removed", "Object removed"),
            ("old", "Previous objects"),
            ("new", "New objects"),
        ] {
            fields.push(FieldDef {
                id: format!("event.{side}Object"),
                label: label.into(),
                category: "History",
                ftype: FieldType::Ref,
                multi: true,
                operators: FieldType::Ref.operators(),
                measures: FieldType::Ref.measures(),
                picker: true,
                options: vec![],
                src: Src::Refs { side, attribute: None },
            });
        }
        let mut res = scalar("event.resolution", "Value matching", "History", FieldType::Enum, "e.resolution", "e.resolution", false);
        res.options = opts(&[("resolved", "Object key known"), ("unresolved", "Recorded label only")]);
        fields.push(res);
    }
    fields.push(scalar("asset.key", "Asset key", "Asset", FieldType::Text, key, key, true));
    fields.push(scalar("asset.label", "Asset name", "Asset", FieldType::Text, label, label, false));
    fields.push(scalar("asset.type", "Object type", "Asset", FieldType::Enum, type_id, &type_name, true));
    fields.push(scalar("asset.created", "Asset created", "Asset", FieldType::Datetime, "o.created_ms", "o.created_ms", false));
    fields.push(scalar("asset.updated", "Asset updated", "Asset", FieldType::Datetime, "o.updated_ms", "o.updated_ms", false));
    if events {
        let mut avail = scalar(
            "asset.available",
            "Asset still in data source",
            "Asset",
            FieldType::Boolean,
            "CASE WHEN o.object_id IS NULL THEN 'false' ELSE 'true' END",
            "CASE WHEN o.object_id IS NULL THEN 'false' ELSE 'true' END",
            false,
        );
        avail.measures = &["countValues"];
        fields.push(avail);
    }

    let mut stmt = conn
        .prepare(
            "SELECT a.attr_id, a.name, a.kind, COALESCE(t.name, a.type_id),
                    (SELECT COUNT(*) FROM attrs b WHERE b.ds_id = a.ds_id AND b.name = a.name)
             FROM attrs a LEFT JOIN types t ON t.ds_id = a.ds_id AND t.type_id = a.type_id
             WHERE a.ds_id = ?1 ORDER BY a.name, t.name",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![ds], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, i64>(4)?))
        })
        .map_err(db_err)?;
    for row in rows {
        let (id, name, kind, type_name, same_name) = row.map_err(db_err)?;
        let (ftype, col) = kind_type(&kind);
        let label = if same_name > 1 { format!("{name} ({type_name})") } else { name };
        if events && ftype == FieldType::Ref {
            for (side, suffix) in [("added", "added"), ("removed", "removed"), ("old", "previous"), ("new", "new")] {
                fields.push(FieldDef {
                    id: format!("event.attr:{id}:{side}"),
                    label: format!("{label} ({suffix})"),
                    category: "Historical attributes",
                    ftype,
                    multi: true,
                    operators: ftype.operators(),
                    measures: ftype.measures(),
                    picker: true,
                    options: vec![],
                    src: Src::Refs { side, attribute: Some(id.clone()) },
                });
            }
        }
        fields.push(FieldDef {
            id: format!("attr:{id}"),
            label: if events { format!("{label} (current)") } else { label },
            category: if events { "Current attributes" } else { "Attributes" },
            ftype,
            multi: true,
            operators: ftype.operators(),
            measures: ftype.measures(),
            picker: matches!(ftype, FieldType::Text | FieldType::Ref) && !matches!(kind.as_str(), "text"),
            options: vec![],
            src: Src::Attr { id, col },
        });
    }
    Ok(fields)
}

pub fn find<'a>(fields: &'a [FieldDef], id: &str) -> AppResult<&'a FieldDef> {
    fields.iter().find(|f| f.id == id).ok_or_else(|| AppError::Invalid(format!("Unknown field \"{id}\". Refresh the data source or edit the report.")))
}
