import { expect, test } from '@playwright/test';

test('a draft keeps its pinned passage and recovers explicitly added passages after reload', async ({ page }) => {
  // Synthetic text keeps this acceptance flow independent of provider access and licensing.
  await page.route('https://bible-api.com/**', async route => {
    const reference = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
    const match = /^(.*) (\d+)$/.exec(reference);
    if (!match) throw new Error(`Unexpected scripture request: ${reference}`);
    await route.fulfill({ json: {
      translation_id: 'kjv',
      verses: [{ book_name: match[1], chapter: Number(match[2]), verse: 1, text: `Synthetic reading fixture for ${reference}.` }],
    } });
  });
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Chapter', exact: true }).selectOption('3');
  await expect(page.getByText('Synthetic reading fixture for John 3.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Reflect on John 3', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Pinned passage reflection');
  const reflection = page.getByRole('textbox', { name: 'Reflection Markdown supported' });
  await reflection.fill('Synthetic unfinished writing survives navigation and reload.');

  await page.getByRole('combobox', { name: 'Book', exact: true }).selectOption('45');
  await page.getByRole('combobox', { name: 'Chapter', exact: true }).selectOption('8');
  await expect(page.getByText('Synthetic reading fixture for Romans 8.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove John 3', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove Romans 8', exact: true })).toHaveCount(0);

  // Switching entries flushes the draft without replacing its initial association.
  await page.getByRole('button', { name: 'New blank entry', exact: true }).click();
  const savedEntry = page.getByRole('navigation', { name: 'Journal entries' })
    .getByRole('button', { name: /Pinned passage reflection/ });
  await savedEntry.click();
  await expect(reflection).toHaveValue('Synthetic unfinished writing survives navigation and reload.');
  await expect(page.getByRole('button', { name: 'Remove John 3', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove Romans 8', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add current passage: Romans 8', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove Romans 8', exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /^Draft saved$/ })).toBeVisible();

  await page.reload();
  await savedEntry.click();
  await expect(reflection).toHaveValue('Synthetic unfinished writing survives navigation and reload.');
  await expect(page.getByRole('button', { name: 'Remove John 3', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove Romans 8', exact: true })).toBeVisible();
  await expect(savedEntry).toContainText('Draft');
});
