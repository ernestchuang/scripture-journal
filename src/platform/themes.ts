export const THEME_STORAGE_KEY = 'scripture-journal.custom-themes';

export const colorTokens = [
  'app-background', 'paper', 'surface', 'surface-raised', 'surface-subtle',
  'surface-active', 'ink', 'muted', 'placeholder', 'line', 'line-strong',
  'accent', 'accent-hover', 'accent-contrast', 'focus', 'selection',
  'error-ink', 'error-surface', 'error-line',
] as const;

export type ColorToken = typeof colorTokens[number];
export type ThemeMode = 'light' | 'dark';
export interface PortableTheme {
  schemaVersion: 1;
  id: string;
  name: string;
  mode: ThemeMode;
  colors: Record<ColorToken, string>;
}

const hexColor = /^#[0-9a-fA-F]{6}$/;
const safeId = /^[a-z0-9][a-z0-9-]{0,63}$/;

function unquote(value: string): string {
  if (value.length >= 2 && value[0] === '"' && value.at(-1) === '"') {
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  throw new Error('Theme values must use double-quoted strings.');
}

/** Parse the deliberately small, non-executable portable theme TOML contract. */
export function parsePortableTheme(source: string): PortableTheme {
  const root = new Map<string, string>();
  const colors = new Map<string, string>();
  let section = '';
  for (const [index, rawLine] of source.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const heading = line.match(/^\[([a-z-]+)]$/);
    if (heading) {
      section = heading[1];
      if (section !== 'colors') throw new Error(`Unsupported section on line ${index + 1}.`);
      continue;
    }
    const pair = line.match(/^([a-z][a-z0-9_-]*)\s*=\s*(.+)$/);
    if (!pair) throw new Error(`Invalid theme syntax on line ${index + 1}.`);
    const target = section === 'colors' ? colors : root;
    if (target.has(pair[1])) throw new Error(`Duplicate theme key “${pair[1]}”.`);
    target.set(pair[1], pair[2]);
  }

  if (root.get('schema_version') !== '1') throw new Error('schema_version must be 1.');
  for (const key of root.keys()) {
    if (!['schema_version', 'id', 'name', 'mode'].includes(key)) throw new Error(`Unknown theme key “${key}”.`);
  }
  const id = unquote(root.get('id') ?? '');
  const name = unquote(root.get('name') ?? '');
  const mode = unquote(root.get('mode') ?? '') as ThemeMode;
  if (!safeId.test(id)) throw new Error('Theme id must use lowercase letters, numbers, and hyphens.');
  if (!name || name.length > 80 || /[\x00-\x1f]/.test(name)) throw new Error('Theme name must be 1–80 printable characters.');
  if (mode !== 'light' && mode !== 'dark') throw new Error('Theme mode must be “light” or “dark”.');

  const normalized = {} as Record<ColorToken, string>;
  for (const token of colorTokens) {
    const value = unquote(colors.get(token) ?? '');
    if (!hexColor.test(value)) throw new Error(`Color “${token}” must be a six-digit hex color.`);
    normalized[token] = value.toLowerCase();
  }
  for (const key of colors.keys()) {
    if (!(colorTokens as readonly string[]).includes(key)) throw new Error(`Unknown color token “${key}”.`);
  }
  return { schemaVersion: 1, id, name, mode, colors: normalized };
}

export function isPortableTheme(value: unknown): value is PortableTheme {
  if (!value || typeof value !== 'object') return false;
  const theme = value as Partial<PortableTheme>;
  return theme.schemaVersion === 1 && typeof theme.id === 'string' && safeId.test(theme.id)
    && typeof theme.name === 'string' && theme.name.length > 0 && theme.name.length <= 80
    && (theme.mode === 'light' || theme.mode === 'dark')
    && !!theme.colors && colorTokens.every(token => hexColor.test(theme.colors?.[token] ?? ''));
}

export function loadThemes(storage: Pick<Storage, 'getItem'>): PortableTheme[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(THEME_STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isPortableTheme) : [];
  } catch { return []; }
}

const omarchyFallbacks: Record<ColorToken, string[]> = {
  'app-background': ['background'], paper: ['lighter_background', 'background'],
  surface: ['lighter_background', 'background'], 'surface-raised': ['lighter_background', 'background'],
  'surface-subtle': ['selection', 'lighter_background'], 'surface-active': ['selection'],
  ink: ['foreground'], muted: ['muted', 'dark_foreground'], placeholder: ['muted', 'dark_foreground'],
  line: ['muted', 'dark_foreground'], 'line-strong': ['dark_foreground', 'foreground'],
  accent: ['green', 'blue'], 'accent-hover': ['bright_green', 'bright_blue', 'green'],
  'accent-contrast': ['background'], focus: ['bright_green', 'bright_blue', 'foreground'],
  selection: ['selection', 'selection_background'], 'error-ink': ['bright_red', 'red'],
  'error-surface': ['dark_background', 'background'], 'error-line': ['red'],
};

export function parseOmarchyTheme(source: string): PortableTheme {
  const values = new Map<string, string>();
  const colorKeys = new Set([...Object.values(omarchyFallbacks).flat(), 'bg', 'fg', 'lighter_bg', 'dark_fg']);
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/);
    if (!match || values.has(match[1])) throw new Error('The active Omarchy palette contains invalid or duplicate fields.');
    const value = match[2] ?? match[3];
    if (match[1] === 'mode' || match[1] === 'theme_type') {
      if (value !== 'light' && value !== 'dark') throw new Error('The active Omarchy palette has an invalid mode.');
    } else if (colorKeys.has(match[1]) && !hexColor.test(value)) {
      throw new Error(`Invalid Omarchy color “${match[1]}”.`);
    }
    values.set(match[1], value.toLowerCase());
  }
  const background = values.get('background') ?? values.get('bg');
  const foreground = values.get('foreground') ?? values.get('fg');
  if (!background || !foreground) throw new Error('The active Omarchy palette is missing background or foreground.');
  for (const [canonical, legacy] of [['background', 'bg'], ['foreground', 'fg'], ['lighter_background', 'lighter_bg'], ['dark_foreground', 'dark_fg']] as const) {
    if (!values.has(canonical) && values.has(legacy)) values.set(canonical, values.get(legacy)!);
  }
  const modeValue = values.get('mode') ?? values.get('theme_type');
  const luminance = Number.parseInt(background.slice(1, 3), 16) + Number.parseInt(background.slice(3, 5), 16) + Number.parseInt(background.slice(5, 7), 16);
  const mode: ThemeMode = modeValue === 'light' || modeValue === 'dark' ? modeValue : luminance > 382 ? 'light' : 'dark';
  const colors = {} as Record<ColorToken, string>;
  for (const token of colorTokens) {
    const value = omarchyFallbacks[token].map(key => values.get(key)).find(Boolean);
    if (!value) throw new Error(`The active Omarchy palette cannot provide “${token}”.`);
    colors[token] = value;
  }
  return { schemaVersion: 1, id: 'omarchy-active', name: 'Omarchy active theme', mode, colors };
}
