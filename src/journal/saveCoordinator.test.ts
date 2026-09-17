import { describe, expect, it, vi } from 'vitest';
import { blankContent, type Entry, type SaveRequest } from '../domain';
import type { JournalApi } from '../platform/journal';
import { SaveCoordinator } from './saveCoordinator';

const record = (request: SaveRequest, revision: string): Entry => ({ id: request.entryId,
  createdAt: '2026-09-17T00:00:00Z', updatedAt: '2026-09-17T00:00:00Z',
  workingRevisionId: revision, publishedRevisionId: request.finish ? revision : null,
  content: structuredClone(request.content),
});
const stub = (saveEntry: JournalApi['saveEntry']) => ({ saveEntry } as JournalApi);

describe('serialized revision saves', () => {
  it('does not lose edits during an in-flight save, and chains expected revision IDs', async () => {
    let resolveFirst!: (entry: Entry) => void;
    const requests: SaveRequest[] = [];
    const save = vi.fn((request: SaveRequest) => {
      requests.push(request);
      return requests.length === 1 ? new Promise<Entry>(resolve => { resolveFirst = resolve; }) : Promise.resolve(record(request, 'r2'));
    });
    const session = new SaveCoordinator('entry', stub(save), blankContent([{ book: 43, chapter: 3 }]), undefined, () => {}, () => {});
    session.update({ ...session.content, body: 'First' });
    const first = session.flush();
    await Promise.resolve(); await Promise.resolve();
    session.update({ ...session.content, body: 'Second' });
    const second = session.flush();
    expect(save).toHaveBeenCalledTimes(1);
    resolveFirst(record(requests[0], 'r1'));
    await Promise.all([first, second]);
    expect(requests.map(request => request.content.body)).toEqual(['First', 'Second']);
    expect(requests.map(request => request.expectedRevisionId)).toEqual([null, 'r1']);
    expect(session.dirty).toBe(false);
    expect(session.content.body).toBe('Second');
  });

  it('retains the draft and revision precondition after failure, then retries', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockImplementation((request: SaveRequest) => Promise.resolve(record(request, 'r1')));
    const session = new SaveCoordinator('entry', stub(save), { ...blankContent(), body: 'Keep this' }, undefined, () => {}, () => {});
    await expect(session.flush()).rejects.toThrow('disk full');
    expect(session.status).toBe('error'); expect(session.dirty).toBe(true);
    expect(session.content.body).toBe('Keep this'); expect(session.revisionId).toBeNull();
    await session.flush();
    expect(session.status).toBe('saved'); expect(session.dirty).toBe(false);
  });

  it('finishes the exact pending content in one save request', async () => {
    const save = vi.fn((request: SaveRequest) => Promise.resolve(record(request, 'finished')));
    const session = new SaveCoordinator('entry', stub(save), { ...blankContent(), body: 'Final words' }, undefined, () => {}, () => {});
    await session.flush(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({ finish: true, content: { body: 'Final words' } });
    expect(session.status).toBe('finished');
  });

  it('retries a failed finish even when the draft content was already saved', async () => {
    const content = blankContent();
    const existing = record({ entryId: 'entry', expectedRevisionId: null, content, finish: false }, 'draft');
    const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockImplementation((request: SaveRequest) => Promise.resolve(record(request, 'published')));
    const session = new SaveCoordinator('entry', stub(save), content, existing, () => {}, () => {});
    await expect(session.flush(true)).rejects.toThrow('disk full');
    expect(session.dirty).toBe(true);
    await session.flush();
    expect(save.mock.calls[1][0].finish).toBe(true);
    expect(session.status).toBe('finished');
  });

  it('captures passage values independently of the reader object', () => {
    const passage = { book: 43, chapter: 3 };
    const session = new SaveCoordinator('entry', stub(vi.fn()), blankContent([passage]), undefined, () => {}, () => {});
    passage.chapter = 4;
    expect(session.content.passages).toEqual([{ book: 43, chapter: 3 }]);
  });
});
