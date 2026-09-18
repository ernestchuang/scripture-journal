import { useLayoutEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isDesktop } from './journal';

export type Appearance = 'system' | 'light' | 'dark';
declare global {
  interface Window {
    scriptureAppearance: {
      getPreference(): Appearance;
      getResolved(): 'light' | 'dark';
      setPreference(value: Appearance): boolean;
    };
  }
}

export function useAppearance() {
  const [preference, setPreference] = useState<Appearance>(() => window.scriptureAppearance.getPreference());
  const [storageError, setStorageError] = useState('');
  const [nativeError, setNativeError] = useState('');
  useLayoutEffect(() => {
    let active = true;
    let nativeUpdates = Promise.resolve();
    const update = () => {
      setPreference(window.scriptureAppearance.getPreference());
      if (isDesktop) {
        const theme = window.scriptureAppearance.getResolved();
        // Serialize native updates so a slow response cannot restore an old theme.
        nativeUpdates = nativeUpdates.catch(() => undefined).then(async () => {
          if (!active) return;
          // Commit webview styles before revealing the initially hidden native window.
          getComputedStyle(document.documentElement).backgroundColor;
          await invoke('apply_appearance', { theme });
          if (active) setNativeError('');
        }).catch(() => { if (active) setNativeError('The window appearance could not be updated.'); });
      }
    };
    update();
    window.addEventListener('appearancechange', update);
    return () => { active = false; window.removeEventListener('appearancechange', update); };
  }, []);
  return {
    preference, error: [storageError, nativeError].filter(Boolean).join(' '),
    change(value: Appearance) {
      setStorageError(window.scriptureAppearance.setPreference(value) ? '' : 'Appearance changed, but this device could not save your preference.');
    },
  };
}
