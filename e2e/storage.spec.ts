import { expect, test } from '@playwright/test';

test('preview storage retains revisions across reload and rejects stale writers', async ({ page }) => {
  await page.goto('/');
  const saved = await page.evaluate(async () => {
    const { browserJournal: api } = await import('/src/platform/browserJournal.ts');
    const content = { title: 'First reflection', body: 'Original words', passages: [{ book: 43, chapter: 1 }], tags: [], links: [] };
    const first = await api.saveEntry({ entryId: crypto.randomUUID(), expectedRevisionId: null, content, finish: false });
    const second = await api.saveEntry({ entryId: first.id, expectedRevisionId: first.workingRevisionId, content: { ...content, body: 'Revised words' }, finish: true });
    let staleRejected = false;
    try {
      await api.saveEntry({ entryId: first.id, expectedRevisionId: first.workingRevisionId, content, finish: false });
    } catch { staleRejected = true; }
    return { first, second, staleRejected };
  });
  expect(saved.staleRejected).toBe(true);
  await page.reload();
  const recovered = await page.evaluate(async ({ first, second }) => {
    const { browserJournal: api } = await import('/src/platform/browserJournal.ts');
    const entries = await api.listEntries();
    const restored = await api.restoreRevision(first.id, first.workingRevisionId, second.workingRevisionId);
    return { entries, restored, history: await api.getHistory(first.id) };
  }, saved);
  expect(recovered.entries[0].content.body).toBe('Revised words');
  expect(recovered.restored.content.body).toBe('Original words');
  expect(recovered.restored.publishedRevisionId).toBe(saved.second.workingRevisionId);
  expect(recovered.restored.workingRevisionId).not.toBe(saved.first.workingRevisionId);
  expect(recovered.history).toHaveLength(3);
  expect(recovered.history.find((revision) => revision.id === recovered.restored.workingRevisionId)?.restoredFromId)
    .toBe(saved.first.workingRevisionId);
});

test('two concurrent preview writers cannot silently overwrite one another', async ({ page }) => {
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const { browserJournal: api } = await import('/src/platform/browserJournal.ts');
    const content = { title: '', body: 'Start', passages: [], tags: [], links: [] };
    const entry = await api.saveEntry({ entryId: crypto.randomUUID(), expectedRevisionId: null, content, finish: false });
    const writes = await Promise.allSettled(['Window A', 'Window B'].map((body) => api.saveEntry({
      entryId: entry.id, expectedRevisionId: entry.workingRevisionId, content: { ...content, body }, finish: false,
    })));
    return { statuses: writes.map((write) => write.status), history: await api.getHistory(entry.id) };
  });
  expect(results.statuses.sort()).toEqual(['fulfilled', 'rejected']);
  expect(results.history).toHaveLength(2);
});
