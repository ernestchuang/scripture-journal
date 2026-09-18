use rusqlite::{params, Connection};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    io::{Cursor, Read},
    path::Path,
};

const KJV_URL: &str = "https://ebible.org/Scriptures/eng-kjv2006_vpl.zip";
const CHAPTERS: [u16; 66] = [
    50, 40, 27, 36, 34, 24, 21, 4, 31, 24, 22, 25, 29, 36, 10, 13, 10, 42, 150, 31, 12, 8, 66, 52,
    5, 48, 12, 14, 3, 9, 1, 4, 7, 3, 3, 3, 2, 14, 4, 28, 16, 24, 21, 28, 16, 16, 13, 6, 6, 4, 4, 5,
    3, 6, 4, 3, 1, 13, 5, 5, 3, 5, 1, 1, 1, 22,
];
const CODES: [&str; 66] = [
    "GEN", "EXO", "LEV", "NUM", "DEU", "JOS", "JDG", "RUT", "1SA", "2SA", "1KI", "2KI", "1CH",
    "2CH", "EZR", "NEH", "EST", "JOB", "PSA", "PRO", "ECC", "SOL", "ISA", "JER", "LAM", "EZE",
    "DAN", "HOS", "JOE", "AMO", "OBA", "JON", "MIC", "NAH", "HAB", "ZEP", "HAG", "ZEC", "MAL",
    "MAT", "MAR", "LUK", "JOH", "ACT", "ROM", "1CO", "2CO", "GAL", "EPH", "PHI", "COL", "1TH",
    "2TH", "1TI", "2TI", "TIT", "PHM", "HEB", "JAM", "1PE", "2PE", "1JO", "2JO", "3JO", "JUD",
    "REV",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verse {
    number: u16,
    text: String,
}

pub struct ScriptureStore {
    connection: Connection,
}

impl ScriptureStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        let connection = Connection::open(path).map_err(|e| e.to_string())?;
        connection.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS verses(translation TEXT NOT NULL, book INTEGER NOT NULL, chapter INTEGER NOT NULL, verse INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(translation,book,chapter,verse)); CREATE TABLE IF NOT EXISTS translations(id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, complete INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS reader_state(id INTEGER PRIMARY KEY CHECK(id=1), translation TEXT NOT NULL, book INTEGER NOT NULL, chapter INTEGER NOT NULL, verse INTEGER);").map_err(|e| e.to_string())?;
        Ok(Self { connection })
    }
    pub fn chapter(
        &self,
        translation: &str,
        book: u16,
        chapter: u16,
    ) -> Result<Vec<Verse>, String> {
        let mut statement = self.connection.prepare("SELECT verse,text FROM verses WHERE translation=?1 AND book=?2 AND chapter=?3 ORDER BY verse").map_err(|e| e.to_string())?;
        let result = statement
            .query_map(params![translation, book, chapter], |row| {
                Ok(Verse {
                    number: row.get(0)?,
                    text: row.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string());
        result
    }
    pub fn has_kjv(&self) -> Result<bool, String> {
        self.connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM translations WHERE id='KJV' AND complete=1)",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())
    }
    pub fn install_kjv(&mut self, verses: Vec<(u16, u16, u16, String)>) -> Result<(), String> {
        validate(&verses)?;
        let tx = self.connection.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM verses WHERE translation='KJV'", [])
            .map_err(|e| e.to_string())?;
        {
            let mut insert = tx
                .prepare("INSERT INTO verses VALUES('KJV',?1,?2,?3,?4)")
                .map_err(|e| e.to_string())?;
            for (book, chapter, verse, text) in verses {
                insert
                    .execute(params![book, chapter, verse, text])
                    .map_err(|e| e.to_string())?;
            }
        }
        tx.execute(
            "INSERT OR REPLACE INTO translations VALUES('KJV','King James Version',?1,1)",
            [KJV_URL],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
}

pub fn download_kjv() -> Result<Vec<(u16, u16, u16, String)>, String> {
    let response =
        reqwest::blocking::get(KJV_URL).map_err(|e| format!("KJV download failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "KJV download failed with HTTP {}.",
            response.status()
        ));
    }
    let bytes = response.bytes().map_err(|e| e.to_string())?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err("KJV package is unexpectedly large.".into());
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let index = (0..archive.len())
        .find(|&i| {
            archive
                .by_index(i)
                .ok()
                .is_some_and(|f| f.name().ends_with("_vpl.txt"))
        })
        .ok_or("KJV package has no VPL text.")?;
    let mut file = archive.by_index(index).map_err(|e| e.to_string())?;
    if file.size() > 12 * 1024 * 1024 {
        return Err("KJV text is unexpectedly large.".into());
    }
    let mut source = String::new();
    file.read_to_string(&mut source)
        .map_err(|e| e.to_string())?;
    parse_vpl(&source)
}

fn parse_vpl(source: &str) -> Result<Vec<(u16, u16, u16, String)>, String> {
    let lookup: BTreeMap<&str, u16> = CODES
        .iter()
        .enumerate()
        .map(|(i, c)| (*c, i as u16 + 1))
        .collect();
    source
        .lines()
        .map(|line| {
            let mut parts = line.splitn(3, ' ');
            let code = parts.next().ok_or("Invalid KJV record.")?;
            let numbers = parts.next().ok_or("Invalid KJV reference.")?;
            let text = parts.next().ok_or("Empty KJV verse.")?;
            let (chapter, verse) = numbers.split_once(':').ok_or("Invalid KJV reference.")?;
            let book = *lookup.get(code).ok_or("Unknown KJV book code.")?;
            let chapter = chapter.parse().map_err(|_| "Invalid KJV chapter.")?;
            let verse = verse.parse().map_err(|_| "Invalid KJV verse.")?;
            if text.trim().is_empty() {
                return Err("Empty KJV verse.".into());
            }
            Ok((book, chapter, verse, text.trim().to_string()))
        })
        .collect()
}

fn validate(verses: &[(u16, u16, u16, String)]) -> Result<(), String> {
    if verses.len() < 30_000 {
        return Err("KJV package is incomplete.".into());
    }
    let mut chapters: BTreeMap<(u16, u16), Vec<u16>> = BTreeMap::new();
    for (book, chapter, verse, _) in verses {
        chapters.entry((*book, *chapter)).or_default().push(*verse);
    }
    for (book_index, chapter_count) in CHAPTERS.iter().enumerate() {
        for chapter in 1..=*chapter_count {
            let key = (book_index as u16 + 1, chapter);
            let found = chapters.get(&key).ok_or_else(|| {
                format!("KJV package is missing book {}, chapter {}.", key.0, key.1)
            })?;
            if found
                .iter()
                .enumerate()
                .any(|(index, verse)| *verse != index as u16 + 1)
            {
                return Err(format!(
                    "KJV package has an invalid verse sequence in book {}, chapter {}.",
                    key.0, key.1
                ));
            }
        }
    }
    if chapters.len() != 1189 {
        return Err("KJV package has unexpected chapters.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_pack_does_not_replace_complete_library() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = ScriptureStore::open(&dir.path().join("s.db")).unwrap();
        assert!(store.install_kjv(vec![(1, 1, 1, "test".into())]).is_err());
        assert!(!store.has_kjv().unwrap());
    }

    #[test]
    #[ignore = "uses the public eBible network endpoint"]
    fn public_kjv_package_still_matches_the_validated_contract() {
        let verses = download_kjv().unwrap();
        assert!(verses.len() > 30_000);
        validate(&verses).unwrap();
    }
}
