//! Turns raw Jira history entries into report events: resolves the affected attribute and the objects referenced
//! before and after the change. Label-only references remain reportable without guessing their object identity.

use std::collections::{BTreeMap, BTreeSet, HashMap};

pub const NORM_VERSION: u32 = 2;

fn is_key(token: &str) -> bool {
    let Some((prefix, number)) = token.rsplit_once('-') else { return false };
    !prefix.is_empty()
        && prefix.len() <= 32
        && prefix.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && prefix.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !number.is_empty()
        && number.len() <= 12
        && number.chars().all(|c| c.is_ascii_digit())
}

/// A bare object key ("STU-12") or a value ending in "(STU-12)".
fn parse_one(token: &str) -> Option<String> {
    let t = token.trim();
    if is_key(t) {
        return Some(t.to_string());
    }
    let inner = t.strip_suffix(')')?;
    let open = inner.rfind('(')?;
    let key = inner[open + 1..].trim();
    is_key(key).then(|| key.to_string())
}

/// Parsed reference keys, `Some(empty)` for an empty value, or `None` if the value is not unambiguous.
/// A comma-separated list is accepted when every part is a key; otherwise the whole value must be a single
/// key or "Label (KEY)" whose label does not itself contain another "(KEY)" part.
pub fn parse_refs(raw: &str, mapping: Option<&BTreeMap<String, String>>) -> Option<BTreeSet<String>> {
    let value = raw.trim();
    if value.is_empty() {
        return Some(BTreeSet::new());
    }
    if let Some(key) = mapping.and_then(|m| m.get(value)) {
        return Some(BTreeSet::from([key.clone()]));
    }
    let lookup = |part: &str| mapping.and_then(|m| m.get(part)).cloned().or_else(|| parse_one(part));
    let parts: Vec<&str> = value.split(',').map(str::trim).filter(|p| !p.is_empty()).collect();
    if parts.len() > 1 {
        let keys: Option<BTreeSet<String>> = parts.iter().map(|p| lookup(p)).collect();
        if keys.is_some() {
            return keys;
        }
        // "Doe, Jane (STU-1)" is one labelled key, but "Bob (STU-2), x (STU-3)" with an unreadable part is ambiguous.
        if parts[..parts.len() - 1].iter().any(|p| parse_one(p).is_some()) {
            return None;
        }
    }
    parse_one(value).map(|k| BTreeSet::from([k]))
}

/// (key, label) pairs written as "Label (KEY-1)" in a history value; used only as a fallback display name.
pub fn ref_labels_in(raw: &str) -> Vec<(String, String)> {
    let one = |t: &str| -> Option<(String, String)> {
        let inner = t.trim().strip_suffix(')')?;
        let open = inner.rfind('(')?;
        let key = inner[open + 1..].trim();
        let label = inner[..open].trim();
        (is_key(key) && !label.is_empty()).then(|| (key.to_string(), label.to_string()))
    };
    let parts: Vec<&str> = raw.split(',').map(str::trim).filter(|p| !p.is_empty()).collect();
    if parts.len() > 1 && parts.iter().all(|p| is_key(p) || one(p).is_some()) {
        return parts.into_iter().filter_map(one).collect();
    }
    if parts.len() > 1 && parts[..parts.len() - 1].iter().any(|p| one(p).is_some()) {
        return vec![];
    }
    one(raw).into_iter().collect()
}

/// Raw tokens that could not be resolved, for the identity-mapping screen.
pub fn unresolved_tokens(raw: &str, mapping: Option<&BTreeMap<String, String>>) -> Vec<String> {
    if parse_refs(raw, mapping).is_some() {
        return vec![];
    }
    let value = raw.trim();
    let parts: Vec<&str> = value.split(',').map(str::trim).filter(|p| !p.is_empty()).collect();
    let all_but_some = parts.len() > 1 && parts.iter().any(|p| mapping.and_then(|m| m.get(*p)).is_some() || parse_one(p).is_some());
    if all_but_some {
        parts
            .into_iter()
            .filter(|p| mapping.and_then(|m| m.get(*p)).is_none() && parse_one(p).is_none())
            .map(str::to_string)
            .collect()
    } else {
        vec![value.to_string()]
    }
}

/// Preserve comma-containing names as one label unless the list has explicit keys or mapped entries.
fn reference_values(raw: &str, mapping: Option<&BTreeMap<String, String>>, attr: &str) -> (BTreeSet<String>, Vec<(String, String)>) {
    let value = raw.trim();
    if value.is_empty() {
        return (BTreeSet::new(), vec![]);
    }
    let parts: Vec<&str> = value.split(',').map(str::trim).filter(|p| !p.is_empty()).collect();
    let is_known = |v: &str| parse_one(v).is_some() || mapping.is_some_and(|m| m.contains_key(v));
    let tokens = if !mapping.is_some_and(|m| m.contains_key(value)) && parts.len() > 1 && parts[..parts.len() - 1].iter().any(|p| is_known(p)) {
        parts
    } else {
        vec![value]
    };
    let mut keys = BTreeSet::new();
    let mut labels = Vec::new();
    for token in tokens {
        let key = mapping.and_then(|m| m.get(token)).cloned().or_else(|| parse_one(token)).unwrap_or_else(|| format!("label:{attr}:{token}"));
        let label = ref_labels_in(token).into_iter().next().map(|(_, label)| label).unwrap_or_else(|| token.to_string());
        if label != key {
            labels.push((key.clone(), label));
        }
        keys.insert(key);
    }
    (keys, labels)
}

#[derive(Clone, Debug)]
pub struct AttrInfo {
    pub id: String,
    pub name: String,
    pub is_ref: bool,
}

/// Attribute lookup for one dataset: current names per object type, plus user-supplied former names.
#[derive(Default)]
pub struct Resolver {
    by_type: HashMap<(String, String), AttrInfo>,
    by_alias: HashMap<String, Vec<(String, AttrInfo)>>,
    pub mappings: BTreeMap<String, BTreeMap<String, String>>,
}

pub struct AttrRow {
    pub id: String,
    pub type_id: String,
    pub name: String,
    pub is_ref: bool,
}

impl Resolver {
    pub fn new(
        attrs: &[AttrRow],
        aliases: &BTreeMap<String, Vec<String>>,
        mappings: &BTreeMap<String, BTreeMap<String, String>>,
    ) -> Self {
        let mut r = Resolver { mappings: mappings.clone(), ..Default::default() };
        for a in attrs {
            let info = AttrInfo { id: a.id.clone(), name: a.name.clone(), is_ref: a.is_ref };
            r.by_type.entry((a.type_id.clone(), a.name.to_lowercase())).or_insert_with(|| info.clone());
            for alias in aliases.get(&a.id).into_iter().flatten() {
                r.by_alias.entry(alias.trim().to_lowercase()).or_default().push((a.type_id.clone(), info.clone()));
            }
        }
        r
    }

    pub fn attr(&self, type_id: &str, affected: &str) -> Option<&AttrInfo> {
        let name = affected.trim().to_lowercase();
        if name.is_empty() {
            return None;
        }
        self.by_type.get(&(type_id.to_string(), name.clone())).or_else(|| {
            let found = self.by_alias.get(&name)?;
            found.iter().find(|(t, _)| t == type_id).or(found.first()).map(|(_, a)| a)
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Normalized {
    pub attr_id: Option<String>,
    pub attr_name: String,
    pub operation: &'static str,
    pub resolved: bool,
    /// (side, key) pairs: old, new, added, removed.
    pub refs: Vec<(&'static str, String)>,
    pub labels: Vec<(String, String)>,
}

pub struct RawEvent<'a> {
    pub type_id: &'a str,
    pub kind: i64,
    pub affected: &'a str,
    pub old: &'a str,
    pub new: &'a str,
}

pub fn normalize(r: &Resolver, e: &RawEvent) -> Normalized {
    let attr = r.attr(e.type_id, e.affected);
    let attr_name = attr.map(|a| a.name.clone()).unwrap_or_else(|| e.affected.trim().to_string());
    let attr_id = attr.map(|a| a.id.clone());
    let old = e.old.trim();
    let new = e.new.trim();

    if e.affected.trim().is_empty() {
        let operation = if e.kind == 0 { "created" } else { "other" };
        return Normalized { attr_id, attr_name, operation, resolved: true, refs: vec![], labels: vec![] };
    }

    let by_text = |old: &str, new: &str| match (old.is_empty(), new.is_empty()) {
        (true, true) => "unchanged",
        (true, false) => "assigned",
        (false, true) => "cleared",
        (false, false) if old == new => "unchanged",
        _ => "reassigned",
    };

    let Some(attr) = attr.filter(|a| a.is_ref) else {
        return Normalized { attr_id, attr_name, operation: by_text(old, new), resolved: true, refs: vec![], labels: vec![] };
    };

    let mapping = r.mappings.get(&attr.id);
    let resolved = parse_refs(old, mapping).is_some() && parse_refs(new, mapping).is_some();
    let (o, mut labels) = reference_values(old, mapping, &attr.id);
    let (n, new_labels) = reference_values(new, mapping, &attr.id);
    labels.extend(new_labels);
    let added: Vec<String> = n.difference(&o).cloned().collect();
    let removed: Vec<String> = o.difference(&n).cloned().collect();
    let operation = match (added.is_empty(), removed.is_empty()) {
        (false, true) => "assigned",
        (false, false) => "reassigned",
        (true, false) => "cleared",
        (true, true) => "unchanged",
    };
    let mut refs = Vec::new();
    refs.extend(o.into_iter().map(|k| ("old", k)));
    refs.extend(n.into_iter().map(|k| ("new", k)));
    refs.extend(added.into_iter().map(|k| ("added", k)));
    refs.extend(removed.into_iter().map(|k| ("removed", k)));
    Normalized { attr_id, attr_name, operation, resolved, refs, labels }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolver(mappings: BTreeMap<String, BTreeMap<String, String>>) -> Resolver {
        let attrs = vec![
            AttrRow { id: "10".into(), type_id: "1".into(), name: "Assigned To".into(), is_ref: true },
            AttrRow { id: "11".into(), type_id: "1".into(), name: "Status".into(), is_ref: false },
        ];
        let aliases = BTreeMap::from([("10".to_string(), vec!["Borrower".to_string()])]);
        Resolver::new(&attrs, &aliases, &mappings)
    }

    fn ev<'a>(affected: &'a str, old: &'a str, new: &'a str) -> RawEvent<'a> {
        RawEvent { type_id: "1", kind: 1, affected, old, new }
    }

    #[test]
    fn reads_labels_from_history_text() {
        assert_eq!(ref_labels_in("Jane Doe (STU-12)"), vec![("STU-12".to_string(), "Jane Doe".to_string())]);
        assert_eq!(ref_labels_in("A (STU-1), STU-2, B (STU-3)").len(), 2);
        assert!(ref_labels_in("STU-12").is_empty());
        assert!(ref_labels_in("Jane (not a key)").is_empty());
        assert_eq!(ref_labels_in("Doe, Jane (STU-12)"), vec![("STU-12".to_string(), "Doe, Jane".to_string())]);
    }

    #[test]
    fn parses_only_unambiguous_keys() {
        assert_eq!(parse_refs("STU-12", None), Some(BTreeSet::from(["STU-12".to_string()])));
        assert_eq!(parse_refs("Jane Doe (STU-12)", None), Some(BTreeSet::from(["STU-12".to_string()])));
        assert_eq!(parse_refs("STU-1, STU-2", None).map(|s| s.len()), Some(2));
        assert_eq!(parse_refs("Bob (STU-2), Cara (STU-3)", None).map(|s| s.len()), Some(2));
        assert_eq!(parse_refs("Doe, Jane (STU-12)", None), Some(BTreeSet::from(["STU-12".to_string()])));
        assert_eq!(parse_refs("Bob (STU-2), mystery", None), None);
        assert_eq!(parse_refs("", None), Some(BTreeSet::new()));
        assert_eq!(parse_refs("Jane Doe", None), None);
        assert_eq!(parse_refs("Doe, Jane", None), None);
        assert_eq!(parse_refs("STU-1, Jane", None), None);
        assert_eq!(parse_refs("12-34", None), None);
        let map = BTreeMap::from([("Jane Doe".to_string(), "STU-12".to_string())]);
        assert_eq!(parse_refs("Jane Doe", Some(&map)), Some(BTreeSet::from(["STU-12".to_string()])));
        assert_eq!(unresolved_tokens("STU-1, Jane", None), vec!["Jane".to_string()]);
        assert_eq!(unresolved_tokens("Doe, Jane", None), vec!["Doe, Jane".to_string()]);
    }

    #[test]
    fn classifies_assignment_operations() {
        let r = resolver(BTreeMap::new());
        let assigned = normalize(&r, &ev("Assigned To", "", "Jane (STU-1)"));
        assert_eq!(assigned.operation, "assigned");
        assert_eq!(assigned.attr_id.as_deref(), Some("10"));
        assert!(assigned.refs.contains(&("added", "STU-1".to_string())));

        let reassigned = normalize(&r, &ev("assigned to", "STU-1", "STU-2"));
        assert_eq!(reassigned.operation, "reassigned");
        assert!(reassigned.refs.contains(&("added", "STU-2".to_string())));
        assert!(reassigned.refs.contains(&("removed", "STU-1".to_string())));

        assert_eq!(normalize(&r, &ev("Assigned To", "STU-2", "")).operation, "cleared");
        assert_eq!(normalize(&r, &ev("Borrower", "", "STU-3")).attr_id.as_deref(), Some("10"));
        assert_eq!(normalize(&r, &ev("Status", "In stock", "Loaned")).operation, "reassigned");
        assert_eq!(normalize(&r, &RawEvent { type_id: "1", kind: 0, affected: "", old: "", new: "" }).operation, "created");
    }

    #[test]
    fn label_only_values_are_reportable_without_mapping() {
        let r = resolver(BTreeMap::new());
        let e = normalize(&r, &ev("Assigned To", "", "Jane Doe"));
        assert!(!e.resolved);
        assert_eq!(e.operation, "assigned");
        assert!(e.refs.contains(&("added", "label:10:Jane Doe".to_string())));
        assert_eq!(e.labels, vec![("label:10:Jane Doe".into(), "Jane Doe".into())]);

        let mapped = resolver(BTreeMap::from([(
            "10".to_string(),
            BTreeMap::from([("Jane Doe".to_string(), "STU-12".to_string())]),
        )]));
        let e = normalize(&mapped, &ev("Assigned To", "", "Jane Doe"));
        assert!(e.resolved);
        assert!(e.refs.contains(&("added", "STU-12".to_string())));
        assert_eq!(e.labels, vec![("STU-12".into(), "Jane Doe".into())]);
    }

    #[test]
    fn preserves_labels_and_partial_lists_without_guessing_identities() {
        let r = resolver(BTreeMap::new());
        let e = normalize(&r, &ev("Assigned To", "Bob (STU-2), mystery", "Bob (STU-2), Jane Doe"));
        assert_eq!(e.operation, "reassigned");
        assert!(e.refs.contains(&("removed", "label:10:mystery".into())));
        assert!(e.refs.contains(&("added", "label:10:Jane Doe".into())));
        assert!(!e.refs.contains(&("added", "STU-2".into())));
        let comma = normalize(&r, &ev("Assigned To", "", "Doe, Jane"));
        assert!(comma.refs.contains(&("added", "label:10:Doe, Jane".into())));
        let labelled = normalize(&r, &ev("Assigned To", "", "Doe, Jane (STU-12)"));
        assert_eq!(labelled.labels, vec![("STU-12".into(), "Doe, Jane".into())]);
        assert_eq!(normalize(&r, &ev("Assigned To", "Jane Doe", "Jane Doe")).operation, "unchanged");
        assert_eq!(normalize(&r, &ev("Assigned To", "Jane Doe", "")).operation, "cleared");
    }

    #[test]
    fn unknown_attributes_keep_their_history_name() {
        let r = resolver(BTreeMap::new());
        let e = normalize(&r, &ev("Old Field", "a", "b"));
        assert_eq!(e.attr_id, None);
        assert_eq!(e.attr_name, "Old Field");
        assert!(e.resolved);
    }
}
