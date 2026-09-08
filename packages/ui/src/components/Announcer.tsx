import type { JSX } from '@solidjs/web';
import type { ViewModel } from '../game.js';

/**
 * The live region [U3-56]. It announces each of: the turn passing to the other
 * player, a round transition — the only moment a score changes, since scoring
 * happens inside `endRound` [0001 E1-28] — and the end of the game.
 *
 * `role="status"` is polite by default, which is right: a move is announced
 * after it lands, not over the top of whatever the player is reading.
 */
export function announcement(vm: ViewModel): string {
  const { game, transition } = vm;
  const parts: string[] = [];

  if (transition !== null) {
    parts.push(
      `Round ${game.round} scored. ` +
        `Player 1 ${change(transition.scoreDelta[0])}, ` +
        `player 2 ${change(transition.scoreDelta[1])}.`,
    );
  }
  if (game.isTerminal) {
    parts.push(
      game.outcome === 0
        ? `Game over. A draw at ${game.scores[0]} points each.`
        : `Game over. Player ${game.outcome === 1 ? 1 : 2} wins, ` +
          `${game.scores[0]} to ${game.scores[1]}.`,
    );
  } else if (vm.thinking !== null) {
    // Announced in the live region, naming the seat [W6-20]. It replaces the
    // "to move" line rather than joining it: a screen reader hearing both would
    // be told the turn had passed to someone who is not being waited on.
    parts.push(`Player ${vm.thinking.seat + 1} is thinking.`);
  } else {
    parts.push(`Player ${game.currentPlayer + 1} to move.`);
  }
  return parts.join(' ');
}

function change(delta: number): string {
  if (delta === 0) return 'scored nothing';
  return delta > 0 ? `scored ${delta}` : `lost ${-delta}`;
}

export function Announcer(props: { message: string }): JSX.Element {
  return (
    <p class="sr-only" role="status" aria-live="polite">
      {props.message}
    </p>
  );
}
