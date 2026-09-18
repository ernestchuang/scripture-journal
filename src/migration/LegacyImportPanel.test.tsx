// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LegacyImportPanel } from './LegacyImportPanel';
import type { LegacyImportApi, LegacyImportPreview } from '../platform/legacyImport';

const initial: LegacyImportPreview = {
  sourceSetId: 'source', previewId: 'snapshot-one', sourceRoot: '/old', recognized: 1,
  changed: 1, unchanged: 2, unsupported: 1, unresolvedLinks: 1,
  records: [
    { relativePath: 'new.md', status: 'new', title: 'New note', date: '2026-01-02', warnings: [], unresolvedLinks: ['missing'] },
    { relativePath: 'changed.md', status: 'changed', title: 'Changed note', date: '2026-01-03', warnings: ['Unknown frontmatter retained in provenance'], unresolvedLinks: [] },
  ],
};

afterEach(cleanup);

describe('LegacyImportPanel', () => {
  it('requires a preview and explicit confirmation, then refreshes the read-only status', async () => {
    const api: LegacyImportApi = {
      chooseDirectory: vi.fn().mockResolvedValue('/old'),
      preview: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce({ ...initial, recognized: 0, changed: 0, unchanged: 4 }),
      confirm: vi.fn().mockResolvedValue({ imported: 1, revisionsCreated: 2, unchanged: 2, unsupported: 1 }),
    };
    render(<LegacyImportPanel api={api} />);
    fireEvent.click(screen.getByRole('button', { name: /import old bible/i }));
    expect(api.chooseDirectory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /choose old journal/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/1 new, 1 changed, 2 already imported/i));
    expect(api.confirm).not.toHaveBeenCalled();
    expect(screen.getByText(/changed files will become new revisions/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /confirm import of 2 files/i }));
    await screen.findByText(/import complete: 1 new entries, 1 new revisions/i);
    expect(api.confirm).toHaveBeenCalledWith('/old', 'snapshot-one');
    await waitFor(() => expect(screen.queryByRole('button', { name: /confirm import/i })).toBeNull());
  });

  it('does not confirm a stale preview after the chosen source changes', async () => {
    const api: LegacyImportApi = {
      chooseDirectory: vi.fn().mockResolvedValue('/old'),
      preview: vi.fn().mockResolvedValue(initial),
      confirm: vi.fn().mockRejectedValue('Legacy source changed since preview; preview it again'),
    };
    render(<LegacyImportPanel api={api} />);
    fireEvent.click(screen.getByRole('button', { name: /import old bible/i }));
    fireEvent.click(screen.getByRole('button', { name: /choose old journal/i }));
    await screen.findByRole('button', { name: /confirm import/i });
    fireEvent.click(screen.getByRole('button', { name: /confirm import/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/preview it again/i);
    expect((screen.getByRole('button', { name: /confirm import/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});
