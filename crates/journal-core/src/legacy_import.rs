use crate::{record_change, EntryContent, Passage};
use anyhow::{ensure, Context, Result};
use chrono::{NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

const MAX_FILE_BYTES: u64 = 2_000_000;
const MAX_FILES: usize = 20_000;

pub(crate) const LEGACY_IMPORT_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS legacy_import_sources(
 source_set_id TEXT NOT NULL,
 relative_path TEXT NOT NULL,
 content_hash TEXT NOT NULL,
 entry_id TEXT NOT NULL REFERENCES entries(id),
 revision_id TEXT NOT NULL REFERENCES revisions(id),
 source_root TEXT NOT NULL,
 source_bytes BLOB NOT NULL,
 metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
 imported_at TEXT NOT NULL,
 PRIMARY KEY(source_set_id,relative_path,content_hash)
);
CREATE INDEX IF NOT EXISTS legacy_import_latest_path ON legacy_import_sources(source_set_id,relative_path,imported_at);
CREATE TRIGGER IF NOT EXISTS legacy_import_sources_immutable BEFORE UPDATE ON legacy_import_sources BEGIN SELECT RAISE(ABORT,'Legacy import provenance is immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_import_sources_retained BEFORE DELETE ON legacy_import_sources BEGIN SELECT RAISE(ABORT,'Legacy import provenance is retained'); END;
";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportPreview {
    pub source_set_id: String,
    pub preview_id: String,
    pub source_root: String,
    pub recognized: usize,
    pub unchanged: usize,
    pub changed: usize,
    pub unsupported: usize,
    pub unresolved_links: usize,
    pub records: Vec<LegacyImportRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportRecord {
    pub relative_path: String,
    pub status: String,
    pub entry_id: Option<String>,
    pub title: Option<String>,
    pub date: Option<String>,
    pub warnings: Vec<String>,
    pub unresolved_links: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportResult {
    pub imported: usize,
    pub revisions_created: usize,
    pub unchanged: usize,
    pub unsupported: usize,
}

#[derive(Clone)]
struct ParsedFile {
    relative_path: String,
    bytes: Vec<u8>,
    hash: String,
    title: String,
    body: String,
    date: String,
    book: u32,
    chapter: u32,
    tags: Vec<String>,
    unknown: Vec<String>,
    link_labels: Vec<String>,
    entry_id: String,
    status: String,
}

struct Scan {
    source_root: String,
    source_set_id: String,
    preview_id: String,
    parsed: Vec<ParsedFile>,
    records: Vec<LegacyImportRecord>,
}

pub(crate) fn preview(conn: &Connection, selected: &Path) -> Result<LegacyImportPreview> {
    let Scan {
        source_root,
        source_set_id,
        preview_id,
        mut parsed,
        mut records,
    } = scan(conn, selected)?;
    let mut labels: HashMap<String, Vec<String>> = HashMap::new();
    for file in &parsed {
        labels
            .entry(file_stem(&file.relative_path))
            .or_default()
            .push(file.entry_id.clone());
        labels
            .entry(file.title.clone())
            .or_default()
            .push(file.entry_id.clone());
    }
    let mut unresolved_links = 0;
    for file in &mut parsed {
        let unresolved: Vec<String> = file
            .link_labels
            .iter()
            .filter(|label| labels.get(*label).is_none_or(|ids| ids.len() != 1))
            .cloned()
            .collect();
        unresolved_links += unresolved.len();
        if let Some(record) = records
            .iter_mut()
            .find(|record| record.relative_path == file.relative_path)
        {
            record.unresolved_links = unresolved;
        }
    }
    Ok(LegacyImportPreview {
        source_set_id,
        preview_id,
        source_root,
        recognized: parsed.iter().filter(|file| file.status == "new").count(),
        unchanged: parsed
            .iter()
            .filter(|file| file.status == "unchanged")
            .count(),
        changed: parsed
            .iter()
            .filter(|file| file.status == "changed")
            .count(),
        unsupported: records
            .iter()
            .filter(|record| record.status == "unsupported")
            .count(),
        unresolved_links,
        records,
    })
}

pub(crate) fn import(
    conn: &mut Connection,
    selected: &Path,
    expected_preview_id: &str,
) -> Result<LegacyImportResult> {
    let Scan {
        source_root,
        source_set_id,
        preview_id,
        parsed,
        records,
    } = scan(conn, selected)?;
    ensure!(
        preview_id == expected_preview_id,
        "Legacy source changed since preview; preview it again"
    );
    let mut labels: HashMap<String, Vec<String>> = HashMap::new();
    for file in &parsed {
        labels
            .entry(file_stem(&file.relative_path))
            .or_default()
            .push(file.entry_id.clone());
        labels
            .entry(file.title.clone())
            .or_default()
            .push(file.entry_id.clone());
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch(LEGACY_IMPORT_SCHEMA)?;
    let now = Utc::now().to_rfc3339();
    let mut imported = 0;
    let mut revisions_created = 0;
    let mut unchanged = 0;
    for file in parsed {
        if file.status == "unchanged" {
            unchanged += 1;
            continue;
        }
        let links = file
            .link_labels
            .iter()
            .filter_map(|label| labels.get(label))
            .filter(|ids| ids.len() == 1)
            .map(|ids| ids[0].clone())
            .collect();
        let content = EntryContent {
            title: file.title.clone(),
            body: file.body.clone(),
            passages: vec![Passage {
                book: file.book,
                chapter: file.chapter,
                start_verse: None,
                end_verse: None,
            }],
            tags: file.tags.clone(),
            links,
        };
        let current: Option<String> = tx
            .query_row(
                "SELECT working_revision_id FROM entries WHERE id=?1",
                [&file.entry_id],
                |row| row.get(0),
            )
            .optional()?;
        let revision_id = stable_id(&format!(
            "revision:{}:{}:{}",
            source_set_id, file.relative_path, file.hash
        ));
        if current.as_deref() != Some(&revision_id) {
            if current.is_none() {
                tx.execute("INSERT INTO entries(id,created_at,updated_at,working_revision_id,published_revision_id) VALUES(?1,?2,?2,?3,?3)", params![file.entry_id,now,revision_id])?;
                imported += 1;
            }
            tx.execute("INSERT INTO revisions(id,entry_id,parent_id,created_at,content) VALUES(?1,?2,?3,?4,?5)", params![revision_id,file.entry_id,current,now,serde_json::to_string(&content)?])?;
            tx.execute("UPDATE entries SET working_revision_id=?1,published_revision_id=?1,updated_at=?2 WHERE id=?3", params![revision_id,now,file.entry_id])?;
            record_change(
                &tx,
                &file.entry_id,
                if current.is_some() {
                    "legacy-import-revision"
                } else {
                    "legacy-import"
                },
                &revision_id,
            )?;
            revisions_created += 1;
        }
        let metadata = serde_json::json!({"date":file.date,"unknownFrontmatter":file.unknown,"unresolvedLinks":file.link_labels.iter().filter(|label| labels.get(*label).is_none_or(|ids| ids.len()!=1)).collect::<Vec<_>>()});
        tx.execute("INSERT OR IGNORE INTO legacy_import_sources(source_set_id,relative_path,content_hash,entry_id,revision_id,source_root,source_bytes,metadata_json,imported_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![source_set_id,file.relative_path,file.hash,file.entry_id,revision_id,source_root,file.bytes,metadata.to_string(),now])?;
    }
    tx.commit()?;
    Ok(LegacyImportResult {
        imported,
        revisions_created,
        unchanged,
        unsupported: records
            .iter()
            .filter(|record| record.status == "unsupported")
            .count(),
    })
}

fn scan(conn: &Connection, selected: &Path) -> Result<Scan> {
    let selected = selected
        .canonicalize()
        .context("Legacy source directory is unavailable")?;
    ensure!(selected.is_dir(), "Legacy source must be a directory");
    let journal = selected.join("journal");
    let root = if journal.is_dir() {
        journal
    } else {
        selected.clone()
    };
    let source_root = selected.to_string_lossy().into_owned();
    let source_set_id = stable_id(&format!("legacy-source:{source_root}"));
    let mut paths = Vec::new();
    collect_markdown(&root, &root, &mut paths)?;
    ensure!(
        paths.len() <= MAX_FILES,
        "Legacy source contains too many files"
    );
    paths.sort_by(|a, b| a.0.cmp(&b.0));
    let mut preview_hasher = Sha256::new();
    let mut snapshots = Vec::with_capacity(paths.len());
    for (relative, path) in paths {
        let bytes = fs::read(path)?;
        ensure!(
            bytes.len() as u64 <= MAX_FILE_BYTES,
            "Legacy file exceeds size limit"
        );
        preview_hasher.update(relative.as_bytes());
        preview_hasher.update([0]);
        preview_hasher.update(&bytes);
        preview_hasher.update([0]);
        snapshots.push((relative, bytes));
    }
    let preview_id = hex(&preview_hasher.finalize());
    let ledger_exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_import_sources')", [], |row| row.get(0))?;
    let mut parsed = Vec::new();
    let mut records = Vec::new();
    for (relative_path, bytes) in snapshots {
        let hash = hex(&Sha256::digest(&bytes));
        if file_stem(&relative_path).starts_with(|c: char| c.is_ascii_digit())
            && file_stem(&relative_path).chars().nth(2) == Some('-')
        {
            records.push(unsupported(
                &relative_path,
                "Chapter note; not a journal entry",
            ));
            continue;
        }
        match parse_file(
            &source_set_id,
            &relative_path,
            bytes,
            hash,
            conn,
            ledger_exists,
        ) {
            Ok(file) => {
                records.push(LegacyImportRecord {
                    relative_path: relative_path.clone(),
                    status: file.status.clone(),
                    entry_id: Some(file.entry_id.clone()),
                    title: Some(file.title.clone()),
                    date: Some(file.date.clone()),
                    warnings: if file.unknown.is_empty() {
                        vec![]
                    } else {
                        vec!["Unknown frontmatter retained in provenance".into()]
                    },
                    unresolved_links: vec![],
                });
                parsed.push(file);
            }
            Err(error) => records.push(unsupported(&relative_path, &error.to_string())),
        }
    }
    Ok(Scan {
        source_root,
        source_set_id,
        preview_id,
        parsed,
        records,
    })
}

fn parse_file(
    source_set_id: &str,
    relative_path: &str,
    bytes: Vec<u8>,
    hash: String,
    conn: &Connection,
    ledger_exists: bool,
) -> Result<ParsedFile> {
    let text = std::str::from_utf8(&bytes).context("File is not UTF-8")?;
    let normalized = text.replace("\r\n", "\n");
    let rest = normalized
        .strip_prefix("---\n")
        .context("No frontmatter block")?;
    let (frontmatter, body) = rest
        .split_once("\n---")
        .context("Unterminated frontmatter block")?;
    let mut values = HashMap::new();
    let mut tags = Vec::new();
    let mut unknown = Vec::new();
    let lines: Vec<&str> = frontmatter.lines().collect();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let Some((key, raw)) = line.split_once(':') else {
            unknown.push(line.to_owned());
            index += 1;
            continue;
        };
        let key = key.trim();
        let value = parse_scalar(raw.trim())?;
        if key == "tags" {
            if value.is_empty() {
                index += 1;
                while index < lines.len() && lines[index].trim_start().starts_with('-') {
                    tags.push(parse_scalar(
                        lines[index].trim_start().trim_start_matches('-').trim(),
                    )?);
                    index += 1;
                }
                continue;
            }
            if value.starts_with('[') && value.ends_with(']') {
                tags.extend(
                    value[1..value.len() - 1]
                        .split(',')
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                        .map(str::to_owned),
                );
            } else {
                tags.push(value);
            }
        } else if matches!(
            key,
            "date" | "book" | "chapter" | "type" | "plan" | "verses"
        ) {
            values.insert(key.to_owned(), value);
        } else {
            unknown.push(line.to_owned());
        }
        index += 1;
    }
    let date = values.remove("date").context("Missing date")?;
    NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d")
        .context("Invalid date; expected YYYY-MM-DD")?;
    let book_name = values.remove("book").context("Missing book")?;
    let book = book_number(&book_name).context("Unknown Bible book")?;
    let chapter: u32 = values
        .remove("chapter")
        .context("Missing chapter")?
        .parse()
        .context("Invalid chapter")?;
    crate::validate_passage(&Passage {
        book,
        chapter,
        start_verse: None,
        end_verse: None,
    })?;
    let body = body.trim_start_matches('\n').to_owned();
    let title = body
        .lines()
        .find_map(|line| line.strip_prefix("# ").map(str::trim))
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| file_stem(relative_path));
    let link_labels = wikilinks(&body);
    let entry_id = stable_id(&format!("entry:{source_set_id}:{relative_path}"));
    let status = if ledger_exists {
        let exact: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM legacy_import_sources WHERE source_set_id=?1 AND relative_path=?2 AND content_hash=?3)", params![source_set_id,relative_path,hash], |row| row.get(0))?;
        if exact { "unchanged" } else {
            let known: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM legacy_import_sources WHERE source_set_id=?1 AND relative_path=?2)", params![source_set_id,relative_path], |row| row.get(0))?;
            if known { "changed" } else { "new" }
        }
    } else { "new" }.to_owned();
    Ok(ParsedFile {
        relative_path: relative_path.to_owned(),
        bytes,
        hash,
        title,
        body,
        date,
        book,
        chapter,
        tags,
        unknown,
        link_labels,
        entry_id,
        status,
    })
}

fn parse_scalar(value: &str) -> Result<String> {
    ensure!(
        !value.starts_with('!') && !value.starts_with('&') && !value.starts_with('*'),
        "Unsafe YAML feature is not supported"
    );
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        return serde_json::from_str(value).context("Invalid quoted YAML scalar");
    }
    if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
        return Ok(value[1..value.len() - 1].replace("''", "'"));
    }
    Ok(value.to_owned())
}

fn collect_markdown(
    root: &Path,
    directory: &Path,
    output: &mut Vec<(String, PathBuf)>,
) -> Result<()> {
    for item in fs::read_dir(directory)? {
        let item = item?;
        let kind = item.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            collect_markdown(root, &item.path(), output)?;
        } else if kind.is_file()
            && item
                .path()
                .extension()
                .and_then(|v| v.to_str())
                .is_some_and(|v| v.eq_ignore_ascii_case("md"))
        {
            ensure!(
                item.metadata()?.len() <= MAX_FILE_BYTES,
                "Legacy file exceeds size limit"
            );
            let relative = item
                .path()
                .strip_prefix(root)?
                .to_string_lossy()
                .replace('\\', "/");
            output.push((relative, item.path()));
        }
    }
    Ok(())
}

fn unsupported(path: &str, reason: &str) -> LegacyImportRecord {
    LegacyImportRecord {
        relative_path: path.into(),
        status: "unsupported".into(),
        entry_id: None,
        title: None,
        date: None,
        warnings: vec![reason.into()],
        unresolved_links: vec![],
    }
}
fn file_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or(path)
        .to_owned()
}
fn wikilinks(body: &str) -> Vec<String> {
    body.split("[[")
        .skip(1)
        .filter_map(|tail| {
            tail.split_once("]]").map(|(value, _)| {
                value
                    .split('|')
                    .next()
                    .unwrap_or(value)
                    .trim()
                    .trim_end_matches(".md")
                    .to_owned()
            })
        })
        .collect()
}
fn stable_id(value: &str) -> String {
    let h = hex(&Sha256::digest(value.as_bytes()));
    format!(
        "{}-{}-4{}-a{}-{}",
        &h[0..8],
        &h[8..12],
        &h[13..16],
        &h[17..20],
        &h[20..32]
    )
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn book_number(name: &str) -> Option<u32> {
    const BOOKS: [&str; 66] = [
        "Genesis",
        "Exodus",
        "Leviticus",
        "Numbers",
        "Deuteronomy",
        "Joshua",
        "Judges",
        "Ruth",
        "1 Samuel",
        "2 Samuel",
        "1 Kings",
        "2 Kings",
        "1 Chronicles",
        "2 Chronicles",
        "Ezra",
        "Nehemiah",
        "Esther",
        "Job",
        "Psalms",
        "Proverbs",
        "Ecclesiastes",
        "Song of Solomon",
        "Isaiah",
        "Jeremiah",
        "Lamentations",
        "Ezekiel",
        "Daniel",
        "Hosea",
        "Joel",
        "Amos",
        "Obadiah",
        "Jonah",
        "Micah",
        "Nahum",
        "Habakkuk",
        "Zephaniah",
        "Haggai",
        "Zechariah",
        "Malachi",
        "Matthew",
        "Mark",
        "Luke",
        "John",
        "Acts",
        "Romans",
        "1 Corinthians",
        "2 Corinthians",
        "Galatians",
        "Ephesians",
        "Philippians",
        "Colossians",
        "1 Thessalonians",
        "2 Thessalonians",
        "1 Timothy",
        "2 Timothy",
        "Titus",
        "Philemon",
        "Hebrews",
        "James",
        "1 Peter",
        "2 Peter",
        "1 John",
        "2 John",
        "3 John",
        "Jude",
        "Revelation",
    ];
    BOOKS
        .iter()
        .position(|book| book.eq_ignore_ascii_case(name.trim()))
        .map(|index| index as u32 + 1)
}
