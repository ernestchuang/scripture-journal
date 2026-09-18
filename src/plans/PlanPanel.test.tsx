// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('distinguishes an empty retained list from a failed load', async () => {
    const plans = api(); vi.mocked(plans.listPlanEnrollments).mockResolvedValueOnce([]);
    render(<PlanPanel api={plans} />);
    expect(await screen.findByText('No retained plan enrollments yet.')).toBeTruthy();
  });

  it('reports a missing pinned definition and retries explicitly', async () => {
    const plans = api(); vi.mocked(plans.listPlanEnrollments).mockResolvedValueOnce([first]);
    vi.mocked(plans.getPlanDefinitionVersion).mockResolvedValueOnce(null).mockResolvedValueOnce(definition(first.definitionVersionId, 'Recovered plan'));
    render(<PlanPanel api={plans} />);
    expect(await screen.findByText(/retained plan definition is unavailable/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry selection' }));
    expect(await screen.findByText('Recovered plan')).toBeTruthy();
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
    resolveFirst(definition(first.definitionVersionId, 'Stale first plan'));
    await waitFor(() => expect(screen.queryByText('Stale first plan')).toBeNull());
  });
});
