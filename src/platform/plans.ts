import { invoke } from '@tauri-apps/api/core';
import type { Passage } from '../domain';

/** A chapter reference in canonical Protestant 66-book order. */
export interface ChapterRef {
  book: number;
  chapter: number;
}

export interface ExplicitScheduleDay {
  day: number;
  passages: Passage[];
}

export interface ChapterStream {
  id: string;
  name: string;
  chapters: ChapterRef[];
}

export type PlanSchedule =
  | { kind: 'explicitSchedule'; days: ExplicitScheduleDay[] }
  | { kind: 'chapterStreams'; streams: ChapterStream[] };

/** Portable definition data only: it never includes enrollment or progress. */
export interface PlanDefinition {
  schemaVersion: number;
  name: string;
  description?: string;
  schedule: PlanSchedule;
}

export interface PlanDefinitionVersion {
  id: string;
  planId: string;
  version: number;
  createdAt: string;
  definition: PlanDefinition;
}

export interface StreamEnrollment {
  streamId: string;
  startingPosition: number;
  loopAfterEnd: boolean;
}

export interface PlanEnrollment {
  id: string;
  definitionVersionId: string;
  createdAt: string;
}

export interface PlanAssignment {
  id: string;
  enrollmentId: string;
  streamId: string;
  ordinal: number;
  cycle: number;
  passage: Passage;
  streamPosition: number | null;
  progressId: string;
}

/** Both preconditions identify exactly the assignment epoch the user loaded. */
export interface CompleteStreamRequest {
  enrollmentId: string;
  streamId: string;
  expectedAssignmentId: string;
  expectedProgressId: string;
}

export interface PlanCompletion {
  id: string;
  assignmentId: string;
  completedAt: string;
}

/** A retained completion with its immutable assignment snapshot and undo state. */
export interface PlanCompletionHistoryItem {
  id: string;
  assignmentId: string;
  enrollmentId: string;
  streamId: string;
  ordinal: number;
  cycle: number;
  passage: Passage;
  streamPosition: number | null;
  completedAt: string;
  undone: boolean;
}

/** Native-only bridge for explicit plan-definition operations. */
export interface PlanDefinitionApi {
  registerFourStreamPlan(): Promise<PlanDefinitionVersion>;
  importPlanDefinitionJson(input: string): Promise<PlanDefinitionVersion>;
  exportPlanDefinitionJson(versionId: string): Promise<string>;
  getPlanDefinitionVersion(versionId: string): Promise<PlanDefinitionVersion | null>;
  listPlanDefinitionVersions(planId: string): Promise<PlanDefinitionVersion[]>;
  listLatestPlanDefinitionVersions(): Promise<PlanDefinitionVersion[]>;
  listPlanEnrollments(): Promise<PlanEnrollment[]>;
  enrollInChapterStreams(
    definitionVersionId: string,
    streams: StreamEnrollment[],
  ): Promise<PlanEnrollment>;
  activePlanAssignments(enrollmentId: string): Promise<PlanAssignment[]>;
  planCompletionHistory(enrollmentId: string): Promise<PlanCompletionHistoryItem[]>;
  completePlanStream(request: CompleteStreamRequest): Promise<PlanCompletion>;
  undoPlanCompletion(completionId: string): Promise<void>;
}

export const nativePlans: PlanDefinitionApi = {
  registerFourStreamPlan: () => invoke<PlanDefinitionVersion>('register_four_stream_plan'),
  importPlanDefinitionJson: input =>
    invoke<PlanDefinitionVersion>('import_plan_definition_json', { input }),
  exportPlanDefinitionJson: versionId =>
    invoke<string>('export_plan_definition_json', { versionId }),
  getPlanDefinitionVersion: versionId =>
    invoke<PlanDefinitionVersion | null>('get_plan_definition_version', { versionId }),
  listPlanDefinitionVersions: planId =>
    invoke<PlanDefinitionVersion[]>('list_plan_definition_versions', { planId }),
  listLatestPlanDefinitionVersions: () =>
    invoke<PlanDefinitionVersion[]>('list_latest_plan_definition_versions'),
  listPlanEnrollments: () => invoke<PlanEnrollment[]>('list_plan_enrollments'),
  enrollInChapterStreams: (definitionVersionId, streams) =>
    invoke<PlanEnrollment>('enroll_in_chapter_streams', { definitionVersionId, streams }),
  activePlanAssignments: enrollmentId =>
    invoke<PlanAssignment[]>('active_plan_assignments', { enrollmentId }),
  planCompletionHistory: enrollmentId =>
    invoke<PlanCompletionHistoryItem[]>('plan_completion_history', { enrollmentId }),
  completePlanStream: request =>
    invoke<PlanCompletion>('complete_plan_stream', { request }),
  undoPlanCompletion: completionId =>
    invoke<void>('undo_plan_completion', { completionId }),
};
