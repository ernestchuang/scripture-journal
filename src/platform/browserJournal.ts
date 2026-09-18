import type { Entry, EntryContent, Revision, SaveRequest } from '../domain';
import type { JournalApi } from './journal';

/** Browser-only preview. Desktop always uses the native SQLite command service. */
const databaseName = 'scripture-journal-preview-v1';
let connection: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('entries')) {
        request.result.createObjectStore('entries', { keyPath: 'id' });
        const revisions = request.result.createObjectStore('revisions', { keyPath: 'id' });
        revisions.createIndex('entryId', 'entryId');
      }
      request.result.createObjectStore('purged', { keyPath: 'id' });
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
    const tx = db.transaction(['entries', 'revisions', 'purged'], 'readwrite');
    const entries = tx.objectStore('entries');
    const lookup = entries.get(request.entryId);
    let result: Entry;
    let failure: Error | undefined;
    const deleted = tx.objectStore('purged').get(request.entryId);
    deleted.onsuccess = () => { if (deleted.result) { failure = new Error('This entry was permanently deleted. Save as a new entry.'); tx.abort(); } };
    if (restoredFromId) {
      const source = tx.objectStore('revisions').get(restoredFromId);
      source.onsuccess = () => {
        if (!source.result || source.result.entryId !== request.entryId) {
          failure = new Error('This version no longer exists.'); tx.abort();
        }
      };
    }
    lookup.onsuccess = () => {
      const existing = lookup.result as Entry | undefined;
      if (existing?.trashedAt) { failure = new Error('Restore this entry from Trash before editing.'); tx.abort(); return; }
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
    return entries.filter(entry => !entry.trashedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
  async listTrash() {
    const db = await database();
    return (await read<Entry[]>(db.transaction('entries').objectStore('entries').getAll())).filter(entry => entry.trashedAt);
  },
  setEntryTrashed: (id, expected, trashed) => mutateEntry(id, expected, (tx, entry) => {
    const result = { ...entry, trashedAt: trashed ? new Date().toISOString() : null, updatedAt: new Date().toISOString() };
    tx.objectStore('entries').put(result); return result;
  }),
  purgeEntry: (id, expected) => mutateEntry(id, expected, (tx, entry) => {
    if (!entry.trashedAt) throw new Error('Move this entry to Trash before permanent deletion.');
    tx.objectStore('purged').add({ id, deletedAt: new Date().toISOString() });
    const cursor = tx.objectStore('revisions').index('entryId').openCursor(id);
    cursor.onsuccess = () => { const item = cursor.result; if (item) { item.delete(); item.continue(); } };
    tx.objectStore('entries').delete(id);
  }),
  purgeRevision: (id, revisionId, expected) => mutateEntry(id, expected, (tx, entry) => {
    if (entry.workingRevisionId === revisionId || entry.publishedRevisionId === revisionId) throw new Error('Cannot delete the working or finished version.');
    const revisions = tx.objectStore('revisions');
    const lookup = revisions.get(revisionId);
    lookup.onsuccess = () => { if (!lookup.result || lookup.result.entryId !== id) { tx.abort(); return; } revisions.delete(revisionId); };
  }),
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

async function mutateEntry<T>(id: string, expected: string, operation: (tx: IDBTransaction, entry: Entry) => T): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['entries', 'revisions', 'purged'], 'readwrite');
    let result: T; let failure: unknown;
    const lookup = tx.objectStore('entries').get(id);
    lookup.onsuccess = () => {
      try {
        const entry = lookup.result as Entry | undefined;
        if (!entry || entry.workingRevisionId !== expected) throw new Error('Entry changed. Reload before continuing.');
        result = operation(tx, entry);
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('Deletion could not finish. No changes were saved.'));
    tx.onerror = () => {};
  });
}
