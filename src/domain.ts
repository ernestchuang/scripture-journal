/** Stable Protestant-canon book number; translation display names live in the reader. */
export interface Passage {
  book: number;
  chapter: number;
  startVerse?: number;
  endVerse?: number;
}

export interface EntryContent {
  title: string;
  body: string;
  passages: Passage[];
  tags: string[];
  links: string[];
}

export interface Entry {
  id: string;
  createdAt: string;
  updatedAt: string;
  workingRevisionId: string;
  publishedRevisionId: string | null;
  content: EntryContent;
  trashedAt?: string | null;
}

export interface Revision {
  id: string;
  entryId: string;
  parentId: string | null;
  restoredFromId: string | null;
  createdAt: string;
  content: EntryContent;
}

export interface SaveRequest {
  entryId: string;
  expectedRevisionId: string | null;
  content: EntryContent;
  finish: boolean;
}

export interface ExportReport {
  written: number;
  unchanged: number;
  conflicts: string[];
  directory: string;
  pending: number;
  cursor: number;
}

export const blankContent = (passages: Passage[] = []): EntryContent => ({
  title: '', body: '', passages, tags: [], links: [],
});
