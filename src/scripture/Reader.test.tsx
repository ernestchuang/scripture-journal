// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import Reader from './Reader';
import { loadChapter, type Verse } from './provider';
vi.mock('./provider', () => ({ loadChapter: vi.fn(), kjvOfflineStatus: vi.fn(async () => false), downloadKjv: vi.fn(), invalidateKjvCache: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('reader isolation', () => {
  it('aborts old chapter work and ignores a late result after external navigation', async () => {
    let finishOld!: (verses: Verse[]) => void;
    let oldSignal!: AbortSignal;
    vi.mocked(loadChapter).mockImplementation((p, signal) => {
      if (p.book === 1) { oldSignal = signal; return new Promise(resolve => { finishOld = resolve; }); }
      return Promise.resolve([{ number: 1, text: 'New chapter fixture.' }]);
    });
    const { rerender } = render(<Reader selection={{ book: 1, chapter: 1 }} onSelectionChange={() => {}} onReflect={() => {}} />);
    rerender(<Reader selection={{ book: 2, chapter: 1 }} onSelectionChange={() => {}} onReflect={() => {}} />);
    await screen.findByText('New chapter fixture.');
    expect(oldSignal.aborted).toBe(true);
    finishOld([{ number: 1, text: 'Stale chapter fixture.' }]);
    await waitFor(() => expect(screen.queryByText('Stale chapter fixture.')).toBeNull());
  });
  it('renders external markup as text and keeps plan selections within a whole chapter', async () => {
    vi.mocked(loadChapter).mockResolvedValue([{ number: 1, text: '<img src=x onerror=alert(1)>' }, { number: 2, text: 'Selected fixture.' }]);
    const { container } = render(<Reader selection={{ book: 1, chapter: 1, startVerse: 2, endVerse: 2 }} onSelectionChange={() => {}} onReflect={() => {}} />);
    await screen.findByText('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.scripture-highlight')?.textContent).toContain('Selected fixture.');
    expect(screen.getByText('Continue reading · Genesis 2')).toBeTruthy();
  });
});
