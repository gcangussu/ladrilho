import { COLOR_CHARS, NUM_COLORS, NUM_ROWS, wallColorAt } from './constants.js';
import { bagCounts, floorPenalty } from './inspect.js';
import type { AzulState, Player } from './types.js';

/** Tiles of a per-colour count array as characters, e.g. `BBRT`. */
function tiles(counts: number[]): string {
  let out = '';
  for (let c = 0; c < NUM_COLORS; c++) out += COLOR_CHARS[c].repeat(counts[c]);
  return out;
}

function playerLines(s: AzulState, p: Player): string[] {
  const lines = [`${p === s.currentPlayer ? '*' : ' '}P${p}  score ${s.scores[p]}`];
  for (let r = 0; r < NUM_ROWS; r++) {
    const n = s.plCount[p][r];
    const filled = n ? COLOR_CHARS[s.plColor[p][r]].repeat(n) : '';
    const line = ('.'.repeat(r + 1 - n) + filled).padStart(5);
    let wall = '';
    for (let col = 0; col < 5; col++) {
      wall += s.walls[p][r * 5 + col] ? COLOR_CHARS[wallColorAt(r, col)] : '.';
    }
    lines.push(`    ${line} | ${wall}`);
  }
  const floor = tiles(s.floor[p]) + (s.floorMarker[p] ? '#' : '');
  lines.push(`    floor: ${floor || '-'} (${floorPenalty(s, p)})`);
  return lines;
}

/** A human-readable board, for debugging. Not a stable format. */
export function renderText(s: AzulState): string {
  const bag = bagCounts(s);
  const counts = (xs: number[]): string =>
    Array.from({ length: NUM_COLORS }, (_, c) => `${COLOR_CHARS[c]}${xs[c]}`).join(' ');
  const lines = [
    `round ${s.roundIndex}  to move: P${s.currentPlayer}  ` +
      `first player: P${s.firstPlayer}  scores: ${s.scores[0]}-${s.scores[1]}` +
      (s.isTerminal ? '  [GAME OVER]' : ''),
    'Factories:',
    ...s.factories.map((f, i) => `  ${i}: ${tiles(f) || '-'}`),
    `  center: ${tiles(s.center) || '-'}${s.markerInCenter ? ' [1st]' : ''}`,
    `  bag: ${counts(bag)}   lid: ${counts(s.lid)}`,
    ...playerLines(s, 0),
    ...playerLines(s, 1),
  ];
  return lines.join('\n');
}
