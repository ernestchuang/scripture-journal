// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entry, SaveRequest } from '../domain';
import type { JournalApi } from '../platform/journal';
import { JournalWorkspace } from './JournalWorkspace';

afterEach(cleanup);
const fakeApi = (): JournalApi => ({
  listEntries: vi.fn(async () => []),
  saveEntry: vi.fn(async (request: SaveRequest): Promise<Entry> => ({
    id: request.entryId, createdAt: '2026-09-17T00:00:00Z', updatedAt: '2026-09-17T00:00:00Z',
    workingRevisionId: 'r1', publishedRevisionId: request.finish ? 'r1' : null, content: request.content,
  })),
  getHistory: vi.fn(async () => []), restoreRevision: vi.fn(), exportJournal: vi.fn(),
});

describe('journal workspace', () => {
  it('does not create an entry on mount and pins reflection to its original passage', async () => {
    const api = fakeApi();
    const { rerender } = render(<JournalWorkspace api={api} passage={{ book: 43, chapter: 3 }} reflectRequest={0} />);
    await screen.findByText('Your reflections will appear here.');
    expect(screen.queryByLabelText(/Reflection Markdown/)).toBeNull();
    expect(api.saveEntry).not.toHaveBeenCalled();
    rerender(<JournalWorkspace api={api} passage={{ book: 43, chapter: 3 }} reflectRequest={1} />);
    await screen.findByLabelText(/Reflection Markdown/);
    rerender(<JournalWorkspace api={api} passage={{ book: 43, chapter: 4 }} reflectRequest={1} />);
    expect(screen.getByRole('button', { name: 'Remove John 3' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove John 4' })).toBeNull();
    fireEvent.change(screen.getByLabelText(/Reflection Markdown/), { target: { value: 'A reflection' } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish entry' }));
    await waitFor(() => expect(api.saveEntry).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveEntry).mock.calls[0][0]).toMatchObject({ finish: true, content: { body: 'A reflection', passages: [{ book: 43, chapter: 3 }] } });
  });

  it('does not navigate away after a failed save and permits retry', async () => {
    const api = fakeApi();
    vi.mocked(api.saveEntry).mockRejectedValueOnce(new Error('Storage unavailable'));
    render(<JournalWorkspace api={api} passage={{ book: 1, chapter: 1 }} reflectRequest={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'New blank entry' }));
    const editor = await screen.findByLabelText(/Reflection Markdown/);
    fireEvent.change(editor, { target: { value: 'Do not lose me' } });
    fireEvent.click(screen.getByRole('button', { name: 'New blank entry' }));
    await screen.findByText('Save failed — draft remains open');
    expect((screen.getByLabelText(/Reflection Markdown/) as HTMLTextAreaElement).value).toBe('Do not lose me');
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await screen.findByText('Draft saved');
    expect((screen.getByLabelText(/Reflection Markdown/) as HTMLTextAreaElement).value).toBe('Do not lose me');
  });

  it('exposes a close flush that persists the current draft', async () => {
    const api = fakeApi();
    let persistence: { flush: () => Promise<void> } | undefined;
    render(<JournalWorkspace api={api} passage={{ book: 43, chapter: 3 }} reflectRequest={0}
      onPersistenceChange={state => { persistence = state; }} />);
    fireEvent.click(screen.getByRole('button', { name: 'New blank entry' }));
    const editor = await screen.findByLabelText(/Reflection Markdown/);
    fireEvent.change(editor, { target: { value: 'Close-safe draft' } });
    expect(persistence).toBeDefined();
    await persistence!.flush();
    expect(api.saveEntry).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.saveEntry).mock.calls[0][0]).toMatchObject({
      finish: false,
      content: { body: 'Close-safe draft' },
    });
  });

  it('keeps edits after a failed Finish unpublished until Finish is clicked again', async () => {
    const api = fakeApi();
    let persistence: { flush: () => Promise<void> } | undefined;
    vi.mocked(api.saveEntry)
      .mockRejectedValueOnce(new Error('Storage unavailable'))
      .mockImplementation(async (request: SaveRequest) => ({
        id: request.entryId, createdAt: '2026-09-17T00:00:00Z', updatedAt: '2026-09-17T00:00:00Z',
        workingRevisionId: request.finish ? 'published' : 'later-draft',
        publishedRevisionId: request.finish ? 'published' : null,
        content: request.content,
      }));
    render(<JournalWorkspace api={api} passage={{ book: 43, chapter: 3 }} reflectRequest={0}
      onPersistenceChange={state => { persistence = state; }} />);
    fireEvent.click(screen.getByRole('button', { name: 'New blank entry' }));
    const editor = await screen.findByLabelText(/Reflection Markdown/);
    fireEvent.change(editor, { target: { value: 'Finish request' } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish entry' }));
    await screen.findByText('Save failed — draft remains open');
    fireEvent.change(editor, { target: { value: 'Later unfinished edit' } });
    await persistence!.flush();
    expect(vi.mocked(api.saveEntry).mock.calls[1][0]).toMatchObject({
      finish: false, content: { body: 'Later unfinished edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Finish entry' }));
    await waitFor(() => expect(vi.mocked(api.saveEntry)).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.saveEntry).mock.calls[2][0]).toMatchObject({
      finish: true, content: { body: 'Later unfinished edit' },
    });
  });
});
