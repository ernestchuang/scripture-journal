import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './style.css';
import { invoke, isTauri } from '@tauri-apps/api/core';

async function start() {
  if (isTauri()) {
    try {
      const smokeTheme = await invoke<'dark' | null>('startup_appearance');
      if (smokeTheme) window.scriptureAppearance.setPreference(smokeTheme);
    } catch { /* Normal theme startup still works if the debug override is unavailable. */ }
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode><App /></React.StrictMode>,
  );
}
void start();
