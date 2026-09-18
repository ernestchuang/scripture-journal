import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));

import {
  nativePlans,
  type CompleteStreamRequest,
  type PlanAssignment,
  type PlanDefinitionVersion,
  type PlanEnrollment,
  type PlanCompletionHistoryItem,
  type StreamEnrollment,
} from './plans';

const version: PlanDefinitionVersion = {
  id: 'version-1',
  planId: 'plan-1',
  version: 1,
  createdAt: '2026-09-18T00:00:00Z',
  definition: {
    schemaVersion: 1,
    name: 'Synthetic plan',
    schedule: { kind: 'explicitSchedule', days: [{ day: 1, passages: [{ book: 43, chapter: 3 }] }] },
  },
};

const streamVersion: PlanDefinitionVersion = {
  ...version,
  id: 'version-2',
  definition: {
    schemaVersion: 1,
    name: 'Four stream plan',
    description: 'A canonical chapter stream plan.',
    schedule: {
      kind: 'chapterStreams',
      streams: [{ id: 'stream-1', name: 'Stream 1', chapters: [{ book: 1, chapter: 1 }] }],
    },
  },
};

const streams: StreamEnrollment[] = [
  { streamId: 'old-testament', startingPosition: 0, loopAfterEnd: true },
];

const enrollment: PlanEnrollment = {
  id: 'enrollment-1',
  definitionVersionId: 'version-1',
  createdAt: '2026-09-18T00:00:00Z',
};

const assignment: PlanAssignment = {
  id: 'assignment-1',
  enrollmentId: enrollment.id,
  streamId: 'old-testament',
  ordinal: 1,
  cycle: 1,
  passage: { book: 1, chapter: 1 },
  streamPosition: null,
  progressId: 'progress-1',
};

const completionRequest: CompleteStreamRequest = {
  enrollmentId: enrollment.id,
  streamId: assignment.streamId,
  expectedAssignmentId: assignment.id,
  expectedProgressId: assignment.progressId,
};

const completionHistory: PlanCompletionHistoryItem = {
  id: 'completion-1',
  assignmentId: assignment.id,
  enrollmentId: enrollment.id,
  streamId: assignment.streamId,
  ordinal: 1,
  cycle: 1,
  passage: assignment.passage,
  streamPosition: null,
  completedAt: '2026-09-18T00:00:01Z',
  undone: true,
};

describe('native plan-definition adapter', () => {
  beforeEach(() => native.invoke.mockReset());

  it('maps each typed operation to its exact native command and camelCase arguments', async () => {
    native.invoke
      .mockResolvedValueOnce(version)
      .mockResolvedValueOnce(streamVersion)
      .mockResolvedValueOnce('{"schemaVersion":1}')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([version])
      .mockResolvedValueOnce([streamVersion]);

    await expect(nativePlans.registerFourStreamPlan()).resolves.toEqual(version);
    await expect(nativePlans.importPlanDefinitionJson('{"schemaVersion":1}')).resolves.toEqual(streamVersion);
    await expect(nativePlans.exportPlanDefinitionJson('version-1')).resolves.toBe('{"schemaVersion":1}');
    await expect(nativePlans.getPlanDefinitionVersion('missing-version')).resolves.toBeNull();
    await expect(nativePlans.listPlanDefinitionVersions('plan-1')).resolves.toEqual([version]);
    await expect(nativePlans.listLatestPlanDefinitionVersions()).resolves.toEqual([streamVersion]);
    expect(native.invoke).toHaveBeenNthCalledWith(1, 'register_four_stream_plan');
    expect(native.invoke).toHaveBeenNthCalledWith(2, 'import_plan_definition_json', { input: '{"schemaVersion":1}' });
    expect(native.invoke).toHaveBeenNthCalledWith(3, 'export_plan_definition_json', { versionId: 'version-1' });
    expect(native.invoke).toHaveBeenNthCalledWith(4, 'get_plan_definition_version', { versionId: 'missing-version' });
    expect(native.invoke).toHaveBeenNthCalledWith(5, 'list_plan_definition_versions', { planId: 'plan-1' });
    expect(native.invoke).toHaveBeenNthCalledWith(6, 'list_latest_plan_definition_versions');
  });

  it('propagates a native mutation error without retrying the import', async () => {
    const error = new Error('Invalid plan definition JSON');
    native.invoke.mockRejectedValueOnce(error);
    await expect(nativePlans.importPlanDefinitionJson('{')).rejects.toBe(error);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith('import_plan_definition_json', { input: '{' });
  });

  it('maps retained enrollment discovery and preserves ordered results', async () => {
    const laterEnrollment: PlanEnrollment = {
      ...enrollment,
      id: 'enrollment-2',
      createdAt: '2026-09-18T00:00:01Z',
    };
    native.invoke.mockResolvedValueOnce([enrollment, laterEnrollment]);

    await expect(nativePlans.listPlanEnrollments()).resolves.toEqual([
      enrollment,
      laterEnrollment,
    ]);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith('list_plan_enrollments');
  });

  it('returns an empty retained enrollment result unchanged', async () => {
    native.invoke.mockResolvedValueOnce([]);

    await expect(nativePlans.listPlanEnrollments()).resolves.toEqual([]);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith('list_plan_enrollments');
  });

  it('propagates enrollment discovery errors without reporting results', async () => {
    const error = new Error('Journal is unavailable; restart the app.');
    native.invoke.mockRejectedValueOnce(error);

    await expect(nativePlans.listPlanEnrollments()).rejects.toBe(error);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith('list_plan_enrollments');
  });

  it('returns an empty latest-definition result unchanged', async () => {
    native.invoke.mockResolvedValueOnce([]);

    await expect(nativePlans.listLatestPlanDefinitionVersions()).resolves.toEqual([]);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith('list_latest_plan_definition_versions');
  });

  it('propagates latest-definition discovery errors without retrying', async () => {
    const error = new Error('Journal is unavailable; restart the app.');
    native.invoke.mockRejectedValueOnce(error);

    await expect(nativePlans.listLatestPlanDefinitionVersions()).rejects.toBe(error);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith('list_latest_plan_definition_versions');
  });

  it('maps stream progress operations with the complete stale-completion precondition', async () => {
    native.invoke
      .mockResolvedValueOnce(enrollment)
      .mockResolvedValueOnce([assignment])
      .mockResolvedValueOnce({
        id: 'completion-1',
        assignmentId: assignment.id,
        completedAt: '2026-09-18T00:00:01Z',
      })
      .mockResolvedValueOnce(undefined);

    await expect(nativePlans.enrollInChapterStreams('version-1', streams)).resolves.toEqual(enrollment);
    await expect(nativePlans.activePlanAssignments(enrollment.id)).resolves.toEqual([assignment]);
    await expect(nativePlans.completePlanStream(completionRequest)).resolves.toMatchObject({
      assignmentId: assignment.id,
    });
    await expect(nativePlans.undoPlanCompletion('completion-1')).resolves.toBeUndefined();

    expect(native.invoke).toHaveBeenNthCalledWith(1, 'enroll_in_chapter_streams', {
      definitionVersionId: 'version-1',
      streams,
    });
    expect(native.invoke).toHaveBeenNthCalledWith(2, 'active_plan_assignments', {
      enrollmentId: enrollment.id,
    });
    expect(native.invoke).toHaveBeenNthCalledWith(3, 'complete_plan_stream', {
      request: completionRequest,
    });
    expect(native.invoke).toHaveBeenNthCalledWith(4, 'undo_plan_completion', {
      completionId: 'completion-1',
    });
  });

  it('maps retained completion history with all camelCase fields intact', async () => {
    native.invoke.mockResolvedValueOnce([completionHistory]);

    await expect(nativePlans.planCompletionHistory(enrollment.id)).resolves.toEqual([
      completionHistory,
    ]);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith('plan_completion_history', {
      enrollmentId: enrollment.id,
    });
    expect(completionHistory).toEqual({
      id: 'completion-1',
      assignmentId: assignment.id,
      enrollmentId: enrollment.id,
      streamId: assignment.streamId,
      ordinal: 1,
      cycle: 1,
      passage: { book: 1, chapter: 1 },
      streamPosition: null,
      completedAt: '2026-09-18T00:00:01Z',
      undone: true,
    });
  });

  it('returns empty retained completion history unchanged', async () => {
    native.invoke.mockResolvedValueOnce([]);

    await expect(nativePlans.planCompletionHistory(enrollment.id)).resolves.toEqual([]);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith('plan_completion_history', {
      enrollmentId: enrollment.id,
    });
  });

  it('propagates completion-history errors without reporting results', async () => {
    const error = new Error('Journal is unavailable; restart the app.');
    native.invoke.mockRejectedValueOnce(error);

    await expect(nativePlans.planCompletionHistory(enrollment.id)).rejects.toBe(error);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith('plan_completion_history', {
      enrollmentId: enrollment.id,
    });
  });

  it('propagates a stale completion error without retrying or reporting success', async () => {
    const error = new Error('Conflict: assignment changed since it was loaded');
    native.invoke.mockRejectedValueOnce(error);

    await expect(nativePlans.completePlanStream(completionRequest)).rejects.toBe(error);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith('complete_plan_stream', {
      request: completionRequest,
    });
  });
});
