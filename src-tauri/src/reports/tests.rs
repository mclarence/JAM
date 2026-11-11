//! End-to-end tests: a fake Jira is collected into an in-memory database, then reports run against it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;
use serde_json::{json, Value};

use super::collect::fake::FakeJira;
use super::collect::{self, Settings, Summary, Tuning};
use super::model::{Dataset, Node, QuerySpec};
use super::query::{self, OTHER_OP};
use super::time::parse_timestamp;
use super::{db, run_spec, status_for_test};
use crate::error::AppError;

const DAY: i64 = 86_400_000;

fn now() -> i64 {
    parse_timestamp("2024-06-15T12:00:00Z").unwrap()
}

fn ago(days: i64) -> String {
    super::time::format_iso(now() - days * DAY, chrono_tz::UTC)
}

fn dataset() -> Dataset {
    serde_json::from_value(json!({
        "id": "ds-1",
        "cloudId": "cloud",
        "workspaceId": "ws",
        "objectTypeIds": ["1"],
    }))
    .unwrap()
}

fn attrs() -> Value {
    json!([
        { "id": "10", "name": "Name", "type": 0, "defaultType": { "id": 0 } },
        { "id": "11", "name": "Borrower", "type": 1 },
        { "id": "12", "name": "Cost", "type": 0, "defaultType": { "id": 1 } },
        { "id": "13", "name": "Status", "type": 7 },
    ])
}

fn object(id: &str, key: &str, updated: &str, borrowers: &[(&str, &str)], cost: f64, status: &str) -> Value {
    let refs: Vec<Value> = borrowers
        .iter()
        .map(|(k, l)| json!({ "displayValue": l, "referencedObject": { "objectKey": k, "label": l } }))
        .collect();
    json!({
        "id": id,
        "objectKey": key,
        "label": format!("Laptop {id}"),
        "objectType": { "id": "1" },
        "created": "2024-01-01T00:00:00.000Z",
        "updated": updated,
        "attributes": [
            { "objectTypeAttributeId": "10", "objectAttributeValues": [{ "value": format!("Laptop {id}") }] },
            { "objectTypeAttributeId": "11", "objectAttributeValues": refs },
            { "objectTypeAttributeId": "12", "objectAttributeValues": [{ "value": cost.to_string() }] },
            { "objectTypeAttributeId": "13", "objectAttributeValues": [{ "status": { "name": status } }] },
        ]
    })
}

fn change(id: &str, days: i64, attr: &str, old: &str, new: &str) -> Value {
    json!({
        "id": id,
        "created": ago(days),
        "affectedAttribute": attr,
        "oldValue": old,
        "newValue": new,
        "type": 2,
        "actor": { "key": "admin-1", "displayName": "Admin", "emailAddress": "admin@example.com" },
    })
}

fn jira() -> FakeJira {
    let fake = FakeJira { types: vec![("1".into(), "Laptops".into(), attrs())], ..Default::default() };
    *fake.objects.lock().unwrap() = vec![
        object("1", "LAP-1", "2024-06-10T00:00:00.000Z", &[("STU-2", "Bob")], 1000.0, "In use"),
        // Two borrowers at once: grouping by borrower must not double count the asset in totals.
        object("2", "LAP-2", "2024-06-13T00:00:00.000Z", &[("STU-2", "Bob"), ("STU-3", "Cara")], 2000.0, "In use"),
        object("3", "LAP-3", "2024-06-01T00:00:00.000Z", &[], 500.0, "In stock"),
        object("4", "LAP-4", "2024-06-01T00:00:00.000Z", &[], 300.0, "Retired"),
    ];
    let mut h = fake.histories.lock().unwrap();
    h.insert(
        "1".into(),
        Ok(json!([
            { "id": "100", "created": ago(200), "type": 0, "actor": { "key": "admin-1", "displayName": "Admin" } },
            change("101", 10, "Borrower", "", "Alice (STU-1)"),
            change("102", 8, "Borrower", "Alice (STU-1)", ""),
            change("103", 5, "Borrower", "", "Bob (STU-2)"),
            change("104", 4, "Cost", "900", "1000"),
        ])),
    );
    h.insert(
        "2".into(),
        Ok(json!([
            change("201", 3, "Borrower", "", "STU-1"),
            change("202", 2, "Borrower", "STU-1", "Bob (STU-2)"),
            change("203", 2, "Borrower", "Bob (STU-2)", "Bob (STU-2), Cara (STU-3)"),
            // Label-only history remains reportable without guessing an object key.
            change("204", 1, "Borrower", "", "Charlie"),
        ])),
    );
    h.insert("3".into(), Err(403));
    h.insert("4".into(), Err(404));
    drop(h);
    fake
}

fn settings() -> Settings {
    Settings { concurrency: 2, requests_per_second: 20.0 }
}

fn tuning() -> Tuning {
    Tuning { backoff: Duration::from_millis(1) }
}

async fn refresh(db: &Arc<Mutex<Connection>>, fake: &FakeJira, full: bool, at: i64) -> Result<Summary, AppError> {
    collect::refresh(db.clone(), &dataset(), full, settings(), fake.clone(), Arc::new(AtomicBool::new(false)), tuning(), &|_| {}, at).await
}

async fn collected() -> (Arc<Mutex<Connection>>, FakeJira) {
    let db = Arc::new(Mutex::new(db::open_memory().unwrap()));
    let fake = jira();
    refresh(&db, &fake, false, now()).await.unwrap();
    (db, fake)
}

fn spec(v: Value) -> QuerySpec {
    let mut v = v;
    let o = v.as_object_mut().unwrap();
    o.entry("v").or_insert(json!(1));
    o.entry("timezone").or_insert(json!("UTC"));
    o.entry("filter").or_insert(json!({ "kind": "group", "join": "and", "children": [] }));
    serde_json::from_value(v).unwrap()
}

fn run(db: &Arc<Mutex<Connection>>, s: Value) -> Value {
    run_spec(&mut db.lock().unwrap(), &dataset(), &spec(s), now()).unwrap()
}

fn borrows(student: &str, days: u64) -> Value {
    json!({
        "entity": "events",
        "mode": "aggregate",
        "filter": { "kind": "group", "join": "and", "children": [
            { "kind": "condition", "field": "event.attribute", "op": "in", "value": ["11"] },
            { "kind": "condition", "field": "event.operation", "op": "in", "value": ["assigned", "reassigned"] },
            { "kind": "condition", "field": "event.addedObject", "op": "in", "value": [student] },
            { "kind": "condition", "field": "event.created", "op": "last", "value": { "amount": days, "unit": "day" } },
        ]},
        "measures": [{ "id": "n", "fn": "count" }, { "id": "assets", "fn": "distinct", "field": "asset.key" }],
    })
}

/// (label, values) per aggregate row, for readable assertions.
fn rows(result: &Value) -> Vec<(Value, Vec<Value>)> {
    result["rows"].as_array().unwrap().iter().map(|r| (r["labels"][0].clone(), r["values"].as_array().unwrap().clone())).collect()
}

fn sorted(mut v: Vec<(Value, Vec<Value>)>) -> Vec<(Value, Vec<Value>)> {
    v.sort_by_key(|(l, _)| l.to_string());
    v
}

#[tokio::test]
async fn counts_student_borrowing_across_assets() {
    let (db, _) = collected().await;
    // STU-1 borrowed LAP-1 (10 days ago) and LAP-2 (3 days ago); returns and the hand-over away from STU-1 do not count.
    assert_eq!(run(&db, borrows("STU-1", 30))["totals"], json!([2, 2]));
    assert_eq!(run(&db, borrows("STU-1", 7))["totals"], json!([1, 1]));
    // STU-2: assigned LAP-1, handed LAP-2; adding STU-3 alongside does not count as another STU-2 borrow.
    assert_eq!(run(&db, borrows("STU-2", 30))["totals"], json!([2, 2]));
    assert_eq!(run(&db, borrows("STU-3", 30))["totals"], json!([1, 1]));
}

#[tokio::test]
async fn groups_borrowing_by_student_and_week() {
    let (db, _) = collected().await;
    let by_student = run(
        &db,
        json!({
            "entity": "events",
            "mode": "aggregate",
            "filter": { "kind": "group", "join": "and", "children": [
                { "kind": "condition", "field": "event.attribute", "op": "in", "value": ["11"] },
                { "kind": "condition", "field": "event.operation", "op": "in", "value": ["assigned", "reassigned"] },
                { "kind": "condition", "field": "event.addedObject", "op": "notEmpty" },
            ]},
            "groupBy": [{ "field": "event.addedObject" }],
            "measures": [{ "id": "n", "fn": "count" }],
        }),
    );
    assert_eq!(
        sorted(rows(&by_student)),
        vec![(json!("Alice"), vec![json!(2)]), (json!("Bob"), vec![json!(2)]), (json!("Cara"), vec![json!(1)]), (json!("Charlie"), vec![json!(1)])]
    );
    // Six borrowing events, including the label-only student.
    assert_eq!(by_student["totals"], json!([6]));

    let weekly = run(
        &db,
        json!({
            "entity": "events",
            "mode": "aggregate",
            "filter": { "kind": "condition", "field": "event.attribute", "op": "in", "value": ["11"] },
            "groupBy": [{ "field": "event.created", "bucket": "week" }],
            "measures": [{ "id": "n", "fn": "count" }],
        }),
    );
    // 2024-06-15 is a Saturday: the week of Monday 06-03 holds the changes 10 and 8 days ago; 5 days ago is Monday 06-10.
    assert_eq!(sorted(rows(&weekly)), vec![(json!("2024-06-03"), vec![json!(2)]), (json!("2024-06-10"), vec![json!(5)])]);
}

#[tokio::test]
async fn unresolved_values_are_flagged_not_guessed() {
    let (db, _) = collected().await;
    let conn = db.lock().unwrap();
    let ds = db::existing_dataset_id(&conn, "ds-1").unwrap().unwrap();
    let r = super::unresolved(&conn, ds, &dataset()).unwrap();
    assert_eq!(r.values.len(), 1);
    assert_eq!(r.values[0].raw, "Charlie");
    assert_eq!(r.values[0].count, 1);
    let status = status_for_test(&conn, &dataset()).unwrap();
    assert_eq!(status.unresolved_events, 1);
    assert_eq!(status.histories_denied, 1);
    assert_eq!(status.histories_missing, 1);
    assert_eq!(status.histories_failed, 0);
}

#[tokio::test]
async fn value_mapping_resolves_names_without_refetching() {
    let (db, fake) = collected().await;
    let requests = fake.log.lock().unwrap().len();
    let mut ds = dataset();
    ds.value_mappings.insert("11".into(), [("Charlie".to_string(), "STU-9".to_string())].into());
    let s = spec(borrows("STU-9", 30));
    let result = run_spec(&mut db.lock().unwrap(), &ds, &s, now()).unwrap();
    assert_eq!(result["totals"], json!([1, 1]));
    let detail = spec(json!({
        "entity": "events", "mode": "detail", "columns": ["event.attr:11:added"],
        "filter": { "kind": "condition", "field": "event.attr:11:added", "op": "in", "value": ["STU-9"] },
    }));
    assert_eq!(run_spec(&mut db.lock().unwrap(), &ds, &detail, now()).unwrap()["rows"], json!([["Charlie"]]));
    let grouped = spec(json!({
        "entity": "events", "mode": "aggregate", "groupBy": [{ "field": "event.attr:11:added" }],
        "filter": { "kind": "condition", "field": "event.attr:11:added", "op": "in", "value": ["STU-9"] },
        "measures": [{ "id": "n", "fn": "count" }],
    }));
    assert_eq!(rows(&run_spec(&mut db.lock().unwrap(), &ds, &grouped, now()).unwrap()), vec![(json!("Charlie"), vec![json!(1)])]);
    // A known object's label takes precedence over historical spelling when explicitly linked.
    ds.value_mappings.get_mut("11").unwrap().insert("Charlie".into(), "STU-2".into());
    let linked = spec(json!({
        "entity": "events", "mode": "detail", "columns": ["event.attr:11:added"],
        "filter": { "kind": "condition", "field": "event.newValue", "op": "eq", "value": "Charlie" },
    }));
    assert_eq!(run_spec(&mut db.lock().unwrap(), &ds, &linked, now()).unwrap()["rows"], json!([["Bob"]]));
    assert_eq!(fake.log.lock().unwrap().len(), requests, "re-normalising must not call Jira");
}

#[tokio::test]
async fn cached_label_only_history_is_reportable_without_matching_or_jira_requests() {
    let (db, fake) = collected().await;
    let requests = fake.log.lock().unwrap().len();
    {
        let conn = db.lock().unwrap();
        conn.execute("DELETE FROM event_refs WHERE ref_key LIKE 'label:%'", []).unwrap();
        conn.execute("DELETE FROM ref_labels WHERE ref_key LIKE 'label:%'", []).unwrap();
        conn.execute("UPDATE events SET norm = 1", []).unwrap();
        conn.execute("UPDATE datasets SET norm_hash = 'legacy-normalization'", []).unwrap();
    }
    let q = json!({
        "entity": "events", "mode": "aggregate",
        "filter": { "kind": "condition", "field": "event.attr:11:added", "op": "notEmpty" },
        "groupBy": [{ "field": "event.attr:11:added" }],
        "measures": [{ "id": "n", "fn": "count" }, { "id": "students", "fn": "distinct", "field": "event.attr:11:added" }],
    });
    let result = run(&db, q);
    assert_eq!(result["totals"], json!([6, 4]));
    assert!(rows(&result).contains(&(json!("Charlie"), vec![json!(1), json!(1)])));
    let detail = json!({
        "entity": "events", "mode": "detail", "columns": ["event.attr:11:added"],
        "filter": { "kind": "condition", "field": "event.attr:11:added", "op": "in", "value": ["label:11:Charlie"] },
    });
    assert_eq!(run(&db, detail)["rows"], json!([["Charlie"]]));
    let conn = db.lock().unwrap();
    let ds = db::existing_dataset_id(&conn, "ds-1").unwrap().unwrap();
    assert!(!super::warnings(&spec(json!({ "entity": "events", "mode": "detail" })), &status_for_test(&conn, &dataset()).unwrap())
        .iter().any(|w| w.code == "unresolved"));
    let fields = super::model::catalogue(&conn, ds, super::model::Entity::Events).unwrap();
    let field = super::model::find(&fields, "event.attr:11:added").unwrap();
    let values = super::field_values(&conn, ds, super::model::Entity::Events, field, "charlie", 50).unwrap();
    assert_eq!(values.len(), 1);
    assert_eq!(values[0].label, "Charlie");
    assert_eq!(values[0].value, json!("label:11:Charlie"));
    assert!(super::unresolved(&conn, ds, &dataset()).unwrap().values[0].suggestion.is_none());
    assert_eq!(fake.log.lock().unwrap().len(), requests);
}

#[tokio::test]
async fn historical_attribute_groups_include_past_borrowers_not_just_current_students() {
    let db = Arc::new(Mutex::new(db::open_memory().unwrap()));
    let mut fake = jira();
    fake.types[0].2.as_array_mut().unwrap().push(json!({ "id": "14", "name": "Owner", "type": 1 }));
    *fake.objects.lock().unwrap() = (1..=3)
        .map(|i| object(&i.to_string(), &format!("LAP-{i}"), &ago(0), &[(&format!("STU-{i}"), &format!("Student {i}"))], 100.0, "In use"))
        .collect();
    {
        let mut histories = fake.histories.lock().unwrap();
        histories.clear();
        for asset in 1..=3 {
            let mut events = Vec::new();
            for n in 1..=4 {
                let student = (asset - 1) * 4 + n;
                events.push(change(&student.to_string(), student, "Borrower", "", &format!("Student {student} (STU-{student})")));
            }
            events.push(change("owner", 1, "Owner", "", "Owner (STU-99)"));
            histories.insert(asset.to_string(), Ok(json!(events)));
        }
    }
    refresh(&db, &fake, false, now()).await.unwrap();
    let requests = fake.log.lock().unwrap().len();
    let mut q = json!({
        "entity": "events",
        "mode": "aggregate",
        "filter": { "kind": "group", "join": "and", "children": [
            { "kind": "condition", "field": "event.attr:11:added", "op": "notEmpty" },
            { "kind": "condition", "field": "event.created", "op": "last", "value": { "amount": 30, "unit": "day" } },
        ]},
        "groupBy": [{ "field": "event.attr:11:added" }],
        "measures": [
            { "id": "n", "fn": "count" },
            { "id": "students", "fn": "distinct", "field": "event.attr:11:added" },
            { "id": "present", "fn": "countValues", "field": "event.attr:11:added" },
        ],
    });
    let historical = run(&db, q.clone());
    assert_eq!(historical["totals"], json!([12, 12, 12]));
    assert_eq!(historical["rows"].as_array().unwrap().len(), 12);
    for student in 1..=12 {
        assert!(rows(&historical).contains(&(json!(format!("Student {student}")), vec![json!(1), json!(1), json!(1)])));
    }
    q["groupBy"][0]["field"] = json!("attr:11");
    assert_eq!(run(&db, q.clone())["rows"].as_array().unwrap().len(), 3, "current attributes retain their snapshot semantics");

    q["groupBy"][0]["field"] = json!("event.attr:11:added");
    q["filter"]["children"][1]["value"]["amount"] = json!(7);
    assert_eq!(run(&db, q.clone())["totals"], json!([6, 6, 6]));
    q["filter"]["children"][0] = json!({ "kind": "condition", "field": "event.attr:11:added", "op": "in", "value": ["STU-5", "STU-99"] });
    assert_eq!(run(&db, q.clone())["totals"], json!([1, 1, 1]));
    q["mode"] = json!("detail");
    q["columns"] = json!(["event.attr:11:added", "attr:11"]);
    assert_eq!(run(&db, q)["rows"], json!([["Student 5", "Student 2"]]));

    let conn = db.lock().unwrap();
    let ds = db::existing_dataset_id(&conn, "ds-1").unwrap().unwrap();
    let fields = super::model::catalogue(&conn, ds, super::model::Entity::Events).unwrap();
    let field = super::model::find(&fields, "event.attr:11:added").unwrap();
    assert_eq!(field.label, "Borrower (added)");
    assert_eq!(super::model::find(&fields, "attr:11").unwrap().label, "Borrower (current)");
    let values = super::field_values(&conn, ds, super::model::Entity::Events, field, "", 100).unwrap();
    assert_eq!(values.len(), 12);
    assert!(!values.iter().any(|v| v.value == json!("STU-99")), "pickers must exclude other attributes");
    assert_eq!(fake.log.lock().unwrap().len(), requests, "historical fields must use local data only");
}

#[tokio::test]
async fn historical_attribute_sides_preserve_additions_returns_and_partial_changes() {
    let (db, _) = collected().await;
    for (side, expected) in [("added", 6), ("removed", 2), ("old", 3), ("new", 6)] {
        let field = format!("event.attr:11:{side}");
        let q = json!({
            "entity": "events", "mode": "aggregate",
            "filter": { "kind": "condition", "field": field, "op": "notEmpty" },
            "measures": [{ "id": "n", "fn": "count" }],
        });
        assert_eq!(run(&db, q)["totals"], json!([expected]), "{side}");
    }
}

#[tokio::test]
async fn multi_valued_groups_do_not_inflate_totals() {
    let (db, _) = collected().await;
    let r = run(
        &db,
        json!({
            "entity": "assets",
            "mode": "aggregate",
            "groupBy": [{ "field": "attr:11" }],
            "measures": [
                { "id": "n", "fn": "count" },
                { "id": "cost", "fn": "sum", "field": "attr:12" },
                { "id": "avg", "fn": "avg", "field": "attr:12" },
            ],
        }),
    );
    // LAP-2 has two borrowers, so it appears under both, but the overall totals count it once.
    assert_eq!(
        sorted(rows(&r)),
        vec![
            (json!("Bob"), vec![json!(2), json!(3000.0), json!(1500.0)]),
            (json!("Cara"), vec![json!(1), json!(2000.0), json!(2000.0)]),
            (Value::Null, vec![json!(2), json!(800.0), json!(400.0)]),
        ]
    );
    assert_eq!(r["totals"], json!([4, 3800.0, 950.0]));
}

#[tokio::test]
async fn soft_deleted_assets_are_excluded_unless_requested() {
    let (db, _) = collected().await;
    let base = json!({
        "entity": "assets",
        "mode": "aggregate",
        "measures": [{ "id": "n", "fn": "count" }],
        "softDelete": [{ "typeId": "1", "attributeId": "13", "value": "retired" }],
    });
    assert_eq!(run(&db, base.clone())["totals"], json!([3]));
    let mut all = base;
    all["includeSoftDeleted"] = json!(true);
    assert_eq!(run(&db, all)["totals"], json!([4]));
}

#[tokio::test]
async fn detail_rows_filter_with_nested_or() {
    let (db, _) = collected().await;
    let r = run(
        &db,
        json!({
            "entity": "assets",
            "mode": "detail",
            "columns": ["asset.key", "attr:12"],
            "filter": { "kind": "group", "join": "or", "children": [
                { "kind": "condition", "field": "attr:12", "op": "gte", "value": 2000 },
                { "kind": "group", "join": "and", "children": [
                    { "kind": "condition", "field": "attr:13", "op": "eq", "value": "in stock" },
                    { "kind": "condition", "field": "asset.key", "op": "startsWith", "value": "lap" },
                ]},
            ]},
            "sort": { "column": "asset.key", "desc": false },
        }),
    );
    assert_eq!(r["total"], json!(2));
    let mut keys: Vec<String> = r["rows"].as_array().unwrap().iter().map(|row| row[0].as_str().unwrap().to_string()).collect();
    keys.sort();
    assert_eq!(keys, vec!["LAP-2", "LAP-3"]);
}

#[tokio::test]
async fn other_bucket_is_measured_not_summed() {
    let (db, _) = collected().await;
    let conn = db.lock().unwrap();
    let ds = db::existing_dataset_id(&conn, "ds-1").unwrap().unwrap();
    let mut s = spec(json!({
        "entity": "assets",
        "mode": "aggregate",
        "measures": [{ "id": "n", "fn": "count" }, { "id": "avg", "fn": "avg", "field": "attr:12" }],
    }));
    // Everything except Bob, including assets with no borrower: LAP-3, LAP-4 and LAP-2 (via Cara).
    let other = Node::Condition { field: "attr:11".into(), op: OTHER_OP.into(), value: json!({ "keys": ["STU-2"], "includeNull": true }) };
    let r = query::run_aggregate(&conn, ds, &s, now(), Some(&other), false).unwrap();
    assert_eq!(r.totals[0], json!(3));
    // The internal operator is rejected when it comes from a saved report.
    s.filter = other;
    assert!(query::run_aggregate(&conn, ds, &s, now(), None, false).is_err());
}

#[tokio::test]
async fn incremental_refresh_refetches_only_changed_assets() {
    let (db, fake) = collected().await;
    let history_calls = |fake: &FakeJira| fake.log.lock().unwrap().iter().filter(|l| l.ends_with("/history")).count();
    let before = history_calls(&fake);
    let s = refresh(&db, &fake, false, now() + 1000).await.unwrap();
    // Nothing changed; denied and missing histories are not retried either.
    assert_eq!(history_calls(&fake) - before, 0);
    assert_eq!(s.histories_fetched, 0);

    {
        let mut objects = fake.objects.lock().unwrap();
        objects[0]["updated"] = json!("2024-06-15T11:00:00.000Z");
        // LAP-2 leaves the data source; its history stays, marked unavailable.
        objects.remove(1);
    }
    fake.histories.lock().unwrap().insert(
        "1".into(),
        Ok(json!([change("101", 10, "Borrower", "", "Alice (STU-1)"), change("105", 0, "Borrower", "Bob (STU-2)", "Alice (STU-1)")])),
    );
    let before = history_calls(&fake);
    let s = refresh(&db, &fake, false, now() + 2000).await.unwrap();
    assert_eq!(history_calls(&fake) - before, 1);
    assert_eq!(s.histories_fetched, 1);

    // LAP-1 now: borrowed 10 days ago and today; LAP-2 (unavailable) 3 days ago.
    let mut q = borrows("STU-1", 30);
    assert_eq!(run(&db, q.clone())["totals"], json!([3, 2]));
    q["includeUnavailable"] = json!(false);
    assert_eq!(run(&db, q)["totals"], json!([2, 1]));
    let status = status_for_test(&db.lock().unwrap(), &dataset()).unwrap();
    assert_eq!(status.unavailable_assets, 1);
    assert_eq!(status.assets, 3);
}

#[tokio::test]
async fn throttling_is_retried_and_reported() {
    let db = Arc::new(Mutex::new(db::open_memory().unwrap()));
    let fake = jira();
    fake.throttle.lock().unwrap().insert("/object/1/history".into(), 2);
    let s = refresh(&db, &fake, false, now()).await.unwrap();
    assert_eq!(s.throttled, 2);
    assert_eq!(s.histories_failed, 0);
    assert_eq!(run(&db, borrows("STU-1", 30))["totals"], json!([2, 2]));
}

#[tokio::test]
async fn persistent_throttling_stops_the_refresh() {
    let db = Arc::new(Mutex::new(db::open_memory().unwrap()));
    let fake = jira();
    fake.throttle.lock().unwrap().insert("/object/1/history".into(), 1000);
    assert!(refresh(&db, &fake, false, now()).await.is_err());
    // Nothing is published from a failed refresh.
    assert!(!status_for_test(&db.lock().unwrap(), &dataset()).unwrap().collected);
}

#[tokio::test]
async fn cancelled_refresh_resumes_from_checkpoints() {
    let db = Arc::new(Mutex::new(db::open_memory().unwrap()));
    let fake = jira();
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = cancel.clone();
    let progress = move |p: collect::Progress| {
        if p.phase == "history" && p.done >= 1 {
            flag.store(true, Ordering::Relaxed);
        }
    };
    let single = Settings { concurrency: 1, requests_per_second: 20.0 };
    let r = collect::refresh(db.clone(), &dataset(), false, single, fake.clone(), cancel, tuning(), &progress, now()).await;
    assert!(matches!(r, Err(AppError::Cancelled)), "{r:?}");
    let status = status_for_test(&db.lock().unwrap(), &dataset()).unwrap();
    assert!(!status.collected);
    assert!(status.resumable >= 1);

    let first = fake.log.lock().unwrap().iter().filter(|l| l.ends_with("/history")).count();
    let s = refresh(&db, &fake, false, now()).await.unwrap();
    let total = fake.log.lock().unwrap().iter().filter(|l| l.ends_with("/history")).count();
    assert_eq!(total, 4, "checkpointed histories are not fetched again (first run fetched {first})");
    assert!(s.histories_reused >= 1);
    assert_eq!(run(&db, borrows("STU-1", 30))["totals"], json!([2, 2]));
}

#[tokio::test]
async fn full_refresh_has_a_cooldown() {
    let (db, fake) = collected().await;
    refresh(&db, &fake, true, now()).await.unwrap();
    assert!(refresh(&db, &fake, true, now() + 60_000).await.is_err());
    refresh(&db, &fake, true, now() + collect::FULL_COOLDOWN_MS + 1).await.unwrap();
}

#[tokio::test]
async fn estimate_uses_a_single_count_request() {
    let db = Arc::new(Mutex::new(db::open_memory().unwrap()));
    let fake = jira();
    let e = collect::estimate(&db, &dataset(), settings(), fake.clone(), now()).await.unwrap();
    assert_eq!(e.assets, 4);
    assert!(e.first_collection);
    assert_eq!(e.history_requests, 4);
    assert_eq!(fake.log.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn exports_every_row_without_emails() {
    let (db, _) = collected().await;
    let conn = db.lock().unwrap();
    let ds = db::existing_dataset_id(&conn, "ds-1").unwrap().unwrap();
    let s = spec(json!({ "entity": "events", "mode": "detail", "columns": ["asset.key", "event.actor", "event.addedObject"] }));
    let plan = query::plan_detail(&conn, ds, &s, now()).unwrap();
    let dir = std::env::temp_dir().join(format!("jam-report-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("out.json");
    let meta = super::export::Meta { name: "Test", tz: chrono_tz::UTC, generated_ms: now() };
    let n = super::export::write_detail(&conn, &plan, None, &path, super::export::Format::Json, &meta).unwrap();
    assert_eq!(n as i64, plan.count(&conn).unwrap());
    let text = std::fs::read_to_string(&path).unwrap();
    serde_json::from_str::<Value>(&text).unwrap();
    assert!(!text.contains("admin@example.com"), "actor emails are never stored");
    assert!(text.contains("Charlie"), "label-only references must be exported");
    assert!(!text.contains("label:11:"), "internal label identifiers are not display values");
    assert!(!text.contains("(STU-"), "references are displayed as labels only");
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Large-volume smoke test: `cargo test --release perf_large_history -- --ignored --nocapture`.
#[test]
#[ignore]
fn perf_large_history() {
    use rusqlite::params;
    let mut conn = db::open_memory().unwrap();
    let ds = db::dataset_id(&conn, "ds-1").unwrap();
    let (assets, per_asset) = (100_000i64, 10i64);
    let start = std::time::Instant::now();
    {
        let tx = conn.transaction().unwrap();
        tx.execute("INSERT INTO types (ds_id, type_id, name) VALUES (?1, '1', 'Laptops')", params![ds]).unwrap();
        tx.execute("INSERT INTO attrs (ds_id, attr_id, type_id, name, kind) VALUES (?1, '11', '1', 'Borrower', 'ref')", params![ds]).unwrap();
        for o in 0..assets {
            let id = o.to_string();
            let key = format!("LAP-{o}");
            tx.execute(
                "INSERT INTO objects (ds_id, object_id, key, label, type_id, created_ms, updated_ms, updated_raw) VALUES (?1, ?2, ?3, ?3, '1', 0, 0, '')",
                params![ds, id, key],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO members (ds_id, object_id, key, label, type_id, present, history_state, history_updated) VALUES (?1, ?2, ?3, ?3, '1', 1, 'ok', '')",
                params![ds, id, key],
            )
            .unwrap();
            for e in 0..per_asset {
                let hid = format!("{o}-{e}");
                let student = format!("STU-{}", (o * 7 + e) % 5000);
                tx.execute(
                    "INSERT INTO events (ds_id, object_id, history_id, created_ms, kind, affected, old_raw, new_raw, attr_id, attr_name, operation, resolution, norm)
                     VALUES (?1, ?2, ?3, ?4, 2, 'Borrower', '', ?5, '11', 'Borrower', 'assigned', 'resolved', 1)",
                    params![ds, id, hid, now() - (e * 9 + o % 30) * DAY, student],
                )
                .unwrap();
                tx.execute(
                    "INSERT INTO event_refs (ds_id, object_id, history_id, side, ref_key) VALUES (?1, ?2, ?3, 'added', ?4)",
                    params![ds, id, hid, student],
                )
                .unwrap();
            }
        }
        tx.commit().unwrap();
    }
    let sig = collect::norm_signature(&conn, ds, &dataset()).unwrap();
    conn.execute("UPDATE datasets SET last_refresh_ms = ?2, norm_hash = ?3 WHERE ds_id = ?1", params![ds, now(), sig]).unwrap();
    db::optimize(&conn).unwrap();
    println!("seeded {} events in {:?}", assets * per_asset, start.elapsed());

    let t = std::time::Instant::now();
    let r = run_spec(&mut conn, &dataset(), &spec(borrows("STU-42", 90)), now()).unwrap();
    println!("one student, 90 days: {} in {:?}", r["totals"], t.elapsed());

    let t = std::time::Instant::now();
    let s = spec(json!({
        "entity": "events", "mode": "aggregate",
        "filter": { "kind": "condition", "field": "event.created", "op": "last", "value": { "amount": 3, "unit": "month" } },
        "groupBy": [{ "field": "event.addedObject" }],
        "measures": [{ "id": "n", "fn": "count" }, { "id": "a", "fn": "distinct", "field": "asset.key" }],
    }));
    let r = run_spec(&mut conn, &dataset(), &s, now()).unwrap();
    println!("by student, 3 months: {} groups in {:?}", r["rows"].as_array().unwrap().len(), t.elapsed());

    let t = std::time::Instant::now();
    let r = run_spec(&mut conn, &dataset(), &spec(json!({ "entity": "events", "mode": "detail" })), now()).unwrap();
    println!("detail first page of {}: {:?}", r["total"], t.elapsed());
}
