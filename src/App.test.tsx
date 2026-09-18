// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry, SaveRequest } from './domain';

const native = vi.hoisted(() => ({
  closeHandler: undefined as undefined | ((event: { preventDefault: () => void }) => Promise<void>),
  onCloseRequested: vi.fn(),
  listEntries: vi.fn(),
  saveEntry: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onCloseRequested: native.onCloseRequested }),
}));
vi.mock('./platform/journal', () => ({
  isDesktop: true,
  nativeJournal: {
    listEntries: native.listEntries,
    saveEntry: native.saveEntry,
    getHistory: vi.fn(async () => []),
    restoreRevision: vi.fn(),
    exportJournal: vi.fn(),
  },
}));
vi.mock('./scripture/Reader', () => ({ Reader: () => null }));

import { App } from './App';

const savedEntry = (request: SaveRequest): Entry => ({
  id: request.entryId,
  createdAt: '2026-09-18T00:00:00Z',
  updatedAt: '2026-09-18T00:00:00Z',
  workingRevisionId: 'working-revision',
  publishedRevisionId: null,
  content: request.content,
});

beforeEach(() => {
  native.invoke.mockReset().mockResolvedValue(undefined);
  // index.html's early bootstrap is exercised by the browser tests.
  window.scriptureAppearance = {
    getPreference: () => 'system',
    getResolved: () => 'dark',
    getBackground: () => '#1d2420',
    getThemes: () => [],
    setPreference: () => true,
    saveTheme: () => true,
    setSystemTheme: () => true,
  };
  native.closeHandler = undefined;
  native.onCloseRequested.mockReset().mockImplementation(async handler => {
    native.closeHandler = handler;
    return vi.fn();
  });
  native.listEntries.mockReset().mockResolvedValue([]);
  native.saveEntry.mockReset();
});

afterEach(cleanup);

describe('native application close lifecycle', () => {
  it('clears a transient native appearance error after a later successful update', async () => {
    native.invoke.mockRejectedValueOnce(new Error('Temporary native failure'));
    render(<App />);
    expect(await screen.findByText('The window appearance could not be updated.')).toBeTruthy();
    await act(async () => { window.dispatchEvent(new Event('appearancechange')); });
    await waitFor(() => expect(screen.queryByText('The window appearance could not be updated.')).toBeNull());
    expect(native.invoke).toHaveBeenCalledTimes(2);
  });

  it('keeps close pending until the current editor generation is saved unfinished', async () => {
    let release: ((entry: Entry) => void) | undefined;
    native.saveEntry.mockImplementation((request: SaveRequest) => new Promise<Entry>(resolve => {
      release = resolve;
    }));
    render(<App />);
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('apply_appearance', { theme: 'dark', background: '#1d2420' }));
    await waitFor(() => expect(native.closeHandler).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'New blank entry' }));
    const editor = await screen.findByLabelText(/Reflection Markdown/);
    fireEvent.change(editor, { target: { value: 'Pending close draft' } });

    const event = { preventDefault: vi.fn() };
    let closeSettled = false;
    const closing = native.closeHandler!(event).then(() => { closeSettled = true; });
    await waitFor(() => expect(native.saveEntry).toHaveBeenCalledTimes(1));
    expect(closeSettled).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    const request = native.saveEntry.mock.calls[0][0] as SaveRequest;
    expect(request).toMatchObject({ finish: false, content: { body: 'Pending close draft' } });

    await act(async () => {
      release!(savedEntry(request));
      await closing;
    });
    expect(closeSettled).toBe(true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect((editor as HTMLTextAreaElement).value).toBe('Pending close draft');
  });

  it('cancels close after a rejected save and keeps the draft editable', async () => {
    native.saveEntry.mockRejectedValue(new Error('Synthetic storage failure'));
    render(<App />);
    await waitFor(() => expect(native.closeHandler).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'New blank entry' }));
    const editor = await screen.findByLabelText(/Reflection Markdown/);
    fireEvent.change(editor, { target: { value: 'Still editable after failure' } });
    const event = { preventDefault: vi.fn() };

    await act(async () => { await native.closeHandler!(event); });

    expect(native.saveEntry).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/journal remains open.*Synthetic storage failure/i)).toBeTruthy();
    expect((editor as HTMLTextAreaElement).value).toBe('Still editable after failure');
    fireEvent.change(editor, { target: { value: 'Editing can continue' } });
    expect((editor as HTMLTextAreaElement).value).toBe('Editing can continue');
  });
});
