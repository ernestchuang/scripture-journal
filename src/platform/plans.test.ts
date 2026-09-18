import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));

import { nativePlans, type PlanDefinitionVersion } from './plans';

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

describe('native plan-definition adapter', () => {
  beforeEach(() => native.invoke.mockReset());

  it('maps each typed operation to its exact native command and camelCase arguments', async () => {
    native.invoke
      .mockResolvedValueOnce(version)
      .mockResolvedValueOnce(streamVersion)
      .mockResolvedValueOnce('{"schemaVersion":1}')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([version]);

    await expect(nativePlans.registerFourStreamPlan()).resolves.toEqual(version);
    await expect(nativePlans.importPlanDefinitionJson('{"schemaVersion":1}')).resolves.toEqual(streamVersion);
    await expect(nativePlans.exportPlanDefinitionJson('version-1')).resolves.toBe('{"schemaVersion":1}');
    await expect(nativePlans.getPlanDefinitionVersion('missing-version')).resolves.toBeNull();
    await expect(nativePlans.listPlanDefinitionVersions('plan-1')).resolves.toEqual([version]);
    expect(native.invoke).toHaveBeenNthCalledWith(1, 'register_four_stream_plan');
    expect(native.invoke).toHaveBeenNthCalledWith(2, 'import_plan_definition_json', { input: '{"schemaVersion":1}' });
    expect(native.invoke).toHaveBeenNthCalledWith(3, 'export_plan_definition_json', { versionId: 'version-1' });
    expect(native.invoke).toHaveBeenNthCalledWith(4, 'get_plan_definition_version', { versionId: 'missing-version' });
    expect(native.invoke).toHaveBeenNthCalledWith(5, 'list_plan_definition_versions', { planId: 'plan-1' });
  });

  it('propagates a native mutation error without retrying the import', async () => {
    const error = new Error('Invalid plan definition JSON');
    native.invoke.mockRejectedValueOnce(error);
    await expect(nativePlans.importPlanDefinitionJson('{')).rejects.toBe(error);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith('import_plan_definition_json', { input: '{' });
  });
});
