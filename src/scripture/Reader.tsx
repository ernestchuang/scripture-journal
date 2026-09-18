import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Passage } from '../domain';
import { adjacentChapter, BOOKS, chapterKey, formatPassage, validPassage } from './books';
import { downloadKjv, invalidateKjvCache, kjvOfflineStatus, loadChapter, type Translation, type Verse } from './provider';
import { isDesktop } from '../platform/journal';
import './reader.css';

export interface ReaderProps {
  selection: Passage;
  onSelectionChange: (passage: Passage) => void;
  onReflect: (passage: Passage) => void;
}
function Chapter({ passage, selected, translation, generation, onAnchorRestored }: { passage: Passage; selected: Passage; translation: Translation; generation: number; onAnchorRestored: () => void }) {
  const sectionRef = useRef<HTMLElement>(null);
  const beforeLoad = useRef<{ height: number; above: boolean } | null>(null);
  const [verses, setVerses] = useState<Verse[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    loadChapter(passage, controller.signal, translation).then(result => {
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
  }, [passage.book, passage.chapter, translation, attempt, generation]);
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (section?.parentElement && beforeLoad.current?.above) section.parentElement.scrollTop += section.offsetHeight - beforeLoad.current.height;
    beforeLoad.current = null;
  }, [verses]);
  useEffect(() => {
    if (verses && selected.startVerse && chapterKey(selected) === chapterKey(passage)) {
      sectionRef.current?.querySelector(`[data-verse="${selected.startVerse}"]`)?.scrollIntoView?.({ block: 'start' });
      onAnchorRestored();
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
  const [translation, setTranslation] = useState<Translation>(() => {
    try {
      const saved = window.localStorage?.getItem('scripture-journal.translation');
      return saved && ['KJV', 'LSB', 'NASB1995', 'ESV'].includes(saved) ? saved as Translation : 'KJV';
    } catch { return 'KJV'; }
  });
  const [offline, setOffline] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [libraryGeneration, setLibraryGeneration] = useState(0);
  const restoringTranslation = useRef(false);
  const viewport = useRef<HTMLDivElement>(null);
  const reported = useRef(chapterKey(safeSelection));
  const lastScrollTop = useRef(0);
  const anchor = useRef<{ key: string; top: number } | null>(null);
  const incomingKey = chapterKey(safeSelection);
  useEffect(() => { void kjvOfflineStatus().then(setOffline).catch(() => setOffline(false)); }, []);
  function changeTranslation(value: Translation) {
    const element = viewport.current;
    const top = element?.getBoundingClientRect().top ?? 0;
    const verse = element && [...element.querySelectorAll<HTMLElement>('[data-verse]')].find(node => node.getBoundingClientRect().bottom > top + 1);
    const section = verse?.closest<HTMLElement>('[data-chapter]');
    if (verse && section) {
      const [book, chapter] = section.dataset.chapter!.split(':').map(Number);
      restoringTranslation.current = true;
      setChapters([{ book, chapter }]);
      onSelectionChange({ book, chapter, startVerse: Number(verse.dataset.verse) });
    }
    setTranslation(value); try { window.localStorage?.setItem('scripture-journal.translation', value); } catch { /* Selection remains active for this session. */ }
  }
  async function installKjv() {
    setDownloading(true); setDownloadError('');
    try { await downloadKjv(); invalidateKjvCache(); setOffline(true); setLibraryGeneration(value => value + 1); }
    catch (error) { setDownloadError(error instanceof Error ? error.message : String(error)); }
    finally { setDownloading(false); }
  }
  useEffect(() => {
    const element = viewport.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let width = element.clientWidth;
    let height = element.clientHeight;
    let saved: { verse: HTMLElement; top: number } | null = null;
    const capture = () => {
      // A resize may dispatch scroll before ResizeObserver. Keep the anchor from
      // the old layout until the observer has compensated for the new one.
      if (!element.clientWidth || element.clientWidth !== width || element.clientHeight !== height) return;
      const top = element.getBoundingClientRect().top;
      const verse = [...element.querySelectorAll<HTMLElement>('[data-verse]')]
        .find(node => node.getBoundingClientRect().bottom > top + 1);
      saved = verse ? { verse, top: verse.getBoundingClientRect().top - top } : null;
    };
    const observer = new ResizeObserver(() => {
      if (!element.clientWidth || !element.clientHeight) return;
      const changed = width !== element.clientWidth || height !== element.clientHeight;
      width = element.clientWidth;
      height = element.clientHeight;
      if (changed && saved && element.contains(saved.verse)) {
        element.scrollTop += saved.verse.getBoundingClientRect().top
          - element.getBoundingClientRect().top - saved.top;
      }
      capture();
    });
    element.addEventListener('scroll', capture);
    observer.observe(element);
    return () => { observer.disconnect(); element.removeEventListener('scroll', capture); };
  }, []);
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
    if (restoringTranslation.current) return;
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
        <label>Translation<select value={translation} aria-describedby="translation-availability" onChange={e => changeTranslation(e.target.value as Translation)}><option value="KJV">KJV</option><option value="LSB">LSB</option><option value="NASB1995">NASB1995</option><option value="ESV">ESV</option></select></label>
      </div>
      <button className="scripture-reflect" onClick={() => onReflect(safeSelection)}>Reflect on {formatPassage(safeSelection)}</button>
      <details id="translation-availability"><summary>About translations &amp; availability</summary><p>KJV is public domain and can be stored offline from eBible.org. LSB, NASB1995, and ESV require an authorized scripture pack; selecting one keeps your place and explains when its text is unavailable.</p>{isDesktop && <button disabled={downloading} onClick={() => void installKjv()}>{downloading ? 'Downloading KJV…' : offline ? 'Refresh offline KJV' : 'Download KJV for offline reading'}</button>}{downloadError && <p role="alert">{downloadError}</p>}</details>
    </header>
    <div ref={viewport} className="scripture-scroll" tabIndex={0} aria-label="Continuous scripture reading" onScroll={handleScroll} onWheel={event => { if (event.deltaY < 0 && (viewport.current?.scrollTop ?? 1) < 10) extend(-1); }}>
      {previous && <button className="scripture-boundary" onClick={() => extend(-1)}>Read preceding chapter · {formatPassage(previous)}</button>}
      {chapters.map(p => <Chapter key={`${translation}:${chapterKey(p)}`} passage={p} selected={safeSelection} translation={translation} generation={libraryGeneration} onAnchorRestored={() => { restoringTranslation.current = false; }} />)}
      {next ? <button className="scripture-boundary" onClick={() => extend(1)}>Continue reading · {formatPassage(next)}</button> : <p>End of Revelation</p>}
      <p className="scripture-attribution">{translation === 'KJV' ? <>King James Version · Public-domain offline package from <a href="https://ebible.org/details.php?id=eng-kjv2006" target="_blank" rel="noreferrer">eBible.org</a>; online fallback by bible-api.com.</> : `${translation} · authorized pack required`}</p>
    </div>
  </article>;
}
export default Reader;
