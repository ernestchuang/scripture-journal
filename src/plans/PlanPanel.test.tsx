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
const api = (): Pick<PlanDefinitionApi, 'listPlanEnrollments' | 'getPlanDefinitionVersion' | 'activePlanAssignments' | 'registerFourStreamPlan' | 'enrollInChapterStreams' | 'completePlanStream'> => ({
  listPlanEnrollments: vi.fn(async () => [first, second]),
  getPlanDefinitionVersion: vi.fn(async id => definition(id, id === second.definitionVersionId ? 'Second plan' : 'First plan')),
  activePlanAssignments: vi.fn(async id => id === first.id ? [{ id: 'assignment-1', enrollmentId: id, streamId: 'psalms', ordinal: 1, cycle: 1, passage: { book: 19, chapter: 1 }, streamPosition: 0, progressId: 'progress-1' }] : []),
  registerFourStreamPlan: vi.fn(async () => fourStream),
  enrollInChapterStreams: vi.fn(async () => created),
  completePlanStream: vi.fn(async request => ({ id: 'completion-1', assignmentId: request.expectedAssignmentId, completedAt: '2026-09-18T00:00:03Z' })),
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
});
