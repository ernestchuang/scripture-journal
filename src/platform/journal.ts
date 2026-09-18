import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Entry, Revision, SaveRequest, ExportReport } from '../domain';

export interface JournalApi {
  listEntries(): Promise<Entry[]>;
  saveEntry(request: SaveRequest): Promise<Entry>;
  getHistory(entryId: string): Promise<Revision[]>;
  restoreRevision(entryId: string, revisionId: string, expectedRevisionId: string): Promise<Entry>;
  exportJournal(directory: string): Promise<ExportReport>;
  listTrash(): Promise<Entry[]>;
  setEntryTrashed(entryId: string, expectedRevisionId: string, trashed: boolean): Promise<Entry>;
  purgeEntry(entryId: string, expectedRevisionId: string): Promise<void>;
  purgeRevision(entryId: string, revisionId: string, expectedRevisionId: string): Promise<void>;
}

export const isDesktop = isTauri();

export const nativeJournal: JournalApi = {
  listTrash: () => invoke('list_trash'),
  setEntryTrashed: (entryId, expectedRevisionId, trashed) => invoke('set_entry_trashed', { entryId, expectedRevisionId, trashed }),
  purgeEntry: (entryId, expectedRevisionId) => invoke('purge_entry', { entryId, expectedRevisionId }),
  purgeRevision: (entryId, revisionId, expectedRevisionId) => invoke('purge_revision', { entryId, revisionId, expectedRevisionId }),
  listEntries: () => invoke('list_entries'),
  saveEntry: (request) => invoke('save_entry', { request }),
  getHistory: (entryId) => invoke('get_history', { entryId }),
  restoreRevision: (entryId, revisionId, expectedRevisionId) =>
    invoke('restore_revision', { entryId, revisionId, expectedRevisionId }),
  exportJournal: (directory) => invoke('export_journal', { directory }),
};
