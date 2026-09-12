/**
 * The forward pass [A8-13], [A8-14]: the checkpoint's network (`nn_version`
 * 84) in eval mode, as `GenericNNetWrapper` exports it to ONNX Runtime.
 *
 * Dropout is the identity in eval mode, and batch norm uses its running
 * statistics. Arithmetic is float64 under [A8-49] — the original's is ONNX
 * Runtime's float32, which is why [A8-37] compares within 1e-5 rather than
 * exactly, and why [A8-39] asks for agreement on 99% of choices rather than
 * all of them.
 *
 * Every buffer here is allocated per session [A8-3], [A8-15]: the weights
 * arrive as one immutable base64 string and each `createNetwork` decodes its
 * own typed arrays from it.
 *
 * Squeeze-excite is present in **every** block, the trunk included. Upstream
 * turns it on by passing the strings `"RE"` and `"HS"` where a boolean is
 * expected, and a non-empty string is true — so a port written from the
 * constructor's apparent intent would leave it out. The checkpoint's
 * `se.fc1`/`se.fc2` tensors in all three blocks are the evidence.
 */

import { exp, softmaxInPlace, tanh } from './exp.js';
import { TENSORS, WEIGHTS_BASE64, WEIGHTS_COUNT } from './weights.js';

/** The board's width: the "length" axis of every 1-d layer. */
const LENGTH = 6;
/** Board rows, which are the network's input channels. */
const CHANNELS = 23;
/** Their action space. */
const ACTIONS = 180;
/** `BatchNorm1d`'s default. */
const BN_EPS = 1e-5;

/** What the network returns [A8-14]: float32, as ONNX Runtime returns it. */
export interface NetworkOutput {
  /** Probabilities indexed by **their** action. Illegal actions are 0. */
  policy: Float32Array;
  /** `[me, them]`, each in [-1, 1]. */
  value: Float32Array;
}

export interface Network {
  /** `legal[a]` is 1 when **their** action `a` is legal here. */
  evaluate(board: Int8Array, legal: Uint8Array): NetworkOutput;
}

/** A linear layer across channels, or along the length axis. */
interface Linear {
  weight: Float64Array;
  bias: Float64Array | null;
  inputs: number;
  outputs: number;
}

/** Batch norm folded to a multiply and an add, per channel. */
interface Norm {
  scale: Float64Array;
  shift: Float64Array;
}

interface Excite {
  down: Linear;
  up: Linear;
}

interface Block {
  /** Absent when the expansion width equals the input width. */
  expand: { linear: Linear; norm: Norm } | null;
  depthwise: { linear: Linear; norm: Norm };
  excite: Excite;
  project: { linear: Linear; norm: Norm };
  /** Hardswish when true, ReLU when false. */
  hardswish: boolean;
  width: number;
  /** Channels in, which with {@link outputs} decides the residual add. */
  inputs: number;
  outputs: number;
  /**
   * This block's own working buffers, never the caller's. The residual add
   * reads the block's input after the mixing stage has run, so a buffer shared
   * with the caller would have been overwritten by then.
   */
  expanded: Float64Array;
  mixed: Float64Array;
  excitation: { mean: Float64Array; squeezed: Float64Array };
}

function relu(x: number): number {
  return x > 0 ? x : 0;
}

/** `relu6(x + 3) / 6`, PyTorch's `Hardsigmoid`. */
function hardsigmoid(x: number): number {
  const shifted = x + 3;
  return (shifted < 0 ? 0 : shifted > 6 ? 6 : shifted) / 6;
}

/** `x · relu6(x + 3) / 6`, PyTorch's `Hardswish`. */
function hardswish(x: number): number {
  return x * hardsigmoid(x);
}

export function createNetwork(): Network {
  // One decode per session. `atob` is the platform's base64, which is exact:
  // it maps bytes to bytes.
  const binary = atob(WEIGHTS_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const values = new Float64Array(WEIGHTS_COUNT);
  for (let i = 0; i < WEIGHTS_COUNT; i++) values[i] = view.getFloat32(i * 4, true);

  const table = new Map<string, { shape: readonly number[]; offset: number }>();
  for (const tensor of TENSORS) table.set(tensor.name, tensor);

  const tensor = (name: string): Float64Array => {
    const entry = table.get(name);
    if (entry === undefined) throw new Error(`the checkpoint has no tensor ${name}`);
    let count = 1;
    for (const n of entry.shape) count *= n;
    return values.subarray(entry.offset, entry.offset + count);
  };
  const shapeOf = (name: string): readonly number[] => {
    const entry = table.get(name);
    if (entry === undefined) throw new Error(`the checkpoint has no tensor ${name}`);
    return entry.shape;
  };

  const linear = (prefix: string, biased: boolean): Linear => {
    const shape = shapeOf(`${prefix}.weight`);
    return {
      weight: tensor(`${prefix}.weight`),
      bias: biased ? tensor(`${prefix}.bias`) : null,
      outputs: shape[0],
      inputs: shape[1],
    };
  };

  /** `(x − mean) / √(var + ε) · γ + β`, folded once per session. */
  const norm = (prefix: string): Norm => {
    const gamma = tensor(`${prefix}.weight`);
    const beta = tensor(`${prefix}.bias`);
    const mean = tensor(`${prefix}.running_mean`);
    const variance = tensor(`${prefix}.running_var`);
    const scale = new Float64Array(gamma.length);
    const shift = new Float64Array(gamma.length);
    for (let c = 0; c < gamma.length; c++) {
      scale[c] = gamma[c] / Math.sqrt(variance[c] + BN_EPS);
      shift[c] = beta[c] - mean[c] * scale[c];
    }
    return { scale, shift };
  };

  const block = (prefix: string, hardswishActivation: boolean): Block => {
    const expandShape = table.has(`${prefix}.expand.linear.weight`)
      ? shapeOf(`${prefix}.expand.linear.weight`)
      : null;
    const projectShape = shapeOf(`${prefix}.project.linear.weight`);
    const width = expandShape === null ? projectShape[1] : expandShape[0];
    const squeeze = shapeOf(`${prefix}.se.fc1.weight`)[0];
    return {
      expanded: new Float64Array(width * LENGTH),
      mixed: new Float64Array(width * LENGTH),
      excitation: { mean: new Float64Array(width), squeezed: new Float64Array(squeeze) },
      expand:
        expandShape === null
          ? null
          : { linear: linear(`${prefix}.expand.linear`, false), norm: norm(`${prefix}.expand.norm`) },
      depthwise: {
        linear: linear(`${prefix}.depthwise.linear`, false),
        norm: norm(`${prefix}.depthwise.norm`),
      },
      excite: { down: linear(`${prefix}.se.fc1`, true), up: linear(`${prefix}.se.fc2`, true) },
      project: {
        linear: linear(`${prefix}.project.linear`, false),
        norm: norm(`${prefix}.project.norm`),
      },
      hardswish: hardswishActivation,
      width,
      inputs: expandShape === null ? projectShape[1] : expandShape[1],
      outputs: projectShape[0],
    };
  };

  const first = { linear: linear('first_layer.linear', false), norm: norm('first_layer.norm') };
  const trunk = block('trunk.0', false);
  const policyBlock = block('output_layers_PI.0', true);
  const policyHead = [linear('output_layers_PI.2', true), linear('output_layers_PI.4', true)];
  const valueBlock = block('output_layers_V.0', true);
  const valueHead = [linear('output_layers_V.2', true), linear('output_layers_V.4', true)];
  /** The original's mask constant, a buffer of the checkpoint: -1e8. */
  const lowValue = tensor('lowvalue')[0];

  // Working buffers, one set per session, reused across calls within it. Each
  // stage writes to its own, so nothing here aliases anything a later stage
  // still has to read.
  const input = new Float64Array(CHANNELS * LENGTH);
  const stem = new Float64Array(CHANNELS * LENGTH);
  const body = new Float64Array(CHANNELS * LENGTH);
  const valueBody = new Float64Array(CHANNELS * LENGTH);
  const policyBody = new Float64Array(policyBlock.outputs * LENGTH);
  const logits = new Float64Array(ACTIONS);
  const hidden = new Float64Array(ACTIONS);
  const valueOut = new Float64Array(2);

  /** `out[o·6 + l] = Σ_c W[o·in + c] · x[c·6 + l]`, the transposed linear. */
  function acrossChannels(x: Float64Array, layer: Linear, out: Float64Array): void {
    for (let o = 0; o < layer.outputs; o++) {
      const row = o * layer.inputs;
      for (let l = 0; l < LENGTH; l++) {
        let total = 0;
        for (let c = 0; c < layer.inputs; c++) total += layer.weight[row + c] * x[c * LENGTH + l];
        out[o * LENGTH + l] = total;
      }
    }
  }

  /** `out[c·6 + l] = Σ_k W[l·6 + k] · x[c·6 + k]`: upstream's "depthwise". */
  function alongLength(x: Float64Array, channels: number, layer: Linear, out: Float64Array): void {
    for (let c = 0; c < channels; c++) {
      const base = c * LENGTH;
      for (let l = 0; l < LENGTH; l++) {
        let total = 0;
        for (let k = 0; k < LENGTH; k++) total += layer.weight[l * LENGTH + k] * x[base + k];
        out[base + l] = total;
      }
    }
  }

  function normalise(x: Float64Array, channels: number, layer: Norm, activation: number): void {
    for (let c = 0; c < channels; c++) {
      const scale = layer.scale[c];
      const shift = layer.shift[c];
      for (let l = 0; l < LENGTH; l++) {
        const value = x[c * LENGTH + l] * scale + shift;
        x[c * LENGTH + l] =
          activation === 0 ? value : activation === 1 ? relu(value) : hardswish(value);
      }
    }
  }

  /** Mean over the length, two linears, and a per-channel scaling. */
  function squeezeExcite(
    x: Float64Array,
    channels: number,
    layer: Excite,
    buffers: { mean: Float64Array; squeezed: Float64Array },
  ): void {
    const mean = buffers.mean;
    const squeezed = buffers.squeezed;
    for (let c = 0; c < channels; c++) {
      let total = 0;
      for (let l = 0; l < LENGTH; l++) total += x[c * LENGTH + l];
      mean[c] = total / LENGTH;
    }
    const down = layer.down;
    for (let j = 0; j < down.outputs; j++) {
      let total = down.bias![j];
      for (let c = 0; c < down.inputs; c++) total += down.weight[j * down.inputs + c] * mean[c];
      squeezed[j] = relu(total);
    }
    const up = layer.up;
    for (let c = 0; c < up.outputs; c++) {
      let total = up.bias![c];
      for (let j = 0; j < up.inputs; j++) total += up.weight[c * up.inputs + j] * squeezed[j];
      const scale = hardsigmoid(total);
      for (let l = 0; l < LENGTH; l++) x[c * LENGTH + l] *= scale;
    }
  }

  /** expand, depthwise, squeeze-excite, project, and the residual add. */
  function inverted(source: Float64Array, layer: Block, out: Float64Array): void {
    const activation = layer.hardswish ? 2 : 1;
    let current = source;
    if (layer.expand !== null) {
      acrossChannels(source, layer.expand.linear, layer.expanded);
      normalise(layer.expanded, layer.width, layer.expand.norm, activation);
      current = layer.expanded;
    }
    const mixed = layer.mixed;
    alongLength(current, layer.width, layer.depthwise.linear, mixed);
    normalise(mixed, layer.width, layer.depthwise.norm, activation);
    squeezeExcite(mixed, layer.width, layer.excite, layer.excitation);
    acrossChannels(mixed, layer.project.linear, out);
    normalise(out, layer.outputs, layer.project.norm, 0);
    // Upstream's `use_res_connect = (in_channels == out_channels)`, written as
    // that and not as an equivalent that happens to hold: the trunk and the
    // value block add, the policy block (23 in, 46 out) does not.
    if (layer.outputs === layer.inputs) {
      for (let i = 0; i < layer.outputs * LENGTH; i++) out[i] += source[i];
    }
  }

  /** Flatten channel-major, then `linear → ReLU → linear`. */
  function head(x: Float64Array, inputs: number, layers: Linear[], out: Float64Array): void {
    const first = layers[0];
    for (let o = 0; o < first.outputs; o++) {
      let total = first.bias![o];
      for (let i = 0; i < inputs; i++) total += first.weight[o * inputs + i] * x[i];
      hidden[o] = relu(total);
    }
    const second = layers[1];
    for (let o = 0; o < second.outputs; o++) {
      let total = second.bias![o];
      for (let i = 0; i < second.inputs; i++) total += second.weight[o * second.inputs + i] * hidden[i];
      out[o] = total;
    }
  }

  return {
    evaluate(board, legal) {
      if (board.length !== CHANNELS * LENGTH) {
        throw new TypeError(`a board is ${CHANNELS * LENGTH} values, not ${board.length}`);
      }
      for (let i = 0; i < board.length; i++) input[i] = board[i];

      acrossChannels(input, first.linear, stem);
      normalise(stem, CHANNELS, first.norm, 0);
      inverted(stem, trunk, body);

      // Value: its own block, then two linears and tanh.
      inverted(body, valueBlock, valueBody);
      head(valueBody, CHANNELS * LENGTH, valueHead, valueOut);

      // Policy: its own block, then two linears, the mask, and the softmax.
      inverted(body, policyBlock, policyBody);
      head(policyBody, policyBlock.outputs * LENGTH, policyHead, logits);
      for (let a = 0; a < ACTIONS; a++) {
        if (legal[a] === 0) logits[a] = lowValue;
      }
      softmaxInPlace(logits);

      const policy = new Float32Array(ACTIONS);
      for (let a = 0; a < ACTIONS; a++) policy[a] = logits[a];
      const out = new Float32Array(2);
      out[0] = tanh(valueOut[0]);
      out[1] = tanh(valueOut[1]);
      return { policy, value: out };
    },
  };
}

/** `exp` is re-exported so the suite can check the port [A8-49]. */
export { exp };
