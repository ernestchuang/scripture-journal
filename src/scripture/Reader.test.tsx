// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Reader from './Reader';
import { importScripturePack, invalidateTranslationCache, loadChapter, type Verse } from './provider';
vi.mock('./provider', () => ({ loadChapter: vi.fn(), kjvOfflineStatus: vi.fn(async () => false), downloadKjv: vi.fn(), invalidateKjvCache: vi.fn(), importScripturePack: vi.fn(), invalidateTranslationCache: vi.fn(), translationInfo: vi.fn(async () => null) }));
vi.mock('../platform/journal', () => ({ isDesktop: true }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('reader isolation', () => {
  it('activates an imported translation and refreshes the visible chapter', async () => {
    vi.mocked(loadChapter).mockImplementation(async (_p, _signal, translation) => [{ number: 1, text: `${translation} fixture` }]);
    vi.mocked(importScripturePack).mockResolvedValue('ESV');
    render(<Reader selection={{ book: 43, chapter: 3 }} onSelectionChange={() => {}} onReflect={() => {}} />);
    fireEvent.click(screen.getByText('About translations & availability'));
    fireEvent.click(screen.getByRole('button', { name: 'Import authorized Scripture pack' }));
    await screen.findByText('ESV pack installed for offline reading.');
    await screen.findByText('ESV fixture');
    expect(invalidateTranslationCache).toHaveBeenCalledWith('ESV');
    expect(vi.mocked(loadChapter).mock.calls.at(-1)?.[0]).toMatchObject({ book: 43, chapter: 3 });
  });
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
  it('refetches a mounted chapter after a successful offline install', async () => {
    vi.mocked(loadChapter).mockResolvedValue([{ number: 1, text: 'Fixture.' }]);
    render(<Reader selection={{ book: 1, chapter: 1 }} onSelectionChange={() => {}} onReflect={() => {}} />);
    await screen.findByText('Fixture.');
    fireEvent.click(screen.getByText('About translations & availability'));
    fireEvent.click(screen.getByRole('button', { name: 'Download KJV for offline reading' }));
    await waitFor(() => expect(loadChapter).toHaveBeenCalledTimes(2));
  });
});
