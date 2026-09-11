/**
 * The network [A8-13], [A8-14], [A8-16], [A8-37].
 *
 * The anchor is [A8-37]: every fixture position evaluated here and compared
 * against what the original's own network returned through ONNX Runtime, which
 * is the only check that can tell a faithful forward pass from a plausible
 * one. Its tolerance is 1e-5 because ours is float64 where the original's is
 * float32; that is a difference in arithmetic, not in the function.
 */

import { describe, expect, it } from 'vitest';
import { createNetwork } from '../src/network.js';
import { TENSORS, WEIGHTS_COUNT } from '../src/weights.js';
import { encodeBoard } from '../src/index.js';
import { fixtures, weightsRecord } from './support/fixtures.js';

const POSITIONS = fixtures();

describe('the forward pass [A8-13], [A8-37]', () => {
  it('[A8-37] agrees with the original on every fixture position, within 1e-5', () => {
    const network = createNetwork();
    let worstPolicy = 0;
    let worstValue = 0;
    let where = '';
    for (const record of POSITIONS) {
      const out = network.evaluate(record.board, record.mask);
      for (let a = 0; a < 180; a++) {
        const gap = Math.abs(out.policy[a] - record.policy[a]);
        if (gap > worstPolicy) {
          worstPolicy = gap;
          where = `${record.game} ply ${record.ply} action ${a}`;
        }
      }
      for (let i = 0; i < 2; i++) {
        worstValue = Math.max(worstValue, Math.abs(out.value[i] - record.value[i]));
      }
    }
    expect(worstPolicy, `worst policy gap at ${where}`).toBeLessThan(1e-5);
    expect(worstValue).toBeLessThan(1e-5);
  });

  it('[A8-13] evaluates the board `encodeBoard` builds, not only the recorded one', () => {
    // The same comparison, driven from our own encoder: [A8-35] says the two
    // boards are equal, so this is [A8-37] end to end from an `AzulJSON`.
    const network = createNetwork();
    for (const record of POSITIONS.slice(0, 25)) {
      const out = network.evaluate(encodeBoard(record.position), record.mask);
      for (let a = 0; a < 180; a++) {
        expect(Math.abs(out.policy[a] - record.policy[a]), `${record.game} ply ${record.ply}`).toBeLessThan(1e-5);
      }
    }
  });

  it('[A8-14] returns probabilities by their action, and a value per seat', () => {
    const network = createNetwork();
    const record = POSITIONS[10];
    const out = network.evaluate(record.board, record.mask);
    expect(out.policy.length).toBe(180);
    expect(out.value.length).toBe(2);
    let total = 0;
    for (let a = 0; a < 180; a++) {
      if (record.mask[a] === 0) expect(out.policy[a], `action ${a} is illegal`).toBe(0);
      else expect(out.policy[a]).toBeGreaterThan(0);
      total += out.policy[a];
    }
    expect(total).toBeCloseTo(1, 5);
    for (const v of out.value) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('[A8-13] returns float32 values, as ONNX Runtime does', () => {
    const network = createNetwork();
    const out = network.evaluate(POSITIONS[3].board, POSITIONS[3].mask);
    for (const p of out.policy) expect(Math.fround(p)).toBe(p);
    for (const v of out.value) expect(Math.fround(v)).toBe(v);
  });

  it('[A8-3] two sessions, interleaved, return the same thing every time', () => {
    const first = createNetwork();
    const second = createNetwork();
    const a = POSITIONS[5];
    const b = POSITIONS[40];
    const expectedA = first.evaluate(a.board, a.mask);
    const expectedB = second.evaluate(b.board, b.mask);
    // Interleave: each session evaluates the other's position in between, so a
    // buffer shared between sessions or left dirty between calls shows up.
    for (let i = 0; i < 3; i++) {
      first.evaluate(b.board, b.mask);
      second.evaluate(a.board, a.mask);
      expect([...first.evaluate(a.board, a.mask).policy]).toEqual([...expectedA.policy]);
      expect([...second.evaluate(b.board, b.mask).value]).toEqual([...expectedB.value]);
    }
  });

  it('[A8-13] refuses a board of the wrong size', () => {
    expect(() => createNetwork().evaluate(new Int8Array(137), new Uint8Array(180))).toThrow(TypeError);
  });
});

describe('the weights table [A8-16]', () => {
  const record = weightsRecord();

  it('[A8-16] holds every tensor of the state_dict but the tracked-batch buffers', () => {
    const omitted = record.stateDict.filter((t) => t.name.endsWith(record.omittedSuffix));
    const kept = record.stateDict.filter((t) => !t.name.endsWith(record.omittedSuffix));
    expect(omitted.length).toBeGreaterThan(0);
    for (const tensor of omitted) expect(tensor.dtype).toBe('torch.int64');
    expect(TENSORS.map((t) => t.name)).toEqual(kept.map((t) => t.name));
    expect(TENSORS.map((t) => [...t.shape])).toEqual(kept.map((t) => t.shape));
  });

  it('[A8-16] lays the tensors out end to end, filling the blob exactly', () => {
    let offset = 0;
    for (const tensor of TENSORS) {
      expect(tensor.offset, `${tensor.name} does not follow the one before it`).toBe(offset);
      offset += tensor.shape.reduce((a, b) => a * b, 1);
    }
    expect(offset).toBe(WEIGHTS_COUNT);
    expect(WEIGHTS_COUNT).toBe(record.count);
  });

  it('[A8-16] was generated from the pinned checkpoint', () => {
    expect(record.commit).toBe('5d6d1f129b76659837f6afd6fb082e8da57e5428');
    expect(record.checkpointSha256).toBe(
      '7d2fbf9203e46837668cd5b8f7bb29b7ea6f9e500f25f148c79e0038a76fe2f9',
    );
    // [A8-34]'s NumPy pin, which [A8-50] depends on.
    expect(record.versions['numpy']).toMatch(/^2\./);
  });
});
