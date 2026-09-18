import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './style.css';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { refreshSystemTheme } from './platform/appearance';

async function start() {
  if (isTauri()) {
    try {
      const smokeTheme = await invoke<'dark' | null>('startup_appearance');
      if (smokeTheme) window.scriptureAppearance.setPreference(smokeTheme);
    } catch { /* Normal theme startup still works if the debug override is unavailable. */ }
  }
  // The native window stays hidden until useAppearance applies these colors.
  // Settle the first optional palette read before React can request that reveal.
  await refreshSystemTheme();
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode><App /></React.StrictMode>,
  );
}
void start();
