import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { ExportReport, Passage } from './domain';
import { isDesktop, nativeJournal } from './platform/journal';
import { browserJournal } from './platform/browserJournal';
import { useAppearance, type Appearance } from './platform/appearance';
import { Reader } from './scripture/Reader';
import { JournalWorkspace, type JournalPersistenceState } from './journal/JournalWorkspace';
import { nativePlans } from './platform/plans';
import { PlanPanel } from './plans/PlanPanel';

const journal = isDesktop ? nativeJournal : browserJournal;
type MaintainedExportStatus = { directory: string | null; lastSuccess: string | null; pending: number; conflicts: string[]; running: boolean; canceled: boolean; error: string | null };
const emptyExportStatus: MaintainedExportStatus = { directory: null, lastSuccess: null, pending: 0, conflicts: [], running: false, canceled: false, error: null };

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
  const [exportStatus, setExportStatus] = useState<MaintainedExportStatus>(emptyExportStatus);
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

  const refreshExportStatus = useCallback(async () => {
    if (!isDesktop) return;
    const status = await invoke<MaintainedExportStatus | undefined>('maintained_export_status');
    if (status) setExportStatus(status);
  }, []);

  const runMaintainedExport = useCallback(async () => {
    if (!isDesktop) return;
    setExporting(true);
    try {
      const result = await invoke<ExportReport | null>('run_maintained_export');
      if (result?.conflicts.length) setNotice(`${result.conflicts.length} managed files need attention. Existing files were preserved.`);
    } catch (error) { setNotice(`Maintained export could not finish: ${String(error)}`); }
    finally { setExporting(false); await refreshExportStatus().catch(() => undefined); }
  }, [refreshExportStatus]);

  useEffect(() => {
    if (!isDesktop) return;
    void refreshExportStatus().catch(() => undefined);
    const timer = window.setInterval(() => { void runMaintainedExport().catch(() => undefined); }, 30_000);
    return () => window.clearInterval(timer);
  }, [refreshExportStatus, runMaintainedExport]);

  function reflect(passage: Passage) {
    setSelection(passage);
    setReflectRequest((request) => request + 1);
    setPane('write');
  }

  async function exportJournal() {
    setNotice('');
    setExporting(true);
    try {
      if (exportStatus.directory && !window.confirm(`Change the maintained export folder?\n\nCurrent: ${exportStatus.directory}\n\nThe old folder will remain untouched.`)) return;
      const directory = await invoke<string | null>('choose_export_directory');
      if (!directory) return;
      const result = await invoke<ExportReport | null>('run_maintained_export');
      if (!result) return;
      setNotice(result.conflicts.length
        ? `${result.written} entries exported. ${result.conflicts.length} files need attention: ${result.conflicts.join(', ')}. Existing files were preserved.`
        : `${result.written} entries exported; ${result.unchanged} already current. ${result.directory}`);
    } catch (error) {
      setNotice(`Export could not finish: ${String(error)}`);
    } finally {
      setExporting(false);
      await refreshExportStatus().catch(() => undefined);
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
          {exportStatus.directory && <button className="export-button" disabled={exporting} onClick={() => void runMaintainedExport()}>Retry export</button>}
          {exportStatus.running && <button className="export-button" onClick={() => void invoke('cancel_maintained_export').then(refreshExportStatus)}>Cancel</button>}
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
      {isDesktop && exportStatus.directory && <div className="preview-note" role="status">
        Maintained export: {exportStatus.pending} pending · {exportStatus.conflicts.length} conflicts
        {exportStatus.lastSuccess ? ` · last success ${new Date(exportStatus.lastSuccess).toLocaleString()}` : ' · awaiting first success'}
        {exportStatus.error ? ` · ${exportStatus.error}` : ''}
        <button onClick={() => void invoke('disconnect_maintained_export').then(refreshExportStatus)}>Stop maintaining</button>
      </div>}

      <main className={`workspace show-${pane}`}>
        <section className="reader-panel" aria-label="Bible reader">
          <Reader selection={selection} onSelectionChange={setSelection} onReflect={reflect} />
        </section>
        <section className="journal-panel" aria-label="Journal">
          <PlanPanel api={isDesktop ? nativePlans : undefined} />
          <JournalWorkspace api={journal} passage={selection} reflectRequest={reflectRequest} onPersistenceChange={rememberPersistence} />
        </section>
      </main>
      <footer className="app-footer"><span>Scripture Journal · Early desktop preview</span><span>Read slowly. Keep what you discover.</span></footer>
    </div>
  );
}
