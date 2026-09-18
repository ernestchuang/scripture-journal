// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PlanDefinitionApi, PlanEnrollment } from '../platform/plans';
import { PlanPanel } from './PlanPanel';

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
const created: PlanEnrollment = { id: 'enrollment-new', definitionVersionId: fourStream.id, createdAt: '2026-09-18T00:00:02Z' };
const history = (id: string, enrollmentId = first.id, undone = false) => ({ id, assignmentId: 'assignment-1', enrollmentId, streamId: 'psalms', ordinal: 1, cycle: 1, passage: { book: 19, chapter: 1 }, streamPosition: 0, completedAt: '2026-09-18T00:00:03Z', undone });
const importedPlan = { id: 'custom-version', planId: 'custom-plan', version: 1, createdAt: first.createdAt, definition: { schemaVersion: 1, name: 'Imported streams', schedule: { kind: 'chapterStreams' as const, streams: [] } } };
const api = (): Pick<PlanDefinitionApi, 'listPlanEnrollments' | 'getPlanDefinitionVersion' | 'activePlanAssignments' | 'planCompletionHistory' | 'registerFourStreamPlan' | 'importPlanDefinitionJson' | 'enrollInChapterStreams' | 'completePlanStream' | 'undoPlanCompletion'> => ({
  listPlanEnrollments: vi.fn(async () => [first, second]),
  getPlanDefinitionVersion: vi.fn(async id => definition(id, id === second.definitionVersionId ? 'Second plan' : 'First plan')),
  activePlanAssignments: vi.fn(async id => id === first.id ? [{ id: 'assignment-1', enrollmentId: id, streamId: 'psalms', ordinal: 1, cycle: 1, passage: { book: 19, chapter: 1 }, streamPosition: 0, progressId: 'progress-1' }] : []),
  planCompletionHistory: vi.fn(async () => []),
  registerFourStreamPlan: vi.fn(async () => fourStream),
  importPlanDefinitionJson: vi.fn(async () => importedPlan),
  enrollInChapterStreams: vi.fn(async () => created),
  completePlanStream: vi.fn(async request => ({ id: 'completion-1', assignmentId: request.expectedAssignmentId, completedAt: '2026-09-18T00:00:03Z' })),
  undoPlanCompletion: vi.fn(async () => undefined),
});

describe('retained plan panel', () => {
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
    expect(screen.getByRole('status').textContent).toBe('Loading retained plans…');
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
    expect(screen.getByText('Book 1 · Chapter 1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Retry plans' }));
    await act(async () => { rejectRetry(new Error('retry offline')); });
    await act(async () => { rejectRefresh(new Error('stale refresh failure')); });
    expect(screen.getByLabelText('Current plan assignments')).toBeTruthy();
    expect(screen.getByText('Book 1 · Chapter 1')).toBeTruthy();
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
