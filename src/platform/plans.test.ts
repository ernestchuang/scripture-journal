import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));

import {
  nativePlans,
  type CalendarAssignmentCompletion,
  type CompleteStreamRequest,
  type CompleteCalendarAssignmentRequest,
  type CalendarEnrollmentRequest,
  type CalendarPlanEnrollment,
  type DatedPlanAssignment,
  type PlanAssignment,
  type PlanDefinition,
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

const calendarRequest: CalendarEnrollmentRequest = {
  definitionVersionId: version.id,
  startDate: '2024-02-28',
  scheduleMode: 'dayOne',
};

const calendarEnrollment: CalendarPlanEnrollment = {
  id: 'calendar-enrollment-1',
  definitionVersionId: version.id,
  createdAt: '2026-09-18T00:00:00Z',
  startDate: '2024-02-28',
  scheduleMode: 'dayOne',
};

const datedAssignment: DatedPlanAssignment = {
  id: 'dated-assignment-1',
  enrollmentId: calendarEnrollment.id,
  definitionVersionId: version.id,
  definitionDay: 1,
  localDate: '2024-02-28',
  passages: [{ book: 1, chapter: 1 }, { book: 40, chapter: 1 }],
};

const calendarCompletionRequest: CompleteCalendarAssignmentRequest = {
  enrollmentId: calendarEnrollment.id,
  assignmentId: datedAssignment.id,
};

const calendarCompletion: CalendarAssignmentCompletion = {
  id: 'calendar-completion-1',
  assignmentId: datedAssignment.id,
  enrollmentId: calendarEnrollment.id,
  completedAt: '2026-09-18T00:00:03Z',
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
    const edited: PlanDefinition = { ...version.definition, name: 'Edited plan' };
    native.invoke
      .mockResolvedValueOnce(version)
      .mockResolvedValueOnce(streamVersion)
      .mockResolvedValueOnce({ ...version, id: 'version-3', version: 2, definition: edited })
      .mockResolvedValueOnce('{"schemaVersion":1}')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([version])
      .mockResolvedValueOnce([streamVersion]);

    await expect(nativePlans.registerFourStreamPlan()).resolves.toEqual(version);
    await expect(nativePlans.importPlanDefinitionJson('{"schemaVersion":1}')).resolves.toEqual(streamVersion);
    await expect(nativePlans.createPlanDefinitionVersion('plan-1', edited)).resolves.toMatchObject({ version: 2, definition: edited });
    await expect(nativePlans.exportPlanDefinitionJson('version-1')).resolves.toBe('{"schemaVersion":1}');
    await expect(nativePlans.getPlanDefinitionVersion('missing-version')).resolves.toBeNull();
    await expect(nativePlans.listPlanDefinitionVersions('plan-1')).resolves.toEqual([version]);
    await expect(nativePlans.listLatestPlanDefinitionVersions()).resolves.toEqual([streamVersion]);
    expect(native.invoke).toHaveBeenNthCalledWith(1, 'register_four_stream_plan');
    expect(native.invoke).toHaveBeenNthCalledWith(2, 'import_plan_definition_json', { input: '{"schemaVersion":1}' });
    expect(native.invoke).toHaveBeenNthCalledWith(3, 'create_plan_definition_version', { planId: 'plan-1', definition: edited });
    expect(native.invoke).toHaveBeenNthCalledWith(4, 'export_plan_definition_json', { versionId: 'version-1' });
    expect(native.invoke).toHaveBeenNthCalledWith(5, 'get_plan_definition_version', { versionId: 'missing-version' });
    expect(native.invoke).toHaveBeenNthCalledWith(6, 'list_plan_definition_versions', { planId: 'plan-1' });
    expect(native.invoke).toHaveBeenNthCalledWith(7, 'list_latest_plan_definition_versions');
  });

  it('propagates version-creation rejection without retrying', async () => {
    const error = new Error('Plan not found');
    native.invoke.mockRejectedValueOnce(error);
    await expect(nativePlans.createPlanDefinitionVersion('missing-plan', version.definition)).rejects.toBe(error);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith('create_plan_definition_version', {
      planId: 'missing-plan',
      definition: version.definition,
    });
  });

  it('maps idempotent M’Cheyne registration to its exact no-argument native command', async () => {
    const mcheyne = { ...version, id: 'mcheyne-version', planId: 'mcheyne-plan', definition: { ...version.definition, name: "M’Cheyne's Daily Bible Readings" } };
    native.invoke.mockResolvedValueOnce(mcheyne).mockResolvedValueOnce(mcheyne);

    await expect(nativePlans.registerMcheynePlan()).resolves.toEqual(mcheyne);
    await expect(nativePlans.registerMcheynePlan()).resolves.toEqual(mcheyne);
    expect(native.invoke).toHaveBeenNthCalledWith(1, 'register_mcheyne_plan');
    expect(native.invoke).toHaveBeenNthCalledWith(2, 'register_mcheyne_plan');
  });

  it('propagates M’Cheyne registration errors without retrying', async () => {
    const error = new Error('Journal is unavailable; restart the app.');
    native.invoke.mockRejectedValueOnce(error);

    await expect(nativePlans.registerMcheynePlan()).rejects.toBe(error);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith('register_mcheyne_plan');
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

  it('maps calendar enrollment and readback with exact local dates, modes, IDs, and snapshots', async () => {
    native.invoke
      .mockResolvedValueOnce(calendarEnrollment)
      .mockResolvedValueOnce(calendarEnrollment)
      .mockResolvedValueOnce([datedAssignment]);

    await expect(nativePlans.enrollInCalendar(calendarRequest)).resolves.toEqual(calendarEnrollment);
    await expect(nativePlans.getCalendarPlanEnrollment(calendarEnrollment.id)).resolves.toEqual(calendarEnrollment);
    await expect(nativePlans.calendarPlanAssignments(calendarEnrollment.id)).resolves.toEqual([datedAssignment]);

    expect(native.invoke).toHaveBeenNthCalledWith(1, 'enroll_in_calendar', { request: calendarRequest });
    expect(native.invoke).toHaveBeenNthCalledWith(2, 'get_calendar_plan_enrollment', { enrollmentId: calendarEnrollment.id });
    expect(native.invoke).toHaveBeenNthCalledWith(3, 'calendar_plan_assignments', { enrollmentId: calendarEnrollment.id });
  });

  it('returns empty or missing calendar readback unchanged and propagates a calendar enrollment error', async () => {
    const error = new Error('Calendar start date must be an ISO local date (YYYY-MM-DD).');
    native.invoke.mockResolvedValueOnce(null).mockResolvedValueOnce([]).mockRejectedValueOnce(error);

    await expect(nativePlans.getCalendarPlanEnrollment('missing-calendar-enrollment')).resolves.toBeNull();
    await expect(nativePlans.calendarPlanAssignments('calendar-enrollment-empty')).resolves.toEqual([]);
    await expect(nativePlans.enrollInCalendar({ ...calendarRequest, startDate: '2024-2-28' })).rejects.toBe(error);

    expect(native.invoke).toHaveBeenNthCalledWith(1, 'get_calendar_plan_enrollment', { enrollmentId: 'missing-calendar-enrollment' });
    expect(native.invoke).toHaveBeenNthCalledWith(2, 'calendar_plan_assignments', { enrollmentId: 'calendar-enrollment-empty' });
    expect(native.invoke).toHaveBeenNthCalledWith(3, 'enroll_in_calendar', { request: { ...calendarRequest, startDate: '2024-2-28' } });
  });

  it('maps calendar completion and retained history with exact IDs and camelCase fields', async () => {
    native.invoke.mockResolvedValueOnce(calendarCompletion).mockResolvedValueOnce([calendarCompletion]);

    await expect(nativePlans.completeCalendarAssignment(calendarCompletionRequest)).resolves.toEqual(calendarCompletion);
    await expect(nativePlans.calendarCompletionHistory(calendarEnrollment.id)).resolves.toEqual([calendarCompletion]);

    expect(native.invoke).toHaveBeenNthCalledWith(1, 'complete_calendar_assignment', { request: calendarCompletionRequest });
    expect(native.invoke).toHaveBeenNthCalledWith(2, 'calendar_completion_history', { enrollmentId: calendarEnrollment.id });
    expect(calendarCompletion).toEqual({
      id: 'calendar-completion-1',
      assignmentId: datedAssignment.id,
      enrollmentId: calendarEnrollment.id,
      completedAt: '2026-09-18T00:00:03Z',
    });
  });

  it('propagates calendar completion ownership and duplicate errors without rewriting arguments', async () => {
    const error = new Error('Calendar assignment does not belong to enrollment');
    const invalid: CompleteCalendarAssignmentRequest = { enrollmentId: 'other-calendar-enrollment', assignmentId: datedAssignment.id };
    native.invoke.mockRejectedValueOnce(error).mockRejectedValueOnce(error);

    await expect(nativePlans.completeCalendarAssignment(invalid)).rejects.toBe(error);
    await expect(nativePlans.completeCalendarAssignment(calendarCompletionRequest)).rejects.toBe(error);

    expect(native.invoke).toHaveBeenNthCalledWith(1, 'complete_calendar_assignment', { request: invalid });
    expect(native.invoke).toHaveBeenNthCalledWith(2, 'complete_calendar_assignment', { request: calendarCompletionRequest });
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
