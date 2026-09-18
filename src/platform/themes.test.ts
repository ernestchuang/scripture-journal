import { describe, expect, it } from 'vitest';
import { colorTokens, isPortableTheme, loadThemes, parseOmarchyTheme, parsePortableTheme } from './themes';

const portable = `schema_version = 1\nid = "forest-night"\nname = "Forest Night"\nmode = "dark"\n\n[colors]\n${colorTokens.map((token, index) => `${token} = "#${String(index + 1).padStart(6, '0')}"`).join('\n')}\n`;

describe('portable themes', () => {
  it('parses and normalizes the complete safe color contract', () => {
    const theme = parsePortableTheme(portable.replace('#000001', '#AABBCC'));
    expect(theme.colors['app-background']).toBe('#aabbcc');
    expect(isPortableTheme(theme)).toBe(true);
  });

  it.each([
    ['missing color', portable.replace('error-line = "#000019"\n', '')],
    ['unsafe color', portable.replace('#000001', 'url(javascript:alert(1))')],
    ['unknown key', `${portable}css = "body { display: none }"\n`],
    ['bad syntax', `${portable}<style>bad</style>`],
  ])('rejects %s', (_, source) => expect(() => parsePortableTheme(source)).toThrow());

  it('ignores malformed persisted themes', () => {
    const good = parsePortableTheme(portable);
    expect(loadThemes({ getItem: () => JSON.stringify([good, { id: 'broken' }]) })).toEqual([good]);
    expect(loadThemes({ getItem: () => '{' })).toEqual([]);
  });
});

describe('Omarchy palette adapter', () => {
  it('maps the semantic Omarchy schema without accepting CSS', () => {
    const source = `mode = "dark"\nbackground = "#101010"\nforeground = "#eeeeee"\nlighter_background = "#202020"\ndark_background = "#080808"\ndark_foreground = "#777777"\nmuted = "#888888"\nselection = "#303030"\ngreen = "#00aa00"\nbright_green = "#33dd33"\nred = "#aa0000"\nbright_red = "#dd3333"\n`;
    const theme = parseOmarchyTheme(source);
    expect(theme.colors.accent).toBe('#00aa00');
    expect(theme.colors['error-ink']).toBe('#dd3333');
    expect(theme.mode).toBe('dark');
  });

  it('rejects palettes that cannot satisfy the semantic contract', () => {
    expect(() => parseOmarchyTheme('background = "#000000"\nforeground = "#ffffff"')).toThrow(/cannot provide/);
  });
});
