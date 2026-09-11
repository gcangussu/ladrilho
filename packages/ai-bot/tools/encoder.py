"""The board encoder, in Python, from the same table as `src/board.ts` [A8-34].

This is how our positions are handed to the original's `valid_moves`,
`make_move` and `predict`. It is deliberately a second implementation of spec
0008's *Data model* table: [A8-35] compares the two, which catches a typo in
either, and [A8-12], [A8-36] and [A8-52] are the checks that do not depend on
both readers of the table having read it the same way.
"""

import numpy as np

ROWS, COLS = 23, 6


def encode(position: dict) -> np.ndarray:
    """The 23x6 int8 board, from the perspective of the seat to move."""
    board = np.zeros((ROWS, COLS), dtype=np.int8)
    me = position["currentPlayer"]
    seats = [position["players"][me], position["players"][1 - me]]

    board[0, 0] = min(seats[0]["score"], 127)
    board[0, 1] = min(seats[1]["score"], 127)
    board[0, 2] = position["round"] + 1

    board[1, :5] = position["bag"]
    floors = [position["players"][0]["floor"], position["players"][1]["floor"]]
    board[2, :5] = [position["lid"][c] + floors[0][c] + floors[1][c] for c in range(5)]
    board[3, :5] = position["center"]
    board[3, 5] = 1 if position["markerInCenter"] else 0
    for d in range(5):
        board[4 + d, :5] = position["factories"][d]

    for i, player in enumerate(seats):
        board[9 + i, :5] = [line["color"] for line in player["patternLines"]]
        board[9 + i, 5] = 1 if player["floorMarker"] else 0
        board[11 + i, :5] = [line["count"] for line in player["patternLines"]]
        board[11 + i, 5] = sum(player["floor"]) + (1 if player["floorMarker"] else 0)
        for r in range(5):
            board[13 + 5 * i + r, :5] = player["wall"][r]
    return board


def their_action(action: int) -> int:
    """Our action index to theirs: the centre moves from source 5 to source 0."""
    source = action // 30
    return ((source + 1) % 6) * 30 + action % 30
