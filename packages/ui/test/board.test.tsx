/**
 * What the board shows. Elements are located by accessible role and visible
 * text throughout [U3-68] — a control this cannot find the way a screen reader
 * would is a control [U3-54] has not labelled.
 */

import { render, within } from '@solidjs/testing-library';
import { NUM_COLORS, NUM_ROWS, wallColorAt } from 'engine';
import { describe, expect, it } from 'vitest';
import { FloorLine } from '../src/components/FloorLine.jsx';
import { GameOver } from '../src/components/GameOver.jsx';
import { PlayerBoard } from '../src/components/PlayerBoard.jsx';
import { Status } from '../src/components/Status.jsx';
import { endedGame, openingView } from './fixtures.js';

const vm = openingView();
const names = vm.game.colorNames;

function board(patch: Partial<Parameters<typeof PlayerBoard>[0]> = {}) {
  return render(() => (
    <PlayerBoard
      name="Player 1"
      player={vm.game.players[0]}
      floorOccupied={vm.floorOccupied[0]}
      placed={null}
      scoreDelta={null}
      toMove={true}
      names={names}
      destinations={null}
      {...patch}
    />
  ));
}

describe('the status panel', () => {
  it('[U3-32] shows the round, the tiles left this round, and where the marker is', () => {
    const { getByRole } = render(() => <Status game={vm.game} seed={vm.seed} names={names} thinking={null} />);
    const status = getByRole('region', { name: 'Game status' });
    expect(status).toHaveTextContent(`Round ${vm.game.round + 1}`);
    expect(status).toHaveTextContent(`${vm.game.tilesLeft} tiles left`);
    expect(status).toHaveTextContent('First-player marker: in the centre');
  });

  it('[U3-33] says whose turn it is in words, not by colour alone', () => {
    const { getByRole } = render(() => <Status game={vm.game} seed={vm.seed} names={names} thinking={null} />);
    expect(getByRole('region', { name: 'Game status' })).toHaveTextContent(
      `Player ${vm.game.currentPlayer + 1} to move`,
    );
  });

  it('[U3-14] shows the seed the game was dealt from', () => {
    const { getByText } = render(() => <Status game={vm.game} seed={4242} names={names} thinking={null} />);
    expect(getByText('4242')).toBeInTheDocument();
  });

  it('[U3-34] shows bag and lid as per-colour counts', () => {
    const { getByRole } = render(() => <Status game={vm.game} seed={vm.seed} names={names} thinking={null} />);
    const status = getByRole('region', { name: 'Game status' });
    for (const color of names.keys()) {
      expect(status).toHaveTextContent(
        `bag ${vm.game.bag[color]}, lid ${vm.game.lid[color]}`,
      );
    }
  });

  it('[U3-36] takes every colour name from game.colorNames', () => {
    const posed = { ...vm.game, colorNames: ['aaa', 'bbb', 'ccc', 'ddd', 'eee'] };
    const { getByRole } = render(() => (
      <Status game={posed} seed={vm.seed} names={posed.colorNames} thinking={null} />
    ));
    const status = getByRole('region', { name: 'Game status' });
    for (const name of posed.colorNames) expect(status).toHaveTextContent(name);
  });
});

describe('a player board', () => {
  it('[U3-32] shows the score, and [U3-33] marks the player to move in words', () => {
    const { getByRole } = board();
    const section = getByRole('region', { name: 'Player 1' });
    expect(section).toHaveTextContent(`Score ${vm.game.players[0].score}`);
    expect(section).toHaveTextContent('To move');
    expect(section).toHaveAttribute('aria-current', 'true');
  });

  it('[U3-33] does not claim the waiting player is to move', () => {
    const { getByRole } = board({ toMove: false });
    const section = getByRole('region', { name: 'Player 1' });
    expect(section).toHaveTextContent('Waiting');
    expect(section).not.toHaveAttribute('aria-current');
  });

  it('[U3-35] shows completed rows, columns and colours', () => {
    const player = vm.game.players[0];
    const { getByRole } = board();
    expect(getByRole('region', { name: 'Player 1' })).toHaveTextContent(
      `Completed: ${player.completedRows} rows, ${player.completedCols} columns, ` +
        `${player.completedColors} colours`,
    );
  });

  it('[U3-37] [U3-36] names the colour of every wall cell, and says it is not yet placed', () => {
    const { getByRole } = board();
    const wall = within(getByRole('group', { name: 'Player 1 wall' }));
    // Every colour occupies exactly one cell in each of the five rows [0001 E1-1],
    // and at the opening none of them has been played.
    for (const name of names) {
      expect(wall.getAllByText(`${name}, not yet placed`)).toHaveLength(NUM_ROWS);
    }
  });

  it('[U3-36] tells a filled wall cell from an empty one without using colour', () => {
    const wall = vm.game.players[0].wall.map((row) => [...row]);
    wall[0][0] = 1;
    const { getByRole } = board({ player: { ...vm.game.players[0], wall } });
    const cells = within(getByRole('group', { name: 'Player 1 wall' }));
    const filled = names[wallColorAt(0, 0)];
    expect(cells.getAllByText(filled)).toHaveLength(1);
    expect(cells.getAllByText(`${filled}, not yet placed`)).toHaveLength(NUM_ROWS - 1);
  });

  it('[U3-37] puts each colour where wallColorAt says it belongs', () => {
    const { getByRole } = board();
    const expected: string[] = [];
    for (let r = 0; r < NUM_ROWS; r++) {
      for (let col = 0; col < NUM_COLORS; col++) expected.push(names[wallColorAt(r, col)]);
    }
    // Cells render in row-major DOM order and each names its colour, so pulling
    // the colour names out of the group in order is the wall read left to right,
    // top to bottom.
    const wall = getByRole('group', { name: 'Player 1 wall' });
    const read = (wall.textContent ?? '').match(new RegExp(names.join('|'), 'g'));
    expect(read).toEqual(expected);
  });
});

describe('the floor line', () => {
  const floorProps = {
    floor: [1, 0, 2, 0, 0],
    marker: true,
    occupied: 4,
    penalty: -6,
    names,
    label: 'Player 1 floor line',
  };

  it('[U3-38] shows the occupied slots and the penalty, both from the engine', () => {
    const { getByRole } = render(() => <FloorLine {...floorProps} />);
    const floor = getByRole('group', { name: 'Player 1 floor line' });
    expect(floor).toHaveTextContent('4 of 7 slots');
    expect(floor).toHaveTextContent('penalty -6');
  });

  it('[U3-38] lays tiles out marker first, then by colour in order 0..4', () => {
    const { getByRole } = render(() => <FloorLine {...floorProps} />);
    const text = getByRole('group', { name: 'Player 1 floor line' }).textContent ?? '';
    const order = [
      text.indexOf('first-player marker'),
      text.indexOf(names[0]),
      text.indexOf(names[2]),
    ];
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text.indexOf(names[1])).toBe(-1);
  });

  it('[U3-38] reports slots past the seventh, which cost nothing', () => {
    const { getByRole } = render(() => (
      <FloorLine {...floorProps} floor={[3, 3, 3, 0, 0]} occupied={10} penalty={-14} />
    ));
    expect(getByRole('group', { name: 'Player 1 floor line' })).toHaveTextContent(
      '3 beyond the last slot, costing nothing',
    );
  });
});

describe('a round transition', () => {
  const placed = Array.from({ length: NUM_ROWS * NUM_COLORS }, (_, i) => (i === 0 ? 1 : 0));

  /** A transition both fills the wall cell and marks it, so a stub must do both. */
  function tiled() {
    const wall = vm.game.players[0].wall.map((row) => [...row]);
    wall[0][0] = 1;
    return { ...vm.game.players[0], wall };
  }

  it('[U3-43] marks the newly-placed wall cells and shows the score change', () => {
    const { getByRole } = board({ placed, scoreDelta: 7, player: tiled() });
    const section = getByRole('region', { name: 'Player 1' });
    expect(section).toHaveTextContent('(+7 this round)');
    expect(within(getByRole('group', { name: 'Player 1 wall' })).getAllByText(
      `${names[wallColorAt(0, 0)]}, just placed`,
    )).toHaveLength(1);
  });

  it('[U3-43] shows a negative change as a loss, not as a gain', () => {
    const { getByRole } = board({ placed, scoreDelta: -3, player: tiled() });
    expect(getByRole('region', { name: 'Player 1' })).toHaveTextContent('(-3 this round)');
  });

  it('[U3-43] the marking clears on a ply that was not a transition', () => {
    const { getByRole } = board({ placed: null, scoreDelta: null, player: tiled() });
    const section = getByRole('region', { name: 'Player 1' });
    expect(section).not.toHaveTextContent('this round');
    expect(within(getByRole('group', { name: 'Player 1 wall' })).queryAllByText(/just placed/))
      .toHaveLength(0);
  });
});

describe('the end of a game', () => {
  it('[U3-44] declares the winner from game.outcome', () => {
    const { getByRole } = render(() => <GameOver game={endedGame()} names={names} />);
    const panel = getByRole('region', { name: 'Final result' });
    expect(panel).toHaveTextContent('Player 1 wins.');
  });

  it('[U3-44] declares the other player the winner when outcome is -1', () => {
    const game = endedGame({ outcome: -1, scores: [40, 50] });
    const { getByRole } = render(() => <GameOver game={game} names={names} />);
    expect(getByRole('region', { name: 'Final result' })).toHaveTextContent('Player 2 wins.');
  });

  it('[U3-44] reports a draw as a draw, not as a win', () => {
    const game = endedGame({ outcome: 0, scores: [45, 45] });
    const { getByRole } = render(() => <GameOver game={game} names={names} />);
    const panel = getByRole('region', { name: 'Final result' });
    expect(panel).toHaveTextContent('A draw.');
    expect(panel).not.toHaveTextContent('wins');
  });

  it('[U3-45] distinguishes an exhausted ending from an ordinary one', () => {
    const ordinary = render(() => <GameOver game={endedGame()} names={names} />);
    expect(ordinary.getByRole('region', { name: 'Final result' })).toHaveTextContent(
      'ended on a completed row',
    );
    const drained = render(() => (
      <GameOver game={endedGame({ exhausted: true })} names={names} />
    ));
    expect(drained.getByRole('region', { name: 'Final result' })).toHaveTextContent(
      'no tiles could be dealt',
    );
  });

  it('[U3-46] shows both final scores and each player’s completed counts', () => {
    const game = endedGame();
    const { getByRole } = render(() => <GameOver game={game} names={names} />);
    const panel = getByRole('region', { name: 'Final result' });
    for (const p of [0, 1]) {
      const player = game.players[p];
      expect(panel).toHaveTextContent(
        `Player ${p + 1}: ${player.score} points, ${player.completedRows} completed rows, ` +
          `${player.completedCols} completed columns, ${player.completedColors} completed colours`,
      );
    }
  });
});
