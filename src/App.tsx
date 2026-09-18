import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Passage } from './domain';
import { isDesktop, nativeJournal } from './platform/journal';
import { browserJournal } from './platform/browserJournal';
import { useAppearance, type Appearance } from './platform/appearance';
import { Reader } from './scripture/Reader';
import { JournalWorkspace, type JournalPersistenceState } from './journal/JournalWorkspace';
import { nativePlans } from './platform/plans';
import { PlanPanel } from './plans/PlanPanel';
import { LegacyImportPanel } from './migration/LegacyImportPanel';
import { nativeLegacyImport } from './platform/legacyImport';

const journal = isDesktop ? nativeJournal : browserJournal;
const portablePreferenceKeys = [
  'scripture-journal.appearance',
  'scripture-journal.custom-themes',
  'scripture-journal.reader-location',
  'scripture-journal.translation',
] as const;
type RestoreOutcome = { notice?: string | null; preferences: Record<string, string> };

export function App() {
  const appearance = useAppearance();
  const [selection, setSelection] = useState<Passage>(() => {
    try {
      const saved = JSON.parse(window.localStorage?.getItem('scripture-journal.reader-location') ?? 'null') as Passage | null;
      return saved && Number.isInteger(saved.book) && Number.isInteger(saved.chapter) ? saved : { book: 43, chapter: 1 };
    } catch { return { book: 43, chapter: 1 }; }
  });
  const [reflectRequest, setReflectRequest] = useState(0);
  const [pane, setPane] = useState<'read' | 'write'>('read');
  const [notice, setNotice] = useState('');
  const [exporting, setExporting] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [restoredPreferences, setRestoredPreferences] = useState<Record<string, string>>({});
  const [journalRefresh, setJournalRefresh] = useState(0);
  const persistence = useRef<JournalPersistenceState | null>(null);
  const rememberPersistence = useCallback((state: JournalPersistenceState) => { persistence.current = state; }, []);
  useEffect(() => { try { window.localStorage?.setItem('scripture-journal.reader-location', JSON.stringify(selection)); } catch { /* Reading remains usable without preference storage. */ } }, [selection]);

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

  useEffect(() => {
    if (!isDesktop) return;
    void invoke<RestoreOutcome>('startup_restore_outcome').then(outcome => {
      if (!outcome) return;
      if (outcome.notice) setNotice(outcome.notice);
      setRestoredPreferences(outcome.preferences ?? {});
    }).catch(error => setNotice(`Restore status could not be read. ${String(error)}`));
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
  async function backup(command: 'create_full_backup' | 'stage_full_restore') {
    setBackupBusy(true); setNotice('');
    try {
      await persistence.current?.flush();
      let result: string | null;
      if (command === 'stage_full_restore') {
        const directory = await invoke<string | null>('choose_restore_backup');
        if (!directory || !window.confirm(`Replace the current journal from this backup after restart?\n\n${directory}\n\nA pre-restore backup will be created first.`)) return;
        result = await invoke<string>('stage_full_restore', { directory });
      } else {
        const preferences = Object.fromEntries(portablePreferenceKeys.flatMap(key => {
          const value = localStorage.getItem(key);
          return value === null ? [] : [[key, value]];
        }));
        result = await invoke<string | null>(command, { preferences });
      }
      if (result) setNotice(command === 'create_full_backup' ? `Full backup created: ${result}` : result);
    } catch (error) { setNotice(`Backup operation failed; the current journal was not replaced. ${String(error)}`); }
    finally { setBackupBusy(false); }
  }

  async function applyRestoredPreferences() {
    try {
      await persistence.current?.flush();
      for (const key of portablePreferenceKeys) {
        const value = restoredPreferences[key];
        if (value !== undefined) localStorage.setItem(key, value);
      }
      await invoke('acknowledge_restored_preferences');
      window.location.reload();
    } catch (error) {
      setNotice(`Restored preferences could not be applied. They remain available to retry. ${String(error)}`);
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
          <button className="export-button" disabled={!isDesktop || backupBusy} onClick={() => void backup('create_full_backup')}>Full backup</button>
          <button className="export-button" disabled={!isDesktop || backupBusy} onClick={() => void backup('stage_full_restore')}>Restore backup</button>
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
        <span>{notice}</span>
        {Object.keys(restoredPreferences).length > 0 && <button onClick={() => void applyRestoredPreferences()}>Apply restored appearance/reading preferences</button>}
        <button onClick={() => setNotice('')} aria-label="Dismiss export notice">×</button>
      </div>}

      <main className={`workspace show-${pane}`}>
        <section className="reader-panel" aria-label="Bible reader">
          <Reader selection={selection} onSelectionChange={setSelection} onReflect={reflect} />
        </section>
        <section className="journal-panel" aria-label="Journal">
          <PlanPanel api={isDesktop ? nativePlans : undefined} />
          <LegacyImportPanel api={isDesktop ? nativeLegacyImport : undefined} onImported={() => setJournalRefresh(value => value + 1)} />
          <JournalWorkspace api={journal} passage={selection} reflectRequest={reflectRequest} refreshRequest={journalRefresh} onPersistenceChange={rememberPersistence} />
        </section>
      </main>
      <footer className="app-footer"><span>Scripture Journal · Early desktop preview</span><span>Read slowly. Keep what you discover.</span></footer>
    </div>
  );
}
