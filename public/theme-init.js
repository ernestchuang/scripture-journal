// Classic, render-blocking script: apply the saved appearance before the app bundle.
(() => {
  const key = 'scripture-journal.appearance';
  const valid = value => ['system', 'light', 'dark'].includes(value);
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try {
    const saved = localStorage.getItem(key);
    if (valid(saved)) preference = saved;
  } catch { /* Restricted storage must not prevent startup. */ }
  const resolve = () => preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
  function apply() {
    const theme = resolve();
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.documentElement.style.backgroundColor = theme === 'dark' ? '#1d2420' : '#f5f2ea';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#1d2420' : '#f5f2ea');
    window.dispatchEvent(new Event('appearancechange'));
  }
  window.scriptureAppearance = {
    getPreference: () => preference,
    getResolved: resolve,
    setPreference(value) {
      if (!valid(value)) return false;
      preference = value;
      let persisted = true;
      try { localStorage.setItem(key, value); } catch { persisted = false; }
      apply();
      return persisted;
    },
  };
  media.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) {
      preference = valid(event.newValue) ? event.newValue : 'system';
      apply();
    }
  });
  apply();
})();
