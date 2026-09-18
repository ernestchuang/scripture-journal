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

/** Native-only bridge for explicit plan-definition operations. */
export interface PlanDefinitionApi {
  registerFourStreamPlan(): Promise<PlanDefinitionVersion>;
  importPlanDefinitionJson(input: string): Promise<PlanDefinitionVersion>;
  exportPlanDefinitionJson(versionId: string): Promise<string>;
  getPlanDefinitionVersion(versionId: string): Promise<PlanDefinitionVersion | null>;
  listPlanDefinitionVersions(planId: string): Promise<PlanDefinitionVersion[]>;
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
};
