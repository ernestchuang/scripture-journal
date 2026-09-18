import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Entry, Revision, SaveRequest, ExportReport } from '../domain';

export interface JournalApi {
  listEntries(): Promise<Entry[]>;
  saveEntry(request: SaveRequest): Promise<Entry>;
  getHistory(entryId: string): Promise<Revision[]>;
  restoreRevision(entryId: string, revisionId: string, expectedRevisionId: string): Promise<Entry>;
  exportJournal(directory: string): Promise<ExportReport>;
}

export const isDesktop = isTauri();

export const nativeJournal: JournalApi = {
  listEntries: () => invoke('list_entries'),
  saveEntry: (request) => invoke('save_entry', { request }),
  getHistory: (entryId) => invoke('get_history', { entryId }),
  restoreRevision: (entryId, revisionId, expectedRevisionId) =>
    invoke('restore_revision', { entryId, revisionId, expectedRevisionId }),
  exportJournal: (directory) => invoke('export_journal', { directory }),
};
