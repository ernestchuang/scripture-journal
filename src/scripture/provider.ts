import type { Passage } from '../domain';
import { BOOKS, chapterKey, validPassage } from './books';
export interface Verse { number: number; text: string }
const cache = new Map<string, Verse[]>();

/** External data remains plain text; callers must never render it as HTML. */
export function parseChapter(value: unknown, passage: Passage): Verse[] {
  if (!value || typeof value !== 'object') throw new Error('Invalid scripture response.');
  const data = value as Record<string, unknown>;
  if (data.translation_id !== 'kjv' || !Array.isArray(data.verses) || !data.verses.length) throw new Error('Scripture response is missing KJV verses.');
  let previous = 0;
  return data.verses.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid verse.');
    const v = raw as Record<string, unknown>;
    if (v.chapter !== passage.chapter || typeof v.verse !== 'number' || !Number.isInteger(v.verse) || v.verse !== previous + 1 || typeof v.text !== 'string' || !v.text.trim()) throw new Error('Invalid verse sequence.');
    // API names Psalm as Psalms and uses the standard names in our catalog otherwise.
    if (v.book_name !== BOOKS[passage.book - 1].name) throw new Error('The source returned a different book.');
    previous = v.verse;
    return { number: v.verse, text: v.text.trim() };
  });
}

/** CORS supported; no bulk prefetch. See https://bible-api.com/ for service limits. */
export async function loadChapter(passage: Passage, signal: AbortSignal): Promise<Verse[]> {
  if (!validPassage(passage)) throw new Error('Invalid passage.');
  const key = chapterKey(passage);
  const existing = cache.get(key);
  if (existing) return existing;
  const url = `https://bible-api.com/${encodeURIComponent(`${BOOKS[passage.book - 1].name} ${passage.chapter}`)}?translation=kjv&single_chapter_book_matching=indifferent`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(response.status === 429 ? 'The scripture source is busy. Wait 30 seconds, then retry.' : 'Scripture could not be loaded. Check your connection and retry.');
  const verses = parseChapter(await response.json(), passage);
  signal.throwIfAborted();
  cache.set(key, verses);
  return verses;
}
