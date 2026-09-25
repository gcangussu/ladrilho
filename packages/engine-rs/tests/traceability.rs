//! Traceability for the crate: the adoption table and the citations.
//!
//! Every requirement declared in 0001, 0002 and 0007 is classified exactly once
//! in 0009's *Adopted requirements* table. Every requirement of 0009, and every
//! one classed `adopted` or `reading`, is cited by a test under `tests/` or
//! excused, with a reason, in 0009's *Traceability exemptions* table.
//!
//! The identifiers this file contains are the two requirements it is the test
//! of, cited beside those tests; the scanner reads them as the citations they
//! are. It contains no others.

mod support;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

const SPEC: &str = "0009-engine-in-rust.md";
const SOURCES: [&str; 3] = ["0001-engine-core.md", "0002-engine-conformance-vectors.md", "0007-scoring-explained.md"];
const ADOPTION_HEADING: &str = "### Adopted requirements";
const EXEMPTION_HEADING: &str = "### Traceability exemptions";
const CLASSES: [&str; 4] = ["adopted", "reading", "replaced", "not adopted"];

/// The prefixes this scanner owns: the crate's own and the three it adopts from.
fn prefixes() -> [String; 4] {
    [["R", "9"].concat(), ["E", "1"].concat(), ["V", "2"].concat(), ["S", "7"].concat()]
}

fn spec(name: &str) -> String {
    let path = support::repo_root().join("spec").join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Every identifier in `text`, in either citation form — `[X-n]` or
/// `[NNNN X-n]` — with the offset it starts at.
fn identifiers(text: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'[' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        // An optional spec number and a space.
        if j + 5 <= b.len() && b[j..j + 4].iter().all(u8::is_ascii_digit) && b[j + 4] == b' ' {
            j += 5;
        }
        let start = j;
        while j < b.len() && b[j].is_ascii_uppercase() {
            j += 1;
        }
        let letters = j - start;
        let digits_start = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if letters == 0 || j == digits_start || j >= b.len() || b[j] != b'-' {
            i += 1;
            continue;
        }
        j += 1;
        let num_start = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j == num_start || j >= b.len() || b[j] != b']' {
            i += 1;
            continue;
        }
        out.push((i, text[start..j].to_string()));
        i = j + 1;
    }
    out
}

/// Identifiers a spec *declares*: those it bolds, `**[X-n]**`.
fn declared(text: &str) -> BTreeSet<String> {
    identifiers(text)
        .into_iter()
        .filter(|(at, id)| text[..*at].ends_with("**") && text[*at + id.len() + 2..].starts_with("**"))
        .map(|(_, id)| id)
        .collect()
}

/// The markdown table rows of the section under `heading`, as columns.
fn table(text: &str, heading: &str) -> Vec<Vec<String>> {
    let start = text.find(heading).unwrap_or_else(|| panic!("0009 has no \"{heading}\" section"));
    let rest = &text[start + heading.len()..];
    let end = [rest.find("\n## "), rest.find("\n### ")].into_iter().flatten().min().unwrap_or(rest.len());
    rest[..end]
        .lines()
        .filter(|l| l.starts_with("| ") && !l.starts_with("| ---") && !l.starts_with("| Requirement"))
        .map(|l| l.trim().trim_matches('|').split(" | ").map(|c| c.trim().to_string()).collect())
        .collect()
}

fn owned(id: &str) -> bool {
    prefixes().iter().any(|p| id.starts_with(&format!("{p}-")))
}

/// Every `.rs` file under `tests/`: the whole harness.
fn test_sources() -> Vec<(PathBuf, String)> {
    fn walk(dir: &Path, out: &mut Vec<(PathBuf, String)>) {
        for e in std::fs::read_dir(dir).unwrap() {
            let path = e.unwrap().path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().is_some_and(|x| x == "rs") {
                let text = std::fs::read_to_string(&path).unwrap();
                out.push((path, text));
            }
        }
    }
    let mut out = Vec::new();
    walk(&support::crate_dir().join("tests"), &mut out);
    out
}

struct Scan {
    /// Declared in 0001, 0002 and 0007.
    sources: BTreeSet<String>,
    /// Declared in 0009.
    own: BTreeSet<String>,
    /// Adoption rows: identifier to class, and how many rows name it.
    classes: BTreeMap<String, Vec<String>>,
    exempt: BTreeMap<String, String>,
    cited: BTreeMap<String, Vec<PathBuf>>,
}

fn scan() -> Scan {
    let mut sources = BTreeSet::new();
    for name in SOURCES {
        sources.extend(declared(&spec(name)));
    }
    let text = spec(SPEC);
    let own = declared(&text);
    let mut classes: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in table(&text, ADOPTION_HEADING) {
        assert!(row.len() >= 2, "adoption row without a class: {row:?}");
        for (_, id) in identifiers(&row[0]) {
            classes.entry(id).or_default().push(row[1].clone());
        }
    }
    let mut exempt = BTreeMap::new();
    for row in table(&text, EXEMPTION_HEADING) {
        let reason = row.get(1).cloned().unwrap_or_default();
        for (_, id) in identifiers(&row[0]) {
            exempt.insert(id, reason.clone());
        }
    }
    let mut cited: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    for (path, text) in test_sources() {
        for (_, id) in identifiers(&text) {
            if owned(&id) {
                cited.entry(id).or_default().push(path.clone());
            }
        }
    }
    Scan { sources, own, classes, exempt, cited }
}

/// [R9-22] The adoption table classifies every declared identifier of the
/// three specs exactly once, with one of the four classes, and names nothing
/// they do not declare.
#[test]
fn every_adopted_spec_requirement_is_classified_once() {
    let s = scan();
    assert!(s.sources.len() > 100, "the scan must see the three specs");
    let mut faults = Vec::new();
    for id in &s.sources {
        match s.classes.get(id) {
            None => faults.push(format!("{id} is declared but not in the adoption table")),
            Some(c) if c.len() > 1 => faults.push(format!("{id} appears {} times", c.len())),
            Some(c) if !CLASSES.contains(&c[0].as_str()) => faults.push(format!("{id} has class {:?}", c[0])),
            _ => {}
        }
    }
    for id in s.classes.keys() {
        if !s.sources.contains(id) {
            faults.push(format!("the adoption table names {id}, which no source spec declares"));
        }
    }
    assert!(faults.is_empty(), "{}", faults.join("\n"));
}

/// [R9-23] Every requirement of 0009, and every one classed adopted or
/// reading, is cited by a test or exempt with a reason; no test cites an identifier that
/// does not exist; no exemption names one that does not, or one that needs
/// none.
#[test]
fn every_requirement_is_cited_or_exempt() {
    let s = scan();
    assert!(!s.own.is_empty(), "the scan must see 0009");
    let required: BTreeSet<String> = s
        .own
        .iter()
        .cloned()
        .chain(s.classes.iter().filter(|(_, c)| matches!(c[0].as_str(), "adopted" | "reading")).map(|(id, _)| id.clone()))
        .collect();
    let exists = |id: &String| s.own.contains(id) || s.sources.contains(id);
    let mut faults = Vec::new();
    for id in &required {
        if !s.cited.contains_key(id) && !s.exempt.contains_key(id) {
            faults.push(format!("{id} is neither cited by a test nor exempt"));
        }
    }
    for (id, paths) in &s.cited {
        if !exists(id) {
            faults.push(format!("{} cites {id}, which does not exist", paths[0].display()));
        }
    }
    for (id, reason) in &s.exempt {
        if !exists(id) {
            faults.push(format!("the exemption table names {id}, which does not exist"));
        } else if !required.contains(id) {
            faults.push(format!("the exemption table names {id}, which needs no citation"));
        }
        if reason.is_empty() {
            faults.push(format!("{id} is exempt without a reason"));
        }
    }
    assert!(faults.is_empty(), "{}", faults.join("\n"));
}

/// The scanner reads both citation forms and only bolded declarations.
#[test]
fn the_scanner_reads_what_it_claims() {
    let x = ["X", "1"].concat();
    let text = format!("**[{x}-1]** and [{x}-2] and [0001 {x}-3], not [{x}-] nor [x1-4] nor [{x}-5");
    let ids: Vec<String> = identifiers(&text).into_iter().map(|(_, id)| id).collect();
    assert_eq!(ids, [format!("{x}-1"), format!("{x}-2"), format!("{x}-3")]);
    assert_eq!(declared(&text), BTreeSet::from([format!("{x}-1")]));
}
