/**
 * There is no server and there are no accounts [U3-8], and nothing survives a
 * reload [U3-15], [U3-16].
 *
 * "No persistence" and "no network" are behaviour, so they are tested as
 * behaviour [U3-72]: every door out of the page is replaced with a stub that
 * throws, and a whole game is played through the door-less build. This is the
 * treatment [0002 V2-31] gives [0001 E1-50], for the same reason — a promise
 * that something is never called is only worth what it costs to break it.
 */

import { render } from '@solidjs/testing-library';
import { CENTER, FLOOR, Rng, apply, decodeAction, encodeAction, newGame, toJSON } from 'engine';
import type { AzulState } from 'engine';
import { flush } from 'solid-js';
import { deal, openSheet } from './sheet-helpers.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickName } from '../src/components/Displays.jsx';
import { floorLineName } from '../src/components/FloorLine.jsx';
import { patternLineName } from '../src/components/PatternLines.jsx';

const GAME_SEED = 555;
const CHOICE_SEED = 271828;
const PLY_LIMIT = 400;

/** Every way out of the page, and the one way in that a reload would use. */
const DOORS = [
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
] as const;

const restore: (() => void)[] = [];

function slamShut(): string[] {
  const opened: string[] = [];
  const trap = (name: string) => {
    opened.push(name);
    throw new Error(`the interface reached for ${name}`);
  };

  for (const door of DOORS) {
    const original = Object.getOwnPropertyDescriptor(window, door);
    Object.defineProperty(window, door, {
      configurable: true,
      get: () => trap(door),
    });
    restore.push(() => {
      if (original) Object.defineProperty(window, door, original);
      else delete (window as unknown as Record<string, unknown>)[door];
    });
  }

  const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => trap('document.cookie'),
    set: () => trap('document.cookie'),
  });
  restore.push(() => {
    delete (document as unknown as Record<string, unknown>).cookie;
    if (cookie) Object.defineProperty(Document.prototype, 'cookie', cookie);
  });

  const beacon = navigator.sendBeacon;
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    value: () => trap('navigator.sendBeacon'),
  });
  restore.push(() => {
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: beacon });
  });

  // [U3-8] as widened by [0012 T12-32]: WebAssembly may be instantiated from
  // bytes in the bundle, never from a network response.
  const wasm = (globalThis as unknown as { WebAssembly: Record<string, unknown> }).WebAssembly;
  for (const name of ['instantiateStreaming', 'compileStreaming']) {
    const original = Object.getOwnPropertyDescriptor(wasm, name);
    Object.defineProperty(wasm, name, { configurable: true, value: () => trap(`WebAssembly.${name}`) });
    restore.push(() => {
      if (original) Object.defineProperty(wasm, name, original);
      else delete wasm[name];
    });
  }

  return opened;
}

afterEach(() => {
  while (restore.length) restore.pop()!();
});

describe('[U3-72] the stubs themselves', () => {
  it('throw when touched, so the game below is not passing vacuously', () => {
    const opened = slamShut();
    expect(() => window.localStorage).toThrow();
    expect(() => window.sessionStorage).toThrow();
    expect(() => window.indexedDB).toThrow();
    expect(() => window.fetch).toThrow();
    expect(() => window.XMLHttpRequest).toThrow();
    expect(() => window.WebSocket).toThrow();
    expect(() => document.cookie).toThrow();
    expect(() => navigator.sendBeacon('/anywhere')).toThrow();
    const wasm = (globalThis as unknown as { WebAssembly: Record<string, () => unknown> }).WebAssembly;
    expect(() => wasm.instantiateStreaming()).toThrow();
    expect(() => wasm.compileStreaming()).toThrow();
    expect(opened.sort()).toEqual(
      [
        ...DOORS,
        'document.cookie',
        'navigator.sendBeacon',
        'WebAssembly.instantiateStreaming',
        'WebAssembly.compileStreaming',
      ].sort(),
    );
  });
});

describe('[U3-72] a game played with every door stubbed to throw', () => {
  it('[U3-15] [U3-66] writes to no storage and makes no request', async () => {
    const opened = slamShut();
    history.replaceState({}, '', `/?seed=${GAME_SEED}`);
    vi.resetModules();
    const { App } = await import('../src/components/App.jsx');
    const screen = render(() => <App />);

    const state: AzulState = newGame(GAME_SEED);
    const rng = new Rng(CHOICE_SEED);

    const named = (name: string): HTMLElement =>
      screen.getByRole('button', { name });

    let ply = 0;
    for (; ply < PLY_LIMIT && !state.isTerminal; ply++) {
      const game = toJSON(state);
      const action = game.legalActions[rng.next() % game.legalActions.length];
      const [source, color, dest] = decodeAction(action);
      const count = (source === CENTER ? game.center : game.factories[source])[color];

      named(pickName({ source, color, count }, game.colorNames)).click();
      flush();

      const p = game.currentPlayer;
      named(
        dest === FLOOR
          ? floorLineName(
              state.floor[p].reduce((a, b) => a + b, 0) + (state.floorMarker[p] ? 1 : 0),
              game.players[p].floorPenalty,
            )
          : patternLineName(game.players[p].patternLines[dest], dest, game.colorNames),
      ).click();
      flush();

      apply(state, encodeAction(source, color, dest));
    }

    expect(state.isTerminal, 'the game never ended').toBe(true);

    // And a new game too, which is the other moment something might be saved —
    // dealt through the sheet, as every new game is [0006 W6-49].
    deal(openSheet(screen));

    expect(opened, 'the interface reached for something it must never touch').toEqual([]);
  });
});

describe('[U3-72] the master, loaded with every door stubbed to throw', () => {
  // [U3-8] as widened by [0012 T12-32]: the module and its weights come from
  // bytes in the bundle, so instantiating them and searching opens nothing.
  it('[U3-66] [W6-47] instantiates the module and plays a move without a request', { timeout: 60_000 }, async () => {
    const opened = slamShut();
    const { createMasterSeat } = await import('../src/masters.js');
    const position = toJSON(newGame(GAME_SEED));
    const reply = await createMasterSeat().answer({ generation: 1, position, tier: 'master', simulations: 100 });
    expect(reply.ok).toBe(true);
    expect(opened).toEqual([]);
  });
});
