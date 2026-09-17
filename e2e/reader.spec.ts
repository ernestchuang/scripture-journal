import { expect, test } from '@playwright/test';

// No downloaded scripture or live provider availability is needed for navigation.
test.beforeEach(async ({ page }) => {
  await page.route('https://bible-api.com/**', async route => {
    const reference = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
    const match = /^(.*) (\d+)$/.exec(reference);
    if (!match) throw new Error(`Unexpected scripture request: ${reference}`);
    await route.fulfill({ json: {
      translation_id: 'kjv',
      verses: Array.from({ length: 12 }, (_, index) => ({
        book_name: match[1], chapter: Number(match[2]), verse: index + 1,
        text: `Synthetic ${reference} verse ${index + 1}.`,
      })),
    } });
  });
  await page.goto('/');
});

for (const scenario of [
  { chapter: '3', adjacent: 'John 4', direction: 'forward' },
  { chapter: '21', adjacent: 'Acts 1', direction: 'forward' },
  { chapter: '3', adjacent: 'John 2', direction: 'backward' },
  { chapter: '1', adjacent: 'Luke 24', direction: 'backward' },
]) {
  test(`continuous reading crosses ${scenario.direction} from John ${scenario.chapter} to ${scenario.adjacent}`, async ({ page }) => {
    await page.getByRole('combobox', { name: 'Chapter', exact: true }).selectOption(scenario.chapter);
    const current = page.getByRole('region', { name: `John ${scenario.chapter}`, exact: true });
    await expect(current).toContainText(`Synthetic John ${scenario.chapter} verse 12.`);
    const scroll = page.getByLabel('Continuous scripture reading');
    await scroll.hover();
    // Wheel input exercises continuous extension, without direct passage navigation
    // or clicking the fallback chapter buttons.
    await page.mouse.wheel(0, scenario.direction === 'forward' ? 10000 : -1000);
    const adjacent = page.getByRole('region', { name: scenario.adjacent, exact: true });
    await expect(adjacent).toContainText(`Synthetic ${scenario.adjacent} verse 12.`);
    await expect(current).toHaveCount(1);
    await expect(adjacent).toHaveCount(1);
    const names = await scroll.getByRole('region').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
    const expected = scenario.direction === 'forward'
      ? [`John ${scenario.chapter}`, scenario.adjacent]
      : [scenario.adjacent, `John ${scenario.chapter}`];
    expect(names.indexOf(expected[1])).toBe(names.indexOf(expected[0]) + 1);
  });
}

test('continuous reading stops at Genesis and Revelation without wrapping', async ({ page }) => {
  const book = page.getByRole('combobox', { name: 'Book', exact: true });
  const scroll = page.getByLabel('Continuous scripture reading');
  await book.selectOption('1');
  await expect(page.getByRole('region', { name: 'Genesis 1', exact: true })).toContainText('Synthetic Genesis 1 verse 12.');
  await scroll.hover();
  await page.mouse.wheel(0, -1000);
  await expect(page.getByRole('button', { name: /^Read preceding chapter/ })).toHaveCount(0);
  await expect(scroll.getByRole('region')).toHaveCount(1);

  await book.selectOption('66');
  await page.getByRole('combobox', { name: 'Chapter', exact: true }).selectOption('22');
  await expect(page.getByRole('region', { name: 'Revelation 22', exact: true })).toContainText('Synthetic Revelation 22 verse 12.');
  await scroll.hover();
  await page.mouse.wheel(0, 10000);
  await expect(page.getByText('End of Revelation', { exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: /^Continue reading/ })).toHaveCount(0);
  await expect(scroll.getByRole('region')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Genesis 1', exact: true })).toHaveCount(0);
});

test('prepending and loading a preceding chapter preserves the visible verse position', async ({ page }) => {
  let releaseChapter!: () => void;
  const chapterReady = new Promise<void>(resolve => { releaseChapter = resolve; });
  await page.route('https://bible-api.com/John%202?*', async route => {
    await chapterReady;
    await route.fulfill({ json: {
      translation_id: 'kjv',
      verses: Array.from({ length: 36 }, (_, index) => ({
        book_name: 'John', chapter: 2, verse: index + 1,
        text: `Delayed synthetic John 2 verse ${index + 1}.`,
      })),
    } });
  });
  await page.getByRole('combobox', { name: 'Chapter', exact: true }).selectOption('3');
  const current = page.getByRole('region', { name: 'John 3', exact: true });
  const verse = current.locator('[data-verse="1"]');
  await expect(verse).toBeInViewport();
  await page.evaluate(() => document.fonts.ready);
  const relativeTop = () => verse.evaluate(node => {
    const viewport = node.closest('.scripture-scroll')!;
    return node.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  });
  const originalTop = await relativeTop();
  await page.getByRole('button', { name: 'Read preceding chapter · John 2', exact: true }).click();
  const previous = page.getByRole('region', { name: 'John 2', exact: true });
  await expect(previous.getByRole('status')).toHaveText('Loading John 2…');
  await expect.poll(async () => Math.abs(await relativeTop() - originalTop)).toBeLessThan(1);
  const placeholderHeight = await previous.evaluate(node => node.getBoundingClientRect().height);
  releaseChapter();
  await expect(previous).toContainText('Delayed synthetic John 2 verse 36.');
  // Prove the fixture actually expanded, so a missing compensation cannot pass
  // merely because the loaded chapter happened to match its placeholder height.
  await expect.poll(() => previous.evaluate(node => node.getBoundingClientRect().height))
    .toBeGreaterThan(placeholderHeight + 500);
  await expect.poll(async () => Math.abs(await relativeTop() - originalTop)).toBeLessThan(1);
  await expect(verse).toBeInViewport();
  await expect(page.getByRole('combobox', { name: 'Chapter', exact: true })).toHaveValue('3');
});
