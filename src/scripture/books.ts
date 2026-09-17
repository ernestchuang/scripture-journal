import type { Passage } from '../domain';

const names = ['Genesis','Exodus','Leviticus','Numbers','Deuteronomy','Joshua','Judges','Ruth','1 Samuel','2 Samuel','1 Kings','2 Kings','1 Chronicles','2 Chronicles','Ezra','Nehemiah','Esther','Job','Psalms','Proverbs','Ecclesiastes','Song of Solomon','Isaiah','Jeremiah','Lamentations','Ezekiel','Daniel','Hosea','Joel','Amos','Obadiah','Jonah','Micah','Nahum','Habakkuk','Zephaniah','Haggai','Zechariah','Malachi','Matthew','Mark','Luke','John','Acts','Romans','1 Corinthians','2 Corinthians','Galatians','Ephesians','Philippians','Colossians','1 Thessalonians','2 Thessalonians','1 Timothy','2 Timothy','Titus','Philemon','Hebrews','James','1 Peter','2 Peter','1 John','2 John','3 John','Jude','Revelation'];
const counts = [50,40,27,36,34,24,21,4,31,24,22,25,29,36,10,13,10,42,150,31,12,8,66,52,5,48,12,14,3,9,1,4,7,3,3,3,2,14,4,28,16,24,21,28,16,16,13,6,6,4,4,5,3,6,4,3,1,13,5,5,3,5,1,1,1,22];
export const BOOKS = names.map((name, i) => ({ id: i + 1, name, chapters: counts[i] }));
export const chapterKey = (p: Passage) => `${p.book}:${p.chapter}`;
export function validPassage(p: Passage): boolean {
  return Number.isInteger(p.book) && Number.isInteger(p.chapter) && p.book >= 1 && p.book <= 66 && p.chapter >= 1 && p.chapter <= BOOKS[p.book - 1].chapters;
}
export function formatPassage(p: Passage): string {
  return `${BOOKS[p.book - 1]?.name ?? 'Unknown book'} ${p.chapter}${p.startVerse ? `:${p.startVerse}${p.endVerse && p.endVerse !== p.startVerse ? `–${p.endVerse}` : ''}` : ''}`;
}
export function adjacentChapter(p: Passage, direction: -1 | 1): Passage | null {
  if (!validPassage(p)) return null;
  const chapter = p.chapter + direction;
  if (chapter >= 1 && chapter <= BOOKS[p.book - 1].chapters) return { book: p.book, chapter };
  const book = p.book + direction;
  return book < 1 || book > 66 ? null : { book, chapter: direction === 1 ? 1 : BOOKS[book - 1].chapters };
}
