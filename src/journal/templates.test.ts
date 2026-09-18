import { describe, expect, it } from 'vitest';
import { contentFromTemplate, writingTemplates } from './templates';

describe('writing templates', () => {
  it('seeds independent Markdown snapshots and passage associations', () => {
    const template = { ...writingTemplates[0], body: '## Observe\n\n', tags: ['study'] };
    const passages = [{ book: 43, chapter: 3 }];
    const first = contentFromTemplate(template, passages);
    first.tags.push('personal'); first.passages[0].chapter = 4;
    template.body = 'Changed template';
    expect(first.body).toBe('## Observe\n\n');
    expect(contentFromTemplate(template, passages)).toMatchObject({ tags: ['study'], passages: [{ book: 43, chapter: 3 }], links: [] });
  });
});
