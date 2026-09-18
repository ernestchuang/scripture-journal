use serde::Deserialize;
use std::{fs::File, io::Read, path::Path};

const MAX_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScripturePack {
    pub format_version: u32,
    pub translation: String,
    pub name: String,
    pub source: String,
    pub chapters: Vec<PackChapter>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PackChapter {
    pub book: u16,
    pub chapter: u16,
    pub verses: Vec<PackVerse>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PackVerse {
    pub number: u16,
    pub text: String,
}

pub fn read_pack(path: &Path) -> Result<ScripturePack, String> {
    if !std::fs::metadata(path)
        .map_err(|e| e.to_string())?
        .is_file()
    {
        return Err("Choose a regular JSON Scripture pack file.".into());
    }
    let file = File::open(path).map_err(|e| format!("Cannot open Scripture pack: {e}"))?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Choose a regular JSON Scripture pack file.".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Scripture pack exceeds 50 MiB.".into());
    }
    let pack: ScripturePack =
        serde_json::from_slice(&bytes).map_err(|e| format!("Invalid Scripture pack: {e}"))?;
    validate_pack(&pack)?;
    Ok(pack)
}

pub fn validate_pack(pack: &ScripturePack) -> Result<(), String> {
    if pack.format_version != 1
        || !["LSB", "NASB1995", "ESV", "KJV"].contains(&pack.translation.as_str())
    {
        return Err("Unsupported Scripture pack version or translation.".into());
    }
    if pack.name.trim().is_empty()
        || pack.name.len() > 200
        || pack.source.trim().is_empty()
        || pack.source.len() > 2000
    {
        return Err("A pack needs a name and source attribution.".into());
    }
    if pack.chapters.len() != 1189 {
        return Err("A pack must contain all 1,189 canonical chapters.".into());
    }
    let mut index = 0;
    for (book, count) in super::scripture::CHAPTERS.iter().enumerate() {
        for chapter in 1..=*count {
            let item = &pack.chapters[index];
            index += 1;
            if item.book != book as u16 + 1
                || item.chapter != chapter
                || item.verses.is_empty()
                || item.verses.len() > 200
            {
                return Err(format!("Missing, duplicate, unordered or invalid chapter at book {} chapter {chapter}.", book + 1));
            }
            // Translation versification can differ. Require an explicit ordered
            // slot for every number; omissions must be represented in the text.
            for (offset, verse) in item.verses.iter().enumerate() {
                if verse.number != offset as u16 + 1
                    || verse.text.trim().is_empty()
                    || verse.text.len() > 100_000
                {
                    return Err(format!(
                        "Invalid verse sequence or text at book {} chapter {chapter}.",
                        book + 1
                    ));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scripture::ScriptureStore;

    fn fixture(translation: &str, text: &str) -> ScripturePack {
        ScripturePack {
            format_version: 1,
            translation: translation.into(),
            name: "Synthetic test edition".into(),
            source: "Synthetic fixtures; no Bible text".into(),
            chapters: crate::scripture::CHAPTERS
                .iter()
                .enumerate()
                .flat_map(|(book, count)| {
                    (1..=*count).map(move |chapter| PackChapter {
                        book: book as u16 + 1,
                        chapter,
                        verses: vec![PackVerse {
                            number: 1,
                            text: text.into(),
                        }],
                    })
                })
                .collect(),
        }
    }

    #[test]
    fn all_translations_persist_and_invalid_replacement_preserves_existing_pack() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("scripture.db");
        let mut store = ScriptureStore::open(&path).unwrap();
        for translation in ["LSB", "NASB1995", "ESV", "KJV"] {
            store
                .install_pack(fixture(translation, "retained synthetic text"))
                .unwrap();
            let mut invalid = fixture(translation, "invalid replacement");
            invalid.chapters.pop();
            assert!(store.install_pack(invalid).is_err());
        }
        drop(store);
        let mut store = ScriptureStore::open(&path).unwrap();
        for translation in ["LSB", "NASB1995", "ESV", "KJV"] {
            let value = serde_json::to_value(store.chapter(translation, 66, 22).unwrap()).unwrap();
            assert_eq!(value[0]["text"], "retained synthetic text");
            assert_eq!(
                store.translation_info(translation).unwrap().unwrap().source,
                "Synthetic fixtures; no Bible text"
            );
        }
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TRIGGER reject_replacement BEFORE INSERT ON verses WHEN NEW.text='replacement' BEGIN SELECT RAISE(ABORT,'simulated failure'); END;").unwrap();
        assert!(store.install_pack(fixture("ESV", "replacement")).is_err());
        let value = serde_json::to_value(store.chapter("ESV", 43, 3).unwrap()).unwrap();
        assert_eq!(value[0]["text"], "retained synthetic text");
    }

    #[test]
    fn rejects_duplicate_chapters_missing_slots_and_nonpersistent_storage() {
        let mut pack = fixture("ESV", "synthetic");
        pack.chapters[1].chapter = 1;
        assert!(validate_pack(&pack).is_err());
        let mut pack = fixture("ESV", "synthetic");
        pack.chapters[0].verses[0].number = 2;
        assert!(validate_pack(&pack).is_err());
        assert!(ScriptureStore::temporary()
            .unwrap()
            .install_pack(fixture("ESV", "synthetic"))
            .is_err());
    }
}
