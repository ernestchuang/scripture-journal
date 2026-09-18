// Classic, render-blocking script: restore a validated palette before the app bundle.
(() => {
  const preferenceKey = 'scripture-journal.appearance';
  const themesKey = 'scripture-journal.custom-themes';
  const tokens = ['app-background', 'paper', 'surface', 'surface-raised', 'surface-subtle', 'surface-active', 'ink', 'muted', 'placeholder', 'line', 'line-strong', 'accent', 'accent-hover', 'accent-contrast', 'focus', 'selection', 'error-ink', 'error-surface', 'error-line'];
  const hex = /^#[0-9a-fA-F]{6}$/;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let themes = [];
  // This palette is intentionally memory-only. A palette read on one desktop
  // must never color a browser session or a different operating system later.
  let systemTheme = null;
  let preference = 'system';
  const validTheme = value => value && value.schemaVersion === 1
    && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id)
    && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 80
    && ['light', 'dark'].includes(value.mode)
    && value.colors && tokens.every(token => hex.test(value.colors[token] || ''));
  const validPreference = value => ['system', 'light', 'dark'].includes(value)
    || (typeof value === 'string' && /^theme:[a-z0-9][a-z0-9-]{0,63}$/.test(value));
  try {
    const savedThemes = JSON.parse(localStorage.getItem(themesKey) || '[]');
    if (Array.isArray(savedThemes)) themes = savedThemes.filter(validTheme);
  } catch { /* A damaged optional palette must not hide a saved dark preference. */ }
  try {
    const savedPreference = localStorage.getItem(preferenceKey);
    // Follow Omarchy was folded into System. Retain the user's intent while
    // dropping the old cached palette, which may be stale or from Linux.
    if (savedPreference === 'omarchy') {
      preference = 'system';
      try { localStorage.setItem(preferenceKey, preference); } catch { /* Optional migration. */ }
    } else if (validPreference(savedPreference)) preference = savedPreference;
    try { localStorage.removeItem('scripture-journal.omarchy-theme'); } catch { /* Optional stale cache cleanup. */ }
  } catch { /* Restricted or damaged storage must not prevent startup. */ }
  const selectedTheme = () => preference === 'system'
    ? systemTheme
    : preference.startsWith('theme:') ? themes.find(theme => theme.id === preference.slice(6)) : null;
  const resolved = () => selectedTheme()?.mode
    || (preference === 'system' || preference.startsWith('theme:')
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
      const candidate = [...themes.filter(item => item.id !== theme.id), theme];
      try { localStorage.setItem(themesKey, JSON.stringify(candidate)); } catch { return false; }
      themes = candidate;
      return true;
    },
    setSystemTheme(theme) {
      if (theme !== null && !validTheme(theme)) return false;
      systemTheme = theme;
      if (preference === 'system') apply();
      return true;
    },
  };
  media.addEventListener('change', () => {
    if (preference === 'system' || (!selectedTheme() && preference.startsWith('theme:'))) apply();
  });
  window.addEventListener('storage', event => {
    if (event.key === preferenceKey || event.key === null) {
      preference = event.newValue === 'omarchy' ? 'system' : validPreference(event.newValue) ? event.newValue : 'system';
      apply();
    }
  });
  apply();
})();
