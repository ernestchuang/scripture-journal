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
