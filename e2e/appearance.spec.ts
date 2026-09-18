import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.beforeEach(async ({ page }) => {
  await page.route('https://bible-api.com/**', route => route.abort());
});

test('System follows OS changes, and explicit choices persist across reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  const appearance = page.getByRole('combobox', { name: 'Appearance' });
  await expect(appearance).toHaveValue('system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await appearance.selectOption('dark');
  await page.reload();
  await expect(appearance).toHaveValue('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await appearance.selectOption('light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(appearance).toHaveValue('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await appearance.selectOption('system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('saved dark preference paints before the React bundle can load', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => localStorage.setItem('scripture-journal.appearance', 'dark'));
  await page.route('**/src/main.tsx', route => route.abort());
  await page.goto('/');
  await expect(page.locator('#root')).toBeEmpty();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(29, 36, 32)');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
});

test('system dark bootstrap also works without a saved preference', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.route('**/src/main.tsx', route => route.abort());
  await page.goto('/');
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(29, 36, 32)');
});

test('corrupt optional palettes cannot override a saved dark startup', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => {
    localStorage.setItem('scripture-journal.appearance', 'dark');
    localStorage.setItem('scripture-journal.custom-themes', '{bad');
    localStorage.setItem('scripture-journal.omarchy-theme', '{also bad');
  });
  await page.route('**/src/main.tsx', route => route.abort());
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(29, 36, 32)');
});

test('failed theme replacement leaves the active palette unchanged', async ({ page }) => {
  const source = readFileSync('docs/themes/forest-night.toml', 'utf8');
  await page.goto('/');
  await page.getByLabel('Import theme').setInputFiles({ name: 'forest.toml', mimeType: 'text/plain', buffer: Buffer.from(source) });
  await expect(page.getByRole('combobox', { name: 'Appearance' })).toHaveValue('theme:forest-night');
  const prior = await page.locator('html').evaluate(element => getComputedStyle(element).backgroundColor);
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('Full storage'); }; });
  await page.getByLabel('Import theme').setInputFiles({ name: 'replacement.toml', mimeType: 'text/plain',
    buffer: Buffer.from(source.replace(/app-background = "#[0-9a-f]+"/i, 'app-background = "#ffffff"')) });
  await expect(page.getByText(/Theme import failed/)).toBeVisible();
  // Force reapplication: a failed import must not silently replace the in-memory palette.
  await page.getByRole('combobox', { name: 'Appearance' }).selectOption('dark');
  await page.getByRole('combobox', { name: 'Appearance' }).selectOption('theme:forest-night');
  await expect(page.locator('html')).toHaveCSS('background-color', prior);
});

test('import reports when the palette saves but its selected preference cannot persist', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'scripture-journal.appearance') throw new Error('Preference write unavailable');
      return original.call(this, key, value);
    };
  });
  await page.getByLabel('Import theme').setInputFiles('docs/themes/forest-night.toml');
  await expect(page.getByRole('combobox', { name: 'Appearance' })).toHaveValue('theme:forest-night');
  await expect(page.getByText('Appearance changed, but this device could not save your preference.')).toBeVisible();
});

test('invalid stored preference falls back to System', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => localStorage.setItem('scripture-journal.appearance', 'invalid'));
  await page.goto('/');
  await expect(page.getByRole('combobox', { name: 'Appearance' })).toHaveValue('system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('imports a portable theme, persists it, and paints it before React on reload', async ({ page }) => {
  await page.goto('/');
  const colors = ['app-background', 'paper', 'surface', 'surface-raised', 'surface-subtle', 'surface-active', 'ink', 'muted', 'placeholder', 'line', 'line-strong', 'accent', 'accent-hover', 'accent-contrast', 'focus', 'selection', 'error-ink', 'error-surface', 'error-line']
    .map((token, index) => `${token} = "#${String(index + 1).padStart(6, '0')}"`).join('\n');
  await page.getByLabel('Import theme').setInputFiles({
    name: 'test-night.toml', mimeType: 'text/plain',
    buffer: Buffer.from(`schema_version = 1\nid = "test-night"\nname = "Test Night"\nmode = "dark"\n[colors]\n${colors}\n`),
  });
  const appearance = page.getByRole('combobox', { name: 'Appearance' });
  await expect(appearance).toHaveValue('theme:test-night');
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(0, 0, 1)');
  await page.reload();
  await expect(appearance).toHaveValue('theme:test-night');
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(0, 0, 1)');
});

test('malformed imported and stored themes keep a usable fallback', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => {
    localStorage.setItem('scripture-journal.appearance', 'theme:broken');
    localStorage.setItem('scripture-journal.custom-themes', '[{"id":"broken","colors":{"app-background":"url(bad)"}}]');
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(29, 36, 32)');
  await page.getByLabel('Import theme').setInputFiles({
    name: 'unsafe.toml', mimeType: 'text/plain', buffer: Buffer.from('schema_version = 1\nid = "unsafe"'),
  });
  await expect(page.getByText(/Theme import failed/)).toBeVisible();
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(29, 36, 32)');
});

test('unavailable preference storage does not prevent writing or theme changes', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error('Storage unavailable'); };
    Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); };
  });
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Appearance' }).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByText('Appearance changed, but this device could not save your preference.')).toBeVisible();
  await page.getByRole('button', { name: 'New blank entry' }).click();
  await page.getByRole('textbox', { name: 'Reflection' }).fill('Synthetic night reflection');
  await expect(page.getByText('Draft saved', { exact: true })).toBeVisible();
});

test('switching appearance preserves the open draft and fits a narrow window', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New blank entry' }).click();
  const body = page.getByRole('textbox', { name: 'Reflection' });
  await body.fill('Keep this draft across appearance changes');
  await page.getByRole('combobox', { name: 'Appearance' }).selectOption('dark');
  await expect(body).toHaveValue('Keep this draft across appearance changes');
  await page.setViewportSize({ width: 420, height: 850 });
  await page.getByRole('button', { name: 'Write & revisit' }).click();
  await expect(body).toHaveValue('Keep this draft across appearance changes');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
