// Classic, render-blocking script: restore a validated palette before the app bundle.
(() => {
  const preferenceKey = 'scripture-journal.appearance';
  const themesKey = 'scripture-journal.custom-themes';
  const omarchyKey = 'scripture-journal.omarchy-theme';
  const tokens = ['app-background', 'paper', 'surface', 'surface-raised', 'surface-subtle', 'surface-active', 'ink', 'muted', 'placeholder', 'line', 'line-strong', 'accent', 'accent-hover', 'accent-contrast', 'focus', 'selection', 'error-ink', 'error-surface', 'error-line'];
  const hex = /^#[0-9a-fA-F]{6}$/;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let themes = [];
  let omarchyTheme = null;
  let preference = 'system';
  const validTheme = value => value && value.schemaVersion === 1
    && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id)
    && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 80
    && ['light', 'dark'].includes(value.mode)
    && value.colors && tokens.every(token => hex.test(value.colors[token] || ''));
  const validPreference = value => ['system', 'light', 'dark', 'omarchy'].includes(value)
    || (typeof value === 'string' && /^theme:[a-z0-9][a-z0-9-]{0,63}$/.test(value));
  try {
    const savedThemes = JSON.parse(localStorage.getItem(themesKey) || '[]');
    if (Array.isArray(savedThemes)) themes = savedThemes.filter(validTheme);
    const savedOmarchy = JSON.parse(localStorage.getItem(omarchyKey) || 'null');
    if (validTheme(savedOmarchy)) omarchyTheme = savedOmarchy;
    const savedPreference = localStorage.getItem(preferenceKey);
    if (validPreference(savedPreference)) preference = savedPreference;
  } catch { /* Restricted or damaged storage must not prevent startup. */ }
  const selectedTheme = () => preference === 'omarchy'
    ? omarchyTheme
    : preference.startsWith('theme:') ? themes.find(theme => theme.id === preference.slice(6)) : null;
  const resolved = () => selectedTheme()?.mode
    || (preference === 'system' || preference === 'omarchy' || preference.startsWith('theme:')
      ? (media.matches ? 'dark' : 'light') : preference);
  function apply() {
    const theme = selectedTheme();
    const mode = resolved();
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode;
    for (const token of tokens) document.documentElement.style.removeProperty(`--${token}`);
    if (theme) for (const token of tokens) document.documentElement.style.setProperty(`--${token}`, theme.colors[token]);
    const background = theme?.colors['app-background'] || (mode === 'dark' ? '#1d2420' : '#f5f2ea');
    document.documentElement.style.backgroundColor = background;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background);
    window.dispatchEvent(new Event('appearancechange'));
  }
  window.scriptureAppearance = {
    getPreference: () => preference,
    getResolved: resolved,
    getBackground: () => selectedTheme()?.colors['app-background'] || (resolved() === 'dark' ? '#1d2420' : '#f5f2ea'),
    getThemes: () => [...themes],
    setPreference(value) {
      if (!validPreference(value)) return false;
      preference = value;
      let persisted = true;
      try { localStorage.setItem(preferenceKey, value); } catch { persisted = false; }
      apply();
      return persisted;
    },
    saveTheme(theme) {
      if (!validTheme(theme)) return false;
      themes = [...themes.filter(item => item.id !== theme.id), theme];
      try { localStorage.setItem(themesKey, JSON.stringify(themes)); } catch { return false; }
      return true;
    },
    setOmarchyTheme(theme) {
      if (!validTheme(theme)) return false;
      omarchyTheme = theme;
      try { localStorage.setItem(omarchyKey, JSON.stringify(theme)); } catch { /* Cache is optional. */ }
      if (preference === 'omarchy') apply();
      return true;
    },
  };
  media.addEventListener('change', () => {
    if (preference === 'system' || (!selectedTheme() && (preference === 'omarchy' || preference.startsWith('theme:')))) apply();
  });
  window.addEventListener('storage', event => {
    if (event.key === preferenceKey || event.key === null) {
      preference = validPreference(event.newValue) ? event.newValue : 'system';
      apply();
    }
  });
  apply();
})();
