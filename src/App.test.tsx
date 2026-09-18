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
  listLatestPlanDefinitionVersions: vi.fn(),
  getPlanDefinitionVersion: vi.fn(),
  activePlanAssignments: vi.fn(),
  planCompletionHistory: vi.fn(),
  registerFourStreamPlan: vi.fn(),
  registerMcheynePlan: vi.fn(),
  importPlanDefinitionJson: vi.fn(),
  createPlanDefinitionVersion: vi.fn(),
  exportPlanDefinitionJson: vi.fn(),
  enrollInChapterStreams: vi.fn(),
  enrollInCalendar: vi.fn(),
  getCalendarPlanEnrollment: vi.fn(),
  calendarPlanAssignments: vi.fn(),
  completeCalendarAssignment: vi.fn(),
  calendarCompletionHistory: vi.fn(),
  completePlanStream: vi.fn(),
  undoPlanCompletion: vi.fn(),
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
    listLatestPlanDefinitionVersions: native.listLatestPlanDefinitionVersions,
    getPlanDefinitionVersion: native.getPlanDefinitionVersion,
    activePlanAssignments: native.activePlanAssignments,
    planCompletionHistory: native.planCompletionHistory,
    registerFourStreamPlan: native.registerFourStreamPlan,
    registerMcheynePlan: native.registerMcheynePlan,
    importPlanDefinitionJson: native.importPlanDefinitionJson,
    createPlanDefinitionVersion: native.createPlanDefinitionVersion,
    exportPlanDefinitionJson: native.exportPlanDefinitionJson,
    enrollInChapterStreams: native.enrollInChapterStreams,
    enrollInCalendar: native.enrollInCalendar,
    getCalendarPlanEnrollment: native.getCalendarPlanEnrollment,
    calendarPlanAssignments: native.calendarPlanAssignments,
    completeCalendarAssignment: native.completeCalendarAssignment,
    calendarCompletionHistory: native.calendarCompletionHistory,
    completePlanStream: native.completePlanStream,
    undoPlanCompletion: native.undoPlanCompletion,
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
  native.listLatestPlanDefinitionVersions.mockReset().mockResolvedValue([]);
  native.getPlanDefinitionVersion.mockReset();
  native.activePlanAssignments.mockReset();
  native.planCompletionHistory.mockReset().mockResolvedValue([]);
  native.registerFourStreamPlan.mockReset();
  native.registerMcheynePlan.mockReset();
  native.importPlanDefinitionJson.mockReset();
  native.createPlanDefinitionVersion.mockReset();
  native.exportPlanDefinitionJson.mockReset();
  native.enrollInChapterStreams.mockReset();
  native.enrollInCalendar.mockReset();
  native.getCalendarPlanEnrollment.mockReset().mockResolvedValue(null);
  native.calendarPlanAssignments.mockReset().mockResolvedValue([]);
  native.completeCalendarAssignment.mockReset();
  native.calendarCompletionHistory.mockReset().mockResolvedValue([]);
  native.completePlanStream.mockReset();
  native.undoPlanCompletion.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('native application close lifecycle', () => {
  it('clears a transient native appearance error after a later successful update', async () => {
    let appearanceCalls = 0;
    native.invoke.mockImplementation(async (command: string) => {
      if (command === 'apply_appearance' && appearanceCalls++ === 0) throw new Error('Temporary native failure');
      return undefined;
    });
    render(<App />);
    expect(await screen.findByText('The window appearance could not be updated.')).toBeTruthy();
    await act(async () => { window.dispatchEvent(new Event('appearancechange')); });
    await waitFor(() => expect(screen.queryByText('The window appearance could not be updated.')).toBeNull());
    expect(native.invoke.mock.calls.filter(([command]) => command === 'apply_appearance')).toHaveLength(2);
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

  it('preserves and autosaves dirty writing while browsing retained plan definitions', async () => {
    native.listLatestPlanDefinitionVersions.mockResolvedValue([
      { id: 'definition-1', planId: 'plan-1', version: 1, createdAt: '2026-09-18T00:00:00Z', definition: { schemaVersion: 1, name: 'First retained', schedule: { kind: 'chapterStreams', streams: [] } } },
      { id: 'definition-2', planId: 'plan-2', version: 2, createdAt: '2026-09-18T00:00:01Z', definition: { schemaVersion: 1, name: 'Second retained', schedule: { kind: 'explicitSchedule', days: [{ day: 1, passages: [{ book: 43, chapter: 3 }] }] } } },
    ]);
    native.saveEntry.mockImplementation(async (request: SaveRequest) => savedEntry(request));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'New blank entry' }));
    const editor = await screen.findByLabelText(/Reflection Markdown/);
    const select = await screen.findByLabelText('Retained plan definition');
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: 'Keep this while browsing definitions' } });
    fireEvent.change(select, { target: { value: 'definition-2' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    expect(screen.getByText('plan-2')).toBeTruthy();
    expect(native.listLatestPlanDefinitionVersions).toHaveBeenCalledTimes(1);
    expect(native.saveEntry).toHaveBeenCalledTimes(1);
    expect(native.saveEntry.mock.calls[0][0]).toMatchObject({ finish: false, content: { body: 'Keep this while browsing definitions' } });
    expect((editor as HTMLTextAreaElement).value).toBe('Keep this while browsing definitions');
  });

  it('preserves and autosaves dirty writing while appending a retained plan version', async () => {
    const first = { id: 'definition-1', planId: 'plan-1', version: 1, createdAt: '2026-09-18T00:00:00Z', definition: { schemaVersion: 1, name: 'Editable retained', schedule: { kind: 'explicitSchedule' as const, days: [{ day: 1, passages: [{ book: 43, chapter: 3 }] }] } } };
    const edited = { ...first.definition, name: 'Edited retained' };
    const second = { ...first, id: 'definition-2', version: 2, definition: edited };
    native.listLatestPlanDefinitionVersions.mockResolvedValueOnce([first]).mockResolvedValueOnce([second]);
    native.createPlanDefinitionVersion.mockResolvedValue(second);
    native.saveEntry.mockImplementation(async (request: SaveRequest) => savedEntry(request));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'New blank entry' }));
    const editor = await screen.findByLabelText(/Reflection Markdown/);
    await screen.findByLabelText('Retained plan definition');
    fireEvent.click(screen.getByRole('button', { name: 'Edit selected as new version' }));
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: 'Keep this while versioning a plan' } });
    fireEvent.change(screen.getByLabelText('Edited plan JSON'), { target: { value: JSON.stringify(edited) } });
    fireEvent.click(screen.getByRole('button', { name: 'Append new plan version' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    expect(native.createPlanDefinitionVersion).toHaveBeenCalledWith(first.planId, edited);
    expect(native.saveEntry).toHaveBeenCalledTimes(1);
    expect(native.saveEntry.mock.calls[0][0]).toMatchObject({ finish: false, content: { body: 'Keep this while versioning a plan' } });
    expect((editor as HTMLTextAreaElement).value).toBe('Keep this while versioning a plan');
  });

  it('preserves and autosaves dirty writing while enrolling in a selected retained definition', async () => {
    const definition = { id: 'retained-version', planId: 'retained-plan', version: 2, createdAt: '2026-09-18T00:00:00Z', definition: { schemaVersion: 1, name: 'Retained streams', schedule: { kind: 'chapterStreams', streams: [{ id: 'retained', name: 'Retained stream', chapters: [{ book: 43, chapter: 1 }] }] } } };
    const enrollment = { id: 'retained-enrollment', definitionVersionId: definition.id, createdAt: '2026-09-18T00:00:01Z' };
    native.listLatestPlanDefinitionVersions.mockResolvedValue([definition]);
    native.listPlanEnrollments.mockResolvedValueOnce([]).mockResolvedValueOnce([enrollment]);
    native.enrollInChapterStreams.mockResolvedValue(enrollment);
    native.getPlanDefinitionVersion.mockResolvedValue(definition);
    native.activePlanAssignments.mockResolvedValue([]);
    native.saveEntry.mockImplementation(async (request: SaveRequest) => savedEntry(request));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'New blank entry' }));
    const editor = await screen.findByLabelText(/Reflection Markdown/);
    const enroll = await screen.findByRole('button', { name: 'Create retained enrollment' });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: 'Keep this while retained enrolling' } });
    fireEvent.click(enroll);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    expect(native.enrollInChapterStreams).toHaveBeenCalledWith(definition.id, [{ streamId: 'retained', startingPosition: 0, loopAfterEnd: true }]);
    expect(native.saveEntry).toHaveBeenCalledTimes(1);
    expect(native.saveEntry.mock.calls[0][0]).toMatchObject({ finish: false, content: { body: 'Keep this while retained enrolling' } });
    expect((editor as HTMLTextAreaElement).value).toBe('Keep this while retained enrolling');
  });

  it('preserves and autosaves dirty writing while exporting a selected retained definition', async () => {
    native.listLatestPlanDefinitionVersions.mockResolvedValue([
      { id: 'definition-1', planId: 'plan-1', version: 1, createdAt: '2026-09-18T00:00:00Z', definition: { schemaVersion: 1, name: 'Retained export', schedule: { kind: 'explicitSchedule', days: [{ day: 1, passages: [{ book: 43, chapter: 3 }] }] } } },
    ]);
    native.exportPlanDefinitionJson.mockResolvedValue('{"schemaVersion":1}');
    native.saveEntry.mockImplementation(async (request: SaveRequest) => savedEntry(request));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'New blank entry' }));
    const editor = await screen.findByLabelText(/Reflection Markdown/);
    const exportButton = await screen.findByRole('button', { name: 'Export retained definition JSON' });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: 'Keep this while exporting a retained definition' } });
    fireEvent.click(exportButton);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    expect(native.exportPlanDefinitionJson).toHaveBeenCalledWith('definition-1');
    expect(native.saveEntry).toHaveBeenCalledTimes(1);
    expect(native.saveEntry.mock.calls[0][0]).toMatchObject({ finish: false, content: { body: 'Keep this while exporting a retained definition' } });
    expect((editor as HTMLTextAreaElement).value).toBe('Keep this while exporting a retained definition');
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

  it('preserves and autosaves dirty writing while explicitly registering M’Cheyne', async () => {
    const version = { id: 'mcheyne-version', planId: 'mcheyne-plan', version: 1, createdAt: '2026-09-18T00:00:00Z', definition: { schemaVersion: 1, name: "M’Cheyne's Daily Bible Readings", schedule: { kind: 'explicitSchedule' as const, days: [{ day: 1, passages: [{ book: 1, chapter: 1 }] }] } } };
    native.registerMcheynePlan.mockResolvedValue(version);
    native.listLatestPlanDefinitionVersions.mockResolvedValueOnce([]).mockResolvedValueOnce([version]);
    native.saveEntry.mockImplementation(async (request: SaveRequest) => savedEntry(request));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'New blank entry' }));
    const editor = await screen.findByLabelText(/Reflection Markdown/);
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: 'Keep this while registering M’Cheyne' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register M’Cheyne plan' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(native.registerMcheynePlan).toHaveBeenCalledTimes(1);
    expect(native.saveEntry.mock.calls[0][0]).toMatchObject({ finish: false, content: { body: 'Keep this while registering M’Cheyne' } });
    expect((editor as HTMLTextAreaElement).value).toBe('Keep this while registering M’Cheyne');
  });

  it('preserves and autosaves dirty writing while explicitly importing a custom plan', async () => {
    const imported = { id: 'custom-version', planId: 'custom-plan', version: 1, createdAt: '2026-09-18T00:00:00Z', definition: { schemaVersion: 1, name: 'Imported streams', schedule: { kind: 'chapterStreams', streams: [] } } };
    native.importPlanDefinitionJson.mockResolvedValue(imported);
    native.saveEntry.mockImplementation(async (request: SaveRequest) => savedEntry(request));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'New blank entry' }));
    const editor = await screen.findByLabelText(/Reflection Markdown/);
    const input = screen.getByLabelText('Custom plan JSON');
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: 'Keep this while importing' } });
    fireEvent.change(input, { target: { value: '{"schemaVersion":1}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import custom plan' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    expect(native.importPlanDefinitionJson).toHaveBeenCalledWith('{"schemaVersion":1}');
    expect(native.saveEntry).toHaveBeenCalledTimes(1);
    expect(native.saveEntry.mock.calls[0][0]).toMatchObject({ finish: false, content: { body: 'Keep this while importing' } });
    expect((editor as HTMLTextAreaElement).value).toBe('Keep this while importing');
  });

  it('preserves and autosaves dirty writing while enrolling in an imported custom plan', async () => {
    const imported = { id: 'custom-version', planId: 'custom-plan', version: 1, createdAt: '2026-09-18T00:00:00Z', definition: { schemaVersion: 1, name: 'Imported streams', schedule: { kind: 'chapterStreams', streams: [{ id: 'custom', name: 'Custom stream', chapters: [{ book: 43, chapter: 1 }] }] } } };
    const enrollment = { id: 'custom-enrollment', definitionVersionId: imported.id, createdAt: '2026-09-18T00:00:01Z' };
    native.importPlanDefinitionJson.mockResolvedValue(imported);
    native.enrollInChapterStreams.mockResolvedValue(enrollment);
    native.listPlanEnrollments.mockResolvedValueOnce([]).mockResolvedValueOnce([enrollment]);
    native.getPlanDefinitionVersion.mockResolvedValue(imported);
    native.activePlanAssignments.mockResolvedValue([]);
    native.saveEntry.mockImplementation(async (request: SaveRequest) => savedEntry(request));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'New blank entry' }));
    const editor = await screen.findByLabelText(/Reflection Markdown/);
    fireEvent.change(screen.getByLabelText('Custom plan JSON'), { target: { value: '{"schemaVersion":1}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import custom plan' }));
    const enroll = await screen.findByRole('button', { name: 'Create custom enrollment' });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: 'Keep this while custom enrolling' } });
    fireEvent.click(enroll);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    expect(native.enrollInChapterStreams).toHaveBeenCalledWith(imported.id, [{ streamId: 'custom', startingPosition: 0, loopAfterEnd: true }]);
    expect(native.saveEntry).toHaveBeenCalledTimes(1);
    expect(native.saveEntry.mock.calls[0][0]).toMatchObject({ finish: false, content: { body: 'Keep this while custom enrolling' } });
    expect((editor as HTMLTextAreaElement).value).toBe('Keep this while custom enrolling');
  });

  it('preserves and autosaves dirty writing while explicitly exporting a selected plan version', async () => {
    const enrollment = { id: 'enrollment-1', definitionVersionId: 'version-1', createdAt: '2026-09-18T00:00:00Z' };
    native.listPlanEnrollments.mockResolvedValue([enrollment]);
    native.getPlanDefinitionVersion.mockResolvedValue({ id: 'version-1', planId: 'plan-1', version: 1, createdAt: enrollment.createdAt, definition: { schemaVersion: 1, name: 'Four streams', schedule: { kind: 'chapterStreams', streams: [] } } });
    native.activePlanAssignments.mockResolvedValue([]);
    native.exportPlanDefinitionJson.mockResolvedValue('{"schemaVersion":1}');
    native.saveEntry.mockImplementation(async (request: SaveRequest) => savedEntry(request));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'New blank entry' }));
    const editor = await screen.findByLabelText(/Reflection Markdown/);
    const exportButton = await screen.findByRole('button', { name: 'Export selected version JSON' });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: 'Keep this while exporting' } });
    fireEvent.click(exportButton);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    expect(native.exportPlanDefinitionJson).toHaveBeenCalledWith('version-1');
    expect(native.saveEntry).toHaveBeenCalledTimes(1);
    expect(native.saveEntry.mock.calls[0][0]).toMatchObject({ finish: false, content: { body: 'Keep this while exporting' } });
    expect((editor as HTMLTextAreaElement).value).toBe('Keep this while exporting');
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

  it('preserves and autosaves dirty writing while explicitly undoing a completion', async () => {
    const enrollment = { id: 'enrollment-1', definitionVersionId: 'version-1', createdAt: '2026-09-18T00:00:00Z' };
    const completion = { id: 'completion-1', assignmentId: 'assignment-1', enrollmentId: enrollment.id, streamId: 'psalms', ordinal: 1, cycle: 1, passage: { book: 19, chapter: 1 }, streamPosition: 0, completedAt: '2026-09-18T00:00:01Z', undone: false };
    native.listPlanEnrollments.mockResolvedValue([enrollment]);
    native.getPlanDefinitionVersion.mockResolvedValue({ id: 'version-1', planId: 'plan-1', version: 1, createdAt: enrollment.createdAt, definition: { schemaVersion: 1, name: 'Four streams', schedule: { kind: 'chapterStreams', streams: [] } } });
    native.activePlanAssignments.mockResolvedValue([]);
    native.planCompletionHistory.mockResolvedValueOnce([completion]).mockResolvedValueOnce([{ ...completion, undone: true }]);
    native.undoPlanCompletion.mockResolvedValue(undefined);
    native.saveEntry.mockImplementation(async (request: SaveRequest) => savedEntry(request));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'New blank entry' }));
    const editor = await screen.findByLabelText(/Reflection Markdown/);
    const undo = await screen.findByRole('button', { name: 'Undo completion completion-1' });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: 'Keep this while undoing' } });
    fireEvent.click(undo);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    expect(native.undoPlanCompletion).toHaveBeenCalledWith(completion.id);
    expect(native.saveEntry).toHaveBeenCalledTimes(1);
    expect(native.saveEntry.mock.calls[0][0]).toMatchObject({ finish: false, content: { body: 'Keep this while undoing' } });
    expect((editor as HTMLTextAreaElement).value).toBe('Keep this while undoing');
  });

  it('offers restored portable preferences without applying them silently', async () => {
    const values = new Map<string, string>([['scripture-journal.appearance', 'light'], ['scripture-journal.reader-location', '{"book":43,"chapter":2}']]);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    } });
    native.invoke.mockImplementation(async (command: string) => command === 'startup_restore_outcome'
      ? { notice: 'Backup restored.', preferences: {
        'scripture-journal.appearance': 'dark',
        'scripture-journal.reader-location': '{"book":43,"chapter":3}',
      } }
      : undefined);

    render(<App />);

    expect(await screen.findByRole('button', { name: 'Apply restored appearance/reading preferences' })).toBeTruthy();
    expect(values.get('scripture-journal.appearance')).toBe('light');
    expect(values.get('scripture-journal.reader-location')).toBe('{"book":43,"chapter":2}');

    native.saveEntry.mockRejectedValueOnce(new Error('Synthetic save failure'));
    fireEvent.click(screen.getByRole('button', { name: 'New blank entry' }));
    fireEvent.change(await screen.findByLabelText(/Reflection Markdown/), { target: { value: 'Unsaved before preference reload' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply restored appearance/reading preferences' }));
    expect(await screen.findByText(/preferences could not be applied.*Synthetic save failure/i)).toBeTruthy();
    expect(values.get('scripture-journal.appearance')).toBe('light');
    expect(native.invoke.mock.calls.some(([command]) => command === 'acknowledge_restored_preferences')).toBe(false);
  });
});
