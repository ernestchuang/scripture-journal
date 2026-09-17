import { describe, expect, it, vi, afterEach } from 'vitest';
import { adjacentChapter, BOOKS, formatPassage } from './books';
import { loadChapter, parseChapter } from './provider';
const fixture = { translation_id: 'kjv', verses: [{ book_name: 'Genesis', chapter: 1, verse: 1, text: 'Synthetic test text.' }] };
afterEach(() => vi.unstubAllGlobals());
describe('chapter navigation', () => {
  it('traverses book boundaries without wrapping the canon', () => {
    expect(BOOKS).toHaveLength(66);
    expect(BOOKS.reduce((n, b) => n + b.chapters, 0)).toBe(1189);
    expect(adjacentChapter({ book: 1, chapter: 50 }, 1)).toEqual({ book: 2, chapter: 1 });
    expect(adjacentChapter({ book: 2, chapter: 1 }, -1)).toEqual({ book: 1, chapter: 50 });
    expect(adjacentChapter({ book: 1, chapter: 1 }, -1)).toBeNull();
    expect(adjacentChapter({ book: 66, chapter: 22 }, 1)).toBeNull();
  });
  it('formats selected verse ranges independently of chapter bounds', () => {
    expect(formatPassage({ book: 43, chapter: 3, startVerse: 16, endVerse: 21 })).toBe('John 3:16–21');
  });
});
describe('external scripture validation', () => {
  it('requires the selected translation, chapter, book and ordered verses', () => {
    expect(parseChapter(fixture, { book: 1, chapter: 1 })).toEqual([{ number: 1, text: 'Synthetic test text.' }]);
    expect(() => parseChapter({ ...fixture, translation_id: 'web' }, { book: 1, chapter: 1 })).toThrow();
    expect(() => parseChapter(fixture, { book: 2, chapter: 1 })).toThrow();
    expect(() => parseChapter(fixture, { book: 1, chapter: 2 })).toThrow();
    expect(() => parseChapter({ ...fixture, verses: [{ ...fixture.verses[0], verse: 2 }] }, { book: 1, chapter: 1 })).toThrow();
  });
  it('retains markup as inert text for React text rendering', () => {
    const raw = '<img src=x onerror=alert(1)>';
    expect(parseChapter({ ...fixture, verses: [{ ...fixture.verses[0], text: raw }] }, { book: 1, chapter: 1 })[0].text).toBe(raw);
  });
  it('requests entire single-chapter books and forwards cancellation', async () => {
    const mock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ translation_id: 'kjv', verses: [{ book_name: 'Jude', chapter: 1, verse: 1, text: 'Synthetic Jude text.' }] }) });
    vi.stubGlobal('fetch', mock);
    const controller = new AbortController();
    await loadChapter({ book: 65, chapter: 1 }, controller.signal);
    expect(mock.mock.calls[0][0]).toContain('single_chapter_book_matching=indifferent');
    expect(mock.mock.calls[0][1].signal).toBe(controller.signal);
  });
  it('does not cache responses from aborted requests', async () => {
    const controller = new AbortController();
    const mock = vi.fn().mockImplementation(async () => { controller.abort(); return { ok: true, json: async () => fixture }; });
    vi.stubGlobal('fetch', mock);
    await expect(loadChapter({ book: 1, chapter: 1 }, controller.signal)).rejects.toThrow();
    mock.mockResolvedValue({ ok: false, status: 429 });
    await expect(loadChapter({ book: 1, chapter: 1 }, new AbortController().signal)).rejects.toThrow('Wait 30 seconds');
  });
});
