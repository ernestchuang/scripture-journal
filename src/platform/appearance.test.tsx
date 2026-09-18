// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('./journal', () => ({ isDesktop: true }));

import { refreshSystemTheme, useAppearance } from './appearance';

const palette = `
background = "#101010"
foreground = "#eeeeee"
lighter_background = "#202020"
dark_background = "#080808"
dark_foreground = "#777777"
selection = "#303030"
green = "#00aa00"
bright_green = "#33dd33"
red = "#aa0000"
bright_red = "#dd3333"
mode = "dark"
`;

function Probe() {
  const appearance = useAppearance();
  return <button onClick={() => appearance.change('system')}>Use System</button>;
}

describe('System desktop palette lifecycle', () => {
  let preference = 'system';
  let applied: unknown[] = [];

  beforeEach(() => {
    preference = 'system';
    applied = [];
    native.invoke.mockReset().mockResolvedValue(null);
    window.scriptureAppearance = {
      getPreference: () => preference as 'system',
      getResolved: () => 'dark',
      getBackground: () => '#1d2420',
      getThemes: () => [],
      setPreference: () => true,
      saveTheme: () => true,
      setSystemTheme: theme => { applied.push(theme); return true; },
    };
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('falls back to the OS by clearing the transient palette for a missing or malformed source', async () => {
    await refreshSystemTheme();
    expect(applied).toEqual([null]);
    native.invoke.mockResolvedValueOnce('not a palette');
    await refreshSystemTheme();
    expect(applied).toEqual([null, null]);
  });

  it('uses a valid compatible palette while System remains current', async () => {
    native.invoke.mockResolvedValueOnce(palette);
    await refreshSystemTheme();
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ id: 'omarchy-active', mode: 'dark', colors: { accent: '#00aa00' } });
  });

  it('does not let a late read change an explicit preference', async () => {
    let finish: (value: string | null) => void = () => undefined;
    native.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const reading = refreshSystemTheme();
    preference = 'dark';
    finish(palette);
    await reading;
    expect(applied).toEqual([]);
  });

  it('serializes polls and ignores a read that finishes after unmount', async () => {
    vi.useFakeTimers();
    let finish: (value: string | null) => void = () => undefined;
    native.invoke.mockImplementation(command => command === 'read_omarchy_theme'
      ? new Promise(resolve => { finish = resolve; })
      : Promise.resolve(undefined));
    const view = render(<Probe />);
    await act(async () => { await Promise.resolve(); });
    expect(native.invoke).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(native.invoke).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(native.invoke).toHaveBeenCalledTimes(2);
    view.unmount();
    finish(palette);
    await act(async () => { await Promise.resolve(); });
    expect(applied).toEqual([]);
  });

  it('invalidates the immediate System probe when the app unmounts', async () => {
    preference = 'dark';
    let finish: (value: string | null) => void = () => undefined;
    window.scriptureAppearance.setPreference = value => {
      preference = value;
      window.dispatchEvent(new Event('appearancechange'));
      return true;
    };
    native.invoke.mockImplementation(command => command === 'read_omarchy_theme'
      ? new Promise(resolve => { finish = resolve; })
      : Promise.resolve(undefined));
    const view = render(<Probe />);
    fireEvent.click(document.querySelector('button')!);
    await act(async () => { await Promise.resolve(); });
    expect(applied).toEqual([null]);
    view.unmount();
    finish(palette);
    await act(async () => { await Promise.resolve(); });
    expect(applied).toEqual([null]);
  });
});
