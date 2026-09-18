// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DatedPlanAssignment, PlanDefinitionApi, PlanDefinitionVersion, PlanEnrollment } from '../platform/plans';
import { ownsRetainedExport, PlanPanel, selectRetainedExportDefinition, startRetainedExport, updateStreamEnrollmentChoice } from './PlanPanel';

afterEach(cleanup);
const first: PlanEnrollment = { id: 'enrollment-1', definitionVersionId: 'version-1', createdAt: '2026-09-18T00:00:00Z' };
const second: PlanEnrollment = { id: 'enrollment-2', definitionVersionId: 'version-2', createdAt: '2026-09-18T00:00:01Z' };
const definition = (id: string, name: string) => ({ id, planId: 'plan-1', version: 1, createdAt: first.createdAt, definition: { schemaVersion: 1, name, schedule: { kind: 'chapterStreams' as const, streams: [] } } });
const fourStream = {
  id: 'four-stream-version', planId: 'four-stream-plan', version: 1, createdAt: first.createdAt,
  definition: { schemaVersion: 1, name: 'Four streams', schedule: { kind: 'chapterStreams' as const, streams: [
    { id: 'old', name: 'Old Testament', chapters: [{ book: 1, chapter: 1 }, { book: 1, chapter: 2 }] },
    { id: 'new', name: 'New Testament', chapters: [{ book: 40, chapter: 1 }] },
    { id: 'psalms', name: 'Psalms', chapters: [{ book: 19, chapter: 1 }] },
    { id: 'proverbs', name: 'Proverbs', chapters: [{ book: 20, chapter: 1 }] },
  ] } },
};
const mcheyne = { id: 'mcheyne-version', planId: 'mcheyne-plan', version: 1, createdAt: first.createdAt, definition: { schemaVersion: 1, name: "M’Cheyne's Daily Bible Readings", schedule: { kind: 'explicitSchedule' as const, days: [{ day: 1, passages: [{ book: 1, chapter: 1 }] }] } } };
const created: PlanEnrollment = { id: 'enrollment-new', definitionVersionId: fourStream.id, createdAt: '2026-09-18T00:00:02Z' };
const history = (id: string, enrollmentId = first.id, undone = false) => ({ id, assignmentId: 'assignment-1', enrollmentId, streamId: 'psalms', ordinal: 1, cycle: 1, passage: { book: 19, chapter: 1 }, streamPosition: 0, completedAt: '2026-09-18T00:00:03Z', undone });
const importedPlan = { id: 'custom-version', planId: 'custom-plan', version: 1, createdAt: first.createdAt, definition: { schemaVersion: 1, name: 'Imported streams', schedule: { kind: 'chapterStreams' as const, streams: [] } } };
const retainedDefinition = { ...importedPlan, id: 'retained-version-1', planId: 'retained-plan-1', definition: { ...importedPlan.definition, name: 'Duplicate name' } };
const retainedExplicit = { ...importedPlan, id: 'retained-version-2', planId: 'retained-plan-2', version: 3, definition: { ...importedPlan.definition, name: 'Duplicate name', schedule: { kind: 'explicitSchedule' as const, days: [{ day: 1, passages: [{ book: 43, chapter: 3 }] }] } } };
const retainedCalendar = { ...retainedExplicit, id: 'retained-calendar-version', planId: 'retained-calendar-plan', definition: { ...retainedExplicit.definition, name: '365-day calendar', schedule: { kind: 'explicitSchedule' as const, days: Array.from({ length: 365 }, (_, index) => ({ day: index + 1, passages: [{ book: 43, chapter: 3 }] })) } } };
const importedStreams = { ...importedPlan, definition: { ...importedPlan.definition, schedule: { kind: 'chapterStreams' as const, streams: [
  { id: 'repeat', name: 'Repeated chapters', chapters: [{ book: 19, chapter: 1 }, { book: 19, chapter: 1 }] },
  { id: 'short', name: 'Short stream', chapters: [{ book: 40, chapter: 1 }] },
] } } };
const customEnrollment: PlanEnrollment = { id: 'custom-enrollment', definitionVersionId: importedStreams.id, createdAt: '2026-09-18T00:00:04Z' };
const retainedStreams = { ...importedStreams, id: retainedDefinition.id, planId: retainedDefinition.planId, definition: { ...importedStreams.definition, name: 'Duplicate name' } };
const retainedEnrollment: PlanEnrollment = { id: 'retained-enrollment', definitionVersionId: retainedStreams.id, createdAt: '2026-09-18T00:00:05Z' };
const calendarEnrollment = { id: 'calendar-enrollment', definitionVersionId: retainedCalendar.id, createdAt: '2026-09-18T00:00:06Z', startDate: '2026-03-01', scheduleMode: 'calendarAligned' as const };
const api = (): Pick<PlanDefinitionApi, 'listPlanEnrollments' | 'listLatestPlanDefinitionVersions' | 'getPlanDefinitionVersion' | 'activePlanAssignments' | 'planCompletionHistory' | 'registerFourStreamPlan' | 'registerMcheynePlan' | 'importPlanDefinitionJson' | 'createPlanDefinitionVersion' | 'exportPlanDefinitionJson' | 'enrollInChapterStreams' | 'enrollInCalendar' | 'getCalendarPlanEnrollment' | 'calendarPlanAssignments' | 'completeCalendarAssignment' | 'calendarCompletionHistory' | 'completePlanStream' | 'undoPlanCompletion'> => ({
  listPlanEnrollments: vi.fn(async () => [first, second]),
  listLatestPlanDefinitionVersions: vi.fn(async () => []),
  getPlanDefinitionVersion: vi.fn(async id => definition(id, id === second.definitionVersionId ? 'Second plan' : 'First plan')),
  activePlanAssignments: vi.fn(async id => id === first.id ? [{ id: 'assignment-1', enrollmentId: id, streamId: 'psalms', ordinal: 1, cycle: 1, passage: { book: 19, chapter: 1 }, streamPosition: 0, progressId: 'progress-1' }] : []),
  planCompletionHistory: vi.fn(async () => []),
  registerFourStreamPlan: vi.fn(async () => fourStream),
  registerMcheynePlan: vi.fn(async () => mcheyne),
  importPlanDefinitionJson: vi.fn(async () => importedPlan),
  createPlanDefinitionVersion: vi.fn(async (_planId, definition) => ({ ...retainedDefinition, id: 'retained-version-3', version: 2, definition })),
  exportPlanDefinitionJson: vi.fn(async id => `{"versionId":"${id}"}`),
  enrollInChapterStreams: vi.fn(async () => created),
  enrollInCalendar: vi.fn(async request => ({ ...calendarEnrollment, definitionVersionId: request.definitionVersionId, startDate: request.startDate, scheduleMode: request.scheduleMode })),
  getCalendarPlanEnrollment: vi.fn(async () => null),
  calendarPlanAssignments: vi.fn(async () => []),
  completeCalendarAssignment: vi.fn(async request => ({ id: 'calendar-completion', assignmentId: request.assignmentId, enrollmentId: request.enrollmentId, completedAt: '2026-09-18T00:00:07Z' })),
  calendarCompletionHistory: vi.fn(async () => []),
  completePlanStream: vi.fn(async request => ({ id: 'completion-1', assignmentId: request.expectedAssignmentId, completedAt: '2026-09-18T00:00:03Z' })),
  undoPlanCompletion: vi.fn(async () => undefined),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function clickRetainedExportOnCommit() {
  return new Promise<void>(resolve => {
    const observer = new MutationObserver(() => {
      const button = Array.from(document.querySelectorAll('button')).find(item => item.textContent === 'Export retained definition JSON');
      if (!button) return;
      observer.disconnect();
      button.click();
      resolve();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

describe('retained plan panel', () => {
  it('makes selection invalidation precede export ownership without a delayed reset', () => {
    const delayedReset = { epoch: 0, selectedDefinitionId: retainedDefinition.id };
    const prematurelyStartedEpoch = startRetainedExport(delayedReset);
    delayedReset.epoch += 1;
    expect(ownsRetainedExport(delayedReset, prematurelyStartedEpoch, retainedDefinition.id)).toBe(false);

    const lifecycle = { epoch: 0, selectedDefinitionId: '' };
    expect(selectRetainedExportDefinition(lifecycle, retainedDefinition.id)).toBe(true);
    expect(lifecycle).toEqual({ epoch: 1, selectedDefinitionId: retainedDefinition.id });

    const exportEpoch = startRetainedExport(lifecycle);
    expect(exportEpoch).toBe(2);
    expect(ownsRetainedExport(lifecycle, exportEpoch, retainedDefinition.id)).toBe(true);
    expect(selectRetainedExportDefinition(lifecycle, retainedDefinition.id)).toBe(false);
    expect(ownsRetainedExport(lifecycle, exportEpoch, retainedDefinition.id)).toBe(true);

    expect(selectRetainedExportDefinition(lifecycle, retainedExplicit.id)).toBe(true);
    expect(ownsRetainedExport(lifecycle, exportEpoch, retainedDefinition.id)).toBe(false);
  });

  it('records an occurrence change even before retained choices have been initialized', () => {
    const streams = retainedStreams.definition.schedule.streams;
    expect(updateStreamEnrollmentChoice(streams, [], 0, { startingPosition: 1 })).toEqual([
      { streamId: 'repeat', startingPosition: 1, loopAfterEnd: true },
      { streamId: 'short', startingPosition: 0, loopAfterEnd: true },
    ]);
  });

  it('registers M’Cheyne only after explicit guarded submission, retains its identity, and does not enroll it', async () => {
    let resolveRegistration!: (value: typeof mcheyne) => void;
    const plans = api();
    vi.mocked(plans.listLatestPlanDefinitionVersions).mockResolvedValueOnce([retainedDefinition]).mockResolvedValueOnce([retainedDefinition, mcheyne]).mockResolvedValueOnce([retainedDefinition, mcheyne]);
    vi.mocked(plans.registerMcheynePlan).mockImplementationOnce(() => new Promise(resolve => { resolveRegistration = resolve; }));
    render(<PlanPanel api={plans} />);
    const select = await screen.findByLabelText('Retained plan definition') as HTMLSelectElement;
    expect(plans.registerMcheynePlan).not.toHaveBeenCalled();
    const register = screen.getByRole('button', { name: 'Register M’Cheyne plan' });
    fireEvent.click(register);
    fireEvent.click(register);
    expect((screen.getByRole('button', { name: 'Registering M’Cheyne plan…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(plans.registerMcheynePlan).toHaveBeenCalledTimes(1);
    await act(async () => { resolveRegistration(mcheyne); });
    expect(await screen.findByText('Registered M’Cheyne definition version 1 for plan mcheyne-plan. Select the retained definition below, then explicitly create a calendar enrollment when ready. Registration does not enroll you or schedule readings.')).toBeTruthy();
    await waitFor(() => expect(plans.listLatestPlanDefinitionVersions).toHaveBeenCalledTimes(2));
    expect(Array.from(select.options, option => option.value)).toContain(mcheyne.id);
    expect(plans.enrollInCalendar).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Register M’Cheyne plan' }));
    await waitFor(() => expect(plans.registerMcheynePlan).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(plans.listLatestPlanDefinitionVersions).toHaveBeenCalledTimes(3));
    expect(Array.from(select.options, option => option.value).filter(id => id === mcheyne.id)).toHaveLength(1);
    expect(plans.enrollInChapterStreams).not.toHaveBeenCalled();
  });

  it('keeps a confirmed M’Cheyne definition and preserved inputs through refresh failure, then retries discovery without registering again', async () => {
    const selectedStreams = { ...retainedStreams, id: 'selected-streams-version', planId: 'selected-streams-plan' };
    const plans = api();
    vi.mocked(plans.listLatestPlanDefinitionVersions)
      .mockResolvedValueOnce([retainedDefinition, selectedStreams])
      .mockRejectedValueOnce(new Error('MCheyne discovery offline'))
      .mockResolvedValueOnce([retainedDefinition, selectedStreams, mcheyne]);
    render(<PlanPanel api={plans} />);
    const select = await screen.findByLabelText('Retained plan definition') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: selectedStreams.id } });
    const starts = await screen.findAllByLabelText('Retained starting chapter');
    fireEvent.change(starts[0], { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Custom plan JSON'), { target: { value: '{"keep":true}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register M’Cheyne plan' }));
    expect(await screen.findByText(/Retained definitions could not be refreshed after the confirmed write: Error: MCheyne discovery offline/)).toBeTruthy();
    expect(Array.from(select.options, option => option.value)).toContain(mcheyne.id);
    expect(select.value).toBe(selectedStreams.id);
    expect((screen.getByLabelText('Custom plan JSON') as HTMLTextAreaElement).value).toBe('{"keep":true}');
    expect((screen.getAllByLabelText('Retained starting chapter')[0] as HTMLSelectElement).value).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Retry retained definitions' }));
    await waitFor(() => expect(plans.listLatestPlanDefinitionVersions).toHaveBeenCalledTimes(3));
    expect(plans.registerMcheynePlan).toHaveBeenCalledTimes(1);
  });

  it('reports a M’Cheyne registration failure and permits one explicit retry', async () => {
    const plans = api();
    vi.mocked(plans.registerMcheynePlan).mockRejectedValueOnce(new Error('native unavailable'));
    render(<PlanPanel api={plans} />);
    fireEvent.click(screen.getByRole('button', { name: 'Register M’Cheyne plan' }));
    expect(await screen.findByText(/Could not register M’Cheyne plan: Error: native unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry M’Cheyne registration' }));
    await waitFor(() => expect(plans.registerMcheynePlan).toHaveBeenCalledTimes(2));
  });

  it('loads retained definitions in core order and distinguishes duplicate names by identity', async () => {
    let resolveDefinitions!: (value: PlanDefinitionVersion[]) => void;
    const plans = api();
    vi.mocked(plans.listLatestPlanDefinitionVersions).mockImplementationOnce(() => new Promise(resolve => { resolveDefinitions = resolve; }));
    render(<PlanPanel api={plans} />);
    expect(screen.getByText('Loading retained plan definitions…')).toBeTruthy();
    await act(async () => { resolveDefinitions([retainedDefinition, retainedExplicit]); });
    const select = screen.getByLabelText('Retained plan definition') as HTMLSelectElement;
    expect(Array.from(select.options, option => option.text)).toEqual([
      'Duplicate name · plan retained-plan-1',
      'Duplicate name · plan retained-plan-2',
    ]);
    expect(select.value).toBe(retainedDefinition.id);
    expect(screen.getByText(retainedDefinition.planId)).toBeTruthy();
    expect(screen.getByText('Chapter streams')).toBeTruthy();
    fireEvent.change(select, { target: { value: retainedExplicit.id } });
    expect(screen.getByText(retainedExplicit.planId)).toBeTruthy();
    expect(screen.getByText('Explicit schedule')).toBeTruthy();
    expect(plans.registerFourStreamPlan).not.toHaveBeenCalled();
    expect(plans.importPlanDefinitionJson).not.toHaveBeenCalled();
    expect(plans.enrollInChapterStreams).not.toHaveBeenCalled();
    expect(plans.completePlanStream).not.toHaveBeenCalled();
    expect(plans.undoPlanCompletion).not.toHaveBeenCalled();
  });

  it('shows empty retained definitions and retries a failed read without writes', async () => {
    const plans = api();
    vi.mocked(plans.listLatestPlanDefinitionVersions).mockRejectedValueOnce(new Error('definition discovery offline')).mockResolvedValueOnce([]);
    render(<PlanPanel api={plans} />);
    expect(await screen.findByText(/Could not load retained plan definitions: Error: definition discovery offline/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry retained definitions' }));
    expect(await screen.findByText('No retained plan definitions yet.')).toBeTruthy();
    expect(plans.listLatestPlanDefinitionVersions).toHaveBeenCalledTimes(2);
    expect(plans.enrollInChapterStreams).not.toHaveBeenCalled();
  });

  it('refreshes retained definitions after confirmed registration without changing the existing selection', async () => {
    const plans = api();
    vi.mocked(plans.listLatestPlanDefinitionVersions)
      .mockResolvedValueOnce([retainedDefinition, retainedExplicit])
      .mockResolvedValueOnce([retainedDefinition, retainedExplicit, fourStream]);
    render(<PlanPanel api={plans} />);
    const select = await screen.findByLabelText('Retained plan definition') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: retainedExplicit.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Set up four-stream plan' }));

    await waitFor(() => expect(plans.listLatestPlanDefinitionVersions).toHaveBeenCalledTimes(2));
    expect(Array.from(select.options, option => option.value)).toContain(fourStream.id);
    expect(select.value).toBe(retainedExplicit.id);
    expect(plans.registerFourStreamPlan).toHaveBeenCalledTimes(1);
    expect(plans.enrollInChapterStreams).not.toHaveBeenCalled();
  });

  it('retains a confirmed import through refresh failure and retries only discovery', async () => {
    const plans = api();
    vi.mocked(plans.listLatestPlanDefinitionVersions)
      .mockResolvedValueOnce([retainedDefinition, retainedExplicit])
      .mockRejectedValueOnce(new Error('post-import discovery offline'))
      .mockResolvedValueOnce([retainedDefinition, retainedExplicit, importedPlan]);
    render(<PlanPanel api={plans} />);
    const select = await screen.findByLabelText('Retained plan definition') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: retainedExplicit.id } });
    fireEvent.change(screen.getByLabelText('Custom plan JSON'), { target: { value: '{"schemaVersion":1}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import custom plan' }));

    expect(await screen.findByText(/Retained definitions could not be refreshed after the confirmed write: Error: post-import discovery offline/)).toBeTruthy();
    expect(Array.from(select.options, option => option.value)).toContain(importedPlan.id);
    expect(select.value).toBe(retainedExplicit.id);
    fireEvent.click(screen.getByRole('button', { name: 'Retry retained definitions' }));
    await waitFor(() => expect(plans.listLatestPlanDefinitionVersions).toHaveBeenCalledTimes(3));
    expect(Array.from(select.options, option => option.value)).toContain(importedPlan.id);
    expect(select.value).toBe(retainedExplicit.id);
    expect(plans.importPlanDefinitionJson).toHaveBeenCalledTimes(1);
  });

  it('ignores an older post-import refresh after a newer write and later selection', async () => {
    let resolveFirstRefresh!: (value: PlanDefinitionVersion[]) => void;
    const newerImport = { ...importedPlan, id: 'newer-version', planId: 'newer-plan', definition: { ...importedPlan.definition, name: 'Newer imported plan' } };
    const plans = api();
    vi.mocked(plans.listLatestPlanDefinitionVersions)
      .mockResolvedValueOnce([retainedDefinition, retainedExplicit])
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirstRefresh = resolve; }))
      .mockResolvedValueOnce([retainedDefinition, retainedExplicit, newerImport]);
    vi.mocked(plans.importPlanDefinitionJson).mockResolvedValueOnce(importedPlan).mockResolvedValueOnce(newerImport);
    render(<PlanPanel api={plans} />);
    const select = await screen.findByLabelText('Retained plan definition') as HTMLSelectElement;
    fireEvent.change(screen.getByLabelText('Custom plan JSON'), { target: { value: '{"first":true}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import custom plan' }));
    await screen.findByText('Imported streams');
    fireEvent.change(screen.getByLabelText('Custom plan JSON'), { target: { value: '{"second":true}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import custom plan' }));
    await screen.findByText('Newer imported plan');
    fireEvent.change(select, { target: { value: retainedExplicit.id } });
    await act(async () => { resolveFirstRefresh([retainedDefinition, importedPlan]); });

    expect(select.value).toBe(retainedExplicit.id);
    expect(Array.from(select.options, option => option.value)).toEqual([
      retainedDefinition.id,
      retainedExplicit.id,
      newerImport.id,
      importedPlan.id,
    ]);
    expect(plans.importPlanDefinitionJson).toHaveBeenCalledTimes(2);
  });

  it('discards post-write discovery settlement after API replacement and unmount', async () => {
    let resolveOldRefresh!: (value: PlanDefinitionVersion[]) => void;
    let rejectUnmountedRefresh!: (reason: unknown) => void;
    const oldApi = api();
    const currentApi = api();
    vi.mocked(oldApi.listLatestPlanDefinitionVersions)
      .mockResolvedValueOnce([retainedDefinition])
      .mockImplementationOnce(() => new Promise(resolve => { resolveOldRefresh = resolve; }));
    vi.mocked(currentApi.listLatestPlanDefinitionVersions).mockResolvedValueOnce([retainedExplicit]);
    const view = render(<PlanPanel api={oldApi} />);
    await screen.findByLabelText('Retained plan definition');
    fireEvent.change(screen.getByLabelText('Custom plan JSON'), { target: { value: '{"old":true}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import custom plan' }));
    await waitFor(() => expect(oldApi.listLatestPlanDefinitionVersions).toHaveBeenCalledTimes(2));
    view.rerender(<PlanPanel api={currentApi} />);
    expect((await screen.findByLabelText('Retained plan definition') as HTMLSelectElement).value).toBe(retainedExplicit.id);
    await act(async () => { resolveOldRefresh([retainedDefinition, importedPlan]); });
    expect((screen.getByLabelText('Retained plan definition') as HTMLSelectElement).value).toBe(retainedExplicit.id);

    const lateApi = api();
    vi.mocked(lateApi.listLatestPlanDefinitionVersions)
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectUnmountedRefresh = reject; }));
    const lateView = render(<PlanPanel api={lateApi} />);
    await screen.findByText('No retained plan definitions yet.');
    fireEvent.change(screen.getAllByLabelText('Custom plan JSON')[1], { target: { value: '{"late":true}' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Import custom plan' })[1]);
    await waitFor(() => expect(lateApi.listLatestPlanDefinitionVersions).toHaveBeenCalledTimes(2));
    lateView.unmount();
    await act(async () => { rejectUnmountedRefresh(new Error('late failure')); });
    expect(lateView.container.textContent).toBe('');
  });

  it('ignores obsolete retained-definition success after API replacement and rejection after unmount', async () => {
    let resolveOld!: (value: PlanDefinitionVersion[]) => void;
    let rejectLate!: (reason: unknown) => void;
    const oldApi = api();
    const currentApi = api();
    vi.mocked(oldApi.listLatestPlanDefinitionVersions).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    vi.mocked(currentApi.listLatestPlanDefinitionVersions).mockResolvedValueOnce([retainedExplicit]);
    const view = render(<PlanPanel api={oldApi} />);
    view.rerender(<PlanPanel api={currentApi} />);
    expect((await screen.findByLabelText('Retained plan definition') as HTMLSelectElement).value).toBe(retainedExplicit.id);
    await act(async () => { resolveOld([retainedDefinition]); });
    expect((screen.getByLabelText('Retained plan definition') as HTMLSelectElement).value).toBe(retainedExplicit.id);
    view.unmount();

    const lateApi = api();
    vi.mocked(lateApi.listLatestPlanDefinitionVersions).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectLate = reject; }));
    const lateView = render(<PlanPanel api={lateApi} />);
    lateView.unmount();
    await act(async () => { rejectLate(new Error('late definition rejection')); });
    expect(lateView.container.textContent).toBe('');
  });

  it('discovers retained unenrolled definitions again after remount', async () => {
    const plans = api();
    vi.mocked(plans.listLatestPlanDefinitionVersions).mockResolvedValue([retainedDefinition]);
    const firstView = render(<PlanPanel api={plans} />);
    expect(await screen.findByText(retainedDefinition.planId)).toBeTruthy();
    firstView.unmount();
    render(<PlanPanel api={plans} />);
    expect(await screen.findByText(retainedDefinition.planId)).toBeTruthy();
    expect(plans.listLatestPlanDefinitionVersions).toHaveBeenCalledTimes(2);
    expect(plans.listPlanEnrollments).toHaveBeenCalledTimes(2);
  });

  it('exports the exact selected retained version for duplicate names and both schedule kinds', async () => {
    const plans = api();
    vi.mocked(plans.listLatestPlanDefinitionVersions).mockResolvedValue([retainedDefinition, retainedExplicit]);
    render(<PlanPanel api={plans} />);
    const select = await screen.findByLabelText('Retained plan definition');
    fireEvent.click(screen.getByRole('button', { name: 'Export retained definition JSON' }));
    expect((await screen.findByLabelText('Exported retained plan JSON') as HTMLTextAreaElement).value).toBe('{"versionId":"retained-version-1"}');
    expect(plans.exportPlanDefinitionJson).toHaveBeenLastCalledWith(retainedDefinition.id);
    fireEvent.change(select, { target: { value: retainedExplicit.id } });
    expect(screen.queryByLabelText('Exported retained plan JSON')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Export retained definition JSON' }));
    expect((await screen.findByLabelText('Exported retained plan JSON') as HTMLTextAreaElement).value).toBe('{"versionId":"retained-version-2"}');
    expect(plans.exportPlanDefinitionJson).toHaveBeenLastCalledWith(retainedExplicit.id);
    expect(plans.importPlanDefinitionJson).not.toHaveBeenCalled();
    expect(plans.enrollInChapterStreams).not.toHaveBeenCalled();
  });

  it('settles and retries an export clicked after discovery commit but before passive effects', async () => {
    let resolveDefinitions!: (definitions: PlanDefinitionVersion[]) => void;
    let rejectExport!: (error: Error) => void;
    const plans = api();
    vi.mocked(plans.listLatestPlanDefinitionVersions).mockImplementationOnce(() => new Promise(resolve => { resolveDefinitions = resolve; }));
    vi.mocked(plans.exportPlanDefinitionJson)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectExport = reject; }))
      .mockResolvedValueOnce('{"recovered":true}');
    render(<PlanPanel api={plans} />);

    const clickedBeforePassiveEffects = clickRetainedExportOnCommit();
    resolveDefinitions([retainedDefinition]);
    await clickedBeforePassiveEffects;
    expect((screen.getByRole('button', { name: 'Exporting retained definition JSON…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { rejectExport(new Error('commit-window failure')); });
    expect(screen.getByText(/Could not export retained plan JSON: Error: commit-window failure/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry retained definition JSON' }));

    expect((await screen.findByLabelText('Exported retained plan JSON') as HTMLTextAreaElement).value).toBe('{"recovered":true}');
    expect(plans.exportPlanDefinitionJson).toHaveBeenNthCalledWith(1, retainedDefinition.id);
    expect(plans.exportPlanDefinitionJson).toHaveBeenNthCalledWith(2, retainedDefinition.id);
  });

  it('shows a retained-definition export failure and permits a retry without changing other plan state', async () => {
    const plans = api();
    vi.mocked(plans.listLatestPlanDefinitionVersions).mockResolvedValue([retainedCalendar]);
    vi.mocked(plans.exportPlanDefinitionJson).mockRejectedValueOnce(new Error('export offline')).mockResolvedValueOnce('{"recovered":true}');
    render(<PlanPanel api={plans} />);
    await screen.findByLabelText('Retained plan definition');
    fireEvent.click(screen.getByRole('button', { name: 'Export retained definition JSON' }));
    expect(await screen.findByText(/Could not export retained plan JSON: Error: export offline/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry retained definition JSON' }));
    expect((await screen.findByLabelText('Exported retained plan JSON') as HTMLTextAreaElement).value).toBe('{"recovered":true}');
    expect(plans.listPlanEnrollments).toHaveBeenCalledTimes(1);
    expect(plans.registerFourStreamPlan).not.toHaveBeenCalled();
    expect(plans.enrollInChapterStreams).not.toHaveBeenCalled();
  });

  it('captures the selected calendar version, local date, and both explicit policies once', async () => {
    let resolveEnrollment!: (value: typeof calendarEnrollment) => void;
    const plans = api();
    vi.mocked(plans.listLatestPlanDefinitionVersions).mockResolvedValue([retainedCalendar]);
    vi.mocked(plans.enrollInCalendar)
      .mockImplementationOnce(() => new Promise(resolve => { resolveEnrollment = resolve; }))
      .mockResolvedValueOnce({ ...calendarEnrollment, scheduleMode: 'dayOne' });
    const firstView = render(<PlanPanel api={plans} />);
    const defaultDate = await screen.findByLabelText('Calendar start date') as HTMLInputElement;
    expect(defaultDate.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((screen.getByLabelText('Calendar schedule policy') as HTMLSelectElement).value).toBe('calendarAligned');
    expect(screen.getByText(/On February 29, it schedules no set so the day is available for catch-up or rest/)).toBeTruthy();
    expect(screen.getByText(/Start from day one schedules all 365 sets.*February 29 as an ordinary scheduled day/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Calendar start date'), { target: { value: '2026-03-01' } });
    const create = screen.getByRole('button', { name: 'Create calendar enrollment' });
    fireEvent.click(create); fireEvent.click(create);
    expect(plans.enrollInCalendar).toHaveBeenCalledTimes(1);
    expect(plans.enrollInCalendar).toHaveBeenNthCalledWith(1, {
      definitionVersionId: retainedCalendar.id,
      startDate: '2026-03-01',
      scheduleMode: 'calendarAligned',
    });
    expect((screen.getByRole('button', { name: 'Creating calendar enrollment…' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Calendar start date'), { target: { value: '2026-04-02' } });
    fireEvent.change(screen.getByLabelText('Calendar schedule policy'), { target: { value: 'dayOne' } });
    await act(async () => { resolveEnrollment(calendarEnrollment); });
    expect(await screen.findByText(/Calendar enrollment calendar-enrollment was created/)).toBeTruthy();
    firstView.unmount();

    const retryPlans = api();
    vi.mocked(retryPlans.listLatestPlanDefinitionVersions).mockResolvedValue([retainedCalendar]);
    render(<PlanPanel api={retryPlans} />);
    fireEvent.change(await screen.findByLabelText('Calendar start date'), { target: { value: '2026-04-02' } });
    fireEvent.change(screen.getByLabelText('Calendar schedule policy'), { target: { value: 'dayOne' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create calendar enrollment' }));
    await waitFor(() => expect(retryPlans.enrollInCalendar).toHaveBeenCalledWith({
      definitionVersionId: retainedCalendar.id,
      startDate: '2026-04-02',
      scheduleMode: 'dayOne',
    }));
  });

  it('preserves calendar inputs through failure and retries with the current captured values', async () => {
    const plans = api();
    vi.mocked(plans.listLatestPlanDefinitionVersions).mockResolvedValue([retainedCalendar]);
    vi.mocked(plans.enrollInCalendar).mockRejectedValueOnce(new Error('calendar unavailable'));
    render(<PlanPanel api={plans} />);
    const dateInput = await screen.findByLabelText('Calendar start date') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2026-05-03' } });
    fireEvent.change(screen.getByLabelText('Calendar schedule policy'), { target: { value: 'dayOne' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create calendar enrollment' }));
    expect(await screen.findByText(/Could not create calendar enrollment: Error: calendar unavailable/)).toBeTruthy();
    expect(dateInput.value).toBe('2026-05-03');
    expect((screen.getByLabelText('Calendar schedule policy') as HTMLSelectElement).value).toBe('dayOne');
    fireEvent.click(screen.getByRole('button', { name: 'Retry calendar enrollment' }));
    await waitFor(() => expect(plans.enrollInCalendar).toHaveBeenCalledTimes(2));
    expect(plans.enrollInCalendar).toHaveBeenLastCalledWith({ definitionVersionId: retainedCalendar.id, startDate: '2026-05-03', scheduleMode: 'dayOne' });
  });

  it('reads retained calendar enrollment metadata and dated passages without enrolling', async () => {
    const retained = { ...calendarEnrollment, id: 'calendar-retained' };
    const enrollment: PlanEnrollment = { id: retained.id, definitionVersionId: retained.definitionVersionId, createdAt: retained.createdAt };
    const plans = api();
    vi.mocked(plans.listPlanEnrollments).mockResolvedValue([enrollment, second]);
    vi.mocked(plans.getCalendarPlanEnrollment).mockImplementation(async id => id === retained.id ? retained : null);
    vi.mocked(plans.calendarPlanAssignments).mockResolvedValue([{ id: 'dated-1', enrollmentId: retained.id, definitionVersionId: retained.definitionVersionId, definitionDay: 60, localDate: '2026-03-01', passages: [{ book: 1, chapter: 1 }, { book: 43, chapter: 3, startVerse: 16, endVerse: 16 }, { book: 2, chapter: 12, startVerse: 21, endVerse: 51 }] }]);
    render(<PlanPanel api={plans} />);
    expect(await screen.findByLabelText('Retained calendar enrollment')).toBeTruthy();
    expect(screen.getByText(/Calendar policy calendarAligned, starting 2026-03-01/)).toBeTruthy();
    expect(await screen.findByText('2026-03-01')).toBeTruthy();
    expect(screen.getByText('Definition day 60')).toBeTruthy();
    expect(screen.getByText('Genesis 1; John 3:16; Exodus 12:21–51')).toBeTruthy();
    expect(screen.getByText('Assignment dated-1 · Definition version retained-calendar-version')).toBeTruthy();
    expect(plans.enrollInCalendar).not.toHaveBeenCalled();
  });

  it('explicitly completes the exact calendar assignment once and refreshes retained history', async () => {
    const retained = { ...calendarEnrollment, id: 'calendar-completable' };
    const assignment: DatedPlanAssignment = { id: 'dated-completable', enrollmentId: retained.id, definitionVersionId: retained.definitionVersionId, definitionDay: 60, localDate: retained.startDate, passages: [{ book: 43, chapter: 3, startVerse: 16, endVerse: 16 }] };
    const completion = { id: 'calendar-completion-exact', assignmentId: assignment.id, enrollmentId: retained.id, completedAt: '2026-09-18T00:00:07Z' };
    const pending = deferred<typeof completion>();
    const plans = api();
    vi.mocked(plans.listPlanEnrollments).mockResolvedValue([{ id: retained.id, definitionVersionId: retained.definitionVersionId, createdAt: retained.createdAt }]);
    vi.mocked(plans.getCalendarPlanEnrollment).mockResolvedValue(retained);
    vi.mocked(plans.calendarPlanAssignments).mockResolvedValue([assignment]);
    vi.mocked(plans.completeCalendarAssignment).mockReturnValue(pending.promise);
    vi.mocked(plans.calendarCompletionHistory).mockResolvedValueOnce([]).mockResolvedValueOnce([completion]);
    render(<PlanPanel api={plans} />);
    const button = await screen.findByRole('button', { name: 'Complete calendar assignment' });
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('button', { name: 'Completing calendar assignment…' }));
    expect(plans.completeCalendarAssignment).toHaveBeenCalledTimes(1);
    expect(plans.completeCalendarAssignment).toHaveBeenCalledWith({ enrollmentId: retained.id, assignmentId: assignment.id });
    await act(async () => { pending.resolve(completion); });
    expect(await screen.findByText(`Completed ${completion.completedAt} · Completion ${completion.id}`)).toBeTruthy();
    expect(screen.getByText('John 3:16')).toBeTruthy();
  });

  it('keeps calendar assignments visible and offers retry after completion rejection', async () => {
    const retained = { ...calendarEnrollment, id: 'calendar-rejected' };
    const assignment: DatedPlanAssignment = { id: 'dated-rejected', enrollmentId: retained.id, definitionVersionId: retained.definitionVersionId, definitionDay: 1, localDate: retained.startDate, passages: [{ book: 1, chapter: 1 }] };
    const plans = api();
    vi.mocked(plans.listPlanEnrollments).mockResolvedValue([{ id: retained.id, definitionVersionId: retained.definitionVersionId, createdAt: retained.createdAt }]);
    vi.mocked(plans.getCalendarPlanEnrollment).mockResolvedValue(retained);
    vi.mocked(plans.calendarPlanAssignments).mockResolvedValue([assignment]);
    vi.mocked(plans.completeCalendarAssignment).mockRejectedValueOnce(new Error('stale assignment')).mockResolvedValue({ id: 'retry-completion', assignmentId: assignment.id, enrollmentId: retained.id, completedAt: '2026-09-18T00:00:08Z' });
    vi.mocked(plans.calendarCompletionHistory).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'retry-completion', assignmentId: assignment.id, enrollmentId: retained.id, completedAt: '2026-09-18T00:00:08Z' }]);
    render(<PlanPanel api={plans} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Complete calendar assignment' }));
    expect(await screen.findByText(/Could not complete calendar assignment: Error: stale assignment/)).toBeTruthy();
    expect(screen.getByText('Genesis 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Complete calendar assignment' }));
    expect(await screen.findByText(/Completion retry-completion/)).toBeTruthy();
  });

  it('guards deferred calendar history across A-B-A selection, API replacement, and unmount without writes', async () => {
    const aFirst = deferred<Awaited<ReturnType<PlanDefinitionApi['calendarCompletionHistory']>>>();
    const bRead = deferred<Awaited<ReturnType<PlanDefinitionApi['calendarCompletionHistory']>>>();
    const aCurrent = deferred<Awaited<ReturnType<PlanDefinitionApi['calendarCompletionHistory']>>>();
    const oldApiRead = deferred<Awaited<ReturnType<PlanDefinitionApi['calendarCompletionHistory']>>>();
    const unmountedRead = deferred<Awaited<ReturnType<PlanDefinitionApi['calendarCompletionHistory']>>>();
    const a = { ...calendarEnrollment, id: 'calendar-history-a' };
    const b = { ...calendarEnrollment, id: 'calendar-history-b', startDate: '2026-04-02' };
    const assignment = (item: typeof a): DatedPlanAssignment => ({ id: `dated-${item.id}`, enrollmentId: item.id, definitionVersionId: item.definitionVersionId, definitionDay: 1, localDate: item.startDate, passages: [{ book: 43, chapter: 3, startVerse: 16, endVerse: 16 }] });
    const currentCompletion = { id: 'completion-current-a', assignmentId: assignment(a).id, enrollmentId: a.id, completedAt: '2026-09-18T00:00:09Z' };
    const plans = api();
    vi.mocked(plans.listPlanEnrollments).mockResolvedValue([a, b]);
    vi.mocked(plans.getCalendarPlanEnrollment).mockImplementation(async id => id === a.id ? a : b);
    vi.mocked(plans.calendarPlanAssignments).mockImplementation(async id => [assignment(id === a.id ? a : b)]);
    let aReads = 0;
    vi.mocked(plans.calendarCompletionHistory).mockImplementation(id => {
      if (id === b.id) return bRead.promise;
      aReads += 1;
      return aReads === 1 ? aFirst.promise : aCurrent.promise;
    });
    const view = render(<PlanPanel api={plans} />);
    const select = await screen.findByLabelText('Retained calendar enrollment');
    await waitFor(() => expect(plans.calendarCompletionHistory).toHaveBeenCalledWith(a.id));
    fireEvent.change(select, { target: { value: b.id } });
    await waitFor(() => expect(plans.calendarCompletionHistory).toHaveBeenCalledWith(b.id));
    fireEvent.change(select, { target: { value: a.id } });
    await waitFor(() => expect(aReads).toBe(2));
    await act(async () => { aCurrent.resolve([currentCompletion]); });
    expect(await screen.findByText(`Completed ${currentCompletion.completedAt} · Completion ${currentCompletion.id}`)).toBeTruthy();
    await act(async () => { aFirst.resolve([]); bRead.reject(new Error('obsolete B history')); });
    expect(screen.getByText(`Completed ${currentCompletion.completedAt} · Completion ${currentCompletion.id}`)).toBeTruthy();
    expect(screen.queryByText(/obsolete B history/)).toBeNull();
    expect((screen.getByLabelText('Retained calendar enrollment') as HTMLSelectElement).value).toBe(a.id);
    expect(plans.completeCalendarAssignment).not.toHaveBeenCalled();

    const replacement = api();
    vi.mocked(replacement.listPlanEnrollments).mockResolvedValue([a]);
    vi.mocked(replacement.getCalendarPlanEnrollment).mockResolvedValue(a);
    vi.mocked(replacement.calendarPlanAssignments).mockResolvedValue([assignment(a)]);
    vi.mocked(replacement.calendarCompletionHistory).mockReturnValueOnce(oldApiRead.promise).mockReturnValueOnce(unmountedRead.promise);
    view.rerender(<PlanPanel api={replacement} />);
    await waitFor(() => expect(replacement.calendarCompletionHistory).toHaveBeenCalledWith(a.id));
    await act(async () => { oldApiRead.reject(new Error('replacement history offline')); });
    expect(screen.queryByText(/replacement history offline/)).toBeNull();
    expect(screen.getByText('John 3:16')).toBeTruthy();
    await waitFor(() => expect(replacement.calendarCompletionHistory).toHaveBeenCalledTimes(2));
    view.unmount();
    await act(async () => { unmountedRead.reject(new Error('after unmount')); });
    expect(view.container.textContent).toBe('');
    expect(replacement.completeCalendarAssignment).not.toHaveBeenCalled();
  });

  it.each(['success', 'rejection'] as const)('ignores stale calendar completion %s after selection changes', async settlement => {
    const pending = deferred<{ id: string; assignmentId: string; enrollmentId: string; completedAt: string }>();
    const a = { ...calendarEnrollment, id: `calendar-completion-a-${settlement}` };
    const b = { ...calendarEnrollment, id: `calendar-completion-b-${settlement}`, startDate: '2026-04-02' };
    const assignment = (item: typeof a): DatedPlanAssignment => ({ id: `dated-${item.id}`, enrollmentId: item.id, definitionVersionId: item.definitionVersionId, definitionDay: 1, localDate: item.startDate, passages: [{ book: 1, chapter: 1 }] });
    const plans = api();
    vi.mocked(plans.listPlanEnrollments).mockResolvedValue([a, b]);
    vi.mocked(plans.getCalendarPlanEnrollment).mockImplementation(async id => id === a.id ? a : b);
    vi.mocked(plans.calendarPlanAssignments).mockImplementation(async id => [assignment(id === a.id ? a : b)]);
    vi.mocked(plans.calendarCompletionHistory).mockResolvedValue([]);
    vi.mocked(plans.completeCalendarAssignment).mockReturnValue(pending.promise);
    render(<PlanPanel api={plans} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Complete calendar assignment' }));
    expect(plans.completeCalendarAssignment).toHaveBeenCalledWith({ enrollmentId: a.id, assignmentId: assignment(a).id });
    fireEvent.change(screen.getByLabelText('Retained calendar enrollment'), { target: { value: b.id } });
    expect(await screen.findByText(b.startDate)).toBeTruthy();
    await act(async () => settlement === 'success'
      ? pending.resolve({ id: 'obsolete-completion', assignmentId: assignment(a).id, enrollmentId: a.id, completedAt: '2026-09-18T00:00:10Z' })
      : pending.reject(new Error('obsolete completion rejection')));
    expect((screen.getByLabelText('Retained calendar enrollment') as HTMLSelectElement).value).toBe(b.id);
    expect(screen.getByText(b.startDate)).toBeTruthy();
    expect(screen.queryByText(/obsolete-completion|obsolete completion rejection/)).toBeNull();
    expect(plans.completeCalendarAssignment).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'rejection'] as const)('keeps the current history after pending old-API history %s settles', async settlement => {
    const oldRead = deferred<Awaited<ReturnType<PlanDefinitionApi['calendarCompletionHistory']>>>();
    const enrollment = { ...calendarEnrollment, id: `calendar-old-api-history-${settlement}` };
    const assignment: DatedPlanAssignment = { id: `dated-old-api-history-${settlement}`, enrollmentId: enrollment.id, definitionVersionId: enrollment.definitionVersionId, definitionDay: 1, localDate: enrollment.startDate, passages: [{ book: 43, chapter: 3, startVerse: 16, endVerse: 16 }] };
    const current = { id: `current-history-${settlement}`, assignmentId: assignment.id, enrollmentId: enrollment.id, completedAt: '2026-09-18T00:00:11Z' };
    const oldPlans = api();
    const currentPlans = api();
    for (const plans of [oldPlans, currentPlans]) {
      vi.mocked(plans.listPlanEnrollments).mockResolvedValue([enrollment]);
      vi.mocked(plans.getCalendarPlanEnrollment).mockResolvedValue(enrollment);
      vi.mocked(plans.calendarPlanAssignments).mockResolvedValue([assignment]);
    }
    vi.mocked(oldPlans.calendarCompletionHistory).mockReturnValue(oldRead.promise);
    vi.mocked(currentPlans.calendarCompletionHistory).mockResolvedValue([current]);
    const view = render(<PlanPanel api={oldPlans} />);
    await waitFor(() => expect(oldPlans.calendarCompletionHistory).toHaveBeenCalledWith(enrollment.id));
    view.rerender(<PlanPanel api={currentPlans} />);
    expect(await screen.findByText(`Completed ${current.completedAt} · Completion ${current.id}`)).toBeTruthy();
    await act(async () => settlement === 'success' ? oldRead.resolve([]) : oldRead.reject(new Error('obsolete old history')));
    expect(screen.getByText(`Completed ${current.completedAt} · Completion ${current.id}`)).toBeTruthy();
    expect(screen.queryByText(/obsolete old history/)).toBeNull();
    expect(oldPlans.completeCalendarAssignment).not.toHaveBeenCalled();
    expect(currentPlans.completeCalendarAssignment).not.toHaveBeenCalled();
  });

  it.each(['success', 'rejection'] as const)('keeps current A completion pending after obsolete A-B-A %s settlement', async settlement => {
    const obsolete = deferred<Awaited<ReturnType<PlanDefinitionApi['completeCalendarAssignment']>>>();
    const current = deferred<Awaited<ReturnType<PlanDefinitionApi['completeCalendarAssignment']>>>();
    const a = { ...calendarEnrollment, id: `calendar-completion-aba-a-${settlement}` };
    const b = { ...calendarEnrollment, id: `calendar-completion-aba-b-${settlement}`, startDate: '2026-04-02' };
    const assignment = (item: typeof a): DatedPlanAssignment => ({ id: `dated-${item.id}`, enrollmentId: item.id, definitionVersionId: item.definitionVersionId, definitionDay: 1, localDate: item.startDate, passages: [{ book: 1, chapter: 1 }] });
    const plans = api();
    vi.mocked(plans.listPlanEnrollments).mockResolvedValue([a, b]);
    vi.mocked(plans.getCalendarPlanEnrollment).mockImplementation(async id => id === a.id ? a : b);
    vi.mocked(plans.calendarPlanAssignments).mockImplementation(async id => [assignment(id === a.id ? a : b)]);
    vi.mocked(plans.calendarCompletionHistory).mockResolvedValue([]);
    vi.mocked(plans.completeCalendarAssignment).mockReturnValueOnce(obsolete.promise).mockReturnValueOnce(current.promise);
    render(<PlanPanel api={plans} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Complete calendar assignment' }));
    fireEvent.change(screen.getByLabelText('Retained calendar enrollment'), { target: { value: b.id } });
    await screen.findByText(b.startDate);
    fireEvent.change(screen.getByLabelText('Retained calendar enrollment'), { target: { value: a.id } });
    fireEvent.click(await screen.findByRole('button', { name: 'Complete calendar assignment' }));
    expect(plans.completeCalendarAssignment).toHaveBeenNthCalledWith(2, { enrollmentId: a.id, assignmentId: assignment(a).id });
    await act(async () => settlement === 'success' ? obsolete.resolve({ id: 'obsolete', assignmentId: assignment(a).id, enrollmentId: a.id, completedAt: '2026-09-18T00:00:12Z' }) : obsolete.reject(new Error('obsolete A completion')));
    expect(screen.getByRole('button', { name: 'Completing calendar assignment…' })).toBeTruthy();
    expect(screen.queryByText(/obsolete A completion|Completion obsolete/)).toBeNull();
    await act(async () => current.reject(new Error('current A failure')));
    expect(await screen.findByText(/current A failure/)).toBeTruthy();
    expect(plans.completeCalendarAssignment).toHaveBeenCalledTimes(2);
  });

  it.each(['success', 'rejection'] as const)('ignores pending completion %s after API replacement and unmount', async settlement => {
    const oldPending = deferred<Awaited<ReturnType<PlanDefinitionApi['completeCalendarAssignment']>>>();
    const unmountedPending = deferred<Awaited<ReturnType<PlanDefinitionApi['completeCalendarAssignment']>>>();
    const enrollment = { ...calendarEnrollment, id: `calendar-completion-api-${settlement}` };
    const assignment: DatedPlanAssignment = { id: `dated-completion-api-${settlement}`, enrollmentId: enrollment.id, definitionVersionId: enrollment.definitionVersionId, definitionDay: 1, localDate: enrollment.startDate, passages: [{ book: 1, chapter: 1 }] };
    const oldPlans = api();
    const replacement = api();
    for (const plans of [oldPlans, replacement]) {
      vi.mocked(plans.listPlanEnrollments).mockResolvedValue([enrollment]);
      vi.mocked(plans.getCalendarPlanEnrollment).mockResolvedValue(enrollment);
      vi.mocked(plans.calendarPlanAssignments).mockResolvedValue([assignment]);
      vi.mocked(plans.calendarCompletionHistory).mockResolvedValue([]);
    }
    vi.mocked(oldPlans.completeCalendarAssignment).mockReturnValue(oldPending.promise);
    vi.mocked(replacement.completeCalendarAssignment).mockReturnValue(unmountedPending.promise);
    const view = render(<PlanPanel api={oldPlans} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Complete calendar assignment' }));
    view.rerender(<PlanPanel api={replacement} />);
    const replacementButton = await screen.findByRole('button', { name: 'Complete calendar assignment' });
    await act(async () => settlement === 'success' ? oldPending.resolve({ id: 'old-api-completion', assignmentId: assignment.id, enrollmentId: enrollment.id, completedAt: '2026-09-18T00:00:13Z' }) : oldPending.reject(new Error('old API completion')));
    expect(screen.queryByText(/old-api-completion|old API completion/)).toBeNull();
    fireEvent.click(replacementButton);
    expect(replacement.completeCalendarAssignment).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => settlement === 'success' ? unmountedPending.resolve({ id: 'unmounted', assignmentId: assignment.id, enrollmentId: enrollment.id, completedAt: '2026-09-18T00:00:14Z' }) : unmountedPending.reject(new Error('unmounted completion')));
    expect(view.container.textContent).toBe('');
    expect(oldPlans.completeCalendarAssignment).toHaveBeenCalledTimes(1);
    expect(replacement.completeCalendarAssignment).toHaveBeenCalledTimes(1);
  });

  it('preserves dated assignment metadata while confirmed-completion history refreshes or fails without replaying the write', async () => {
    const retained = { ...calendarEnrollment, id: 'calendar-history-refresh' };
    const assignment: DatedPlanAssignment = { id: 'dated-history-refresh', enrollmentId: retained.id, definitionVersionId: retained.definitionVersionId, definitionDay: 60, localDate: retained.startDate, passages: [{ book: 2, chapter: 12, startVerse: 21, endVerse: 51 }] };
    const completion = { id: 'completion-history-refresh', assignmentId: assignment.id, enrollmentId: retained.id, completedAt: '2026-09-18T00:00:09Z' };
    const refresh = deferred<typeof completion[]>();
    const plans = api();
    vi.mocked(plans.listPlanEnrollments).mockResolvedValue([{ id: retained.id, definitionVersionId: retained.definitionVersionId, createdAt: retained.createdAt }]);
    vi.mocked(plans.getCalendarPlanEnrollment).mockResolvedValue(retained);
    vi.mocked(plans.calendarPlanAssignments).mockResolvedValue([assignment]);
    vi.mocked(plans.completeCalendarAssignment).mockResolvedValue(completion);
    vi.mocked(plans.calendarCompletionHistory).mockResolvedValueOnce([]).mockReturnValueOnce(refresh.promise).mockResolvedValueOnce([completion]);
    render(<PlanPanel api={plans} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Complete calendar assignment' }));
    expect(await screen.findByText('Completion status is loading.')).toBeTruthy();
    expect(screen.getByText('2026-03-01')).toBeTruthy();
    expect(screen.getByText('Exodus 12:21–51')).toBeTruthy();
    expect(screen.getByText(`Assignment ${assignment.id} · Definition version ${assignment.definitionVersionId}`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Complete calendar assignment' })).toBeNull();
    expect(screen.queryByText(/Completed 2026-09-18T00:00:09Z/)).toBeNull();
    await act(async () => { refresh.reject(new Error('history offline')); });
    expect(await screen.findByText(/Could not load calendar completion history: Error: history offline/)).toBeTruthy();
    expect(screen.getByText('Completion status is unavailable.')).toBeTruthy();
    expect(screen.getByText('Exodus 12:21–51')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Complete calendar assignment' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry calendar completion history' }));
    expect(await screen.findByText(`Completed ${completion.completedAt} · Completion ${completion.id}`)).toBeTruthy();
    expect(plans.completeCalendarAssignment).toHaveBeenCalledTimes(1);
    expect(plans.calendarCompletionHistory).toHaveBeenCalledTimes(3);
  });

  it('keeps initial calendar assignments visible but completion status unknown until history retry succeeds', async () => {
    const retained = { ...calendarEnrollment, id: 'calendar-history-initial-failure' };
    const assignment: DatedPlanAssignment = { id: 'dated-history-initial-failure', enrollmentId: retained.id, definitionVersionId: retained.definitionVersionId, definitionDay: 1, localDate: retained.startDate, passages: [{ book: 43, chapter: 3, startVerse: 16, endVerse: 16 }] };
    const plans = api();
    vi.mocked(plans.listPlanEnrollments).mockResolvedValue([{ id: retained.id, definitionVersionId: retained.definitionVersionId, createdAt: retained.createdAt }]);
    vi.mocked(plans.getCalendarPlanEnrollment).mockResolvedValue(retained);
    vi.mocked(plans.calendarPlanAssignments).mockResolvedValue([assignment]);
    vi.mocked(plans.calendarCompletionHistory).mockRejectedValueOnce(new Error('initial history offline')).mockResolvedValueOnce([]);
    render(<PlanPanel api={plans} />);
    expect(await screen.findByText(/Could not load calendar completion history: Error: initial history offline/)).toBeTruthy();
    expect(screen.getByText('2026-03-01')).toBeTruthy();
    expect(screen.getByText('John 3:16')).toBeTruthy();
    expect(screen.getByText(`Assignment ${assignment.id} · Definition version ${assignment.definitionVersionId}`)).toBeTruthy();
    expect(screen.getByText('Completion status is unavailable.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Complete calendar assignment' })).toBeNull();
    expect(plans.completeCalendarAssignment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry calendar completion history' }));
    expect(await screen.findByRole('button', { name: 'Complete calendar assignment' })).toBeTruthy();
  });

  it('refreshes confirmed calendar enrollment discovery without re-enrolling', async () => {
    const plans = api();
    vi.mocked(plans.listLatestPlanDefinitionVersions).mockResolvedValue([retainedCalendar]);
    vi.mocked(plans.listPlanEnrollments).mockResolvedValue([]);
    vi.mocked(plans.getCalendarPlanEnrollment).mockImplementation(async id => id === calendarEnrollment.id ? calendarEnrollment : null);
    vi.mocked(plans.calendarPlanAssignments).mockResolvedValue([]);
    render(<PlanPanel api={plans} />);
    fireEvent.change(await screen.findByLabelText('Calendar start date'), { target: { value: calendarEnrollment.startDate } });
    fireEvent.click(screen.getByRole('button', { name: 'Create calendar enrollment' }));
    expect(await screen.findByLabelText('Retained calendar enrollment')).toBeTruthy();
    expect(await screen.findByText('No retained calendar assignments.')).toBeTruthy();
    expect(plans.enrollInCalendar).toHaveBeenCalledTimes(1);
    expect(vi.mocked(plans.listPlanEnrollments).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps a calendar-only restart out of stream exhaustion, completion, and history UI', async () => {
    const retained = { ...calendarEnrollment, id: 'calendar-only' };
    const enrollment: PlanEnrollment = { id: retained.id, definitionVersionId: retained.definitionVersionId, createdAt: retained.createdAt };
    const plans = api();
    vi.mocked(plans.listPlanEnrollments).mockResolvedValue([enrollment]);
    vi.mocked(plans.listLatestPlanDefinitionVersions).mockResolvedValue([retainedCalendar]);
    vi.mocked(plans.getCalendarPlanEnrollment).mockResolvedValue(retained);
    vi.mocked(plans.calendarPlanAssignments).mockResolvedValue([{ id: 'dated-only', enrollmentId: retained.id, definitionVersionId: retained.definitionVersionId, definitionDay: 60, localDate: retained.startDate, passages: [{ book: 2, chapter: 12, startVerse: 21, endVerse: 51 }] }]);
    render(<PlanPanel api={plans} />);
    expect(await screen.findByText('2026-03-01')).toBeTruthy();
    expect(screen.queryByLabelText('Retained enrollment')).toBeNull();
    expect(screen.queryByText(/enrollment is exhausted/i)).toBeNull();
    expect(screen.queryByLabelText('Current plan assignments')).toBeNull();
    expect(screen.queryByLabelText('Retained completion history')).toBeNull();
    expect(plans.activePlanAssignments).not.toHaveBeenCalled();
    expect(plans.planCompletionHistory).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Export retained definition JSON' }));
    expect((await screen.findByLabelText('Exported retained plan JSON') as HTMLTextAreaElement).value).toBe(`{"versionId":"${retainedCalendar.id}"}`);
  });

  it('keeps calendar enrollments out of mixed stream selection while preserving stream controls', async () => {
    const retained = { ...calendarEnrollment, id: 'calendar-mixed' };
    const calendar: PlanEnrollment = { id: retained.id, definitionVersionId: retained.definitionVersionId, createdAt: retained.createdAt };
    const plans = api();
    vi.mocked(plans.listPlanEnrollments).mockResolvedValue([calendar, first]);
    vi.mocked(plans.getCalendarPlanEnrollment).mockImplementation(async id => id === calendar.id ? retained : null);
    vi.mocked(plans.calendarPlanAssignments).mockResolvedValue([]);
    render(<PlanPanel api={plans} />);
    expect(await screen.findByText('No retained calendar assignments.')).toBeTruthy();
    const selector = await screen.findByLabelText('Retained enrollment') as HTMLSelectElement;
    expect(Array.from(selector.options, option => option.value)).toEqual([first.id]);
    expect(await screen.findByLabelText('Current plan assignments')).toBeTruthy();
    expect(await screen.findByLabelText('Retained completion history')).toBeTruthy();
    expect(plans.activePlanAssignments).toHaveBeenCalledWith(first.id);
    expect(plans.planCompletionHistory).toHaveBeenCalledWith(first.id);
    expect(plans.activePlanAssignments).not.toHaveBeenCalledWith(calendar.id);
    expect(plans.planCompletionHistory).not.toHaveBeenCalledWith(calendar.id);
  });

  it('keeps a confirmed calendar creation out of stream UI after discovery refresh', async () => {
    const plans = api();
    vi.mocked(plans.listLatestPlanDefinitionVersions).mockResolvedValue([retainedCalendar]);
    vi.mocked(plans.listPlanEnrollments).mockResolvedValue([]);
    vi.mocked(plans.getCalendarPlanEnrollment).mockImplementation(async id => id === calendarEnrollment.id ? calendarEnrollment : null);
    vi.mocked(plans.calendarPlanAssignments).mockResolvedValue([]);
    render(<PlanPanel api={plans} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create calendar enrollment' }));
    expect(await screen.findByText('No retained calendar assignments.')).toBeTruthy();
    expect(screen.queryByLabelText('Retained enrollment')).toBeNull();
    expect(screen.queryByText(/enrollment is exhausted/i)).toBeNull();
    expect(plans.activePlanAssignments).not.toHaveBeenCalled();
    expect(plans.planCompletionHistory).not.toHaveBeenCalled();
  });

  it('retries retained calendar discovery and assignment reads after failures', async () => {
    const retained = { ...calendarEnrollment, id: 'calendar-retry' };
    const enrollment: PlanEnrollment = { id: retained.id, definitionVersionId: retained.definitionVersionId, createdAt: retained.createdAt };
    const plans = api();
    vi.mocked(plans.listPlanEnrollments).mockResolvedValue([enrollment]);
    vi.mocked(plans.getCalendarPlanEnrollment).mockRejectedValueOnce(new Error('metadata offline')).mockResolvedValue(retained);
    vi.mocked(plans.calendarPlanAssignments).mockRejectedValueOnce(new Error('assignments offline')).mockResolvedValue([]);
    render(<PlanPanel api={plans} />);
    expect(await screen.findByText(/Could not load retained calendar enrollments: Error: metadata offline/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry calendar enrollments' }));
    expect(await screen.findByLabelText('Retained calendar enrollment')).toBeTruthy();
    expect(await screen.findByText(/Could not load dated calendar assignments: Error: assignments offline/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry calendar assignments' }));
    expect(await screen.findByText('No retained calendar assignments.')).toBeTruthy();
    expect(plans.enrollInCalendar).not.toHaveBeenCalled();
  });

  it('guards deferred calendar discovery across API replacement, retry, and unmount without replaying writes', async () => {
    const oldRead = deferred<typeof calendarEnrollment | null>();
    const currentRead = deferred<typeof calendarEnrollment | null>();
    const unmountedRead = deferred<typeof calendarEnrollment | null>();
    const oldEnrollment = { ...calendarEnrollment, id: 'calendar-old' };
    const currentEnrollment = { ...calendarEnrollment, id: 'calendar-current' };
    const oldPlans = api();
    const currentPlans = api();
    const unmountedPlans = api();
    vi.mocked(oldPlans.listPlanEnrollments).mockResolvedValue([{ id: oldEnrollment.id, definitionVersionId: oldEnrollment.definitionVersionId, createdAt: oldEnrollment.createdAt }]);
    vi.mocked(oldPlans.getCalendarPlanEnrollment).mockReturnValue(oldRead.promise);
    vi.mocked(currentPlans.listPlanEnrollments).mockResolvedValue([{ id: currentEnrollment.id, definitionVersionId: currentEnrollment.definitionVersionId, createdAt: currentEnrollment.createdAt }]);
    vi.mocked(currentPlans.getCalendarPlanEnrollment).mockReturnValue(currentRead.promise);
    vi.mocked(unmountedPlans.listPlanEnrollments).mockResolvedValue([{ id: currentEnrollment.id, definitionVersionId: currentEnrollment.definitionVersionId, createdAt: currentEnrollment.createdAt }]);
    vi.mocked(unmountedPlans.getCalendarPlanEnrollment).mockReturnValue(unmountedRead.promise);

    const view = render(<PlanPanel api={oldPlans} />);
    expect(await screen.findByText('Loading retained calendar enrollments…')).toBeTruthy();
    await waitFor(() => expect(oldPlans.getCalendarPlanEnrollment).toHaveBeenCalledWith(oldEnrollment.id));
    view.rerender(<PlanPanel api={currentPlans} />);
    await waitFor(() => expect(currentPlans.getCalendarPlanEnrollment).toHaveBeenCalledWith(currentEnrollment.id));
    await act(async () => { currentRead.resolve(currentEnrollment); });
    expect((await screen.findByLabelText('Retained calendar enrollment') as HTMLSelectElement).value).toBe(currentEnrollment.id);
    await act(async () => { oldRead.reject(new Error('stale replacement metadata')); });
    expect(screen.queryByText(/stale replacement metadata/)).toBeNull();
    expect(screen.queryByText(oldEnrollment.id)).toBeNull();
    view.rerender(<PlanPanel api={unmountedPlans} />);
    await waitFor(() => expect(unmountedPlans.getCalendarPlanEnrollment).toHaveBeenCalledWith(currentEnrollment.id));
    view.unmount();
    await act(async () => { unmountedRead.resolve(currentEnrollment); });
    expect(view.container.textContent).toBe('');

    for (const plans of [oldPlans, currentPlans, unmountedPlans]) {
      expect(plans.enrollInCalendar).not.toHaveBeenCalled();
      expect(plans.completePlanStream).not.toHaveBeenCalled();
      expect(plans.undoPlanCompletion).not.toHaveBeenCalled();
    }
  });

  it('guards deferred dated assignments across selection, retry, API replacement, and unmount', async () => {
    const firstRead = deferred<DatedPlanAssignment[]>();
    const failedRead = deferred<DatedPlanAssignment[]>();
    const staleReplacementRead = deferred<DatedPlanAssignment[]>();
    const replacementRead = deferred<DatedPlanAssignment[]>();
    const unmountedRead = deferred<DatedPlanAssignment[]>();
    const one = { ...calendarEnrollment, id: 'calendar-deferred-one' };
    const two = { ...calendarEnrollment, id: 'calendar-deferred-two', startDate: '2026-04-02' };
    const enrollmentRows = [one, two].map(item => ({ id: item.id, definitionVersionId: item.definitionVersionId, createdAt: item.createdAt }));
    const oldPlans = api();
    const replacementPlans = api();
    for (const plans of [oldPlans, replacementPlans]) {
      vi.mocked(plans.listPlanEnrollments).mockResolvedValue(enrollmentRows);
      vi.mocked(plans.getCalendarPlanEnrollment).mockImplementation(async id => id === one.id ? one : two);
    }
    vi.mocked(oldPlans.calendarPlanAssignments).mockImplementation(id => id === one.id ? firstRead.promise : failedRead.promise);
    let replacementCurrentReads = 0;
    vi.mocked(replacementPlans.calendarPlanAssignments).mockImplementation(id => {
      if (id === two.id) return staleReplacementRead.promise;
      replacementCurrentReads += 1;
      return replacementCurrentReads === 1 ? replacementRead.promise : unmountedRead.promise;
    });

    const view = render(<PlanPanel api={oldPlans} />);
    const select = await screen.findByLabelText('Retained calendar enrollment');
    expect(await screen.findByText('Loading dated calendar assignments…')).toBeTruthy();
    expect(oldPlans.calendarPlanAssignments).toHaveBeenCalledWith(one.id);
    fireEvent.change(select, { target: { value: two.id } });
    await waitFor(() => expect(oldPlans.calendarPlanAssignments).toHaveBeenCalledWith(two.id));
    await act(async () => { firstRead.reject(new Error('stale first rejection')); });
    expect(screen.queryByText(/stale first rejection/)).toBeNull();
    await act(async () => { failedRead.reject(new Error('selected assignments offline')); });
    expect(await screen.findByText(/selected assignments offline/)).toBeTruthy();

    view.rerender(<PlanPanel api={replacementPlans} />);
    await waitFor(() => expect(replacementPlans.calendarPlanAssignments).toHaveBeenCalledWith(one.id));
    await act(async () => { staleReplacementRead.reject(new Error('stale replacement rejection')); });
    expect(screen.queryByText(/stale replacement rejection/)).toBeNull();
    await act(async () => { replacementRead.reject(new Error('replacement assignments offline')); });
    expect(await screen.findByText(/replacement assignments offline/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry calendar assignments' }));
    await waitFor(() => expect(replacementCurrentReads).toBe(2));
    view.unmount();
    await act(async () => { unmountedRead.reject(new Error('unmounted rejection')); });
    expect(view.container.textContent).toBe('');

    for (const plans of [oldPlans, replacementPlans]) {
      expect(plans.enrollInCalendar).not.toHaveBeenCalled();
      expect(plans.completePlanStream).not.toHaveBeenCalled();
      expect(plans.undoPlanCompletion).not.toHaveBeenCalled();
    }
  });

  it.each(['success', 'rejection'] as const)('ignores deferred old-API assignment %s after replacement results are visible', async settlement => {
    const oldRead = deferred<DatedPlanAssignment[]>();
    const oldEnrollment = { ...calendarEnrollment, id: `calendar-old-${settlement}`, startDate: '2026-02-01' };
    const currentEnrollment = { ...calendarEnrollment, id: `calendar-current-${settlement}`, startDate: '2026-05-04', scheduleMode: 'dayOne' as const };
    const currentAssignment: DatedPlanAssignment = {
      id: `dated-current-${settlement}`,
      enrollmentId: currentEnrollment.id,
      definitionVersionId: currentEnrollment.definitionVersionId,
      definitionDay: 64,
      localDate: currentEnrollment.startDate,
      passages: [{ book: 43, chapter: 3, startVerse: 16, endVerse: 16 }],
    };
    const oldPlans = api();
    const currentPlans = api();
    vi.mocked(oldPlans.listPlanEnrollments).mockResolvedValue([{ id: oldEnrollment.id, definitionVersionId: oldEnrollment.definitionVersionId, createdAt: oldEnrollment.createdAt }]);
    vi.mocked(oldPlans.getCalendarPlanEnrollment).mockResolvedValue(oldEnrollment);
    vi.mocked(oldPlans.calendarPlanAssignments).mockReturnValue(oldRead.promise);
    vi.mocked(currentPlans.listPlanEnrollments).mockResolvedValue([{ id: currentEnrollment.id, definitionVersionId: currentEnrollment.definitionVersionId, createdAt: currentEnrollment.createdAt }]);
    vi.mocked(currentPlans.getCalendarPlanEnrollment).mockResolvedValue(currentEnrollment);
    vi.mocked(currentPlans.calendarPlanAssignments).mockResolvedValue([currentAssignment]);

    const view = render(<PlanPanel api={oldPlans} />);
    await waitFor(() => expect(oldPlans.calendarPlanAssignments).toHaveBeenCalledWith(oldEnrollment.id));
    view.rerender(<PlanPanel api={currentPlans} />);
    expect(await screen.findByText(`Assignment ${currentAssignment.id} · Definition version ${currentAssignment.definitionVersionId}`)).toBeTruthy();
    expect((screen.getByLabelText('Retained calendar enrollment') as HTMLSelectElement).value).toBe(currentEnrollment.id);
    expect(screen.getByText(currentEnrollment.startDate)).toBeTruthy();
    expect(screen.getByText('John 3:16')).toBeTruthy();
    expect(currentPlans.calendarPlanAssignments).toHaveBeenCalledWith(currentEnrollment.id);

    await act(async () => {
      if (settlement === 'success') {
        oldRead.resolve([{ id: 'dated-obsolete', enrollmentId: oldEnrollment.id, definitionVersionId: oldEnrollment.definitionVersionId, definitionDay: 1, localDate: oldEnrollment.startDate, passages: [{ book: 1, chapter: 1 }] }]);
      } else {
        oldRead.reject(new Error('obsolete old API rejection'));
      }
    });

    expect((screen.getByLabelText('Retained calendar enrollment') as HTMLSelectElement).value).toBe(currentEnrollment.id);
    expect(screen.getByText(`Assignment ${currentAssignment.id} · Definition version ${currentAssignment.definitionVersionId}`)).toBeTruthy();
    expect(screen.getByText(currentEnrollment.startDate)).toBeTruthy();
    expect(screen.getByText('John 3:16')).toBeTruthy();
    expect(screen.queryByText(oldEnrollment.startDate)).toBeNull();
    expect(screen.queryByText(/dated-obsolete|obsolete old API rejection/)).toBeNull();
    for (const plans of [oldPlans, currentPlans]) {
      expect(plans.enrollInCalendar).not.toHaveBeenCalled();
      expect(plans.completePlanStream).not.toHaveBeenCalled();
      expect(plans.undoPlanCompletion).not.toHaveBeenCalled();
    }
  });

  it('discards stale dated-assignment responses after calendar selection and unmount', async () => {
    let resolveFirst!: (items: DatedPlanAssignment[]) => void;
    const one = { ...calendarEnrollment, id: 'calendar-one' };
    const two = { ...calendarEnrollment, id: 'calendar-two', scheduleMode: 'dayOne' as const, startDate: '2026-04-02' };
    const plans = api();
    vi.mocked(plans.listPlanEnrollments).mockResolvedValue([
      { id: one.id, definitionVersionId: one.definitionVersionId, createdAt: one.createdAt },
      { id: two.id, definitionVersionId: two.definitionVersionId, createdAt: two.createdAt },
    ]);
    vi.mocked(plans.getCalendarPlanEnrollment).mockImplementation(async id => id === one.id ? one : two);
    vi.mocked(plans.calendarPlanAssignments).mockImplementation(id => {
      if (id === one.id) return new Promise(resolve => { resolveFirst = resolve; });
      if (id === two.id) return Promise.resolve([{ id: 'dated-two', enrollmentId: two.id, definitionVersionId: two.definitionVersionId, definitionDay: 1, localDate: two.startDate, passages: [{ book: 2, chapter: 2 }] }]);
      return Promise.resolve([]);
    });
    const view = render(<PlanPanel api={plans} />);
    const select = await screen.findByLabelText('Retained calendar enrollment');
    fireEvent.change(select, { target: { value: two.id } });
    expect(await screen.findByText('2026-04-02')).toBeTruthy();
    await act(async () => { resolveFirst([{ id: 'stale', enrollmentId: one.id, definitionVersionId: one.definitionVersionId, definitionDay: 1, localDate: '2026-01-01', passages: [{ book: 1, chapter: 1 }] }]); });
    expect(screen.queryByText('2026-01-01')).toBeNull();
    view.unmount();
  });

  it('offers only day-one enrollment and truthful schedule-length copy for a short custom calendar', async () => {
    const plans = api();
    vi.mocked(plans.listLatestPlanDefinitionVersions).mockResolvedValue([retainedExplicit]);
    render(<PlanPanel api={plans} />);
    expect(await screen.findByText(/This 1-set calendar starts from day one/)).toBeTruthy();
    expect(screen.getByText(/Calendar alignment is available only for an exact 365-day schedule; February 29 is an ordinary scheduled day/)).toBeTruthy();
    const policy = screen.getByLabelText('Calendar schedule policy') as HTMLSelectElement;
    expect(policy.value).toBe('dayOne');
    expect(Array.from(policy.options, option => option.value)).toEqual(['dayOne']);
    expect(screen.queryByText(/all 365 sets successively/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Calendar start date'), { target: { value: '2026-06-04' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create calendar enrollment' }));
    await waitFor(() => expect(plans.enrollInCalendar).toHaveBeenCalledWith({
      definitionVersionId: retainedExplicit.id,
      startDate: '2026-06-04',
      scheduleMode: 'dayOne',
    }));
  });

  it('ignores obsolete calendar settlement after selection, API replacement, and unmount', async () => {
    let resolveOld!: (value: typeof calendarEnrollment) => void;
    let resolveReplaced!: (value: typeof calendarEnrollment) => void;
    let resolveUnmounted!: (value: typeof calendarEnrollment) => void;
    const oldApi = api();
    const currentApi = api();
    const replacementApi = api();
    vi.mocked(oldApi.listLatestPlanDefinitionVersions).mockResolvedValue([retainedCalendar, retainedStreams]);
    vi.mocked(oldApi.enrollInCalendar).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    vi.mocked(currentApi.listLatestPlanDefinitionVersions).mockResolvedValue([retainedCalendar]);
    vi.mocked(currentApi.enrollInCalendar).mockImplementationOnce(() => new Promise(resolve => { resolveReplaced = resolve; }));
    vi.mocked(replacementApi.listLatestPlanDefinitionVersions).mockResolvedValue([retainedCalendar]);
    vi.mocked(replacementApi.enrollInCalendar).mockImplementationOnce(() => new Promise(resolve => { resolveUnmounted = resolve; }));
    const view = render(<PlanPanel api={oldApi} />);
    await screen.findByLabelText('Calendar start date');
    fireEvent.click(screen.getByRole('button', { name: 'Create calendar enrollment' }));
    fireEvent.change(screen.getByLabelText('Retained plan definition'), { target: { value: retainedStreams.id } });
    await act(async () => { resolveOld(calendarEnrollment); });
    expect(screen.queryByText(/Calendar enrollment calendar-enrollment was created/)).toBeNull();
    view.rerender(<PlanPanel api={currentApi} />);
    expect((await screen.findByLabelText('Retained plan definition') as HTMLSelectElement).value).toBe(retainedCalendar.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Create calendar enrollment' }));
    view.rerender(<PlanPanel api={replacementApi} />);
    await act(async () => { resolveReplaced(calendarEnrollment); });
    expect(screen.queryByText(/Calendar enrollment calendar-enrollment was created/)).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Create calendar enrollment' }));
    view.unmount();
    await act(async () => { resolveUnmounted(calendarEnrollment); });
    expect(view.container.textContent).toBe('');
  });

  it('keeps retained-definition export state independent from an imported-definition export', async () => {
    const plans = api();
    vi.mocked(plans.listLatestPlanDefinitionVersions).mockResolvedValue([retainedDefinition, retainedExplicit]);
    render(<PlanPanel api={plans} />);
    await screen.findByLabelText('Retained plan definition');
    fireEvent.change(screen.getByLabelText('Custom plan JSON'), { target: { value: '{"schemaVersion":1}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import custom plan' }));
    await screen.findByText('Imported streams');
    fireEvent.click(screen.getByRole('button', { name: 'Export imported version JSON' }));
    expect((await screen.findByLabelText('Exported imported plan JSON') as HTMLTextAreaElement).value).toBe('{"versionId":"custom-version"}');
    fireEvent.click(screen.getByRole('button', { name: 'Export retained definition JSON' }));
    expect((await screen.findByLabelText('Exported retained plan JSON') as HTMLTextAreaElement).value).toBe('{"versionId":"retained-version-1"}');
    fireEvent.change(screen.getByLabelText('Retained plan definition'), { target: { value: retainedExplicit.id } });
    expect(screen.queryByLabelText('Exported retained plan JSON')).toBeNull();
    expect((screen.getByLabelText('Exported imported plan JSON') as HTMLTextAreaElement).value).toBe('{"versionId":"custom-version"}');
  });

  it('discards deferred retained-definition export results after selection, API replacement, and unmount', async () => {
    let resolveFirst!: (value: string) => void;
    let rejectSecond!: (reason: unknown) => void;
    let resolveThird!: (value: string) => void;
    const oldApi = api();
    const currentApi = api();
    vi.mocked(oldApi.listLatestPlanDefinitionVersions).mockResolvedValue([retainedDefinition, retainedExplicit]);
    vi.mocked(oldApi.exportPlanDefinitionJson)
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSecond = reject; }));
    vi.mocked(currentApi.listLatestPlanDefinitionVersions).mockResolvedValue([retainedDefinition]);
    vi.mocked(currentApi.exportPlanDefinitionJson).mockImplementationOnce(() => new Promise(resolve => { resolveThird = resolve; }));
    const view = render(<PlanPanel api={oldApi} />);
    const select = await screen.findByLabelText('Retained plan definition');
    fireEvent.click(screen.getByRole('button', { name: 'Export retained definition JSON' }));
    fireEvent.change(select, { target: { value: retainedExplicit.id } });
    await act(async () => { resolveFirst('{"stale":"first"}'); });
    expect(screen.queryByLabelText('Exported retained plan JSON')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Export retained definition JSON' }));
    fireEvent.change(select, { target: { value: retainedDefinition.id } });
    await act(async () => { rejectSecond(new Error('stale rejection')); });
    expect(screen.queryByText(/stale rejection/)).toBeNull();
    view.rerender(<PlanPanel api={currentApi} />);
    await screen.findByLabelText('Retained plan definition');
    fireEvent.click(screen.getByRole('button', { name: 'Export retained definition JSON' }));
    view.unmount();
    await act(async () => { resolveThird('{"late":"replacement"}'); });
    expect(view.container.textContent).toBe('');
  });

  it('appends the captured retained plan explicitly and preserves newer input through refresh recovery', async () => {
    let resolveCreate!: (value: PlanDefinitionVersion) => void;
    const editedDefinition = { ...retainedStreams.definition, name: 'Edited retained streams' };
    const createdVersion = { ...retainedStreams, id: 'retained-version-3', version: 2, definition: editedDefinition };
    const plans = api();
    vi.mocked(plans.listLatestPlanDefinitionVersions)
      .mockResolvedValueOnce([retainedStreams, retainedExplicit])
      .mockRejectedValueOnce(new Error('edit refresh offline'))
      .mockResolvedValueOnce([createdVersion, retainedExplicit]);
    vi.mocked(plans.createPlanDefinitionVersion).mockImplementationOnce(() => new Promise(resolve => { resolveCreate = resolve; }));
    render(<PlanPanel api={plans} />);
    const definitionSelect = await screen.findByLabelText('Retained plan definition') as HTMLSelectElement;
    fireEvent.click(screen.getByRole('button', { name: 'Edit selected as new version' }));
    const editor = screen.getByLabelText('Edited plan JSON') as HTMLTextAreaElement;
    const submitted = JSON.stringify(editedDefinition);
    fireEvent.change(editor, { target: { value: submitted } });
    const append = screen.getByRole('button', { name: 'Append new plan version' });
    fireEvent.click(append); fireEvent.click(append);
    expect(plans.createPlanDefinitionVersion).toHaveBeenCalledTimes(1);
    expect(plans.createPlanDefinitionVersion).toHaveBeenCalledWith(retainedStreams.planId, editedDefinition);
    fireEvent.change(definitionSelect, { target: { value: retainedExplicit.id } });
    const newerInput = JSON.stringify({ ...editedDefinition, name: 'Newer unsent edit' });
    fireEvent.change(editor, { target: { value: newerInput } });
    fireEvent.change(definitionSelect, { target: { value: retainedStreams.id } });
    await act(async () => { resolveCreate(createdVersion); });

    expect(await screen.findByText(/Retained definitions could not be refreshed after the confirmed write: Error: edit refresh offline/)).toBeTruthy();
    expect(editor.value).toBe(newerInput);
    expect(screen.getByText(/Editing plan retained-plan-1 from definition version 1/)).toBeTruthy();
    expect(definitionSelect.value).toBe(createdVersion.id);
    expect(Array.from(definitionSelect.options, option => option.value)).toContain(createdVersion.id);
    fireEvent.click(screen.getByRole('button', { name: 'Retry retained definitions' }));
    await waitFor(() => expect(plans.listLatestPlanDefinitionVersions).toHaveBeenCalledTimes(3));
    expect(plans.createPlanDefinitionVersion).toHaveBeenCalledTimes(1);
    expect(plans.enrollInChapterStreams).not.toHaveBeenCalled();
    expect(plans.completePlanStream).not.toHaveBeenCalled();
    expect(plans.undoPlanCompletion).not.toHaveBeenCalled();
  });

  it('preserves the edit target and input across parse and native rejection before explicit retry', async () => {
    let rejectCreate!: (reason: unknown) => void;
    const correctedDefinition = { ...retainedDefinition.definition, name: 'Corrected edit' };
    const newerDefinition = { ...correctedDefinition, name: 'Newer correction' };
    const createdVersion = { ...retainedDefinition, id: 'retained-version-3', version: 2, definition: newerDefinition };
    const plans = api();
    vi.mocked(plans.listLatestPlanDefinitionVersions).mockResolvedValue([retainedDefinition, retainedExplicit]);
    vi.mocked(plans.createPlanDefinitionVersion)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCreate = reject; }))
      .mockResolvedValueOnce(createdVersion);
    render(<PlanPanel api={plans} />);
    const definitionSelect = await screen.findByLabelText('Retained plan definition');
    fireEvent.click(screen.getByRole('button', { name: 'Edit selected as new version' }));
    const editor = screen.getByLabelText('Edited plan JSON') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '{' } });
    fireEvent.click(screen.getByRole('button', { name: 'Append new plan version' }));
    expect(await screen.findByText(/Could not parse edited plan JSON/)).toBeTruthy();
    expect(plans.createPlanDefinitionVersion).not.toHaveBeenCalled();

    fireEvent.change(editor, { target: { value: JSON.stringify(correctedDefinition) } });
    fireEvent.click(screen.getByRole('button', { name: 'Append new plan version' }));
    fireEvent.change(definitionSelect, { target: { value: retainedExplicit.id } });
    fireEvent.change(editor, { target: { value: JSON.stringify(newerDefinition) } });
    await act(async () => { rejectCreate(new Error('native validation failed')); });
    expect(await screen.findByText(/Could not append plan version: Error: native validation failed/)).toBeTruthy();
    expect(editor.value).toBe(JSON.stringify(newerDefinition));
    expect(screen.getByText(/Editing plan retained-plan-1 from definition version 1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Append new plan version' }));
    await waitFor(() => expect(plans.createPlanDefinitionVersion).toHaveBeenCalledTimes(2));
    expect(plans.createPlanDefinitionVersion).toHaveBeenNthCalledWith(1, retainedDefinition.planId, correctedDefinition);
    expect(plans.createPlanDefinitionVersion).toHaveBeenNthCalledWith(2, retainedDefinition.planId, newerDefinition);
  });

  it('enrolls the exact selected retained version once with explicit occurrence and loop choices', async () => {
    const plans = api();
    vi.mocked(plans.listLatestPlanDefinitionVersions).mockResolvedValue([retainedStreams, retainedExplicit]);
    vi.mocked(plans.enrollInChapterStreams).mockResolvedValueOnce(retainedEnrollment);
    vi.mocked(plans.listPlanEnrollments).mockResolvedValueOnce([first, second]).mockResolvedValueOnce([first, second, retainedEnrollment]);
    render(<PlanPanel api={plans} />);
    const starts = await screen.findAllByLabelText('Retained starting chapter') as HTMLSelectElement[];
    const loops = screen.getAllByLabelText('Retained stream loops') as HTMLInputElement[];
    expect(Array.from(starts[0].options, option => option.text)).toEqual(['Book 19 · Chapter 1', 'Book 19 · Chapter 1']);
    fireEvent.change(starts[0], { target: { value: '1' } });
    fireEvent.click(loops[1]);
    const submit = screen.getByRole('button', { name: 'Create retained enrollment' });
    fireEvent.click(submit); fireEvent.click(submit);

    await waitFor(() => expect(plans.enrollInChapterStreams).toHaveBeenCalledTimes(1));
    expect(plans.enrollInChapterStreams).toHaveBeenCalledWith(retainedStreams.id, [
      { streamId: 'repeat', startingPosition: 1, loopAfterEnd: true },
      { streamId: 'short', startingPosition: 0, loopAfterEnd: false },
    ]);
    expect(await screen.findByText(/Retained-plan enrollment retained-enrollment was created for definition version retained-version-1/)).toBeTruthy();
    expect((screen.getByLabelText('Retained enrollment') as HTMLSelectElement).value).toBe(retainedEnrollment.id);
  });

  it('preserves retained choices through import overlay, failed refresh, retry, and enrollment', async () => {
    let rejectRefresh!: (reason: unknown) => void;
    const plans = api();
    vi.mocked(plans.listLatestPlanDefinitionVersions)
      .mockResolvedValueOnce([retainedStreams])
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRefresh = reject; }))
      .mockResolvedValueOnce([retainedStreams, importedPlan]);
    vi.mocked(plans.enrollInChapterStreams).mockResolvedValueOnce(retainedEnrollment);
    render(<PlanPanel api={plans} />);
    const starts = await screen.findAllByLabelText('Retained starting chapter') as HTMLSelectElement[];
    const loops = screen.getAllByLabelText('Retained stream loops') as HTMLInputElement[];
    fireEvent.change(starts[0], { target: { value: '1' } });
    fireEvent.click(loops[1]);
    fireEvent.change(screen.getByLabelText('Custom plan JSON'), { target: { value: '{"schemaVersion":1}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import custom plan' }));
    await waitFor(() => expect(plans.listLatestPlanDefinitionVersions).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getAllByLabelText('Retained stream loops')[0]);
    await act(async () => { rejectRefresh(new Error('refresh unavailable')); });

    expect((screen.getAllByLabelText('Retained starting chapter')[0] as HTMLSelectElement).value).toBe('1');
    expect((screen.getAllByLabelText('Retained stream loops')[0] as HTMLInputElement).checked).toBe(false);
    expect((screen.getAllByLabelText('Retained stream loops')[1] as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Retry retained definitions' }));
    await waitFor(() => expect(plans.listLatestPlanDefinitionVersions).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole('button', { name: 'Create retained enrollment' }));

    await waitFor(() => expect(plans.enrollInChapterStreams).toHaveBeenCalledTimes(1));
    expect(plans.enrollInChapterStreams).toHaveBeenCalledWith(retainedStreams.id, [
      { streamId: 'repeat', startingPosition: 1, loopAfterEnd: false },
      { streamId: 'short', startingPosition: 0, loopAfterEnd: false },
    ]);
    expect(plans.importPlanDefinitionJson).toHaveBeenCalledTimes(1);
  });

  it('retains selected-version choices after rejection and permits one explicit retry', async () => {
    let rejectEnrollment!: (reason: unknown) => void;
    const plans = api();
    vi.mocked(plans.listLatestPlanDefinitionVersions).mockResolvedValue([retainedStreams]);
    vi.mocked(plans.enrollInChapterStreams)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectEnrollment = reject; }))
      .mockResolvedValueOnce(retainedEnrollment);
    render(<PlanPanel api={plans} />);
    const starts = await screen.findAllByLabelText('Retained starting chapter') as HTMLSelectElement[];
    fireEvent.change(starts[0], { target: { value: '1' } });
    const submit = screen.getByRole('button', { name: 'Create retained enrollment' });
    fireEvent.click(submit); fireEvent.click(submit);
    expect((screen.getByRole('button', { name: 'Creating retained enrollment…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(plans.enrollInChapterStreams).toHaveBeenCalledTimes(1);
    await act(async () => { rejectEnrollment(new Error('retained enrollment rejected')); });
    expect(await screen.findByText(/Could not create retained-plan enrollment: Error: retained enrollment rejected/)).toBeTruthy();
    expect((screen.getAllByLabelText('Retained starting chapter')[0] as HTMLSelectElement).value).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Create retained enrollment' }));
    await waitFor(() => expect(plans.enrollInChapterStreams).toHaveBeenCalledTimes(2));
  });

  it('retains confirmed enrollment across selection change and failed post-commit discovery', async () => {
    let resolveEnrollment!: (value: PlanEnrollment) => void;
    const plans = api();
    vi.mocked(plans.listLatestPlanDefinitionVersions).mockResolvedValue([retainedStreams, retainedExplicit]);
    vi.mocked(plans.enrollInChapterStreams).mockImplementationOnce(() => new Promise(resolve => { resolveEnrollment = resolve; }));
    vi.mocked(plans.listPlanEnrollments).mockResolvedValueOnce([first, second]).mockRejectedValueOnce(new Error('retained refresh offline'));
    render(<PlanPanel api={plans} />);
    const create = await screen.findByRole('button', { name: 'Create retained enrollment' }) as HTMLButtonElement;
    await waitFor(() => expect(create.disabled).toBe(false));
    fireEvent.click(create);
    const definitionSelect = screen.getByLabelText('Retained plan definition') as HTMLSelectElement;
    fireEvent.change(definitionSelect, { target: { value: retainedExplicit.id } });
    expect(screen.getByRole('button', { name: 'Create calendar enrollment' })).toBeTruthy();
    await act(async () => { resolveEnrollment(retainedEnrollment); });

    expect(definitionSelect.value).toBe(retainedExplicit.id);
    expect((screen.getByLabelText('Retained enrollment') as HTMLSelectElement).value).toBe(retainedEnrollment.id);
    expect(screen.queryByText(/retained refresh offline/)).toBeNull();
    fireEvent.change(definitionSelect, { target: { value: retainedStreams.id } });
    expect(await screen.findByText(/Retained-plan enrollment was created, but retained plans could not be refreshed: Error: retained refresh offline/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create retained enrollment' })).toBeNull();
    expect(plans.enrollInChapterStreams).toHaveBeenCalledTimes(1);
  });

  it('suppresses stale retained-enrollment rejection after selection and settlement after API replacement or unmount', async () => {
    let rejectSelection!: (reason: unknown) => void;
    let resolveReplacement!: (value: PlanEnrollment) => void;
    let rejectUnmount!: (reason: unknown) => void;
    const oldApi = api();
    const currentApi = api();
    vi.mocked(oldApi.listLatestPlanDefinitionVersions).mockResolvedValue([retainedStreams, retainedExplicit]);
    vi.mocked(oldApi.enrollInChapterStreams)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSelection = reject; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveReplacement = resolve; }));
    vi.mocked(currentApi.listLatestPlanDefinitionVersions).mockResolvedValue([retainedStreams]);
    const view = render(<PlanPanel api={oldApi} />);
    const create = await screen.findByRole('button', { name: 'Create retained enrollment' }) as HTMLButtonElement;
    await waitFor(() => expect(create.disabled).toBe(false));
    fireEvent.click(create);
    fireEvent.change(screen.getByLabelText('Retained plan definition'), { target: { value: retainedExplicit.id } });
    await act(async () => { rejectSelection(new Error('stale retained rejection')); });
    expect(screen.queryByText(/stale retained rejection/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Retained plan definition'), { target: { value: retainedStreams.id } });
    const replacement = screen.getByRole('button', { name: 'Create retained enrollment' }) as HTMLButtonElement;
    await waitFor(() => expect(replacement.disabled).toBe(false));
    fireEvent.click(replacement);
    view.rerender(<PlanPanel api={currentApi} />);
    await act(async () => { resolveReplacement(retainedEnrollment); });
    expect(screen.queryByText(/Retained-plan enrollment retained-enrollment/)).toBeNull();
    expect(await screen.findByRole('button', { name: 'Create retained enrollment' })).toBeTruthy();
    view.unmount();

    const lateApi = api();
    vi.mocked(lateApi.listLatestPlanDefinitionVersions).mockResolvedValue([retainedStreams]);
    vi.mocked(lateApi.enrollInChapterStreams).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectUnmount = reject; }));
    const lateView = render(<PlanPanel api={lateApi} />);
    const lateCreate = await screen.findByRole('button', { name: 'Create retained enrollment' }) as HTMLButtonElement;
    await waitFor(() => expect(lateCreate.disabled).toBe(false));
    fireEvent.click(lateCreate);
    lateView.unmount();
    await act(async () => { rejectUnmount(new Error('late unmount rejection')); });
    expect(lateView.container.textContent).toBe('');
  });

  it('shows core-ordered enrollments and read-only current assignments', async () => {
    const plans = api(); render(<PlanPanel api={plans} />);
    expect(await screen.findByText('First plan')).toBeTruthy();
    expect(screen.getByText('psalms')).toBeTruthy();
    expect(plans.listPlanEnrollments).toHaveBeenCalledTimes(1);
    expect(plans.getPlanDefinitionVersion).toHaveBeenCalledWith(first.definitionVersionId);
    expect(plans.activePlanAssignments).toHaveBeenCalledWith(first.id);
  });

  it('renders an empty retained list', async () => {
    const plans = api(); vi.mocked(plans.listPlanEnrollments).mockResolvedValueOnce([]);
    render(<PlanPanel api={plans} />);
    expect(await screen.findByText('No retained plan enrollments yet.')).toBeTruthy();
  });

  it('exports only the explicitly selected retained definition and preserves native JSON exactly', async () => {
    const plans = api(); render(<PlanPanel api={plans} />);
    await screen.findByText('First plan');
    expect(plans.exportPlanDefinitionJson).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Export selected version JSON' }));
    const output = await screen.findByLabelText('Exported plan JSON') as HTMLTextAreaElement;
    expect(plans.exportPlanDefinitionJson).toHaveBeenCalledWith(first.definitionVersionId);
    expect(output.value).toBe('{"versionId":"version-1"}');
  });

  it('suppresses duplicate exports, retains output through a failure, and retries', async () => {
    let resolveExport!: (value: string) => void;
    const plans = api();
    vi.mocked(plans.exportPlanDefinitionJson)
      .mockImplementationOnce(() => new Promise(resolve => { resolveExport = resolve; }))
      .mockRejectedValueOnce(new Error('native export offline'))
      .mockResolvedValueOnce('{"fresh":true}');
    render(<PlanPanel api={plans} />);
    await screen.findByText('First plan');
    const button = screen.getByRole('button', { name: 'Export selected version JSON' });
    fireEvent.click(button); fireEvent.click(button);
    expect(plans.exportPlanDefinitionJson).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Exporting selected version JSON…' })).toBeTruthy();
    await act(async () => { resolveExport('{"retained":true}'); });
    expect((await screen.findByLabelText('Exported plan JSON') as HTMLTextAreaElement).value).toBe('{"retained":true}');
    fireEvent.click(screen.getByRole('button', { name: 'Export selected version JSON' }));
    expect(await screen.findByText(/Could not export selected plan JSON: Error: native export offline/)).toBeTruthy();
    expect((screen.getByLabelText('Exported plan JSON') as HTMLTextAreaElement).value).toBe('{"retained":true}');
    fireEvent.click(screen.getByRole('button', { name: 'Retry selected version JSON' }));
    expect((await screen.findByLabelText('Exported plan JSON') as HTMLTextAreaElement).value).toBe('{"fresh":true}');
  });

  it('discards an export that resolves after selecting another enrollment or unmounting', async () => {
    let resolveFirst!: (value: string) => void;
    let resolveSecond!: (value: string) => void;
    const plans = api();
    vi.mocked(plans.exportPlanDefinitionJson)
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }));
    const view = render(<PlanPanel api={plans} />);
    const select = await screen.findByLabelText('Retained enrollment');
    fireEvent.click(await screen.findByRole('button', { name: 'Export selected version JSON' }));
    fireEvent.change(select, { target: { value: second.id } });
    expect(await screen.findByText('Second plan')).toBeTruthy();
    await act(async () => { resolveFirst('{"wrong":"version-1"}'); });
    expect(screen.queryByLabelText('Exported plan JSON')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Export selected version JSON' }));
    view.unmount();
    await act(async () => { resolveSecond('{"late":"version-2"}'); });
    expect(view.container.textContent).toBe('');
  });

  it('imports exact custom JSON only through an explicit action and retains the confirmation', async () => {
    const plans = api();
    vi.mocked(plans.listPlanEnrollments).mockRejectedValueOnce(new Error('discovery offline'));
    render(<PlanPanel api={plans} />);
    const input = screen.getByLabelText('Custom plan JSON');
    const button = screen.getByRole('button', { name: 'Import custom plan' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: ' {"schemaVersion":1} ' } });
    fireEvent.click(button);
    expect(plans.importPlanDefinitionJson).toHaveBeenCalledWith(' {"schemaVersion":1} ');
    expect(await screen.findByText('Imported streams')).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe('');
    expect(await screen.findByText(/Could not load retained plans: Error: discovery offline/)).toBeTruthy();
    expect(screen.getByText('Imported streams')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Export imported version JSON' }));
    expect((await screen.findByLabelText('Exported imported plan JSON') as HTMLTextAreaElement).value).toBe('{"versionId":"custom-version"}');
    expect(plans.exportPlanDefinitionJson).toHaveBeenCalledWith(importedPlan.id);
  });

  it('retains custom JSON after a native validation failure and permits a corrected retry', async () => {
    const plans = api();
    vi.mocked(plans.importPlanDefinitionJson).mockRejectedValueOnce(new Error('Invalid plan definition JSON')).mockResolvedValueOnce(importedPlan);
    render(<PlanPanel api={plans} />);
    const input = screen.getByLabelText('Custom plan JSON') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '{' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import custom plan' }));
    expect(await screen.findByText(/Could not import custom plan: Error: Invalid plan definition JSON/)).toBeTruthy();
    expect(input.value).toBe('{');
    fireEvent.change(input, { target: { value: '{"schemaVersion":1}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import custom plan' }));
    expect(await screen.findByText('Imported streams')).toBeTruthy();
    expect(plans.importPlanDefinitionJson).toHaveBeenCalledTimes(2);
  });

  it('suppresses duplicate pending imports and preserves a newer selection', async () => {
    let resolveImport!: (value: typeof importedPlan) => void;
    const plans = api();
    vi.mocked(plans.importPlanDefinitionJson).mockImplementationOnce(() => new Promise(resolve => { resolveImport = resolve; }));
    const view = render(<PlanPanel api={plans} />);
    const select = await screen.findByLabelText('Retained enrollment');
    fireEvent.change(screen.getByLabelText('Custom plan JSON'), { target: { value: '{"schemaVersion":1}' } });
    const button = screen.getByRole('button', { name: 'Import custom plan' });
    fireEvent.click(button); fireEvent.click(button);
    expect(plans.importPlanDefinitionJson).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Importing plan…' })).toBeTruthy();
    fireEvent.change(select, { target: { value: second.id } });
    expect(await screen.findByText('Second plan')).toBeTruthy();
    await act(async () => { resolveImport(importedPlan); });
    expect(screen.getByText('Imported streams')).toBeTruthy();
    expect((select as HTMLSelectElement).value).toBe(second.id);
    view.unmount();
  });

  it('does not clear newer unsent JSON when an earlier import succeeds', async () => {
    let resolveImport!: (value: typeof importedPlan) => void;
    const plans = api();
    vi.mocked(plans.importPlanDefinitionJson)
      .mockImplementationOnce(() => new Promise(resolve => { resolveImport = resolve; }))
      .mockResolvedValueOnce({ ...importedPlan, id: 'custom-version-2', definition: { ...importedPlan.definition, name: 'Imported replacement' } });
    render(<PlanPanel api={plans} />);
    const input = screen.getByLabelText('Custom plan JSON') as HTMLTextAreaElement;
    const firstDocument = '{"schemaVersion":1,"name":"First"}';
    const newerDocument = '{"schemaVersion":1,"name":"Newer unsent"}';
    fireEvent.change(input, { target: { value: firstDocument } });
    fireEvent.click(screen.getByRole('button', { name: 'Import custom plan' }));
    fireEvent.change(input, { target: { value: newerDocument } });
    await act(async () => { resolveImport(importedPlan); });

    expect(screen.getByText('Imported streams')).toBeTruthy();
    expect(input.value).toBe(newerDocument);
    fireEvent.click(screen.getByRole('button', { name: 'Import custom plan' }));
    expect(await screen.findByText('Imported replacement')).toBeTruthy();
    expect(plans.importPlanDefinitionJson).toHaveBeenNthCalledWith(1, firstDocument);
    expect(plans.importPlanDefinitionJson).toHaveBeenNthCalledWith(2, newerDocument);
    expect(input.value).toBe('');
  });

  it('discards a late import result after unmount', async () => {
    let resolveImport!: (value: typeof importedPlan) => void;
    const plans = api();
    vi.mocked(plans.importPlanDefinitionJson).mockImplementationOnce(() => new Promise(resolve => { resolveImport = resolve; }));
    const view = render(<PlanPanel api={plans} />);
    fireEvent.change(screen.getByLabelText('Custom plan JSON'), { target: { value: '{"schemaVersion":1}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import custom plan' }));
    view.unmount();
    await act(async () => { resolveImport(importedPlan); });
    expect(view.container.textContent).toBe('');
  });

  it('explicitly enrolls the exact imported stream version with occurrence and loop choices', async () => {
    const plans = api();
    vi.mocked(plans.importPlanDefinitionJson).mockResolvedValueOnce(importedStreams);
    vi.mocked(plans.enrollInChapterStreams).mockResolvedValueOnce(customEnrollment);
    vi.mocked(plans.listPlanEnrollments).mockResolvedValueOnce([first, second]).mockResolvedValueOnce([first, second, customEnrollment]);
    render(<PlanPanel api={plans} />);
    fireEvent.change(screen.getByLabelText('Custom plan JSON'), { target: { value: '{"custom":true}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import custom plan' }));
    const starts = await screen.findAllByLabelText('Custom starting chapter') as HTMLSelectElement[];
    const loops = screen.getAllByLabelText('Custom stream loops') as HTMLInputElement[];
    expect(starts[0].options).toHaveLength(2);
    expect(Array.from(starts[0].options, option => option.text)).toEqual(['Book 19 · Chapter 1', 'Book 19 · Chapter 1']);
    fireEvent.change(starts[0], { target: { value: '1' } });
    fireEvent.click(loops[1]);
    const submit = screen.getByRole('button', { name: 'Create custom enrollment' });
    fireEvent.click(submit); fireEvent.click(submit);

    await waitFor(() => expect(plans.enrollInChapterStreams).toHaveBeenCalledTimes(1));
    expect(plans.enrollInChapterStreams).toHaveBeenCalledWith(importedStreams.id, [
      { streamId: 'repeat', startingPosition: 1, loopAfterEnd: true },
      { streamId: 'short', startingPosition: 0, loopAfterEnd: false },
    ]);
    expect(await screen.findByText(/Custom-plan enrollment custom-enrollment was created for definition version custom-version/)).toBeTruthy();
    expect((await screen.findByLabelText('Retained enrollment') as HTMLSelectElement).value).toBe(customEnrollment.id);
  });

  it('reports custom enrollment rejection, retains choices, and permits one explicit retry', async () => {
    let rejectEnrollment!: (reason: unknown) => void;
    const plans = api();
    vi.mocked(plans.importPlanDefinitionJson).mockResolvedValueOnce(importedStreams);
    vi.mocked(plans.enrollInChapterStreams)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectEnrollment = reject; }))
      .mockResolvedValueOnce(customEnrollment);
    render(<PlanPanel api={plans} />);
    fireEvent.change(screen.getByLabelText('Custom plan JSON'), { target: { value: '{"custom":true}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import custom plan' }));
    const starts = await screen.findAllByLabelText('Custom starting chapter') as HTMLSelectElement[];
    fireEvent.change(starts[0], { target: { value: '1' } });
    const submit = screen.getByRole('button', { name: 'Create custom enrollment' });
    fireEvent.click(submit); fireEvent.click(submit);
    expect((screen.getByRole('button', { name: 'Creating custom enrollment…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(plans.enrollInChapterStreams).toHaveBeenCalledTimes(1);
    await act(async () => { rejectEnrollment(new Error('custom enrollment rejected')); });
    expect(await screen.findByText(/Could not create custom-plan enrollment: Error: custom enrollment rejected/)).toBeTruthy();
    expect((screen.getAllByLabelText('Custom starting chapter')[0] as HTMLSelectElement).value).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Create custom enrollment' }));
    await waitFor(() => expect(plans.enrollInChapterStreams).toHaveBeenCalledTimes(2));
  });

  it('preserves newer import input and confirmed custom enrollment when refresh fails after navigation', async () => {
    let resolveEnrollment!: (value: PlanEnrollment) => void;
    const plans = api();
    vi.mocked(plans.importPlanDefinitionJson).mockResolvedValueOnce(importedStreams);
    vi.mocked(plans.enrollInChapterStreams).mockImplementationOnce(() => new Promise(resolve => { resolveEnrollment = resolve; }));
    vi.mocked(plans.listPlanEnrollments).mockResolvedValueOnce([first, second]).mockRejectedValueOnce(new Error('custom refresh offline'));
    render(<PlanPanel api={plans} />);
    const input = screen.getByLabelText('Custom plan JSON') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '{"custom":true}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import custom plan' }));
    await screen.findByRole('button', { name: 'Create custom enrollment' });
    fireEvent.click(screen.getByRole('button', { name: 'Create custom enrollment' }));
    fireEvent.change(screen.getByLabelText('Retained enrollment'), { target: { value: second.id } });
    fireEvent.change(input, { target: { value: '{"newer":"unsent"}' } });
    expect((screen.getByRole('button', { name: 'Import custom plan' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { resolveEnrollment(customEnrollment); });

    expect(await screen.findByText(/Custom-plan enrollment was created, but retained plans could not be refreshed: Error: custom refresh offline/)).toBeTruthy();
    expect(input.value).toBe('{"newer":"unsent"}');
    const select = screen.getByLabelText('Retained enrollment') as HTMLSelectElement;
    expect(select.value).toBe(customEnrollment.id);
    expect(screen.getByRole('option', { name: customEnrollment.id })).toBeTruthy();
    expect(plans.enrollInChapterStreams).toHaveBeenCalledTimes(1);
  });

  it('does not reinterpret an imported explicit schedule as chapter streams', async () => {
    const plans = api();
    vi.mocked(plans.importPlanDefinitionJson).mockResolvedValueOnce({ ...importedPlan, definition: { ...importedPlan.definition, schedule: { kind: 'explicitSchedule', days: [{ day: 1, passages: [{ book: 43, chapter: 3 }] }] } } });
    render(<PlanPanel api={plans} />);
    fireEvent.change(screen.getByLabelText('Custom plan JSON'), { target: { value: '{"calendar":true}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import custom plan' }));
    expect(await screen.findByText('This imported calendar plan cannot be enrolled as chapter streams.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create custom enrollment' })).toBeNull();
    expect(plans.enrollInChapterStreams).not.toHaveBeenCalled();
  });

  it('shows retained completion identity, passage, timestamp, and undone state', async () => {
    const plans = api();
    vi.mocked(plans.planCompletionHistory).mockResolvedValueOnce([
      history('completion-undone', first.id, true), history('completion-current'),
    ]);
    render(<PlanPanel api={plans} />);
    expect(await screen.findByLabelText('Retained completion history')).toBeTruthy();
    expect(screen.getByText('Completion completion-undone · Assignment assignment-1')).toBeTruthy();
    expect(screen.getAllByText('Completed 2026-09-18T00:00:03Z')).toHaveLength(2);
    expect(screen.getByText('Undone')).toBeTruthy();
    expect(screen.getByText('Current completion')).toBeTruthy();
    expect(plans.planCompletionHistory).toHaveBeenCalledWith(first.id);
  });

  it('shows empty completion history and retries a rejected read', async () => {
    const plans = api();
    vi.mocked(plans.planCompletionHistory).mockRejectedValueOnce(new Error('history offline')).mockResolvedValueOnce([]);
    render(<PlanPanel api={plans} />);
    expect(await screen.findByText(/Could not load completion history: Error: history offline/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry completion history' }));
    expect(await screen.findByText('No retained completions yet.')).toBeTruthy();
  });

  it('ignores late history success and failure after selecting another enrollment', async () => {
    let resolveFirst!: (value: Awaited<ReturnType<PlanDefinitionApi['planCompletionHistory']>>) => void;
    let rejectFirst!: (reason: unknown) => void;
    const plans = api();
    vi.mocked(plans.planCompletionHistory)
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce([history('completion-second', second.id)])
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce([history('completion-second', second.id)]);
    render(<PlanPanel api={plans} />);
    const select = await screen.findByLabelText('Retained enrollment');
    fireEvent.change(select, { target: { value: second.id } });
    expect(await screen.findByText('Completion completion-second · Assignment assignment-1')).toBeTruthy();
    await act(async () => { resolveFirst([history('stale-success')]); });
    expect(screen.queryByText('Completion stale-success · Assignment assignment-1')).toBeNull();
    fireEvent.change(select, { target: { value: first.id } });
    expect(await screen.findByText('Loading completion history…')).toBeTruthy();
    fireEvent.change(select, { target: { value: second.id } });
    expect(await screen.findByText('Completion completion-second · Assignment assignment-1')).toBeTruthy();
    await act(async () => { rejectFirst(new Error('stale failure')); });
    expect(screen.queryByText(/stale failure/)).toBeNull();
  });

  it('refreshes history after a confirmed completion without overwriting a newer selection', async () => {
    let resolveCompletion!: (value: { id: string; assignmentId: string; completedAt: string }) => void;
    let resolveRefresh!: (value: Awaited<ReturnType<PlanDefinitionApi['planCompletionHistory']>>) => void;
    const plans = api();
    vi.mocked(plans.planCompletionHistory)
      .mockResolvedValueOnce([history('completion-initial')])
      .mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve; }))
      .mockResolvedValueOnce([history('completion-second', second.id)]);
    vi.mocked(plans.completePlanStream).mockImplementationOnce(() => new Promise(resolve => { resolveCompletion = resolve; }));
    render(<PlanPanel api={plans} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Complete psalms' }));
    await act(async () => { resolveCompletion({ id: 'completion-result', assignmentId: 'assignment-1', completedAt: '2026-09-18T00:00:04Z' }); });
    await waitFor(() => expect(plans.planCompletionHistory).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Loading completion history…')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Retained enrollment'), { target: { value: second.id } });
    expect(await screen.findByText('Completion completion-second · Assignment assignment-1')).toBeTruthy();
    await act(async () => { resolveRefresh([history('stale-refresh')]); });
    expect(screen.getByText('Completion completion-second · Assignment assignment-1')).toBeTruthy();
    expect(screen.queryByText('Completion stale-refresh · Assignment assignment-1')).toBeNull();
  });

  it('shows loading and retains the enrollment order returned by the core', async () => {
    let resolveList!: (value: PlanEnrollment[]) => void;
    const plans = api();
    vi.mocked(plans.listPlanEnrollments).mockImplementationOnce(() => new Promise(resolve => { resolveList = resolve; }));
    render(<PlanPanel api={plans} />);
    expect(screen.getByText('Loading retained plans…')).toBeTruthy();
    await act(async () => { resolveList([second, first]); });
    const select = await screen.findByLabelText('Retained enrollment') as HTMLSelectElement;
    expect(Array.from(select.options, option => option.value)).toEqual([second.id, first.id]);
  });

  it('reports a rejected list and retries without falsely showing empty', async () => {
    const plans = api(); vi.mocked(plans.listPlanEnrollments).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([first]);
    render(<PlanPanel api={plans} />);
    expect(await screen.findByText(/Could not load retained plans: Error: offline/)).toBeTruthy();
    expect(screen.queryByText('No retained plan enrollments yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry plans' }));
    expect(await screen.findByText('First plan')).toBeTruthy();
  });

  it('reports a missing pinned definition and retries explicitly', async () => {
    const plans = api(); vi.mocked(plans.listPlanEnrollments).mockResolvedValueOnce([first]);
    vi.mocked(plans.getPlanDefinitionVersion).mockResolvedValueOnce(null).mockResolvedValueOnce(definition(first.definitionVersionId, 'Recovered plan'));
    render(<PlanPanel api={plans} />);
    expect(await screen.findByText(/retained plan definition is unavailable/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry selection' }));
    expect(await screen.findByText('Recovered plan')).toBeTruthy();
  });

  it('reports a rejected assignment without falsely reporting exhaustion and retries', async () => {
    const plans = api(); vi.mocked(plans.listPlanEnrollments).mockResolvedValueOnce([first]);
    vi.mocked(plans.activePlanAssignments).mockRejectedValueOnce(new Error('assignment unavailable')).mockResolvedValueOnce([]);
    render(<PlanPanel api={plans} />);
    expect(await screen.findByText(/assignment unavailable/)).toBeTruthy();
    expect(screen.queryByText(/enrollment is exhausted/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry selection' }));
    expect(await screen.findByText(/enrollment is exhausted/i)).toBeTruthy();
  });

  it('ignores late detail responses after selecting another enrollment', async () => {
    let resolveFirst!: (value: ReturnType<typeof definition>) => void;
    const plans = api();
    vi.mocked(plans.getPlanDefinitionVersion).mockImplementation(id => id === first.definitionVersionId
      ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve(definition(id, 'Second plan')));
    render(<PlanPanel api={plans} />);
    const select = await screen.findByLabelText('Retained enrollment');
    fireEvent.change(select, { target: { value: second.id } });
    expect(await screen.findByText('Second plan')).toBeTruthy();
    await act(async () => { resolveFirst(definition(first.definitionVersionId, 'Stale first plan')); });
    expect(screen.getByText('Second plan')).toBeTruthy();
    expect(screen.queryByText('Stale first plan')).toBeNull();
  });

  it('ignores a late detail rejection after selecting another enrollment', async () => {
    let rejectFirst!: (reason: unknown) => void;
    const plans = api();
    vi.mocked(plans.getPlanDefinitionVersion).mockImplementation(id => id === first.definitionVersionId
      ? new Promise((_resolve, reject) => { rejectFirst = reject; }) : Promise.resolve(definition(id, 'Second plan')));
    render(<PlanPanel api={plans} />);
    const select = await screen.findByLabelText('Retained enrollment');
    fireEvent.change(select, { target: { value: second.id } });
    expect(await screen.findByText('Second plan')).toBeTruthy();
    await act(async () => { rejectFirst(new Error('stale rejection')); });
    expect(screen.getByText('Second plan')).toBeTruthy();
    expect(screen.queryByText(/stale rejection/i)).toBeNull();
  });

  it('discards pending list and detail responses after unmount', async () => {
    let resolveList!: (value: PlanEnrollment[]) => void;
    const plans = api(); vi.mocked(plans.listPlanEnrollments).mockImplementationOnce(() => new Promise(resolve => { resolveList = resolve; }));
    const listView = render(<PlanPanel api={plans} />); listView.unmount();
    await act(async () => { resolveList([first]); });

    let resolveDefinition!: (value: ReturnType<typeof definition>) => void;
    vi.mocked(plans.listPlanEnrollments).mockResolvedValueOnce([first]);
    vi.mocked(plans.getPlanDefinitionVersion).mockImplementationOnce(() => new Promise(resolve => { resolveDefinition = resolve; }));
    const detailView = render(<PlanPanel api={plans} />);
    await screen.findByLabelText('Retained enrollment'); detailView.unmount();
    await act(async () => { resolveDefinition(definition(first.definitionVersionId, 'Late plan')); });
    expect(screen.queryByText('Late plan')).toBeNull();
  });

  it('identifies browser preview plans as native-only', () => {
    render(<PlanPanel />);
    expect(screen.getByText('Plans are available in the native desktop app.')).toBeTruthy();
  });

  it('requires explicit setup and submits selected starts and loop policies once', async () => {
    const plans = api();
    vi.mocked(plans.listPlanEnrollments).mockResolvedValueOnce([]).mockResolvedValueOnce([created]);
    render(<PlanPanel api={plans} />);
    await screen.findByText('No retained plan enrollments yet.');
    expect(plans.registerFourStreamPlan).not.toHaveBeenCalled();
    expect(plans.enrollInChapterStreams).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Set up four-stream plan' }));
    expect(await screen.findByText('Four streams')).toBeTruthy();
    const starts = screen.getAllByLabelText('Starting chapter') as HTMLSelectElement[];
    const loops = screen.getAllByLabelText('Loop after the final chapter') as HTMLInputElement[];
    expect(starts.map(select => select.value)).toEqual(['0', '0', '0', '0']);
    expect(loops.every(input => input.checked)).toBe(true);
    fireEvent.change(starts[0], { target: { value: '1' } });
    fireEvent.click(loops[1]);
    const submit = screen.getByRole('button', { name: 'Create enrollment' });
    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => expect(plans.enrollInChapterStreams).toHaveBeenCalledTimes(1));
    expect(plans.enrollInChapterStreams).toHaveBeenCalledWith(fourStream.id, [
      { streamId: 'old', startingPosition: 1, loopAfterEnd: true },
      { streamId: 'new', startingPosition: 0, loopAfterEnd: false },
      { streamId: 'psalms', startingPosition: 0, loopAfterEnd: true },
      { streamId: 'proverbs', startingPosition: 0, loopAfterEnd: true },
    ]);
    await waitFor(() => expect((screen.getByLabelText('Retained enrollment') as HTMLSelectElement).value).toBe(created.id));
    expect(plans.listPlanEnrollments).toHaveBeenCalledTimes(2);
  });

  it('disables pending enrollment and reports failure without retrying or mutating the retained selection', async () => {
    let rejectEnrollment!: (reason: unknown) => void;
    const plans = api();
    vi.mocked(plans.enrollInChapterStreams).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectEnrollment = reject; }));
    render(<PlanPanel api={plans} />);
    await screen.findByText('First plan');
    fireEvent.click(screen.getByRole('button', { name: 'Set up four-stream plan' }));
    await screen.findByText('Four streams');
    fireEvent.click(screen.getByRole('button', { name: 'Create enrollment' }));
    expect((screen.getByRole('button', { name: 'Creating enrollment…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { rejectEnrollment(new Error('database busy')); });
    expect(await screen.findByText(/Could not create enrollment: Error: database busy/)).toBeTruthy();
    expect(plans.enrollInChapterStreams).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('Retained enrollment') as HTMLSelectElement).value).toBe(first.id);
  });

  it('reports a failed explicit setup without registering or enrolling again automatically', async () => {
    const plans = api();
    vi.mocked(plans.registerFourStreamPlan).mockRejectedValueOnce(new Error('registration failed'));
    render(<PlanPanel api={plans} />);
    await screen.findByText('First plan');
    fireEvent.click(screen.getByRole('button', { name: 'Set up four-stream plan' }));
    expect(await screen.findByText(/Could not prepare four-stream enrollment: Error: registration failed/)).toBeTruthy();
    expect(plans.registerFourStreamPlan).toHaveBeenCalledTimes(1);
    expect(plans.enrollInChapterStreams).not.toHaveBeenCalled();
  });

  it('ignores an obsolete enrollment result after unmount', async () => {
    let resolveEnrollment!: (value: PlanEnrollment) => void;
    const plans = api();
    vi.mocked(plans.enrollInChapterStreams).mockImplementationOnce(() => new Promise(resolve => { resolveEnrollment = resolve; }));
    const view = render(<PlanPanel api={plans} />);
    await screen.findByText('First plan');
    fireEvent.click(screen.getByRole('button', { name: 'Set up four-stream plan' }));
    await screen.findByText('Four streams');
    fireEvent.click(screen.getByRole('button', { name: 'Create enrollment' }));
    view.unmount();
    await act(async () => { resolveEnrollment(created); });
    expect(plans.listPlanEnrollments).toHaveBeenCalledTimes(1);
  });

  it('settles setup when retained discovery is retried while registration is pending', async () => {
    let resolveSetup!: (value: typeof fourStream) => void;
    const plans = api();
    vi.mocked(plans.listPlanEnrollments).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([first]);
    vi.mocked(plans.registerFourStreamPlan).mockImplementationOnce(() => new Promise(resolve => { resolveSetup = resolve; }));
    render(<PlanPanel api={plans} />);
    await screen.findByText(/Could not load retained plans/);
    fireEvent.click(screen.getByRole('button', { name: 'Set up four-stream plan' }));
    expect((screen.getByRole('button', { name: 'Preparing…' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry plans' }));
    await act(async () => { resolveSetup(fourStream); });
    expect(await screen.findByText('Four streams')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create enrollment' })).toBeTruthy();
  });

  it('settles successful and failed enrollment actions across discovery retries', async () => {
    let resolveEnrollment!: (value: PlanEnrollment) => void;
    const plans = api();
    vi.mocked(plans.listPlanEnrollments)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([first, created]);
    vi.mocked(plans.enrollInChapterStreams).mockImplementationOnce(() => new Promise(resolve => { resolveEnrollment = resolve; }));
    const view = render(<PlanPanel api={plans} />);
    await screen.findByText(/Could not load retained plans/);
    fireEvent.click(screen.getByRole('button', { name: 'Set up four-stream plan' }));
    await screen.findByText('Four streams');
    fireEvent.click(screen.getByRole('button', { name: 'Create enrollment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry plans' }));
    await act(async () => { resolveEnrollment(created); });
    await waitFor(() => expect((screen.getByLabelText('Retained enrollment') as HTMLSelectElement).value).toBe(created.id));
    view.unmount();

    let rejectEnrollment!: (reason: unknown) => void;
    const failingPlans = api();
    vi.mocked(failingPlans.listPlanEnrollments).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([first]);
    vi.mocked(failingPlans.enrollInChapterStreams).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectEnrollment = reject; }));
    render(<PlanPanel api={failingPlans} />);
    await screen.findByText(/Could not load retained plans/);
    fireEvent.click(screen.getByRole('button', { name: 'Set up four-stream plan' }));
    await screen.findByText('Four streams');
    fireEvent.click(screen.getByRole('button', { name: 'Create enrollment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry plans' }));
    await act(async () => { rejectEnrollment(new Error('write rejected')); });
    expect(await screen.findByText(/Could not create enrollment: Error: write rejected/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create enrollment' })).toBeTruthy();
    expect(failingPlans.enrollInChapterStreams).toHaveBeenCalledTimes(1);
  });

  it('does not let an older discovery overwrite a confirmed enrollment refresh', async () => {
    let resolveInitial!: (value: PlanEnrollment[]) => void;
    const plans = api();
    vi.mocked(plans.listPlanEnrollments)
      .mockImplementationOnce(() => new Promise(resolve => { resolveInitial = resolve; }))
      .mockResolvedValueOnce([first, created]);
    render(<PlanPanel api={plans} />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up four-stream plan' }));
    await screen.findByText('Four streams');
    fireEvent.click(screen.getByRole('button', { name: 'Create enrollment' }));
    await waitFor(() => expect((screen.getByLabelText('Retained enrollment') as HTMLSelectElement).value).toBe(created.id));
    await act(async () => { resolveInitial([first]); });
    expect((screen.getByLabelText('Retained enrollment') as HTMLSelectElement).value).toBe(created.id);
    expect(screen.getByRole('option', { name: created.id })).toBeTruthy();
  });

  it('keeps known and confirmed enrollments when post-commit refresh fails', async () => {
    const plans = api();
    vi.mocked(plans.listPlanEnrollments).mockResolvedValueOnce([first]).mockRejectedValueOnce(new Error('refresh offline'));
    render(<PlanPanel api={plans} />);
    await screen.findByText('First plan');
    fireEvent.click(screen.getByRole('button', { name: 'Set up four-stream plan' }));
    await screen.findByText('Four streams');
    fireEvent.click(screen.getByRole('button', { name: 'Create enrollment' }));
    expect(await screen.findByText(/Enrollment was created, but retained plans could not be refreshed: Error: refresh offline/)).toBeTruthy();
    const select = screen.getByLabelText('Retained enrollment') as HTMLSelectElement;
    expect(Array.from(select.options, option => option.value)).toEqual([first.id, created.id]);
    expect(select.value).toBe(created.id);
    expect(plans.enrollInChapterStreams).toHaveBeenCalledTimes(1);
  });

  it('keeps a confirmed enrollment finalized when a newer retry supersedes its pending refresh', async () => {
    let resolveRefresh!: (value: PlanEnrollment[]) => void;
    let resolveRetry!: (value: PlanEnrollment[]) => void;
    const plans = api();
    vi.mocked(plans.listPlanEnrollments)
      .mockRejectedValueOnce(new Error('initial offline'))
      .mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveRetry = resolve; }));
    render(<PlanPanel api={plans} />);
    await screen.findByText(/Could not load retained plans/);
    fireEvent.click(screen.getByRole('button', { name: 'Set up four-stream plan' }));
    await screen.findByText('Four streams');
    fireEvent.click(screen.getByRole('button', { name: 'Create enrollment' }));
    await waitFor(() => expect(plans.listPlanEnrollments).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Create enrollment' })).toBeNull();
    expect((screen.getByLabelText('Retained enrollment') as HTMLSelectElement).value).toBe(created.id);

    fireEvent.click(screen.getByRole('button', { name: 'Retry plans' }));
    await act(async () => { resolveRetry([first, created]); });
    expect((screen.getByLabelText('Retained enrollment') as HTMLSelectElement).value).toBe(created.id);
    expect(screen.queryByRole('button', { name: 'Create enrollment' })).toBeNull();
    await act(async () => { resolveRefresh([first, created]); });
    expect((screen.getByLabelText('Retained enrollment') as HTMLSelectElement).value).toBe(created.id);
    expect(plans.enrollInChapterStreams).toHaveBeenCalledTimes(1);
  });

  it('keeps a confirmed enrollment finalized when retry and stale refresh both reject', async () => {
    let rejectRefresh!: (reason: unknown) => void;
    let rejectRetry!: (reason: unknown) => void;
    const plans = api();
    vi.mocked(plans.listPlanEnrollments)
      .mockRejectedValueOnce(new Error('initial offline'))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRefresh = reject; }))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRetry = reject; }));
    render(<PlanPanel api={plans} />);
    await screen.findByText(/Could not load retained plans/);
    fireEvent.click(screen.getByRole('button', { name: 'Set up four-stream plan' }));
    await screen.findByText('Four streams');
    fireEvent.click(screen.getByRole('button', { name: 'Create enrollment' }));
    await waitFor(() => expect(plans.listPlanEnrollments).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Retry plans' }));
    await act(async () => { rejectRetry(new Error('retry offline')); });
    expect(await screen.findByText(/Could not load retained plans: Error: retry offline/)).toBeTruthy();
    expect((screen.getByLabelText('Retained enrollment') as HTMLSelectElement).value).toBe(created.id);
    expect(screen.queryByRole('button', { name: 'Create enrollment' })).toBeNull();
    await act(async () => { rejectRefresh(new Error('stale refresh failure')); });
    expect(screen.queryByText(/stale refresh failure/)).toBeNull();
    expect((screen.getByLabelText('Retained enrollment') as HTMLSelectElement).value).toBe(created.id);
    expect(plans.enrollInChapterStreams).toHaveBeenCalledTimes(1);
  });

  it('preserves ready assignment details when discovery retry and stale refresh reject', async () => {
    let rejectRefresh!: (reason: unknown) => void;
    let rejectRetry!: (reason: unknown) => void;
    const plans = api();
    vi.mocked(plans.listPlanEnrollments)
      .mockRejectedValueOnce(new Error('initial offline'))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRefresh = reject; }))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRetry = reject; }));
    vi.mocked(plans.getPlanDefinitionVersion).mockResolvedValue(fourStream);
    vi.mocked(plans.activePlanAssignments).mockResolvedValue([{ id: 'created-assignment', enrollmentId: created.id, streamId: 'old', ordinal: 1, cycle: 1, passage: { book: 1, chapter: 1 }, streamPosition: 0, progressId: 'created-progress' }]);
    render(<PlanPanel api={plans} />);
    await screen.findByText(/Could not load retained plans/);
    fireEvent.click(screen.getByRole('button', { name: 'Set up four-stream plan' }));
    await screen.findByText('Four streams');
    fireEvent.click(screen.getByRole('button', { name: 'Create enrollment' }));
    expect(await screen.findByLabelText('Current plan assignments')).toBeTruthy();
    expect(screen.getByLabelText('Current plan assignments').textContent).toContain('Book 1 · Chapter 1');

    fireEvent.click(screen.getByRole('button', { name: 'Retry plans' }));
    await act(async () => { rejectRetry(new Error('retry offline')); });
    await act(async () => { rejectRefresh(new Error('stale refresh failure')); });
    expect(screen.getByLabelText('Current plan assignments')).toBeTruthy();
    expect(screen.getByLabelText('Current plan assignments').textContent).toContain('Book 1 · Chapter 1');
    expect((screen.getByLabelText('Retained enrollment') as HTMLSelectElement).value).toBe(created.id);
    expect(plans.enrollInChapterStreams).toHaveBeenCalledTimes(1);
  });

  it('allows pending assignment details to settle after discovery retry failure', async () => {
    let rejectRefresh!: (reason: unknown) => void;
    let rejectRetry!: (reason: unknown) => void;
    let resolveAssignments!: (value: Awaited<ReturnType<PlanDefinitionApi['activePlanAssignments']>>) => void;
    const plans = api();
    vi.mocked(plans.listPlanEnrollments)
      .mockRejectedValueOnce(new Error('initial offline'))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRefresh = reject; }))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRetry = reject; }));
    vi.mocked(plans.getPlanDefinitionVersion).mockResolvedValue(fourStream);
    vi.mocked(plans.activePlanAssignments).mockImplementationOnce(() => new Promise(resolve => { resolveAssignments = resolve; }));
    render(<PlanPanel api={plans} />);
    await screen.findByText(/Could not load retained plans/);
    fireEvent.click(screen.getByRole('button', { name: 'Set up four-stream plan' }));
    await screen.findByText('Four streams');
    fireEvent.click(screen.getByRole('button', { name: 'Create enrollment' }));
    expect(await screen.findByText('Loading current assignments…')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Retry plans' }));
    await act(async () => { rejectRetry(new Error('retry offline')); });
    await act(async () => { rejectRefresh(new Error('stale refresh failure')); });
    expect(screen.getByText('Loading current assignments…')).toBeTruthy();
    await act(async () => { resolveAssignments([]); });
    expect(await screen.findByText(/enrollment is exhausted/i)).toBeTruthy();
    expect((screen.getByLabelText('Retained enrollment') as HTMLSelectElement).value).toBe(created.id);
    expect(plans.enrollInChapterStreams).toHaveBeenCalledTimes(1);
  });

  it('completes only the displayed assignment once with exact stale-write preconditions', async () => {
    let resolveCompletion!: (value: { id: string; assignmentId: string; completedAt: string }) => void;
    const plans = api();
    const current = { id: 'assignment-1', enrollmentId: first.id, streamId: 'psalms', ordinal: 1, cycle: 1, passage: { book: 19, chapter: 1 }, streamPosition: 0, progressId: 'progress-1' };
    const independent = { id: 'assignment-2', enrollmentId: first.id, streamId: 'old', ordinal: 1, cycle: 1, passage: { book: 1, chapter: 1 }, streamPosition: 0, progressId: 'progress-2' };
    const advanced = { ...current, id: 'assignment-3', ordinal: 2, passage: { book: 19, chapter: 2 }, streamPosition: 1, progressId: 'progress-3' };
    vi.mocked(plans.activePlanAssignments).mockResolvedValueOnce([current, independent]).mockResolvedValueOnce([advanced, independent]);
    vi.mocked(plans.completePlanStream).mockImplementationOnce(() => new Promise(resolve => { resolveCompletion = resolve; }));
    render(<PlanPanel api={plans} />);
    const button = await screen.findByRole('button', { name: 'Complete psalms' });
    fireEvent.click(button); fireEvent.click(button);
    expect((screen.getByRole('button', { name: 'Completing…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(plans.completePlanStream).toHaveBeenCalledTimes(1);
    expect(plans.completePlanStream).toHaveBeenCalledWith({ enrollmentId: first.id, streamId: 'psalms', expectedAssignmentId: current.id, expectedProgressId: current.progressId });
    await act(async () => { resolveCompletion({ id: 'completion-1', assignmentId: current.id, completedAt: '2026-09-18T00:00:03Z' }); });
    expect(await screen.findByText('Book 19 · Chapter 2')).toBeTruthy();
    expect(screen.getByText('Book 1 · Chapter 1')).toBeTruthy();
  });

  it('keeps a rejected completion actionable and does not retry it', async () => {
    const plans = api();
    vi.mocked(plans.completePlanStream).mockRejectedValueOnce(new Error('stale assignment'));
    render(<PlanPanel api={plans} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Complete psalms' }));
    expect(await screen.findByText(/Could not complete chapter: Error: stale assignment/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete psalms' })).toBeTruthy();
    expect(plans.completePlanStream).toHaveBeenCalledTimes(1);
  });

  it('removes a confirmed stale assignment when its refresh fails', async () => {
    const plans = api();
    vi.mocked(plans.activePlanAssignments).mockResolvedValueOnce([{ id: 'assignment-1', enrollmentId: first.id, streamId: 'psalms', ordinal: 1, cycle: 1, passage: { book: 19, chapter: 1 }, streamPosition: 0, progressId: 'progress-1' }]).mockRejectedValueOnce(new Error('refresh failed'));
    render(<PlanPanel api={plans} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Complete psalms' }));
    expect(await screen.findByText(/Chapter was completed, but assignments could not be refreshed: Error: refresh failed/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Complete psalms' })).toBeNull();
    expect(plans.completePlanStream).toHaveBeenCalledTimes(1);
  });

  it('does not show a late completion rejection after selecting another enrollment', async () => {
    let rejectCompletion!: (reason: unknown) => void;
    const plans = api();
    vi.mocked(plans.completePlanStream).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCompletion = reject; }));
    render(<PlanPanel api={plans} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Complete psalms' }));
    fireEvent.change(screen.getByLabelText('Retained enrollment'), { target: { value: second.id } });
    expect(await screen.findByText('Second plan')).toBeTruthy();
    await act(async () => { rejectCompletion(new Error('late rejection')); });
    expect(screen.queryByText(/late rejection/)).toBeNull();
    expect(screen.getByText('Second plan')).toBeTruthy();
  });

  it('does not overwrite the new selection when completion confirms after navigation', async () => {
    let resolveCompletion!: (value: { id: string; assignmentId: string; completedAt: string }) => void;
    const plans = api();
    vi.mocked(plans.completePlanStream).mockImplementationOnce(() => new Promise(resolve => { resolveCompletion = resolve; }));
    render(<PlanPanel api={plans} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Complete psalms' }));
    fireEvent.change(screen.getByLabelText('Retained enrollment'), { target: { value: second.id } });
    expect(await screen.findByText('Second plan')).toBeTruthy();
    await act(async () => { resolveCompletion({ id: 'completion-1', assignmentId: 'assignment-1', completedAt: '2026-09-18T00:00:03Z' }); });
    expect(screen.getByText('Second plan')).toBeTruthy();
    expect((screen.getByLabelText('Retained enrollment') as HTMLSelectElement).value).toBe(second.id);
    expect(plans.activePlanAssignments).toHaveBeenCalledTimes(2);
    expect(plans.completePlanStream).toHaveBeenCalledTimes(1);
  });

  it('recovers retained details when completion refresh fails after A-to-B-to-A navigation', async () => {
    let resolveCompletion!: (value: { id: string; assignmentId: string; completedAt: string }) => void;
    let resolveOldDetails!: (value: Awaited<ReturnType<PlanDefinitionApi['activePlanAssignments']>>) => void;
    let rejectRefresh!: (reason: unknown) => void;
    const plans = api();
    const current = { id: 'assignment-1', enrollmentId: first.id, streamId: 'psalms', ordinal: 1, cycle: 1, passage: { book: 19, chapter: 1 }, streamPosition: 0, progressId: 'progress-1' };
    const independent = { id: 'assignment-2', enrollmentId: first.id, streamId: 'old', ordinal: 1, cycle: 1, passage: { book: 1, chapter: 1 }, streamPosition: 0, progressId: 'progress-2' };
    const advanced = { ...current, id: 'assignment-3', ordinal: 2, passage: { book: 19, chapter: 2 }, streamPosition: 1, progressId: 'progress-3' };
    vi.mocked(plans.activePlanAssignments)
      .mockResolvedValueOnce([current, independent])
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => new Promise(resolve => { resolveOldDetails = resolve; }))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRefresh = reject; }))
      .mockResolvedValueOnce([advanced, independent]);
    vi.mocked(plans.completePlanStream).mockImplementationOnce(() => new Promise(resolve => { resolveCompletion = resolve; }));
    render(<PlanPanel api={plans} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Complete psalms' }));
    const select = screen.getByLabelText('Retained enrollment');
    fireEvent.change(select, { target: { value: second.id } });
    expect(await screen.findByText('Second plan')).toBeTruthy();
    fireEvent.change(select, { target: { value: first.id } });
    expect(await screen.findByText('Loading current assignments…')).toBeTruthy();

    await act(async () => { resolveCompletion({ id: 'completion-1', assignmentId: current.id, completedAt: '2026-09-18T00:00:03Z' }); });
    await waitFor(() => expect(plans.activePlanAssignments).toHaveBeenCalledTimes(4));
    await act(async () => { rejectRefresh(new Error('refresh failed')); });
    await act(async () => { resolveOldDetails([current, independent]); });
    expect(screen.queryByText('Loading current assignments…')).toBeNull();
    expect(await screen.findByText(/Chapter was completed, but assignments could not be refreshed: Error: refresh failed/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Complete psalms' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Complete old' })).toBeTruthy();
    expect((select as HTMLSelectElement).value).toBe(first.id);

    fireEvent.click(screen.getByRole('button', { name: 'Retry assignments' }));
    expect(await screen.findByText('Book 19 · Chapter 2')).toBeTruthy();
    expect(screen.getByText('Book 1 · Chapter 1')).toBeTruthy();
    expect(plans.completePlanStream).toHaveBeenCalledTimes(1);
  });

  it('undoes the exact displayed completion once and refreshes history and assignments independently', async () => {
    let resolveUndo!: () => void;
    const plans = api();
    const item = history('completion-current');
    const restored = { id: 'assignment-restored', enrollmentId: first.id, streamId: 'psalms', ordinal: 1, cycle: 1, passage: { book: 19, chapter: 1 }, streamPosition: 0, progressId: 'progress-restored' };
    vi.mocked(plans.planCompletionHistory).mockResolvedValueOnce([item]).mockResolvedValueOnce([{ ...item, undone: true }]);
    vi.mocked(plans.activePlanAssignments).mockResolvedValueOnce([]).mockResolvedValueOnce([restored]);
    vi.mocked(plans.undoPlanCompletion).mockImplementationOnce(() => new Promise(resolve => { resolveUndo = resolve; }));
    render(<PlanPanel api={plans} />);
    const button = await screen.findByRole('button', { name: 'Undo completion completion-current' });
    fireEvent.click(button); fireEvent.click(button);
    expect((screen.getByRole('button', { name: 'Undoing…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(plans.undoPlanCompletion).toHaveBeenCalledTimes(1);
    expect(plans.undoPlanCompletion).toHaveBeenCalledWith(item.id);
    await act(async () => { resolveUndo(); });
    await waitFor(() => expect(plans.planCompletionHistory).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(plans.activePlanAssignments).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Undone')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Undo completion completion-current' })).toBeNull();
    expect(await screen.findByRole('button', { name: 'Complete psalms' })).toBeTruthy();
  });

  it('explains causal undo rejection without changing history or retrying mutation', async () => {
    const plans = api();
    vi.mocked(plans.planCompletionHistory).mockResolvedValueOnce([history('completion-current')]);
    vi.mocked(plans.undoPlanCompletion).mockRejectedValueOnce(new Error('Undo later completions first'));
    render(<PlanPanel api={plans} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo completion completion-current' }));
    expect(await screen.findByText(/Later active completions must be undone first.*Undo later completions first/)).toBeTruthy();
    expect(screen.getByText('Current completion')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo completion completion-current' })).toBeTruthy();
    expect(plans.undoPlanCompletion).toHaveBeenCalledTimes(1);
  });

  it('retains confirmed undo when history and assignment refresh fail, then recovers reads only', async () => {
    const plans = api();
    const item = history('completion-current');
    vi.mocked(plans.planCompletionHistory)
      .mockResolvedValueOnce([item])
      .mockRejectedValueOnce(new Error('history refresh failed'))
      .mockResolvedValueOnce([{ ...item, undone: true }]);
    vi.mocked(plans.activePlanAssignments).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('assignment refresh failed')).mockResolvedValueOnce([]);
    render(<PlanPanel api={plans} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo completion completion-current' }));
    expect(await screen.findByText(/Completion history could not be refreshed: Error: history refresh failed/)).toBeTruthy();
    expect(screen.getByText('Undone')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Undo completion completion-current' })).toBeNull();
    expect(await screen.findByText(/assignment refresh failed/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry completion history' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry selection' }));
    await waitFor(() => expect(plans.planCompletionHistory).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(plans.activePlanAssignments).toHaveBeenCalledTimes(3));
    expect(screen.getByText('Undone')).toBeTruthy();
    expect(plans.undoPlanCompletion).toHaveBeenCalledTimes(1);
  });

  it('ignores a late undo rejection after selection changes', async () => {
    let rejectUndo!: (reason: unknown) => void;
    const plans = api();
    vi.mocked(plans.planCompletionHistory).mockResolvedValueOnce([history('completion-current')]).mockResolvedValueOnce([]);
    vi.mocked(plans.undoPlanCompletion).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectUndo = reject; }));
    render(<PlanPanel api={plans} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo completion completion-current' }));
    fireEvent.change(screen.getByLabelText('Retained enrollment'), { target: { value: second.id } });
    expect(await screen.findByText('No retained completions yet.')).toBeTruthy();
    await act(async () => { rejectUndo(new Error('late undo rejection')); });
    expect(screen.queryByText(/late undo rejection/)).toBeNull();
    expect((screen.getByLabelText('Retained enrollment') as HTMLSelectElement).value).toBe(second.id);
  });

  it('keeps a confirmed undo when selection changes before success and returns', async () => {
    let resolveUndo!: () => void;
    const plans = api();
    const item = history('completion-current');
    vi.mocked(plans.planCompletionHistory)
      .mockResolvedValueOnce([item])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...item, undone: false }]);
    vi.mocked(plans.undoPlanCompletion).mockImplementationOnce(() => new Promise(resolve => { resolveUndo = resolve; }));
    render(<PlanPanel api={plans} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo completion completion-current' }));
    fireEvent.change(screen.getByLabelText('Retained enrollment'), { target: { value: second.id } });
    expect(await screen.findByText('No retained completions yet.')).toBeTruthy();
    await act(async () => { resolveUndo(); });
    fireEvent.change(screen.getByLabelText('Retained enrollment'), { target: { value: first.id } });
    expect(await screen.findByText('Undone')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Undo completion completion-current' })).toBeNull();
    expect(plans.undoPlanCompletion).toHaveBeenCalledTimes(1);
  });

  it('recovers cached confirmed undo after navigation and a failed return read', async () => {
    let resolveUndo!: () => void;
    const plans = api();
    const item = history('completion-current');
    vi.mocked(plans.planCompletionHistory)
      .mockResolvedValueOnce([item])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('return history failed'))
      .mockResolvedValueOnce([{ ...item, undone: true }]);
    vi.mocked(plans.undoPlanCompletion).mockImplementationOnce(() => new Promise(resolve => { resolveUndo = resolve; }));
    render(<PlanPanel api={plans} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo completion completion-current' }));
    fireEvent.change(screen.getByLabelText('Retained enrollment'), { target: { value: second.id } });
    expect(await screen.findByText('No retained completions yet.')).toBeTruthy();
    await act(async () => { resolveUndo(); });

    fireEvent.change(screen.getByLabelText('Retained enrollment'), { target: { value: first.id } });
    expect(await screen.findByText(/Completion history could not be refreshed: Error: return history failed/)).toBeTruthy();
    expect(screen.getByText('Undone')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Undo completion completion-current' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry completion history' }));
    await waitFor(() => expect(plans.planCompletionHistory).toHaveBeenCalledTimes(4));
    expect(screen.getByText('Undone')).toBeTruthy();
    expect(plans.undoPlanCompletion).toHaveBeenCalledTimes(1);
  });
});
