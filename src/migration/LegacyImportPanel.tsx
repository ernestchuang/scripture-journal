import { useEffect, useRef, useState } from 'react';
import type { LegacyImportApi, LegacyImportPreview, LegacyImportResult } from '../platform/legacyImport';
import './legacy-import.css';

export function LegacyImportPanel({ api }: { api?: LegacyImportApi }) {
  const [open, setOpen] = useState(false);
  const [directory, setDirectory] = useState('');
  const [preview, setPreview] = useState<LegacyImportPreview>();
  const [result, setResult] = useState<LegacyImportResult>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; request.current += 1; }, []);

  async function choose() {
    if (!api || busy) return;
    const current = ++request.current;
    setBusy(true); setError(''); setResult(undefined); setPreview(undefined);
    try {
      const selected = await api.chooseDirectory();
      if (!mounted.current || current !== request.current || !selected) return;
      setDirectory(selected);
      const inspected = await api.preview(selected);
      if (!mounted.current || current !== request.current) return;
      setPreview(inspected);
    } catch (cause) {
      if (mounted.current && current === request.current) setError(String(cause));
    } finally {
      if (mounted.current && current === request.current) setBusy(false);
    }
  }

  async function confirm() {
    if (!api || !preview || busy) return;
    const current = ++request.current;
    const confirmedPreview = preview;
    setBusy(true); setError('');
    try {
      const imported = await api.confirm(directory, confirmedPreview.previewId);
      if (!mounted.current || current !== request.current) return;
      setResult(imported);
      const refreshed = await api.preview(directory);
      if (!mounted.current || current !== request.current) return;
      setPreview(refreshed);
    } catch (cause) {
      if (mounted.current && current === request.current) setError(String(cause));
    } finally {
      if (mounted.current && current === request.current) setBusy(false);
    }
  }

  return <aside className="legacy-import" aria-label="Import an old journal">
    <button type="button" className="legacy-import-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      Import old Bible Reading Plans journal
    </button>
    {open && <div className="legacy-import-body">
      <p>This reads the folder you choose and shows a preview. It does not change the old files.</p>
      <button type="button" onClick={() => void choose()} disabled={!api || busy}>{busy && !preview ? 'Reading…' : 'Choose old journal folder'}</button>
      {!api && <p>Legacy import is available in the desktop app.</p>}
      {error && <p role="alert">Import could not continue: {error}</p>}
      {preview && <>
        <p role="status"><strong>{preview.recognized}</strong> new, <strong>{preview.changed}</strong> changed, <strong>{preview.unchanged}</strong> already imported, <strong>{preview.unsupported}</strong> unsupported. {preview.unresolvedLinks} unresolved links.</p>
        {preview.changed > 0 && <p>Changed files will become new revisions of the same journal entries.</p>}
        <ul>{preview.records.map(record => <li key={record.relativePath}>
          <strong>{record.title ?? record.relativePath}</strong> — {record.status}
          {record.warnings.map(warning => <span key={warning}> · {warning}</span>)}
          {record.unresolvedLinks.length > 0 && <span> · unresolved: {record.unresolvedLinks.join(', ')}</span>}
        </li>)}</ul>
        {(preview.recognized > 0 || preview.changed > 0) && <button type="button" onClick={() => void confirm()} disabled={busy}>
          {busy ? 'Importing…' : `Confirm import of ${preview.recognized + preview.changed} file${preview.recognized + preview.changed === 1 ? '' : 's'}`}
        </button>}
      </>}
      {result && <p role="status">Import complete: {result.imported} new entries, {result.revisionsCreated - result.imported} new revisions, {result.unchanged} unchanged.</p>}
    </div>}
  </aside>;
}
