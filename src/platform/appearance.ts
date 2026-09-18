import { useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isDesktop } from './journal';
import { parseOmarchyTheme, parsePortableTheme, type PortableTheme } from './themes';

export type Appearance = 'system' | 'light' | 'dark' | `theme:${string}`;
declare global {
  interface Window {
    scriptureAppearance: {
      getPreference(): Appearance;
      getResolved(): 'light' | 'dark';
      getBackground(): string;
      getThemes(): PortableTheme[];
      setPreference(value: Appearance): boolean;
      saveTheme(theme: PortableTheme): boolean;
      setSystemTheme(theme: PortableTheme | null): boolean;
    };
  }
}

/**
 * Reads the optional desktop palette only while System is active. The palette
 * remains in memory: its absence, a malformed file, or a failed read restores
 * the normal OS light/dark result instead of retaining old Linux colors.
 */
export async function refreshSystemTheme(isCurrent = () => window.scriptureAppearance.getPreference() === 'system') {
  if (!isDesktop || !isCurrent()) return;
  let theme: PortableTheme | null = null;
  try {
    const source = await invoke<string | null>('read_omarchy_theme');
    if (source) theme = parseOmarchyTheme(source);
  } catch { /* System intentionally falls back to the OS appearance. */ }
  if (isCurrent()) window.scriptureAppearance.setSystemTheme(theme);
}

export function useAppearance() {
  const [preference, setPreference] = useState<Appearance>(() => window.scriptureAppearance.getPreference());
  const [themes, setThemes] = useState(() => window.scriptureAppearance.getThemes());
  const [storageError, setStorageError] = useState('');
  const [nativeError, setNativeError] = useState('');
  const [importError, setImportError] = useState('');
  const probeEpoch = useRef(0);
  useLayoutEffect(() => {
    let active = true;
    let nativeUpdates = Promise.resolve();
    const update = () => {
      probeEpoch.current += 1;
      setPreference(window.scriptureAppearance.getPreference());
      if (isDesktop) {
        const theme = window.scriptureAppearance.getResolved();
        const background = window.scriptureAppearance.getBackground();
        nativeUpdates = nativeUpdates.catch(() => undefined).then(async () => {
          if (!active) return;
          getComputedStyle(document.documentElement).backgroundColor;
          await invoke('apply_appearance', { theme, background });
          if (active) setNativeError('');
        }).catch(() => { if (active) setNativeError('The window appearance could not be updated.'); });
      }
    };
    update();
    window.addEventListener('appearancechange', update);
    return () => {
      active = false;
      // Invalidate an immediate System probe started by change(), which is not
      // owned by the polling effect below.
      probeEpoch.current += 1;
      window.removeEventListener('appearancechange', update);
    };
  }, []);
  useLayoutEffect(() => {
    if (!isDesktop || preference !== 'system') return;
    let active = true;
    // Keep one read in flight. This avoids a delayed filesystem read building a
    // burst of stale queued polls. The current-preference guard makes unmount
    // and explicit overrides authoritative over that one callback.
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      const epoch = probeEpoch.current;
      try {
        await refreshSystemTheme(() => active
          && probeEpoch.current === epoch
          && window.scriptureAppearance.getPreference() === 'system');
      } finally {
        refreshing = false;
      }
    };
    const timer = window.setInterval(refresh, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [preference]);
  return {
    preference, themes,
    error: [storageError, nativeError, importError].filter(Boolean).join(' '),
    change(value: Appearance) {
      // Never revive a previous desktop palette while a fresh System probe is
      // pending after an explicit override.
      if (value === 'system') window.scriptureAppearance.setSystemTheme(null);
      setStorageError(window.scriptureAppearance.setPreference(value) ? '' : 'Appearance changed, but this device could not save your preference.');
      // A return to System should not wait for the next polling interval.
      // The appearancechange listener advances the epoch before this starts.
      if (value === 'system') {
        const epoch = probeEpoch.current;
        void refreshSystemTheme(() => probeEpoch.current === epoch
          && window.scriptureAppearance.getPreference() === 'system');
      }
    },
    async importTheme(file: File) {
      try {
        if (file.size > 64 * 1024) throw new Error('Theme files must be smaller than 64 KB.');
        const theme = parsePortableTheme(await file.text());
        if (!window.scriptureAppearance.saveTheme(theme)) throw new Error('The theme could not be saved on this device.');
        setThemes(window.scriptureAppearance.getThemes());
        setImportError('');
        setStorageError(window.scriptureAppearance.setPreference(`theme:${theme.id}`) ? '' : 'Appearance changed, but this device could not save your preference.');
      } catch (error) {
        setImportError(`Theme import failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
