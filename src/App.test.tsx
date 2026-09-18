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
  listPlanEnrollments: vi.fn(),
  getPlanDefinitionVersion: vi.fn(),
  activePlanAssignments: vi.fn(),
  planCompletionHistory: vi.fn(),
  registerFourStreamPlan: vi.fn(),
  enrollInChapterStreams: vi.fn(),
  completePlanStream: vi.fn(),
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
vi.mock('./platform/plans', () => ({
  nativePlans: {
    listPlanEnrollments: native.listPlanEnrollments,
    getPlanDefinitionVersion: native.getPlanDefinitionVersion,
    activePlanAssignments: native.activePlanAssignments,
    planCompletionHistory: native.planCompletionHistory,
    registerFourStreamPlan: native.registerFourStreamPlan,
    enrollInChapterStreams: native.enrollInChapterStreams,
    completePlanStream: native.completePlanStream,
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
  native.listPlanEnrollments.mockReset().mockResolvedValue([]);
  native.getPlanDefinitionVersion.mockReset();
  native.activePlanAssignments.mockReset();
  native.planCompletionHistory.mockReset().mockResolvedValue([]);
  native.registerFourStreamPlan.mockReset();
  native.enrollInChapterStreams.mockReset();
  native.completePlanStream.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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

  it('keeps a dirty editor intact while browsing retained plan assignments', async () => {
    native.listPlanEnrollments.mockResolvedValueOnce([
      { id: 'enrollment-1', definitionVersionId: 'version-1', createdAt: '2026-09-18T00:00:00Z' },
      { id: 'enrollment-2', definitionVersionId: 'version-2', createdAt: '2026-09-18T00:00:01Z' },
    ]);
    native.getPlanDefinitionVersion.mockImplementation(async (id: string) => ({ id, planId: 'plan', version: 1, createdAt: '2026-09-18T00:00:00Z', definition: { schemaVersion: 1, name: id, schedule: { kind: 'chapterStreams', streams: [] } } }));
    native.activePlanAssignments.mockResolvedValue([]);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'New blank entry' }));
    const editor = await screen.findByLabelText(/Reflection Markdown/);
    fireEvent.change(editor, { target: { value: 'Keep this draft' } });
    const select = await screen.findByLabelText('Retained enrollment');
    fireEvent.change(select, { target: { value: 'enrollment-2' } });
    await screen.findByText('version-2');
    expect((editor as HTMLTextAreaElement).value).toBe('Keep this draft');
    expect(native.saveEntry).not.toHaveBeenCalled();
  });

  it('autosaves a dirty editor after browsing retained plan assignments', async () => {
    native.listPlanEnrollments.mockResolvedValueOnce([
      { id: 'enrollment-1', definitionVersionId: 'version-1', createdAt: '2026-09-18T00:00:00Z' },
      { id: 'enrollment-2', definitionVersionId: 'version-2', createdAt: '2026-09-18T00:00:01Z' },
    ]);
    native.getPlanDefinitionVersion.mockImplementation(async (id: string) => ({ id, planId: 'plan', version: 1, createdAt: '2026-09-18T00:00:00Z', definition: { schemaVersion: 1, name: id, schedule: { kind: 'chapterStreams', streams: [] } } }));
    native.activePlanAssignments.mockResolvedValue([]);
    native.saveEntry.mockImplementation(async (request: SaveRequest) => savedEntry(request));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'New blank entry' }));
    const editor = await screen.findByLabelText(/Reflection Markdown/);
    const select = await screen.findByLabelText('Retained enrollment');
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: 'Save this after browsing' } });
    fireEvent.change(select, { target: { value: 'enrollment-2' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(native.saveEntry).toHaveBeenCalledTimes(1);
    expect(native.saveEntry.mock.calls[0][0]).toMatchObject({ finish: false, content: { body: 'Save this after browsing' } });
    expect(screen.getByRole('status').textContent).toBe('Draft saved');
    expect((editor as HTMLTextAreaElement).value).toBe('Save this after browsing');
  });

  it('preserves and autosaves dirty writing while explicitly enrolling in four streams', async () => {
    const version = {
      id: 'four-version', planId: 'four-plan', version: 1, createdAt: '2026-09-18T00:00:00Z',
      definition: { schemaVersion: 1, name: 'Four streams', schedule: { kind: 'chapterStreams', streams: [
        { id: 'old', name: 'Old Testament', chapters: [{ book: 1, chapter: 1 }] },
        { id: 'new', name: 'New Testament', chapters: [{ book: 40, chapter: 1 }] },
        { id: 'psalms', name: 'Psalms', chapters: [{ book: 19, chapter: 1 }] },
        { id: 'proverbs', name: 'Proverbs', chapters: [{ book: 20, chapter: 1 }] },
      ] } },
    };
    const enrollment = { id: 'new-enrollment', definitionVersionId: version.id, createdAt: '2026-09-18T00:00:01Z' };
    native.listPlanEnrollments.mockResolvedValueOnce([]).mockResolvedValueOnce([enrollment]);
    native.registerFourStreamPlan.mockResolvedValue(version);
    native.enrollInChapterStreams.mockResolvedValue(enrollment);
    native.getPlanDefinitionVersion.mockResolvedValue(version);
    native.activePlanAssignments.mockResolvedValue([]);
    native.saveEntry.mockImplementation(async (request: SaveRequest) => savedEntry(request));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'New blank entry' }));
    const editor = await screen.findByLabelText(/Reflection Markdown/);
    await screen.findByText('No retained plan enrollments yet.');
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: 'Keep this while enrolling' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set up four-stream plan' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Create enrollment' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    expect(native.enrollInChapterStreams).toHaveBeenCalledTimes(1);
    expect(native.saveEntry).toHaveBeenCalledTimes(1);
    expect(native.saveEntry.mock.calls[0][0]).toMatchObject({ finish: false, content: { body: 'Keep this while enrolling' } });
    expect((editor as HTMLTextAreaElement).value).toBe('Keep this while enrolling');
  });

  it('preserves and autosaves dirty writing while explicitly completing a stream', async () => {
    const enrollment = { id: 'enrollment-1', definitionVersionId: 'version-1', createdAt: '2026-09-18T00:00:00Z' };
    const assignment = { id: 'assignment-1', enrollmentId: enrollment.id, streamId: 'psalms', ordinal: 1, cycle: 1, passage: { book: 19, chapter: 1 }, streamPosition: 0, progressId: 'progress-1' };
    native.listPlanEnrollments.mockResolvedValue([enrollment]);
    native.getPlanDefinitionVersion.mockResolvedValue({ id: 'version-1', planId: 'plan-1', version: 1, createdAt: enrollment.createdAt, definition: { schemaVersion: 1, name: 'Four streams', schedule: { kind: 'chapterStreams', streams: [] } } });
    native.activePlanAssignments.mockResolvedValueOnce([assignment]).mockResolvedValueOnce([]);
    native.completePlanStream.mockResolvedValue({ id: 'completion-1', assignmentId: assignment.id, completedAt: '2026-09-18T00:00:01Z' });
    native.saveEntry.mockImplementation(async (request: SaveRequest) => savedEntry(request));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'New blank entry' }));
    const editor = await screen.findByLabelText(/Reflection Markdown/);
    const complete = await screen.findByRole('button', { name: 'Complete psalms' });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: 'Keep this while completing' } });
    fireEvent.click(complete);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    expect(native.completePlanStream).toHaveBeenCalledWith({ enrollmentId: enrollment.id, streamId: assignment.streamId, expectedAssignmentId: assignment.id, expectedProgressId: assignment.progressId });
    expect(native.saveEntry).toHaveBeenCalledTimes(1);
    expect(native.saveEntry.mock.calls[0][0]).toMatchObject({ finish: false, content: { body: 'Keep this while completing' } });
    expect((editor as HTMLTextAreaElement).value).toBe('Keep this while completing');
  });
});
