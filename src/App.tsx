import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Passage } from './domain';
import { isDesktop, nativeJournal } from './platform/journal';
import { browserJournal } from './platform/browserJournal';
import { useAppearance, type Appearance } from './platform/appearance';
import { Reader } from './scripture/Reader';
import { JournalWorkspace, type JournalPersistenceState } from './journal/JournalWorkspace';

const journal = isDesktop ? nativeJournal : browserJournal;

export function App() {
  const appearance = useAppearance();
  const [selection, setSelection] = useState<Passage>({ book: 43, chapter: 1 });
  const [reflectRequest, setReflectRequest] = useState(0);
  const [pane, setPane] = useState<'read' | 'write'>('read');
  const [notice, setNotice] = useState('');
  const [exporting, setExporting] = useState(false);
  const persistence = useRef<JournalPersistenceState | null>(null);
  const rememberPersistence = useCallback((state: JournalPersistenceState) => { persistence.current = state; }, []);

  useEffect(() => {
    if (!isDesktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested(async (event) => {
      try {
        // The Tauri listener awaits this handler before destroying the window.
        await persistence.current?.flush();
      } catch (error) {
        event.preventDefault();
        setNotice(`Your latest writing could not be saved. The journal remains open. ${String(error)}`);
      }
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; })
      .catch(() => setNotice('Close protection could not start. Wait for Draft saved before closing the app.'));
    return () => { disposed = true; unlisten?.(); };
  }, []);

  function reflect(passage: Passage) {
    setSelection(passage);
    setReflectRequest((request) => request + 1);
    setPane('write');
  }

  async function exportJournal() {
    setNotice('');
    setExporting(true);
    try {
      const directory = await invoke<string | null>('choose_export_directory');
      if (!directory) return;
      const result = await journal.exportJournal(directory);
      setNotice(result.conflicts.length
        ? `${result.written} entries exported. ${result.conflicts.length} files need attention: ${result.conflicts.join(', ')}. Existing files were preserved.`
        : `${result.written} entries exported; ${result.unchanged} already current. ${result.directory}`);
    } catch (error) {
      setNotice(`Export could not finish: ${String(error)}`);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <a className="brand" href="#" onClick={(event) => event.preventDefault()} aria-label="Scripture Journal home">
          <span className="brand-mark" aria-hidden="true">S<span>J</span></span>
          <span><strong>Scripture Journal</strong><small>A place to read &amp; reflect</small></span>
        </a>
        <div className="header-actions">
          <label className="theme-control">Appearance
            <select value={appearance.preference} onChange={event => appearance.change(event.target.value as Appearance)}>
              <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
              {appearance.supportsOmarchy && <option value="omarchy">Follow Omarchy</option>}
              {appearance.themes.map(theme => <option key={theme.id} value={`theme:${theme.id}`}>{theme.name}</option>)}
            </select>
          </label>
          <label className="theme-import">Import theme
            <input type="file" accept=".toml,text/plain" onChange={event => {
              const file = event.target.files?.[0];
              if (file) void appearance.importTheme(file);
              event.target.value = '';
            }} />
          </label>
          <span className="local-label"><i aria-hidden="true" /> {isDesktop ? 'Local journal' : 'Browser preview'}</span>
          <button className="export-button" onClick={() => void exportJournal()}
            disabled={!isDesktop || exporting}
            title={isDesktop ? 'Export finished entries to an Obsidian folder' : 'Folder export is available in the desktop app'}>
            {exporting ? 'Exporting…' : 'Export to Obsidian'}
          </button>
        </div>
      </header>
      {appearance.error && <div className="app-notice" role="status">{appearance.error}</div>}

      {!isDesktop && <div className="preview-note" role="note">
        Preview: writing stays in this browser. The desktop app saves to its own local journal database.
      </div>}

      <nav className="mobile-tabs" aria-label="Workspace">
        <button aria-pressed={pane === 'read'} onClick={() => setPane('read')}>Read</button>
        <button aria-pressed={pane === 'write'} onClick={() => setPane('write')}>Write &amp; revisit</button>
      </nav>

      {notice && <div className="app-notice" role="status">
        <span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss export notice">×</button>
      </div>}

      <main className={`workspace show-${pane}`}>
        <section className="reader-panel" aria-label="Bible reader">
          <Reader selection={selection} onSelectionChange={setSelection} onReflect={reflect} />
        </section>
        <section className="journal-panel" aria-label="Journal">
          <JournalWorkspace api={journal} passage={selection} reflectRequest={reflectRequest} onPersistenceChange={rememberPersistence} />
        </section>
      </main>
      <footer className="app-footer"><span>Scripture Journal · Early desktop preview</span><span>Read slowly. Keep what you discover.</span></footer>
    </div>
  );
}
