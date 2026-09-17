import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Passage } from '../domain';
import { adjacentChapter, BOOKS, chapterKey, formatPassage, validPassage } from './books';
import { loadChapter, type Verse } from './provider';
import './reader.css';

export interface ReaderProps {
  selection: Passage;
  onSelectionChange: (passage: Passage) => void;
  onReflect: (passage: Passage) => void;
}
function Chapter({ passage, selected }: { passage: Passage; selected: Passage }) {
  const sectionRef = useRef<HTMLElement>(null);
  const beforeLoad = useRef<{ height: number; above: boolean } | null>(null);
  const [verses, setVerses] = useState<Verse[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    loadChapter(passage, controller.signal).then(result => {
      if (!controller.signal.aborted) {
        const section = sectionRef.current;
        const parent = section?.parentElement;
        if (section && parent) beforeLoad.current = { height: section.offsetHeight, above: section.getBoundingClientRect().bottom <= parent.getBoundingClientRect().top + 120 };
        setVerses(result);
      }
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Unable to load scripture.');
    });
    return () => controller.abort();
  }, [passage.book, passage.chapter, attempt]);
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (section?.parentElement && beforeLoad.current?.above) section.parentElement.scrollTop += section.offsetHeight - beforeLoad.current.height;
    beforeLoad.current = null;
  }, [verses]);
  useEffect(() => {
    if (verses && selected.startVerse && chapterKey(selected) === chapterKey(passage)) {
      sectionRef.current?.querySelector(`[data-verse="${selected.startVerse}"]`)?.scrollIntoView?.({ block: 'start' });
    }
  }, [verses, selected.startVerse, selected.book, selected.chapter]);
  return <section ref={sectionRef} className="scripture-chapter" data-chapter={chapterKey(passage)} aria-label={formatPassage(passage)}>
    <h3>{formatPassage(passage)}</h3>
    {error ? <div role="alert"><p>{error}</p><button onClick={() => setAttempt(n => n + 1)}>Retry {formatPassage(passage)}</button></div>
      : verses ? <div className="scripture-verses">{verses.map(verse => {
        const highlighted = chapterKey(selected) === chapterKey(passage) && !!selected.startVerse && verse.number >= selected.startVerse && verse.number <= (selected.endVerse ?? selected.startVerse);
        return <p key={verse.number} data-verse={verse.number} className={highlighted ? 'scripture-highlight' : ''}><sup>{verse.number}</sup> {verse.text}</p>;
      })}</div> : <p role="status">Loading {formatPassage(passage)}…</p>}
  </section>;
}

export function Reader({ selection, onSelectionChange, onReflect }: ReaderProps) {
  const safeSelection = validPassage(selection) ? selection : { book: 1, chapter: 1 };
  const [chapters, setChapters] = useState<Passage[]>([safeSelection]);
  const viewport = useRef<HTMLDivElement>(null);
  const reported = useRef(chapterKey(safeSelection));
  const lastScrollTop = useRef(0);
  const anchor = useRef<{ key: string; top: number } | null>(null);
  const incomingKey = chapterKey(safeSelection);
  useEffect(() => {
    if (incomingKey !== reported.current) {
      reported.current = incomingKey;
      setChapters([{ book: safeSelection.book, chapter: safeSelection.chapter }]);
      if (viewport.current) viewport.current.scrollTop = 0;
    }
  }, [incomingKey]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (anchor.current && element) {
      const section = element.querySelector<HTMLElement>(`[data-chapter="${anchor.current.key}"]`);
      if (section) element.scrollTop += section.getBoundingClientRect().top - anchor.current.top;
      anchor.current = null;
    }
  }, [chapters]);
  function extend(direction: -1 | 1) {
    const edge = direction === 1 ? chapters[chapters.length - 1] : chapters[0];
    const next = adjacentChapter(edge, direction);
    if (!next) return;
    // Do not race repeated wheel events while the boundary chapter is still loading.
    const edgeNode = viewport.current?.querySelector(`[data-chapter="${chapterKey(edge)}"]`);
    if (direction === -1 && edgeNode?.querySelector('[role="status"]')) return;
    const visible = viewport.current?.querySelector<HTMLElement>(`[data-chapter="${reported.current}"]`);
    if (visible) anchor.current = { key: reported.current, top: visible.getBoundingClientRect().top };
    setChapters(current => {
      if (current.some(p => chapterKey(p) === chapterKey(next))) return current;
      const expanded = direction === 1 ? [...current, next] : [next, ...current];
      return direction === 1 ? expanded.slice(-9) : expanded.slice(0, 9);
    });
  }
  function handleScroll() {
    const element = viewport.current;
    if (!element) return;
    const top = element.getBoundingClientRect().top + 100;
    let current = chapters[0];
    for (const section of element.querySelectorAll<HTMLElement>('[data-chapter]')) {
      if (section.getBoundingClientRect().top <= top) {
        const [book, chapter] = section.dataset.chapter!.split(':').map(Number);
        current = { book, chapter };
      }
    }
    if (chapterKey(current) !== reported.current) {
      reported.current = chapterKey(current);
      onSelectionChange(current);
    }
    const movingUp = element.scrollTop < lastScrollTop.current;
    lastScrollTop.current = element.scrollTop;
    if (movingUp && element.scrollTop < 10) extend(-1);
    if (element.scrollTop > 0 && element.scrollHeight - element.scrollTop - element.clientHeight < 160) extend(1);
  }
  const previous = adjacentChapter(chapters[0], -1);
  const next = adjacentChapter(chapters[chapters.length - 1], 1);
  return <article className="scripture-reader" aria-label="Bible reader">
    <header className="scripture-toolbar">
      <div><span className="scripture-eyebrow">THE READING ROOM</span><h2>Scripture</h2></div>
      <div className="scripture-navigation">
        <label>Book<select value={safeSelection.book} onChange={e => onSelectionChange({ book: Number(e.target.value), chapter: 1 })}>{BOOKS.map(book => <option key={book.id} value={book.id}>{book.name}</option>)}</select></label>
        <label>Chapter<select value={safeSelection.chapter} onChange={e => onSelectionChange({ book: safeSelection.book, chapter: Number(e.target.value) })}>{Array.from({ length: BOOKS[safeSelection.book - 1].chapters }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select></label>
        <label>Translation<select value="KJV" aria-describedby="translation-availability" onChange={() => {}}><option>KJV</option><option disabled>LSB — pending</option><option disabled>NASB1995 — pending</option><option disabled>ESV — pending</option></select></label>
      </div>
      <button className="scripture-reflect" onClick={() => onReflect(safeSelection)}>Reflect on {formatPassage(safeSelection)}</button>
      <details id="translation-availability"><summary>About translations & availability</summary><p>KJV is loaded on demand from bible-api.com. Read chapters remain available in memory for this session; persistent offline downloads are not yet available. LSB, NASB1995, and ESV await source and licensing integration.</p></details>
    </header>
    <div ref={viewport} className="scripture-scroll" tabIndex={0} aria-label="Continuous scripture reading" onScroll={handleScroll} onWheel={event => { if (event.deltaY < 0 && (viewport.current?.scrollTop ?? 1) < 10) extend(-1); }}>
      {previous && <button className="scripture-boundary" onClick={() => extend(-1)}>Read preceding chapter · {formatPassage(previous)}</button>}
      {chapters.map(p => <Chapter key={chapterKey(p)} passage={p} selected={safeSelection} />)}
      {next ? <button className="scripture-boundary" onClick={() => extend(1)}>Continue reading · {formatPassage(next)}</button> : <p>End of Revelation</p>}
      <p className="scripture-attribution">King James Version · Text supplied by <a href="https://bible-api.com/" target="_blank" rel="noreferrer">bible-api.com</a></p>
    </div>
  </article>;
}
export default Reader;
