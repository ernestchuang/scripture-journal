import { blankContent, type EntryContent, type Passage } from '../domain';

/** Templates seed independent Markdown snapshots; later template changes never
 * rewrite existing entries. Identity and version allow future user templates. */
export interface WritingTemplate {
  id: string;
  version: number;
  name: string;
  description: string;
  title: string;
  body: string;
  tags: readonly string[];
}

export const writingTemplates: readonly WritingTemplate[] = [{
  id: 'blank', version: 1, name: 'Blank',
  description: 'An open page for your own reflection.', title: '', body: '', tags: [],
}];

export function contentFromTemplate(template: WritingTemplate, passages: Passage[] = []): EntryContent {
  return { ...blankContent(structuredClone(passages)), title: template.title,
    body: template.body, tags: [...template.tags] };
}
