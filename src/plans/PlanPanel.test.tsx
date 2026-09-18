// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PlanDefinitionApi, PlanEnrollment } from '../platform/plans';
import { PlanPanel } from './PlanPanel';

afterEach(cleanup);
const first: PlanEnrollment = { id: 'enrollment-1', definitionVersionId: 'version-1', createdAt: '2026-09-18T00:00:00Z' };
const second: PlanEnrollment = { id: 'enrollment-2', definitionVersionId: 'version-2', createdAt: '2026-09-18T00:00:01Z' };
const definition = (id: string, name: string) => ({ id, planId: 'plan-1', version: 1, createdAt: first.createdAt, definition: { schemaVersion: 1, name, schedule: { kind: 'chapterStreams' as const, streams: [] } } });
const api = (): Pick<PlanDefinitionApi, 'listPlanEnrollments' | 'getPlanDefinitionVersion' | 'activePlanAssignments'> => ({
  listPlanEnrollments: vi.fn(async () => [first, second]),
  getPlanDefinitionVersion: vi.fn(async id => definition(id, id === second.definitionVersionId ? 'Second plan' : 'First plan')),
  activePlanAssignments: vi.fn(async id => id === first.id ? [{ id: 'assignment-1', enrollmentId: id, streamId: 'psalms', ordinal: 1, cycle: 1, passage: { book: 19, chapter: 1 }, streamPosition: 0, progressId: 'progress-1' }] : []),
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
});
