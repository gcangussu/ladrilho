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


PATCHED = ("normalise", "np_roll", "pick_highest_UCB", "get_next_best_action_and_canonical_state")


def build_reference(mcts_module):
    """The original's numba functions rebuilt with `fastmath=False`.

    Compiled **here, before anything fastmath has compiled in this process**,
    and that ordering is load-bearing. On a cold numba cache, building a
    fastmath=False dispatcher from a `py_func` whose fastmath=True twin has
    already compiled in the same process can yield fastmath code anyway: the
    generator once recorded, and labelled as the reference search's, priors
    that were the as-shipped search's, and it stopped happening the moment the
    on-disk cache was warm. `verify=True` in {@link run_sequence} is what
    caught it and is the reason it exists; do not remove either.

    Returns the three dispatchers `MCTS.search` reaches directly, already
    compiled on representative arguments. The fourth patched function,
    `get_next_best_action_and_canonical_state`, is **not** covered — see
    {@link install_reference} for why it cannot be.
    """
    reference = {
        name: njit(cache=False, fastmath=False, nogil=True)(getattr(mcts_module, name).py_func)
        for name in ("normalise", "np_roll", "pick_highest_UCB")
    }
    reference["normalise"](np.ones(180, dtype=np.float32))
    reference["np_roll"](np.zeros(2, dtype=np.float32), 1)
    reference["pick_highest_UCB"](*sample_ucb_arguments())
    return reference


def sample_ucb_arguments(valid=None, priors=None, visits=0, counts=None, qsa=None, qs=0.0, n_iter=1):
    """Arguments `pick_highest_UCB` accepts, for compiling and for comparing."""
    Vs = np.zeros(180, dtype=np.bool_) if valid is None else valid
    if valid is None:
        Vs[:8] = True
    Ps = (np.ones(180, dtype=np.float32) / 180) if priors is None else priors
    Nsa = np.zeros(180, dtype=np.int64) if counts is None else counts
    Qsa = np.full(180, -42.0, dtype=np.float64) if qsa is None else qsa
    return (
        np.zeros(2, dtype=np.float32),  # Es
        Vs, Ps, visits, Qsa, Nsa, np.float32(qs),
        0.5,       # cpuct
        True,      # forced_playouts
        n_iter,
        0.05,      # fpu
    )


def install_reference(mcts_module, reference):
    """Swap the reference dispatchers in; returns a callable putting them back.

    `get_next_best_action_and_canonical_state` is rebuilt here rather than in
    {@link build_reference} because numba binds globals at compile time, and
    the global it needs is the reference `pick_highest_UCB` installed below.

    So it is the one patched function outside that ordering guarantee: it
    compiles after the as-shipped run has compiled its fastmath twin, and it is
    the only one that calls `pick_highest_UCB` during a search. What stands in
    for the guarantee there is measurement rather than ordering — the manifest
    records that the two builds of `pick_highest_UCB` choose alike over the
    recorded nodes ({@link pick_agreement}), and a cold-cache regeneration
    reproduced every recorded byte.
    """
    shipped = {name: getattr(mcts_module, name) for name in PATCHED}
    for name, function in reference.items():
        setattr(mcts_module, name, function)
    mcts_module.get_next_best_action_and_canonical_state = njit(fastmath=False, nogil=True)(
        shipped["get_next_best_action_and_canonical_state"].py_func
    )

    def restore():
        for name, function in shipped.items():
            setattr(mcts_module, name, function)

    return restore


def pick_agreement(shipped_pick, reference_pick, nodes, patterns=6):
    """Do the two builds of `pick_highest_UCB` choose the same action?

    Recorded in the manifest so that `seq-counts-reference.u16` and
    `seq-counts-shipped.u16` being byte-identical is evidence rather than a
    coincidence nobody checked: `verify` covers `normalise` only, and the same
    fastmath leak could in principle reach selection.
    """
    agreed = total = 0
    for index, node in enumerate(nodes):
        valid = np.zeros(180, dtype=np.bool_)
        valid[node["legal"]] = True
        priors = np.asarray(node["normalised"], dtype=np.float32)
        for pattern in range(patterns):
            counts = np.zeros(180, dtype=np.int64)
            qsa = np.full(180, -42.0, dtype=np.float64)
            visits = pattern * 7
            for position, action in enumerate(node["legal"]):
                if (position + index) % (pattern + 2) == 0:
                    counts[action] = 1 + (position % 3)
                    qsa[action] = ((position + pattern) % 11) / 10.0 - 0.5
            arguments = sample_ucb_arguments(
                valid=valid, priors=priors, visits=visits, counts=counts, qsa=qsa,
                qs=((index + pattern) % 7) / 10.0 - 0.3, n_iter=pattern * 13,
            )
            total += 1
            agreed += int(shipped_pick(*arguments) == reference_pick(*arguments))
    return {"cases": total, "agreed": agreed}


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
            # A score past 127 shows here as a negative one. The other arm of
            # that row — a wrap that `score_round`'s max(score - penalty, 0)
            # clamps back to 0 in the same call — leaves a non-negative score
            # and is not detected. It would not hide a difference: [A8-38]
            # would compare diverged trees and fail loudly. These games score
            # nowhere near 128.
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
