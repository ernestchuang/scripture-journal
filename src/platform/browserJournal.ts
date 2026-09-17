import type { Entry, EntryContent, Revision, SaveRequest } from '../domain';
import type { JournalApi } from './journal';

/** Browser-only preview. Desktop always uses the native SQLite command service. */
const databaseName = 'scripture-journal-preview-v1';
let connection: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('entries', { keyPath: 'id' });
      const revisions = request.result.createObjectStore('revisions', { keyPath: 'id' });
      revisions.createIndex('entryId', 'entryId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Browser storage could not be opened.'));
    request.onblocked = () => reject(new Error('Close other preview tabs and reload.'));
  });
  return connection;
}

function read<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Browser storage failed.'));
  });
}

async function save(request: SaveRequest, restoredFromId: string | null = null): Promise<Entry> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['entries', 'revisions'], 'readwrite');
    const entries = tx.objectStore('entries');
    const lookup = entries.get(request.entryId);
    let result: Entry;
    let failure: Error | undefined;
    lookup.onsuccess = () => {
      const existing = lookup.result as Entry | undefined;
      if ((existing?.workingRevisionId ?? null) !== request.expectedRevisionId) {
        failure = new Error('This entry changed in another window. Reopen it before saving.');
        tx.abort();
        return;
      }
      const now = new Date().toISOString();
      const unchanged = existing && !restoredFromId &&
        JSON.stringify(existing.content) === JSON.stringify(request.content);
      const revisionId = unchanged ? existing.workingRevisionId : crypto.randomUUID();
      if (!unchanged) {
        const revision: Revision = {
          id: revisionId, entryId: request.entryId,
          parentId: existing?.workingRevisionId ?? null,
          restoredFromId, createdAt: now, content: structuredClone(request.content),
        };
        tx.objectStore('revisions').add(revision);
      }
      result = {
        id: request.entryId, createdAt: existing?.createdAt ?? now, updatedAt: now,
        workingRevisionId: revisionId,
        publishedRevisionId: request.finish ? revisionId : existing?.publishedRevisionId ?? null,
        content: structuredClone(request.content),
      };
      entries.put(result);
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('The entry could not be saved.'));
    tx.onerror = () => { /* onabort supplies the transaction's final outcome */ };
  });
}

export const browserJournal: JournalApi = {
  async listEntries() {
    const db = await database();
    const entries = await read<Entry[]>(db.transaction('entries').objectStore('entries').getAll());
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
  saveEntry: (request) => save(request),
  async getHistory(entryId) {
    const db = await database();
    const revisions = await read<Revision[]>(db.transaction('revisions').objectStore('revisions')
      .index('entryId').getAll(entryId));
    return revisions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  async restoreRevision(entryId, revisionId, expectedRevisionId) {
    const db = await database();
    const revision = await read<Revision | undefined>(db.transaction('revisions')
      .objectStore('revisions').get(revisionId));
    if (!revision || revision.entryId !== entryId) throw new Error('Revision not found.');
    return save({ entryId, expectedRevisionId, content: revision.content as EntryContent, finish: false }, revisionId);
  },
  async exportJournal() {
    throw new Error('Open the desktop app to maintain an Obsidian folder.');
  },
};
