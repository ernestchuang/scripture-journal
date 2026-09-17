import { useEffect, useRef, useState } from 'react';
import { blankContent, type Entry, type EntryContent, type Passage, type Revision } from '../domain';
import type { JournalApi } from '../platform/journal';
import { SaveCoordinator } from './saveCoordinator';
import './journal.css';

const books = ['Genesis','Exodus','Leviticus','Numbers','Deuteronomy','Joshua','Judges','Ruth','1 Samuel','2 Samuel','1 Kings','2 Kings','1 Chronicles','2 Chronicles','Ezra','Nehemiah','Esther','Job','Psalms','Proverbs','Ecclesiastes','Song of Solomon','Isaiah','Jeremiah','Lamentations','Ezekiel','Daniel','Hosea','Joel','Amos','Obadiah','Jonah','Micah','Nahum','Habakkuk','Zephaniah','Haggai','Zechariah','Malachi','Matthew','Mark','Luke','John','Acts','Romans','1 Corinthians','2 Corinthians','Galatians','Ephesians','Philippians','Colossians','1 Thessalonians','2 Thessalonians','1 Timothy','2 Timothy','Titus','Philemon','Hebrews','James','1 Peter','2 Peter','1 John','2 John','3 John','Jude','Revelation'];
const passageLabel = (p: Passage) => `${books[p.book - 1] ?? `Book ${p.book}`} ${p.chapter}${p.startVerse ? `:${p.startVerse}${p.endVerse && p.endVerse !== p.startVerse ? `–${p.endVerse}` : ''}` : ''}`;
const title = (entry: Entry) => entry.content.title.trim() || 'Untitled reflection';
const date = (value: string) => new Date(value).toLocaleString();

export interface JournalPersistenceState {
  pending: boolean;
  flush: () => Promise<void>;
}
export interface JournalWorkspaceProps {
  api: JournalApi;
  passage: Passage;
  reflectRequest: number;
  /** Native close handler must await flush and cancel closing if it rejects. */
  onPersistenceChange?: (state: JournalPersistenceState) => void;
}

export function JournalWorkspace({ api, passage, reflectRequest, onPersistenceChange }: JournalWorkspaceProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [query, setQuery] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [operationError, setOperationError] = useState('');
  const [busy, setBusy] = useState(false);
  const [, redraw] = useState(0);
  const [history, setHistory] = useState<Revision[] | null>(null);
  const [inspected, setInspected] = useState<Revision | null>(null);
  const [linkSelection, setLinkSelection] = useState('');
  const sessionRef = useRef<SaveCoordinator | null>(null);
  const committedEntries = useRef(new Map<string, Entry>());
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const mounted = useRef(true);
  const lastReflect = useRef(0);
  const session = sessionRef.current;
  const content = session?.content;
  const generation = session?.generation;

  useEffect(() => {
    mounted.current = true;
    let active = true;
    api.listEntries().then(items => {
      if (!active) return;
      setEntries(current => {
        const merged = new Map(items.map(entry => [entry.id, entry]));
        current.forEach(entry => merged.set(entry.id, entry));
        return [...merged.values()];
      });
      setLoaded(true);
    }).catch(error => { if (active) setLoadError(String(error)); });
    return () => { active = false; mounted.current = false; };
  }, [api]);

  const refresh = () => {
    const current = sessionRef.current;
    onPersistenceChange?.({
      pending: !!current && (current.dirty || current.status === 'saving'),
      flush: async () => { await queueRef.current; await sessionRef.current?.flush(); },
    });
    if (mounted.current) redraw(value => value + 1);
  };
  const committed = (entry: Entry) => {
    committedEntries.current.set(entry.id, entry);
    if (mounted.current) setEntries(items => [entry, ...items.filter(item => item.id !== entry.id)]);
  };
  const open = (entry?: Entry, passages: Passage[] = []) => {
    if (entry) entry = committedEntries.current.get(entry.id) ?? entry;
    sessionRef.current = new SaveCoordinator(entry?.id ?? crypto.randomUUID(), api,
      entry?.content ?? blankContent(structuredClone(passages)), entry, refresh, committed);
    setHistory(null); setInspected(null); setLinkSelection(''); setOperationError(''); refresh();
  };

  // Keep this component mounted when changing reader/journal layout tabs.
  // Every navigation awaits all pending saves; failed saves keep the editor intact.
  const navigate = (action: () => void | Promise<void>, flush = true) => {
    const work = queueRef.current.catch(() => undefined).then(async () => {
      setBusy(true); setOperationError('');
      try { if (flush) await sessionRef.current?.flush(); await action(); }
      catch (error) { setOperationError(String(error)); }
      finally { setBusy(false); }
    });
    queueRef.current = work;
  };

  useEffect(() => {
    if (reflectRequest <= lastReflect.current) return;
    lastReflect.current = reflectRequest;
    const captured = structuredClone(passage);
    navigate(() => open(undefined, [captured]));
  }, [reflectRequest]);

  useEffect(() => {
    if (!session || !session.dirty || session.status === 'error') return;
    const timer = window.setTimeout(() => { void session.flush().catch(() => undefined); }, 600);
    return () => window.clearTimeout(timer);
  }, [session, generation]);

  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (sessionRef.current?.dirty || sessionRef.current?.status === 'saving') { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, []);

  const edit = (patch: Partial<EntryContent>) => {
    if (session && !busy) session.update({ ...session.content, ...patch });
  };
  const finish = () => {
    navigate(async () => {
      await sessionRef.current?.flush(true);
      setHistory(null); setInspected(null);
    }, false);
  };
  const showHistory = () => navigate(async () => {
    const current = sessionRef.current;
    if (current) { setHistory(await api.getHistory(current.id)); setInspected(null); }
  });
  const restore = (revision: Revision) => navigate(async () => {
    const current = sessionRef.current;
    if (!current?.revisionId) return;
    const restored = await api.restoreRevision(current.id, revision.id, current.revisionId);
    committed(restored); open(restored);
  });
  const matches = entries.filter(entry => {
    const needle = query.trim().toLowerCase();
    return `${entry.content.title} ${entry.content.body} ${entry.content.tags.join(' ')} ${entry.content.passages.map(passageLabel).join(' ')}`.toLowerCase().includes(needle);
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const backlinks = session ? entries.filter(entry => entry.id !== session.id && entry.content.links.includes(session.id)) : [];

  return <section className="journal-workspace" aria-label="Journal">
    <header className="journal-heading">
      <div><span className="journal-eyebrow">YOUR REFLECTIONS</span><h2>Journal</h2></div>
      <button onClick={() => navigate(() => open())} disabled={busy}>New blank entry</button>
    </header>
    {loadError && <div role="alert" className="journal-error">Could not load your journal: {loadError}
      <button onClick={() => { setLoadError(''); api.listEntries().then(items => { setEntries(items); setLoaded(true); }).catch(error => setLoadError(String(error))); }}>Retry loading</button>
    </div>}
    <label className="journal-search">Find a reflection<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Words, tags, or passages" /></label>
    <nav className="journal-entry-list" aria-label="Journal entries">
      {!loaded && !loadError && <p>Loading your journal…</p>}
      {loaded && matches.length === 0 && <p>{query ? 'No matching reflections.' : 'Your reflections will appear here.'}</p>}
      {matches.map(entry => <button key={entry.id} aria-current={session?.id === entry.id ? 'true' : undefined} disabled={busy} onClick={() => navigate(() => open(entry))}>
        <strong>{title(entry)}</strong><span>{entry.content.passages.map(passageLabel).join(' · ') || 'Personal reflection'}</span>
        <small>{entry.publishedRevisionId === entry.workingRevisionId ? 'Finished' : 'Draft'} · {date(entry.updatedAt)}</small>
      </button>)}
    </nav>
    {operationError && <p role="alert" className="journal-error">Action could not finish. Your current writing is still here. {operationError}</p>}
    {!session || !content ? <div className="journal-empty"><h3>A place to pause and reflect</h3><p>Choose Reflect in the reader to begin with that passage, or start a blank entry.</p></div> : <div className="journal-editor">
      <div className="journal-save-row"><span role="status" aria-live="polite">{session.status === 'saving' ? 'Saving…' : session.status === 'finished' ? 'Finished' : session.status === 'saved' ? 'Draft saved' : session.status === 'error' ? 'Save failed — draft remains open' : 'Unsaved changes'}</span>
        <button disabled={busy} onClick={finish}>Finish entry</button>
      </div>
      {session.status === 'error' && <div role="alert" className="journal-error">{session.error}<button disabled={busy} onClick={() => navigate(() => undefined)}>Retry save</button></div>}
      <fieldset disabled={busy} className="journal-fields">
        <label>Title<input value={content.title} onChange={event => edit({ title: event.target.value })} placeholder="Give this reflection a title" /></label>
        <div className="journal-passages"><span>Connected passages</span>
          {content.passages.length === 0 && <small>No passage attached.</small>}
          {content.passages.map((item, index) => <span className="journal-chip" key={JSON.stringify(item)}>{passageLabel(item)}<button aria-label={`Remove ${passageLabel(item)}`} onClick={() => edit({ passages: content.passages.filter((_, i) => i !== index) })}>×</button></span>)}
          <button onClick={() => { if (!content.passages.some(item => JSON.stringify(item) === JSON.stringify(passage))) edit({ passages: [...content.passages, structuredClone(passage)] }); }}>Add current passage: {passageLabel(passage)}</button>
        </div>
        <label>Reflection <small>Markdown supported</small><textarea value={content.body} onChange={event => edit({ body: event.target.value })} placeholder="What stands out to you?" rows={14} /></label>
        <label>Tags <small>Separate with commas</small><input value={content.tags.join(', ')} onChange={event => edit({ tags: event.target.value.split(',').map(tag => tag.trimStart()) })} /></label>
        <div className="journal-links"><label htmlFor="journal-link-picker">Connect another entry</label>
          <div className="journal-inline"><select id="journal-link-picker" value={linkSelection} onChange={event => setLinkSelection(event.target.value)}><option value="">Choose a reflection</option>{entries.filter(entry => entry.id !== session.id && !content.links.includes(entry.id)).map(entry => <option key={entry.id} value={entry.id}>{title(entry)}</option>)}</select>
            <button disabled={!linkSelection} onClick={() => { edit({ links: [...content.links, linkSelection] }); setLinkSelection(''); }}>Connect</button></div>
          <ul>{content.links.map(id => { const entry = entries.find(item => item.id === id); return <li key={id}>{entry ? <button onClick={() => navigate(() => open(entry))}>{title(entry)}</button> : <span>Unavailable entry ({id})</span>}<button aria-label={`Remove connection to ${entry ? title(entry) : id}`} onClick={() => edit({ links: content.links.filter(link => link !== id) })}>Remove</button></li>; })}</ul>
        </div>
      </fieldset>
      <div className="journal-backlinks"><h3>Referenced by</h3>{backlinks.length ? <ul>{backlinks.map(entry => <li key={entry.id}><button disabled={busy} onClick={() => navigate(() => open(entry))}>{title(entry)}</button></li>)}</ul> : <p>No other entries link here yet.</p>}</div>
      <button disabled={busy} onClick={showHistory}>View revision history</button>
      {history && <section className="journal-history" aria-label="Revision history"><h3>Revision history</h3><p>Restoring creates a new version. Earlier versions are kept.</p>
        <ol>{history.map((revision, index) => <li key={revision.id}><button onClick={() => setInspected(revision)}>Version {history.length - index} · {date(revision.createdAt)}</button>{revision.id === session.revisionId && <small> Current</small>}</li>)}</ol>
        {inspected && <article><h4>{inspected.content.title || 'Untitled reflection'}</h4><p>{inspected.content.passages.map(passageLabel).join(' · ')}</p><pre>{inspected.content.body || '(Blank reflection)'}</pre><p>Tags: {inspected.content.tags.join(', ') || 'None'}</p><p>Connections: {inspected.content.links.map(id => entries.find(entry => entry.id === id)?.content.title || id).join(', ') || 'None'}</p><button disabled={busy || inspected.id === session.revisionId} onClick={() => restore(inspected)}>Restore this version</button></article>}
      </section>}
    </div>}
  </section>;
}
