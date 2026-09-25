//! Properties of the package itself: the manifest, the toolchain, and what
//! the source may and may not contain.
//!
//! The words these checks search for are assembled from fragments, so this
//! file never matches its own patterns.

mod support;

use std::path::{Path, PathBuf};
use support::crate_dir;

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Every `.rs` file under `dir`, recursively.
fn rust_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for e in entries {
        let path = e.unwrap().path();
        if path.is_dir() {
            if path.file_name().is_some_and(|n| n == "target") {
                continue;
            }
            out.extend(rust_files(&path));
        } else if path.extension().is_some_and(|x| x == "rs") {
            out.push(path);
        }
    }
    out.sort();
    out
}

/// Source with `//` comments removed, so documentation may name what the code
/// may not use.
fn code(text: &str) -> String {
    text.lines().map(|l| l.split("//").next().unwrap_or("")).collect::<Vec<_>>().join("\n")
}

fn library_code() -> Vec<(PathBuf, String)> {
    rust_files(&crate_dir().join("src")).into_iter().map(|p| {
        let t = code(&read(&p));
        (p, t)
    }).collect()
}

/// The `[section]` of a TOML file, as its lines, up to the next header.
fn section<'a>(toml: &'a str, header: &str) -> Option<Vec<&'a str>> {
    let mut lines = toml.lines();
    lines.by_ref().find(|l| l.trim() == header)?;
    Some(lines.take_while(|l| !l.trim_start().starts_with('[')).map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).collect())
}

fn words(text: &str) -> Vec<&str> {
    text.split(|c: char| !(c.is_alphanumeric() || c == '_')).filter(|w| !w.is_empty()).collect()
}

/// [R9-1] One library crate, azul_engine, edition 2024, unpublished, on an
/// exactly pinned stable toolchain with clippy, lockfile present, and every
/// cargo call in the scripts locked.
#[test]
fn the_crate_and_its_toolchain_are_pinned() {
    let manifest = read(&crate_dir().join("Cargo.toml"));
    let package = section(&manifest, "[package]").unwrap();
    for want in ["name = \"azul_engine\"", "edition = \"2024\"", "publish = false"] {
        assert!(package.contains(&want), "[package] lacks {want}");
    }
    assert!(!manifest.contains("[[bin]]") && !crate_dir().join("src/main.rs").exists() && !crate_dir().join("src/bin").exists(), "a library crate only");
    let toolchain = read(&crate_dir().join("rust-toolchain.toml"));
    let channel = toolchain.lines().find_map(|l| l.trim().strip_prefix("channel = ")).expect("a channel");
    let version = channel.trim_matches('"');
    let parts: Vec<&str> = version.split('.').collect();
    assert!(parts.len() == 3 && parts.iter().all(|p| p.parse::<u32>().is_ok()), "channel {channel} is not an exact release");
    assert!(toolchain.contains("\"clippy\""), "the clippy component");
    assert!(crate_dir().join("Cargo.lock").exists(), "Cargo.lock is committed");
    let pkg = read(&crate_dir().join("package.json"));
    let scripts: serde_json::Value = serde_json::from_str::<serde_json::Value>(&pkg).unwrap()["scripts"].clone();
    for (name, cmd) in scripts.as_object().unwrap() {
        let cmd = cmd.as_str().unwrap();
        if cmd.contains("cargo ") {
            assert!(cmd.contains("--locked"), "script {name} runs cargo without --locked");
        }
    }
}

/// [R9-2] The pnpm package and its four scripts, delegating to cargo.
#[test]
fn the_pnpm_package_delegates_to_cargo() {
    let pkg: serde_json::Value = serde_json::from_str(&read(&crate_dir().join("package.json"))).unwrap();
    assert_eq!(pkg["name"], "engine-rs");
    let s = &pkg["scripts"];
    assert_eq!(s["test"], "cargo test --locked");
    assert_eq!(s["typecheck"], "cargo clippy --locked --all-targets -- -D warnings");
    assert!(s["bench"].as_str().unwrap().starts_with("cargo bench --locked"));
    assert!(s["compare"].as_str().unwrap().starts_with("cargo run --locked --release"));
    let workspace = read(&support::repo_root().join("pnpm-workspace.yaml"));
    assert!(workspace.contains("'packages/*'"), "the workspace picks the package up");
}

/// [R9-3] No runtime or build dependencies; serde_json is the only
/// dev-dependency. [E1-50] is its runtime half.
#[test]
fn the_only_dependency_is_serde_json_for_the_tests() {
    let manifest = read(&crate_dir().join("Cargo.toml"));
    assert_eq!(section(&manifest, "[dependencies]"), Some(vec![]), "[dependencies] must be empty");
    assert!(section(&manifest, "[build-dependencies]").is_none_or(|s| s.is_empty()));
    let dev = section(&manifest, "[dev-dependencies]").unwrap();
    let names: Vec<&str> = dev.iter().map(|l| l.split('=').next().unwrap().trim()).collect();
    assert_eq!(names, ["serde_json"]);
    assert!(!manifest.contains("[target."), "no platform-specific dependencies");
}

/// [R9-4] Synchronous throughout: no async function, block or closure, no
/// await, no Future implemented, in any Rust file of the package; and no
/// async runtime or futures crate in the lockfile.
///
/// Seen to fail [R9-24] against `pub async fn probe() {}` added to
/// `src/score.rs`: this test failed and no other in this file.
#[test]
fn nothing_is_async() {
    let asy = ["as", "ync"].concat();
    let awa = [".aw", "ait"].concat();
    let fut = ["Fut", "ure"].concat();
    let mut faults = Vec::new();
    let files = rust_files(&crate_dir());
    assert!(files.len() > 10, "the scan must see the package");
    for path in &files {
        let text = code(&read(path));
        let w = words(&text);
        for (i, word) in w.iter().enumerate() {
            if *word == asy && matches!(w.get(i + 1), Some(&"fn") | Some(&"move") | Some(&"unsafe")) {
                faults.push(format!("{}: `{asy} {}`", path.display(), w[i + 1]));
            }
        }
        // An async block or closure: the keyword followed by `{` or `|`.
        for (i, _) in text.match_indices(&asy) {
            let before = text[..i].chars().last().is_none_or(|c| !(c.is_alphanumeric() || c == '_'));
            let after = text[i + asy.len()..].trim_start();
            if before && (after.starts_with('{') || after.starts_with('|')) {
                faults.push(format!("{}: an {asy} block or closure", path.display()));
            }
        }
        if text.contains(&awa) {
            faults.push(format!("{}: `{awa}`", path.display()));
        }
        if w.windows(4).any(|x| x[0] == "impl" && x.contains(&fut.as_str()) && x.contains(&"for")) {
            faults.push(format!("{}: implements {fut}", path.display()));
        }
    }
    let lock = read(&crate_dir().join("Cargo.lock"));
    let banned = |name: &str| {
        ["tokio", &[&asy, "-std"].concat(), "smol", "futures"].contains(&name)
            || name.starts_with("futures-")
            || name.starts_with(&[&asy, "-"].concat())
    };
    for line in lock.lines() {
        if let Some(name) = line.strip_prefix("name = ") {
            let name = name.trim_matches('"');
            if banned(name) {
                faults.push(format!("Cargo.lock: {name}"));
            }
        }
    }
    assert!(faults.is_empty(), "{}", faults.join("\n"));
}

/// [R9-5] The library spawns no thread, sleeps, blocks, or reads a clock; and
/// the types a caller moves between threads are Send + Sync.
#[test]
fn the_library_neither_waits_nor_spawns() {
    fn send_sync<T: Send + Sync>() {}
    send_sync::<azul_engine::AzulState<azul_engine::Seeded>>();
    send_sync::<azul_engine::Canonical>();
    send_sync::<azul_engine::RoundScoring>();
    send_sync::<azul_engine::IllegalAction>();
    let banned = ["thread", "sleep", "Instant", "SystemTime", "Condvar", "Barrier", "park", "spawn"];
    for (path, text) in library_code() {
        for w in words(&text) {
            assert!(!banned.contains(&w), "{}: `{w}`", path.display());
        }
    }
}

/// [R9-6] The library forbids unsafe code, and contains none.
#[test]
fn the_library_forbids_unsafe() {
    let lib = read(&crate_dir().join("src/lib.rs"));
    assert!(lib.contains(&["#![forbid(", "unsafe_code)]"].concat()));
    let kw = ["uns", "afe"].concat();
    for (path, text) in library_code() {
        let n = words(&text).iter().filter(|&&w| w == kw).count();
        assert_eq!(n, 0, "{}", path.display());
    }
}

/// The body of `pub struct AzulState`, and the attributes above it.
fn state_struct() -> (String, String) {
    let text = read(&crate_dir().join("src/state.rs"));
    let at = text.find("pub struct AzulState").expect("the struct");
    let attrs = text[..at].lines().rev().take_while(|l| l.trim_start().starts_with("#[") || l.trim_start().starts_with("///")).collect::<Vec<_>>().join("\n");
    let body = &text[at..];
    let end = body.find("\n}").unwrap();
    (attrs, body[..end].to_string())
}

/// [R9-8] Every field of AzulState is private to the crate, and there is no
/// recount: nothing outside can invalidate a cache.
#[test]
fn the_state_has_no_public_field() {
    let (_, body) = state_struct();
    let fields: Vec<&str> = body.lines().skip(1).map(str::trim).filter(|l| l.contains(':') && !l.starts_with("//")).collect();
    assert!(fields.len() >= 18, "the scan must see the fields");
    for f in fields {
        // Private, or visible to the crate only: never `pub`, `pub(super)` or
        // `pub(in …)`, which would reach past it.
        assert!(!f.starts_with("pub") || f.starts_with("pub(crate) "), "public field: {f}");
    }
    for (path, text) in library_code() {
        assert!(!words(&text).contains(&"recount"), "{}", path.display());
    }
}

/// [R9-9] The state owns no heap allocation — fixed arrays and scalars only —
/// and is not Copy; [R9-17]'s allocator test shows clone allocates nothing.
/// [R9-10] It derives PartialEq and Debug, which compare and print every
/// field, the cache and the shuffler included.
#[test]
fn the_state_is_plain_data_compared_whole() {
    let (attrs, body) = state_struct();
    let derive = attrs.lines().find(|l| l.contains("derive(")).expect("a derive");
    assert!(!words(derive).contains(&"Copy"), "must not be Copy");
    for d in ["Clone", "Debug", "PartialEq"] {
        assert!(words(derive).contains(&d), "derive lacks {d}");
    }
    for heap in ["Vec", "Box", "String", "Rc", "Arc", "HashMap", "BTreeMap"] {
        assert!(!words(&body).contains(&heap), "a {heap} in the state");
    }
    assert!(std::mem::size_of::<azul_engine::AzulState>() < 512);
    assert!(!body.contains("impl PartialEq"), "equality is derived, not hand-written");
}

/// [E1-50] No filesystem, network, clock, environment, threads or processes
/// in the library.
#[test]
fn the_library_touches_nothing_outside() {
    for (path, text) in library_code() {
        for m in ["fs", "net", "time", "env", "thread", "process"] {
            let path_text = ["std::", m].concat();
            assert!(!text.contains(&path_text), "{}: {path_text}", path.display());
        }
    }
}

/// [E1-51] Only apply, apply_explained and the shuffler take `&mut self`, and
/// the library holds no ambient mutable state.
#[test]
fn only_the_ply_mutates_and_nothing_is_ambient() {
    let mut mutators = Vec::new();
    for (path, text) in library_code() {
        for line in text.lines() {
            if line.contains("fn ") && line.contains("&mut self") && line.trim_start().starts_with("pub fn") {
                mutators.push(line.trim().split('(').next().unwrap().trim_start_matches("pub fn ").to_string());
            }
        }
        let w = words(&text);
        for banned in ["thread_local", "Cell", "RefCell", "OnceCell", "OnceLock", "Mutex", "RwLock", "LazyLock"] {
            assert!(!w.contains(&banned), "{}: {banned}", path.display());
        }
        assert!(!w.iter().any(|x| x.starts_with("Atomic")), "{}: atomics", path.display());
        assert!(!text.contains(&["static ", "mut"].concat()), "{}: static mut", path.display());
    }
    mutators.sort();
    assert_eq!(mutators, ["apply", "apply_explained"]);
    let rng = read(&crate_dir().join("src/rng.rs"));
    assert!(rng.contains("fn shuffle(&mut self, bag: &mut [u8], index: u32);"));
}

/// [R9-14] The public surface: every name the spec lists is exported under
/// that name. Renaming or removing one fails to compile here. An extra export
/// is not seen, and this does not claim otherwise.
#[test]
fn the_public_surface_is_the_listing() {
    #[allow(unused_imports)]
    use azul_engine::{
        ACTION_SPACE, Action, ActionList, AzulState, CENTER, COL_BONUS, COLOR_BONUS, CUM_PENALTY,
        Canonical, CanonicalError, ENCODED_SIZE, FACTORY_SIZE, FLOOR, FLOOR_PENALTIES, FLOOR_SLOTS,
        FloorCharge, IllegalAction, NUM_COLORS, NUM_FACTORIES, NUM_ROWS, NUM_TILES, OFF_BAG,
        OFF_CENTER, OFF_CENTER_TOTAL, OFF_FACTORIES, OFF_FACTORY_FLAGS, OFF_I_START, OFF_LID,
        OFF_MARKER_CENTER, OFF_MY_FLOOR, OFF_MY_LINES, OFF_MY_SETS, OFF_MY_WALL, OFF_OP_FLOOR,
        OFF_OP_LINES, OFF_OP_SETS, OFF_OP_WALL, OFF_ROUND, OFF_SCORES, OFF_TILES_LEFT, Outcome,
        Placement, Player, PlayerBonuses, PlayerRound, ROW_BONUS, RoundScoring, Seeded, Shuffler,
        TILES_PER_COLOR, decode_action, encode_action, placement_value, wall_col, wall_color_at,
        wall_completed_colors, wall_completed_cols, wall_completed_rows,
    };
    assert_eq!((NUM_COLORS, TILES_PER_COLOR, NUM_TILES, NUM_FACTORIES, FACTORY_SIZE, NUM_ROWS), (5, 20, 100, 5, 4, 5));
    assert_eq!((CENTER, FLOOR, ACTION_SPACE, FLOOR_SLOTS), (5, 5, 180, 7));
    assert_eq!(FLOOR_PENALTIES, [-1, -1, -2, -2, -2, -3, -3]);
    assert_eq!(CUM_PENALTY, [0, -1, -2, -4, -6, -8, -11, -14]);
    assert_eq!((ROW_BONUS, COL_BONUS, COLOR_BONUS), (2, 7, 10));
    let s: AzulState = AzulState::seeded(0);
    let list: ActionList = s.legal_actions();
    let _: &[Action] = list.as_slice();
    let _: Result<AzulState, CanonicalError> = AzulState::from_canonical(&s.to_canonical(), Seeded::new(0));
    let _: fn(&mut Seeded, &mut [u8], u32) = <Seeded as Shuffler>::shuffle;
}

/// [V2-8] The suite needs no network and no Python: the vectors are local
/// files, the one dev-dependency is a crates.io release pinned by the
/// lockfile, and nothing under `tests/` opens a socket or spawns a process —
/// the only ways a test could reach a network or an interpreter.
#[test]
fn the_suite_is_self_contained() {
    assert!(support::vector_dir().is_dir());
    let manifest = read(&crate_dir().join("Cargo.toml"));
    for header in ["[dependencies]", "[dev-dependencies]", "[build-dependencies]"] {
        for line in section(&manifest, header).unwrap_or_default() {
            for source in ["git", "path", "registry"] {
                assert!(!line.contains(&format!("{source} =")), "{header}: {line}");
            }
        }
    }
    let lock = read(&crate_dir().join("Cargo.lock"));
    for line in lock.lines().filter(|l| l.starts_with("source = ")) {
        assert!(line.contains("registry+https://github.com/rust-lang/crates.io-index"), "{line}");
    }
    let banned = [["std::", "net"].concat(), ["std::", "process"].concat(), ["Command", "::new"].concat()];
    for path in rust_files(&crate_dir().join("tests")) {
        let text = code(&read(&path));
        for b in &banned {
            assert!(!text.contains(b.as_str()), "{}: {b}", path.display());
        }
    }
}
