import { invoke } from '@tauri-apps/api/core';

export interface LegacyImportRecord {
  relativePath: string;
  status: 'new' | 'changed' | 'unchanged' | 'unsupported';
  entryId?: string;
  title?: string;
  date?: string;
  warnings: string[];
  unresolvedLinks: string[];
}

export interface LegacyImportPreview {
  sourceSetId: string;
  previewId: string;
  sourceRoot: string;
  recognized: number;
  unchanged: number;
  changed: number;
  unsupported: number;
  unresolvedLinks: number;
  records: LegacyImportRecord[];
}

export interface LegacyImportResult {
  imported: number;
  revisionsCreated: number;
  unchanged: number;
  unsupported: number;
}

export interface LegacyImportApi {
  chooseDirectory(): Promise<string | null>;
  preview(directory: string): Promise<LegacyImportPreview>;
  confirm(directory: string, expectedPreviewId: string): Promise<LegacyImportResult>;
}

export const nativeLegacyImport: LegacyImportApi = {
  chooseDirectory: () => invoke('choose_legacy_import_directory'),
  preview: directory => invoke('preview_legacy_import', { directory }),
  confirm: (directory, expectedPreviewId) => invoke('confirm_legacy_import', { directory, expectedPreviewId }),
};
