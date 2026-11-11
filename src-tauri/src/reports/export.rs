//! Streams report results to CSV or JSON. Files are written beside the target and renamed when complete, so a
//! failed export never leaves a truncated file behind.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use chrono_tz::Tz;
use rusqlite::Connection;
use serde_json::{Map, Value};

use super::query::{AggResult, AggRow, DetailPlan};
use super::time::{format_iso, format_local};
use crate::error::{AppError, AppResult};
use crate::reports::model::Sort;

#[derive(Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Csv,
    Json,
}

impl Format {
    fn ext(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Json => "json",
        }
    }
}

pub fn check_path(path: &str, format: Format) -> AppResult<PathBuf> {
    let p = PathBuf::from(path);
    let ok = p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case(format.ext()));
    if !ok || p.file_name().is_none() {
        return Err(AppError::Invalid(format!("Only .{} files can be written here.", format.ext())));
    }
    Ok(p)
}

/// Spreadsheet apps execute cells that start with these characters as formulas.
fn neutralize(s: &str) -> String {
    if s.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{s}")
    } else {
        s.to_string()
    }
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn number_text(v: &Value) -> String {
    match v {
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() => {
                let s = format!("{:.4}", f);
                s.trim_end_matches('0').trim_end_matches('.').to_string()
            }
            _ => n.to_string(),
        },
        Value::Null => String::new(),
        other => other.as_str().map(str::to_string).unwrap_or_else(|| other.to_string()),
    }
}

fn csv_cell(v: &Value, ctype: &str, tz: Tz) -> String {
    let text = match (v, ctype) {
        (Value::Null, _) => return String::new(),
        (Value::Number(n), "datetime") => return n.as_i64().map(|ms| format_local(ms, tz)).unwrap_or_default(),
        (Value::Number(_), _) => return number_text(v),
        (Value::String(s), _) => s.clone(),
        (other, _) => other.to_string(),
    };
    csv_field(&neutralize(&text))
}

fn json_cell(v: &Value, ctype: &str, tz: Tz) -> Value {
    match (v, ctype) {
        (Value::Number(n), "datetime") => n.as_i64().map(|ms| Value::String(format_iso(ms, tz))).unwrap_or(Value::Null),
        _ => v.clone(),
    }
}

fn unique_labels(labels: impl Iterator<Item = String>) -> Vec<String> {
    let mut seen = std::collections::HashMap::<String, usize>::new();
    labels
        .map(|l| {
            let n = seen.entry(l.clone()).or_insert(0);
            *n += 1;
            if *n == 1 { l } else { format!("{l} ({n})") }
        })
        .collect()
}

struct Sink {
    tmp: PathBuf,
    target: PathBuf,
    out: BufWriter<File>,
}

impl Sink {
    fn create(target: &Path) -> AppResult<Self> {
        let name = target.file_name().and_then(|n| n.to_str()).unwrap_or("export");
        let tmp = target.with_file_name(format!(".{name}.{}.partial", std::process::id()));
        let out = BufWriter::new(File::create(&tmp)?);
        Ok(Self { tmp, target: target.to_path_buf(), out })
    }

    fn finish(mut self) -> AppResult<()> {
        self.out.flush()?;
        let file = self.out.into_inner().map_err(|e| AppError::Io(e.to_string()))?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&self.tmp, &self.target)?;
        Ok(())
    }
}

/// Removes the partial file if writing failed.
fn guarded(target: &Path, write: impl FnOnce(&mut BufWriter<File>) -> AppResult<()>) -> AppResult<()> {
    let mut sink = Sink::create(target)?;
    let tmp = sink.tmp.clone();
    let result = write(&mut sink.out).and_then(|_| sink.finish());
    if result.is_err() {
        let _ = std::fs::remove_file(tmp);
    }
    result
}

pub struct Meta<'a> {
    pub name: &'a str,
    pub tz: Tz,
    pub generated_ms: i64,
}

fn json_header(out: &mut impl Write, meta: &Meta, columns: &[(String, &'static str)]) -> AppResult<()> {
    let cols: Vec<Value> = columns.iter().map(|(l, t)| serde_json::json!({ "label": l, "type": t })).collect();
    write!(
        out,
        "{{\"report\":{},\"generatedAt\":{},\"timezone\":{},\"columns\":{},\"rows\":[",
        Value::String(meta.name.into()),
        Value::String(format_iso(meta.generated_ms, meta.tz)),
        Value::String(meta.tz.name().into()),
        Value::Array(cols)
    )?;
    Ok(())
}

pub fn write_detail(conn: &Connection, plan: &DetailPlan, sort: Option<&Sort>, path: &Path, format: Format, meta: &Meta) -> AppResult<u64> {
    let labels = unique_labels(plan.columns.iter().map(|c| c.label.clone()));
    let types: Vec<&'static str> = plan.columns.iter().map(|c| c.ctype).collect();
    let mut count = 0u64;
    guarded(path, |out| {
        match format {
            Format::Csv => {
                out.write_all("\u{feff}".as_bytes())?;
                let header: Vec<String> = labels.iter().map(|l| csv_field(&neutralize(l))).collect();
                write!(out, "{}\r\n", header.join(","))?;
                plan.each(conn, sort, |row| {
                    let cells: Vec<String> = row.iter().zip(&types).map(|(v, t)| csv_cell(v, t, meta.tz)).collect();
                    write!(out, "{}\r\n", cells.join(","))?;
                    count += 1;
                    Ok(())
                })?;
            }
            Format::Json => {
                let cols: Vec<(String, &'static str)> = labels.iter().cloned().zip(types.iter().copied()).collect();
                json_header(out, meta, &cols)?;
                plan.each(conn, sort, |row| {
                    let mut obj = Map::new();
                    for ((v, t), l) in row.iter().zip(&types).zip(&labels) {
                        obj.insert(l.clone(), json_cell(v, t, meta.tz));
                    }
                    if count > 0 {
                        out.write_all(b",")?;
                    }
                    serde_json::to_writer(&mut *out, &Value::Object(obj)).map_err(|e| AppError::Io(e.to_string()))?;
                    count += 1;
                    Ok(())
                })?;
                out.write_all(b"]}")?;
            }
        }
        Ok(())
    })?;
    Ok(count)
}

/// Columns for an aggregate export: each grouping (plus its object key for reference fields), then each measure.
/// (header, column type, cell reader) for each exported aggregate column.
type AggColumn<'a> = (String, &'static str, Box<dyn Fn(&AggRow) -> Value + 'a>);

fn agg_columns(result: &AggResult) -> Vec<AggColumn<'_>> {
    let mut cols: Vec<AggColumn<'_>> = Vec::new();
    for (i, d) in result.dimensions.iter().enumerate() {
        let ctype: &'static str = if d.ctype == "number" { "number" } else { "text" };
        cols.push((d.label.clone(), ctype, Box::new(move |r: &AggRow| r.labels.get(i).cloned().unwrap_or(Value::Null))));
        if d.ctype == "ref" {
            cols.push((format!("{} key", d.label), "text", Box::new(move |r: &AggRow| r.keys.get(i).cloned().unwrap_or(Value::Null))));
        }
    }
    for (i, m) in result.measures.iter().enumerate() {
        cols.push((m.label.clone(), "number", Box::new(move |r: &AggRow| r.values.get(i).cloned().unwrap_or(Value::Null))));
    }
    cols
}

pub fn write_aggregate(result: &AggResult, rows: &[AggRow], path: &Path, format: Format, meta: &Meta) -> AppResult<u64> {
    let cols = agg_columns(result);
    let labels = unique_labels(cols.iter().map(|c| c.0.clone()));
    // A report without groupings exports its single totals row.
    let totals_row;
    let rows: &[AggRow] = if result.dimensions.is_empty() {
        totals_row = [AggRow { keys: vec![], labels: vec![], values: result.totals.clone() }];
        &totals_row
    } else {
        rows
    };
    guarded(path, |out| {
        match format {
            Format::Csv => {
                out.write_all("\u{feff}".as_bytes())?;
                let header: Vec<String> = labels.iter().map(|l| csv_field(&neutralize(l))).collect();
                write!(out, "{}\r\n", header.join(","))?;
                for r in rows {
                    let cells: Vec<String> = cols.iter().map(|(_, t, get)| csv_cell(&get(r), t, meta.tz)).collect();
                    write!(out, "{}\r\n", cells.join(","))?;
                }
            }
            Format::Json => {
                let header: Vec<(String, &'static str)> = labels.iter().cloned().zip(cols.iter().map(|c| c.1)).collect();
                json_header(out, meta, &header)?;
                for (n, r) in rows.iter().enumerate() {
                    let mut obj = Map::new();
                    for ((_, _, get), l) in cols.iter().zip(&labels) {
                        obj.insert(l.clone(), get(r));
                    }
                    if n > 0 {
                        out.write_all(b",")?;
                    }
                    serde_json::to_writer(&mut *out, &Value::Object(obj)).map_err(|e| AppError::Io(e.to_string()))?;
                }
                out.write_all(b"]}")?;
            }
        }
        Ok(())
    })?;
    Ok(rows.len() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neutralizes_formulas_only_in_text() {
        assert_eq!(csv_cell(&Value::String("=SUM(A1)".into()), "text", Tz::UTC), "'=SUM(A1)");
        assert_eq!(csv_cell(&Value::String("-5".into()), "text", Tz::UTC), "'-5");
        assert_eq!(csv_cell(&serde_json::json!(-5), "number", Tz::UTC), "-5");
        assert_eq!(csv_cell(&serde_json::json!(2.5), "number", Tz::UTC), "2.5");
        assert_eq!(csv_cell(&Value::String("a, \"b\"".into()), "text", Tz::UTC), "\"a, \"\"b\"\"\"");
        assert_eq!(csv_cell(&serde_json::json!(0), "datetime", Tz::UTC), "1970-01-01 00:00:00");
    }

    #[test]
    fn rejects_mismatched_extensions() {
        assert!(check_path("/tmp/report.csv", Format::Csv).is_ok());
        assert!(check_path("/tmp/report.CSV", Format::Csv).is_ok());
        assert!(check_path("/tmp/report.json", Format::Csv).is_err());
        assert!(check_path("/tmp/report.txt", Format::Json).is_err());
    }
}
