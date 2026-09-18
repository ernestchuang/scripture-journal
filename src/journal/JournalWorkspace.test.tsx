// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { blankContent, type Entry, type SaveRequest } from '../domain';
import type { JournalApi } from '../platform/journal';
import { JournalWorkspace } from './JournalWorkspace';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const fakeApi = (): JournalApi => ({
  listEntries: vi.fn(async () => []),
  saveEntry: vi.fn(async (request: SaveRequest): Promise<Entry> => ({
    id: request.entryId, createdAt: '2026-09-17T00:00:00Z', updatedAt: '2026-09-17T00:00:00Z',
    workingRevisionId: 'r1', publishedRevisionId: request.finish ? 'r1' : null, content: request.content,
  })),
  getHistory: vi.fn(async () => []), restoreRevision: vi.fn(), exportJournal: vi.fn(),
});

describe('journal workspace', () => {
  it('combines revisit filters without changing open writing', async () => {
    const api = fakeApi();
    const make = (id: string, finished: boolean, chapter: number, tags: string[]): Entry => ({
      id, createdAt: '2026-09-17T00:00:00Z', updatedAt: '2026-09-17T00:00:00Z',
      workingRevisionId: 'r1', publishedRevisionId: finished ? 'r1' : null,
      content: { ...blankContent([{ book: 43, chapter }]), title: id, tags },
    });
    vi.mocked(api.listEntries).mockResolvedValue([
      make('Trust', true, 3, ['hope']), make('Questions', false, 3, ['hope']), make('Next chapter', true, 4, ['hope']),
    ]);
    render(<JournalWorkspace api={api} passage={{ book: 43, chapter: 3 }} reflectRequest={0} />);
    fireEvent.click(await screen.findByRole('button', { name: /Questions/ }));
    const editor = await screen.findByLabelText(/Reflection Markdown/);
    fireEvent.change(editor, { target: { value: 'Still writing' } });
    fireEvent.click(screen.getByText('Filter reflections'));
    fireEvent.change(screen.getByLabelText('Tag'), { target: { value: 'hope' } });
    fireEvent.change(screen.getByLabelText('Bible book'), { target: { value: '43' } });
    fireEvent.change(screen.getByLabelText('Chapter'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Entry status'), { target: { value: 'finished' } });
    const nav = screen.getByRole('navigation', { name: 'Journal entries' });
    expect(nav.textContent).toContain('Trust');
    expect(nav.textContent).not.toContain('Questions');
    expect(nav.textContent).not.toContain('Next chapter');
    expect((editor as HTMLTextAreaElement).value).toBe('Still writing');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(nav.textContent).toContain('Questions');
    expect(nav.textContent).toContain('Next chapter');
  });
  it('persists continuous typing without waiting for an idle pause', async () => {
    const api = fakeApi();
    render(<JournalWorkspace api={api} passage={{ book: 1, chapter: 1 }} reflectRequest={0} />);
    await screen.findByText('Your reflections will appear here.');
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New blank entry' })); });
    const editor = screen.getByLabelText(/Reflection Markdown/);
    for (let index = 0; index < 10; index++) {
      fireEvent.change(editor, { target: { value: `Continuous writing ${index}` } });
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    }
    expect(api.saveEntry).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.saveEntry).mock.calls[0][0]).toMatchObject({
      finish: false, content: { body: 'Continuous writing 9' },
    });
  });

  it('recovers a stale writer into a new draft and preserves it if recovery fails', async () => {
    const api = fakeApi();
    const original: Entry = {
      id: crypto.randomUUID(), createdAt: '2026-09-17T00:00:00Z', updatedAt: '2026-09-17T00:00:00Z',
      workingRevisionId: 'old', publishedRevisionId: 'old',
      content: { ...blankContent([{ book: 43, chapter: 3 }]), title: 'Original entry', body: 'Original body', tags: ['study'] },
    };
    const competing = { ...original, workingRevisionId: 'competing', content: { ...original.content, body: 'Other writer' } };
    vi.mocked(api.listEntries).mockResolvedValueOnce([original]).mockResolvedValue([competing]);
    vi.mocked(api.saveEntry).mockRejectedValueOnce(new Error('Entry changed since it was loaded'))
      .mockRejectedValueOnce(new Error('Storage unavailable'));
    render(<JournalWorkspace api={api} passage={{ book: 1, chapter: 1 }} reflectRequest={0} />);
    fireEvent.click(await screen.findByRole('button', { name: /Original entry/ }));
    const editor = await screen.findByLabelText(/Reflection Markdown/);
    fireEvent.change(editor, { target: { value: 'My conflicting writing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish entry' }));
    await screen.findByText('Save failed — draft remains open');
    fireEvent.click(screen.getByRole('button', { name: 'Save as new draft' }));
    await screen.findByText(/Action could not finish.*Storage unavailable/);
    expect((editor as HTMLTextAreaElement).value).toBe('My conflicting writing');
    fireEvent.click(screen.getByRole('button', { name: 'Save as new draft' }));
    await screen.findByText('Draft saved');
    const requests = vi.mocked(api.saveEntry).mock.calls.map(([request]) => request);
    expect(requests[0]).toMatchObject({ entryId: original.id, expectedRevisionId: 'old', finish: true });
    expect(requests[2].entryId).not.toBe(original.id);
    expect(requests[2]).toMatchObject({ expectedRevisionId: null, finish: false,
      content: { body: 'My conflicting writing', tags: ['study'], passages: [{ book: 43, chapter: 3 }] } });
    // Reopening the original uses the refreshed competing version, not cached old content.
    fireEvent.click(screen.getAllByRole('button', { name: /Original entry/ }).find(button => button.getAttribute('aria-current') !== 'true')!);
    await waitFor(() => expect((screen.getByLabelText(/Reflection Markdown/) as HTMLTextAreaElement).value).toBe('Other writer'));
  });

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
