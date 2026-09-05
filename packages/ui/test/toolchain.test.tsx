/**
 * Toolchain smoke test: Solid v2 renders under Vitest with jsdom, staged writes
 * behave as the migration guide describes, and the engine imports cleanly into
 * this package. Nothing here is a requirement of spec 0003 — it exists so that
 * a failure in a later suite is a failure of the code under test, not of the
 * setup around it.
 */

import { render } from '@solidjs/testing-library';
import { newGame, toJSON } from 'engine';
import { createSignal, flush } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { App } from '../src/components/App.jsx';

describe('toolchain', () => {
  it('renders a Solid v2 component into jsdom', () => {
    const { getByRole } = render(() => <App />);
    expect(getByRole('main', { name: 'Azul' })).toBeInTheDocument();
  });

  it('stages writes: a read after a set returns the previous value until flush', () => {
    const [count, setCount] = createSignal(0);
    setCount(1);
    expect(count()).toBe(0);
    flush();
    expect(count()).toBe(1);
  });

  it('imports the engine', () => {
    expect(toJSON(newGame(1)).legalActions.length).toBeGreaterThan(0);
  });
});
