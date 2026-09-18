import { useLayoutEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isDesktop } from './journal';
import { parseOmarchyTheme, parsePortableTheme, type PortableTheme } from './themes';

export type Appearance = 'system' | 'light' | 'dark' | 'omarchy' | `theme:${string}`;
declare global {
  interface Window {
    scriptureAppearance: {
      getPreference(): Appearance;
      getResolved(): 'light' | 'dark';
      getBackground(): string;
      getThemes(): PortableTheme[];
      setPreference(value: Appearance): boolean;
      saveTheme(theme: PortableTheme): boolean;
      setOmarchyTheme(theme: PortableTheme): boolean;
    };
  }
}

export function useAppearance() {
  const [preference, setPreference] = useState<Appearance>(() => window.scriptureAppearance.getPreference());
  const [themes, setThemes] = useState(() => window.scriptureAppearance.getThemes());
  const [storageError, setStorageError] = useState('');
  const [nativeError, setNativeError] = useState('');
  const [importError, setImportError] = useState('');
  const supportsOmarchy = isDesktop && /Linux/i.test(navigator.userAgent);
  useLayoutEffect(() => {
    let active = true;
    let nativeUpdates = Promise.resolve();
    const update = () => {
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
    return () => { active = false; window.removeEventListener('appearancechange', update); };
  }, []);
  useLayoutEffect(() => {
    if (!supportsOmarchy || preference !== 'omarchy') return;
    let active = true;
    const refresh = async () => {
      try {
        const source = await invoke<string | null>('read_omarchy_theme');
        if (active && source) {
          window.scriptureAppearance.setOmarchyTheme(parseOmarchyTheme(source));
          setNativeError('');
        }
      } catch {
        if (active) setNativeError('The active Omarchy palette is unavailable; the last usable colors remain active.');
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [preference, supportsOmarchy]);
  return {
    preference, themes, supportsOmarchy,
    error: [storageError, nativeError, importError].filter(Boolean).join(' '),
    change(value: Appearance) {
      setStorageError(window.scriptureAppearance.setPreference(value) ? '' : 'Appearance changed, but this device could not save your preference.');
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
