"""The recorded searches [A8-34]: what the original's MCTS did, call by call.

Three things are recorded for each whole-game sequence:

* the **as-shipped** search, exactly as `pit.py` runs it — numba compiled with
  `fastmath=True`, which licenses reassociation and fused operations whose
  rounding no fixed-order TypeScript loop can match;
* the **reference** search, the same code with its numba functions recompiled
  with `fastmath=False` and nothing else changed. That is what [A8-38] compares
  against exactly, because there is nothing legitimate left to differ;
* the same reference search with a node's `Qs` held in float64, to find the
  **float32 witness** — the first call whose visit counts move when that one
  type changes. Without a witness, [A8-44]'s row for it is struck and this
  manifest's statement is the record.

A sequence is one seat of one recorded game, with one `MCTS` object for the
whole game, as `pit.py` keeps one per player. Our recorded moves are played
whatever the original chooses, so each seat's sequence of positions is fixed in
advance and the tree carried between calls is exercised without the original
ever choosing a move.
"""

import struct

import numpy as np
from numba import njit


def make_reference(mcts_module):
    """The original's search with its numba functions rebuilt without fastmath.

    Returns a callable restoring the as-shipped ones. Nothing else changes:
    each function is recompiled from its own `py_func`, and
    `get_next_best_action_and_canonical_state` is rebuilt after its global
    `pick_highest_UCB` is replaced, because numba binds globals at compile
    time.
    """
    shipped = {
        name: getattr(mcts_module, name)
        for name in ("normalise", "np_roll", "pick_highest_UCB", "get_next_best_action_and_canonical_state")
    }
    mcts_module.normalise = njit(cache=False, fastmath=False, nogil=True)(shipped["normalise"].py_func)
    mcts_module.np_roll = njit(cache=False, fastmath=False, nogil=True)(shipped["np_roll"].py_func)
    mcts_module.pick_highest_UCB = njit(cache=False, fastmath=False, nogil=True)(
        shipped["pick_highest_UCB"].py_func
    )
    mcts_module.get_next_best_action_and_canonical_state = njit(fastmath=False, nogil=True)(
        shipped["get_next_best_action_and_canonical_state"].py_func
    )

    def restore():
        for name, function in shipped.items():
            setattr(mcts_module, name, function)

    return restore


def make_float64_qs(mcts_module):
    """`MCTS` with a node's `Qs` kept in float64 [A8-50], [A8-44].

    A transcription of `MCTS.search` at the pinned commit with exactly one
    change, marked below. It exists to answer whether the float32 `Qs` that
    NumPy 2 produces is observable in the visit counts at all.
    """

    class Float64Qs(mcts_module.MCTS):
        def search(self, canonicalBoard, dirichlet_noise=False, forced_playouts=False):
            s = self.game.stringRepresentation(canonicalBoard)
            Es, Vs, Ps, Ns, Qsa, Nsa, r, Qs = self.nodes_data.get(s, (None,) * 8)
            if r is None:
                r = self.game.getRound(canonicalBoard)

            if Es is None:
                Es = self.game.getGameEnded(canonicalBoard, 0)
                if Es.any():
                    self.nodes_data[s] = (Es, Vs, Ps, Ns, Qsa, Nsa, r, Qs)
                    return Es
            elif Es.any():
                return Es

            if Ps is None:
                Vs = self.game.getValidMoves(canonicalBoard, 0)
                Ps, v = self.nnet.predict(canonicalBoard, Vs)
                mcts_module.normalise(Ps)
                Ns, Qsa, Nsa = 0, self.Qsa_default.copy(), self.Nsa_default.copy()
                # THE ONE CHANGE: float64 where the original stores v[0],
                # which NumPy 2 keeps in float32.
                self.nodes_data[s] = (Es, Vs, Ps, Ns, Qsa, Nsa, r, np.float64(v[0]))
                return v

            a, next_s, next_player = mcts_module.get_next_best_action_and_canonical_state(
                Es, Vs, Ps, Ns, Qsa, Nsa, Qs,
                self.args.cpuct, self.game.board, canonicalBoard,
                forced_playouts, self.step, self.args.fpu, self.random_seed,
            )
            v = self.search(next_s)
            v = mcts_module.np_roll(v, next_player)

            Qsa[a] = (Nsa[a] * Qsa[a] + v[0]) / (Nsa[a] + 1)
            Qs = ((Ns + 1) * Qs + v[0]) / (Ns + 2)
            Nsa[a] += 1
            Ns += 1

            self.nodes_data[s] = (Es, Vs, Ps, Ns, Qsa, Nsa, r, Qs)
            return v

    return Float64Qs


class UniformPrior:
    """The stub network of [A8-34]: uniform `P` over legal actions, value 0.

    It produces exact ties in `u`, which is what [A8-44]'s `>` versus `>=`
    mutation needs to be visible at all.
    """

    def predict(self, board, valid_actions):
        valid = np.asarray(valid_actions, dtype=np.bool_)
        policy = np.zeros(180, dtype=np.float32)
        policy[valid] = np.float32(1.0 / int(valid.sum()))
        return policy, np.zeros(2, dtype=np.float32)


def hook_predict(net):
    """Records what the search asked the network, by board.

    The raw policy is captured here, before `MCTS.search` normalises it in
    place; the normalised one is read back from the node afterwards, so
    [A8-53] can check our normalisation against the original's rather than
    against itself.
    """
    evaluated = {}
    original = net.predict

    def predict(board, valid_actions):
        policy, value = original(board, valid_actions)
        evaluated[board.tobytes()] = {
            "board": np.array(board, dtype=np.int8),
            "raw": np.array(policy, dtype=np.float32),
            "value": np.array(value, dtype=np.float32),
        }
        return policy, value

    net.predict = predict
    return evaluated


def sequential_float32(values):
    """A float32 running total in index order, which is what numba's `sum`
    of a float32 array compiles to without `fastmath` [A8-50]."""
    total = np.float32(0)
    for value in values:
        total = np.float32(total + value)
    return total


def run_sequence(game, mcts, encode, positions, evaluated, collect_nodes=True, verify=False):
    """One seat of one game: every call, with its counts, choice and nodes."""
    calls = []
    for record in positions:
        board = encode(record["position"])
        evaluated.clear()
        mcts.getActionProb(board, temp=1, force_full_search=True)
        key = game.stringRepresentation(board)
        node = mcts.nodes_data[key]
        counts = np.asarray(node[5], dtype=np.int64)
        # The first-index maximum [A8-24], never `pit.py`'s pick, which is
        # random on a `late-tie`.
        chosen = int(np.argmax(counts))

        nodes = []
        deviations = set()
        for node_key, seen in evaluated.items():
            board_seen = seen["board"]
            # What the original's boards say and ours cannot: an uncapped
            # floor count, and a score that wrapped through 8 bits.
            if board_seen[11, 5] > 7 or board_seen[12, 5] > 7:
                deviations.add("floor-overflow")
            if board_seen[0, 0] < 0 or board_seen[0, 1] < 0:
                deviations.add("score-wrap")
            # `no-centre-take` needs a whole round in which neither seat takes
            # from the centre, which needs every display monochrome so that no
            # take ever leaves a remainder there. That is a property of a
            # round's opening board, and it is detected here as exactly that
            # necessary condition: over-reporting a call costs only a shorter
            # compared prefix, where under-reporting would compare two trees
            # that have already diverged.
            displays = board_seen[4:9, :5]
            monochrome = all(int(np.count_nonzero(display)) == 1 for display in displays)
            if monochrome and board_seen[3, 5] == 1 and not board_seen[3, :5].any():
                deviations.add("no-centre-take")
            if not collect_nodes:
                continue
            stored = mcts.nodes_data.get(node_key)
            if stored is None or stored[2] is None:
                continue  # expanded and then pruned, or terminal
            if verify:
                # The reference search normalises with numba's `sum` compiled
                # without `fastmath`. If what the node holds is not that, the
                # recording is not of the reference search, and every exact
                # comparison built on it would be measuring the wrong run.
                expected = (seen["raw"] / sequential_float32(seen["raw"])).astype(np.float32)
                if not np.array_equal(np.asarray(stored[2], dtype=np.float32), expected):
                    raise AssertionError(
                        "the recorded prior is not the reference search's: "
                        f"stored {np.asarray(stored[2])[:3]} vs sequential {expected[:3]}"
                    )
            nodes.append(
                {
                    "board": board_seen,
                    "legal": [int(i) for i in np.flatnonzero(np.asarray(stored[1]))],
                    "raw": seen["raw"],
                    "normalised": np.array(stored[2], dtype=np.float32),
                    "value": seen["value"],
                }
            )

        calls.append(
            {
                "ply": record["ply"],
                "counts": counts,
                "chosen": chosen,
                "qs": float(node[7]),
                "qsType": type(node[7]).__name__,
                "deviations": sorted(deviations),
                "nodes": nodes,
            }
        )
    return calls


def pack_nodes(nodes):
    """Every evaluated node, as the four binary files [A8-38], [A8-53]."""
    boards, legal, raw, normalised, values = bytearray(), bytearray(), bytearray(), bytearray(), bytearray()
    for node in nodes:
        indices = node["legal"]
        boards += node["board"].tobytes()
        legal += struct.pack("<B", len(indices)) + bytes(indices)
        raw += struct.pack(f"<{len(indices)}f", *[float(node["raw"][i]) for i in indices])
        normalised += struct.pack(f"<{len(indices)}f", *[float(node["normalised"][i]) for i in indices])
        values += struct.pack("<2f", *[float(x) for x in node["value"]])
    return {
        "boards": bytes(boards),
        "legal": bytes(legal),
        "raw": bytes(raw),
        "normalised": bytes(normalised),
        "values": bytes(values),
    }
