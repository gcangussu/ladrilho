// A stub with the agreed signature: the teammate's Graph.tsx replaces this file at merge.
import type { JSX } from '@solidjs/web';
import type { PlyRecord } from '../game.js';
import type { Seating } from '../opponent.js';

export function EstimateGraph(_props: { history: readonly PlyRecord[]; seating: Seating }): JSX.Element {
  return <div class="graph" />;
}
