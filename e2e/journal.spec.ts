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

test('connections survive renaming and restoring history without losing the intervening version', async ({ page }) => {
  // This journal-only flow needs no live scripture service.
  await page.route('https://bible-api.com/**', route => route.abort());
  await page.goto('/');
  const title = page.getByRole('textbox', { name: 'Title', exact: true });
  const body = page.getByRole('textbox', { name: 'Reflection Markdown supported' });
  const entries = page.getByRole('navigation', { name: 'Journal entries' });
  const sourceEntry = entries.getByRole('button', { name: /Source reflection/ });
  const targetEntry = entries.getByRole('button', { name: /Renamed target/ });
  const history = page.getByRole('region', { name: 'Revision history' });
  const versions = history.getByRole('button', { name: /^Version / });

  await page.getByRole('button', { name: 'New blank entry' }).click();
  await title.fill('Target reflection');
  await body.fill('Synthetic target content.');
  await page.getByRole('button', { name: 'Finish entry' }).click();
  await page.getByRole('button', { name: 'New blank entry' }).click();
  await title.fill('Source reflection');
  await body.fill('Original connected content.');
  await page.getByRole('combobox', { name: 'Connect another entry' }).selectOption({ label: 'Target reflection' });
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: 'Finish entry' }).click();

  // Follow the outgoing connection, rename its target, then follow the backlink.
  await page.getByRole('button', { name: 'Target reflection', exact: true }).click();
  await expect(body).toHaveValue('Synthetic target content.');
  await title.fill('Renamed target');
  await page.getByRole('button', { name: 'Source reflection', exact: true }).click();
  await expect(body).toHaveValue('Original connected content.');
  await expect(page.getByRole('button', { name: 'Renamed target', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View revision history' }).click();
  await expect(versions.first()).toBeVisible();
  const linkedVersion = await versions.first().innerText();

  await body.fill('Later content without a connection.');
  await page.getByRole('button', { name: 'Remove connection to Renamed target', exact: true }).click();
  await page.getByRole('button', { name: 'Finish entry' }).click();
  await targetEntry.click();
  await expect(page.getByText('No other entries link here yet.', { exact: true })).toBeVisible();
  await sourceEntry.click();
  await page.getByRole('button', { name: 'View revision history' }).click();
  await expect(versions.first()).toBeVisible();
  const removedVersion = await versions.first().innerText();
  const countBeforeRestore = await versions.count();
  await history.getByRole('button', { name: linkedVersion, exact: true }).click();
  await expect(history.getByText('Connections: Renamed target', { exact: true })).toBeVisible();
  await expect(history.locator('pre')).toHaveText('Original connected content.');
  await history.getByRole('button', { name: 'Restore this version' }).click();
  await expect(body).toHaveValue('Original connected content.');
  await expect(sourceEntry).toContainText('Draft');

  await page.reload();
  await sourceEntry.click();
  await expect(body).toHaveValue('Original connected content.');
  await expect(sourceEntry).toContainText('Draft');
  await page.getByRole('button', { name: 'View revision history' }).click();
  await expect(versions).toHaveCount(countBeforeRestore + 1);
  await history.getByRole('button', { name: removedVersion, exact: true }).click();
  await expect(history.locator('pre')).toHaveText('Later content without a connection.');
  await expect(history.getByText('Connections: None', { exact: true })).toBeVisible();
  await expect(history.getByRole('button', { name: linkedVersion, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Renamed target', exact: true }).click();
  await expect(body).toHaveValue('Synthetic target content.');
  await page.getByRole('button', { name: 'Source reflection', exact: true }).click();
  await expect(body).toHaveValue('Original connected content.');
});
