#!/usr/bin/env python3
"""Generate the engine conformance vectors from the ludometer oracle [0002 V2-9].

This script is the *only* thing permitted to write to
`packages/engine/test/vectors/`. Vectors are never hand-edited: a wrong vector
is a bug in here or a real disagreement, and editing one by hand hides both.

Usage:

    python tools/vectors/dump_vectors.py --ludometer <checkout> \\
        --out packages/engine/test/vectors

See `tools/vectors/README.md` for how to recreate the checkout.

Two rules shape everything below.

* [V2-10] Every recorded value is the oracle's opinion. The script reads the
  oracle's accessors where they exist and its documented state attributes
  otherwise; it never re-derives a score, a legal-action list or a tile total
  in Python. The one exception the spec grants is `shufflesUsed` [V2-32],
  which the oracle has no counter for — it is the length of the shuffle log
  kept by the patch below, i.e. a count of interceptions this script made.
* [V2-11] Regeneration is reproducible: the same checkout and the same seeds
  produce byte-identical files. Nothing here reads the clock — `generatedAt`
  is the ludometer commit's own date.
"""

from __future__ import annotations

import argparse
import json
import random
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

# --------------------------------------------------------------------------
# The shuffle patch [V2-10], [V2-32].
#
# The oracle consumes randomness in exactly one place — `random.Random.shuffle`
# on the bag, at `new_game` and at every lid recycle. Intercepting it records
# the resulting order (which is what a vector replays, [V2-2]) and counts the
# calls (which is what `shufflesUsed` is, [V2-32]). The patch is installed
# before the engine is imported and stays for the life of the process; this is
# a single-purpose generator script, and nothing else in it shuffles.
# --------------------------------------------------------------------------

SHUFFLE_LOG: list[list[int]] = []
_ORIGINAL_SHUFFLE = random.Random.shuffle


def _recording_shuffle(self: random.Random, x: list[Any]) -> None:
    _ORIGINAL_SHUFFLE(self, x)
    SHUFFLE_LOG.append(list(x))


random.Random.shuffle = _recording_shuffle  # type: ignore[method-assign]

SCHEMA = 1
REPO = "RemiFabre/ludometer"
SCRIPT = "tools/vectors/dump_vectors.py"
MAX_PLIES = 400  # a lawful two-player game runs ~70; this is a runaway guard

# Filled in by `main` once the checkout is on `sys.path`.
engine: Any = None


# --------------------------------------------------------------------------
# Reading the oracle
# --------------------------------------------------------------------------


def canonical(s: Any, shuffle_base: int) -> dict[str, Any]:
    """The oracle's state in the port's canonical form [V2-5], [0001 E1-62].

    Field order matches the data model in *0001 — Engine core*, which is what
    `toCanonical` emits; every value is copied straight off the oracle. Only
    `shufflesUsed` is not an oracle attribute [V2-32]: it is the number of
    shuffles intercepted since `shuffle_base`, so a position fixture rebases
    to zero [V2-33] and a game vector (base 0) counts the creation shuffle.
    """
    return {
        "factories": [f[:] for f in s.factories],
        "center": s.center[:],
        "markerInCenter": bool(s.marker_in_center),
        "bag": s.bag[:],
        "lid": s.lid[:],
        "walls": [w[:] for w in s.walls],
        "plColor": [x[:] for x in s.pl_color],
        "plCount": [x[:] for x in s.pl_count],
        "floor": [f[:] for f in s.floor],
        "floorMarker": [bool(b) for b in s.floor_marker],
        "scores": s.scores[:],
        "currentPlayer": s.current_player,
        "firstPlayer": s.first_player,
        "roundIndex": s.round_index,
        "tilesLeft": s.tiles_left,
        "shufflesUsed": len(SHUFFLE_LOG) - shuffle_base,
        "isTerminal": bool(s.is_terminal),
        "exhausted": bool(s.exhausted),
    }


def final_block(s: Any) -> dict[str, Any]:
    """`scores`, `outcome` and `exhausted`, all read from the oracle."""
    result = s.outcome()
    return {
        "scores": s.scores[:],
        # `outcome()` is a float in Python (+1.0 / 0.0 / -1.0) and an integer
        # in the port; the value is the oracle's, the type is the port's.
        "outcome": None if result is None else int(result),
        "exhausted": bool(s.exhausted),
    }


# --------------------------------------------------------------------------
# Move policies [V2-14]
#
# Each returns one action from `legal`. Every steered policy falls back to a
# uniform pick on the plies where it has no opinion — the centre is empty at
# the start of every round, so a policy without a fallback has nothing to say.
# --------------------------------------------------------------------------

Policy = Callable[[Any, list[int], random.Random], int]


def uniform(s: Any, legal: list[int], pick: random.Random) -> int:
    return pick.choice(legal)


def biggest_pile(s: Any, legal: list[int], pick: random.Random) -> int:
    """Always take the largest pile available."""

    def size(action: int) -> int:
        source, rest = divmod(action, 30)
        color = rest // 6
        pool = s.center if source == engine.CENTER else s.factories[source]
        return pool[color]

    best = max(size(a) for a in legal)
    return pick.choice([a for a in legal if size(a) == best])


def centre_first(s: Any, legal: list[int], pick: random.Random) -> int:
    """Always take from the centre while it holds anything."""
    from_centre = [a for a in legal if a // 30 == engine.CENTER]
    return pick.choice(from_centre if from_centre else legal)


def avoid_marker(s: Any, legal: list[int], pick: random.Random) -> int:
    """Never take the first-player marker until forced to."""
    if s.marker_in_center:
        safe = [a for a in legal if a // 30 != engine.CENTER]
        if safe:
            return pick.choice(safe)
    return pick.choice(legal)


def prefer_lines(s: Any, legal: list[int], pick: random.Random) -> int:
    """Fill pattern lines rather than the floor.

    Only used by the short-census position, where tiles have to leave
    circulation for the bag and lid to run dry at all.
    """
    lines = [a for a in legal if a % 6 != engine.FLOOR]
    return pick.choice(lines if lines else legal)


GAME_POLICIES: list[Policy] = [uniform, biggest_pile, centre_first, avoid_marker]


# --------------------------------------------------------------------------
# Recording
# --------------------------------------------------------------------------


def record_plies(
    s: Any,
    shuffle_base: int,
    choose: Callable[[Any, list[int]], int],
    limit: int,
) -> list[dict[str, Any]]:
    """Play up to `limit` plies, recording the legal list, the action and the
    resulting state [V2-1], [V2-7]."""
    plies: list[dict[str, Any]] = []
    while not s.is_terminal and len(plies) < limit:
        legal = s.legal_actions()
        action = choose(s, legal)
        if action not in legal:
            raise AssertionError(f"scripted action {action} is not legal")
        s.apply(action)
        plies.append(
            {"action": action, "legal": legal, "state": canonical(s, shuffle_base)}
        )
    return plies


def build_vector(
    kind: str,
    generator: dict[str, Any],
    initial: dict[str, Any],
    shuffle_base: int,
    plies: list[dict[str, Any]],
    s: Any,
    note: str | None = None,
    census: str | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {"schema": SCHEMA, "kind": kind, "generator": generator}
    if note is not None:
        out["note"] = note
    if census is not None:
        out["census"] = census
    out["shuffles"] = [x[:] for x in SHUFFLE_LOG[shuffle_base:]]
    out["initial"] = initial
    out["plies"] = plies
    out["final"] = final_block(s)
    return out


def provenance(
    commit: str, date: str | None, python_seed: int, policy: str | None = None
) -> dict[str, Any]:
    gen: dict[str, Any] = {
        "repo": REPO,
        "commit": commit,
        "script": SCRIPT,
        "pythonSeed": python_seed,
    }
    if policy is not None:
        # Beyond the field list sketched in [V2-37], which requires these
        # fields without forbidding others. It is recorded because [V2-14] is
        # a claim about *how* a vector was generated, and without it the suite
        # can only assert a proxy for steering rather than steering itself.
        gen["policy"] = policy
    if date is not None:
        # [V2-11] the ludometer commit's date, never the clock.
        gen["generatedAt"] = date
    return gen


# --------------------------------------------------------------------------
# Full games [V2-13], [V2-14], [V2-15]
# --------------------------------------------------------------------------


def make_game(seed: int, policy: Policy, commit: str, date: str | None) -> dict[str, Any]:
    SHUFFLE_LOG.clear()
    s = engine.AzulState.new_game(seed)  # the creation shuffle is index 0 [V2-36]
    initial = canonical(s, 0)
    pick = random.Random(0xA2 * 1000 + seed)
    plies = record_plies(s, 0, lambda st, legal: policy(st, legal, pick), MAX_PLIES)
    if not s.is_terminal:
        raise AssertionError(f"game seed {seed} did not finish in {MAX_PLIES} plies")
    if s.exhausted:
        # [V2-15] there is no other lawful ending; exhaustion is unreachable
        # from a full census [0001 E1-37].
        raise AssertionError(f"game seed {seed} ended by exhaustion")
    return build_vector(
        "game",
        provenance(commit, date, seed, policy.__name__),
        initial,
        0,
        plies,
        s,
    )


# --------------------------------------------------------------------------
# Handcrafted positions [V2-16], [V2-17]
#
# Each is posed by writing the oracle's own documented state attributes and
# then calling its `recount()`, which is how *0001 E1-5* says a hand-edited
# position is made consistent. The port never sees any of that: it loads the
# recorded snapshot through `fromCanonical` [V2-3], [V2-36].
# --------------------------------------------------------------------------

POSE_SEED = 0


def pose() -> Any:
    """A blank, lawful, empty position to build on.

    `new_game` shuffles once before we overwrite everything, which is why a
    position fixture rebases `shufflesUsed` [V2-33]: the un-rebased value here
    is always 1, and a vector recording 1 would make a *correct* engine ask for
    `shuffles[1]` at its first lid recycle.
    """
    s = engine.AzulState.new_game(POSE_SEED)
    s.factories = [[0] * 5 for _ in range(5)]
    s.center = [0] * 5
    s.marker_in_center = True
    s.bag = []
    s.lid = [0] * 5
    s.walls = [[0] * 25 for _ in range(2)]
    s.pl_color = [[-1] * 5 for _ in range(2)]
    s.pl_count = [[0] * 5 for _ in range(2)]
    s.floor = [[0] * 5 for _ in range(2)]
    s.floor_marker = [False, False]
    s.scores = [0, 0]
    s.current_player = 0
    s.first_player = 0
    s.round_index = 0
    s.is_terminal = False
    s.exhausted = False
    s.recount()
    return s


def top_up_bag(s: Any) -> None:
    """Add tiles to the bag until the oracle reports a full census.

    The deficit comes from the oracle's own `tile_census()` against the
    documented `TILES_PER_COLOR`; the colours are then interleaved so a posed
    position deals a mixed board rather than five monochrome displays. Choosing
    a fixture's bag is authoring, not the deriving [V2-10] forbids — and the
    result is read back off the oracle like every other recorded field.
    """
    need = [engine.TILES_PER_COLOR - n for n in s.tile_census()]
    if min(need) < 0:
        raise AssertionError(f"posed position holds more than 20 of a colour: {need}")
    while any(need):
        for c in range(engine.NUM_COLORS):
            if need[c]:
                s.bag.append(c)
                need[c] -= 1
    s.recount()
    if s.tile_census() != [engine.TILES_PER_COLOR] * engine.NUM_COLORS:
        raise AssertionError(f"census after top-up: {s.tile_census()}")


def scripted(actions: list[int], then: Policy, pick: random.Random) -> Callable[[Any, list[int]], int]:
    """Play `actions` in order, then hand over to `then`."""
    remaining = list(actions)

    def choose(s: Any, legal: list[int]) -> int:
        if remaining:
            return remaining.pop(0)
        return then(s, legal, pick)

    return choose


def act(source: int, color: int, dest: int) -> int:
    """The oracle's own action encoding [0001 E1-6]."""
    return engine.encode_action(source, color, dest)


def make_position(
    name: str,
    note: str,
    build: Callable[[], Any],
    actions: list[int],
    extra: int,
    commit: str,
    date: str | None,
    census: str | None = None,
    then: Policy = uniform,
    play_seed: int = 0xB2,
) -> tuple[str, dict[str, Any]]:
    SHUFFLE_LOG.clear()
    s = build()
    base = len(SHUFFLE_LOG)  # the pose's own shuffle is not the fixture's [V2-33]
    initial = canonical(s, base)
    pick = random.Random(play_seed)
    plies = record_plies(s, base, scripted(actions, then, pick), len(actions) + extra)
    return name, build_vector(
        "position",
        provenance(commit, date, POSE_SEED),
        initial,
        base,
        plies,
        s,
        note=note,
        census=census,
    )


# --- the seven positions [V2-16] ------------------------------------------


def pos_two_runs() -> Any:
    s = pose()
    wall = s.walls[0]
    for row, col in ((2, 1), (2, 3), (1, 2), (3, 2)):
        wall[row * 5 + col] = 1
    # Colour 0 in row 2 lands on (2, 2) — between (2,1)/(2,3) and (1,2)/(3,2).
    s.pl_color[0][2] = 0
    s.pl_count[0][2] = 3
    s.factories[0][3] = 1
    s.factories[1][4] = 2
    top_up_bag(s)
    return s


def pos_cascade() -> Any:
    s = pose()
    # Row 0 holds colour 1 -> cell (0, 1); row 1 holds colour 0 -> cell (1, 1).
    # Row 1 scores 2 only because row 0 resolved first.
    s.pl_color[0][0] = 1
    s.pl_count[0][0] = 1
    s.pl_color[0][1] = 0
    s.pl_count[0][1] = 2
    s.factories[0][2] = 1
    s.factories[1][2] = 1
    top_up_bag(s)
    return s


def pos_overfull_floor() -> Any:
    s = pose()
    s.floor[0] = [3, 2, 2, 0, 0]  # seven tiles, no marker yet
    s.floor[1] = [5, 0, 0, 0, 0]
    s.marker_in_center = True
    s.center[1] = 1
    s.factories[0][2] = 4
    s.factories[1][3] = 4
    s.scores[0] = 20
    top_up_bag(s)
    return s


def pos_clamped_penalty() -> Any:
    s = pose()
    s.scores[0] = 3
    s.floor[0] = [7, 0, 0, 0, 0]
    s.factories[0][1] = 2
    s.factories[1][2] = 2
    top_up_bag(s)
    return s


SHORT_COMPOSE_SEED = 301
SHORT_PLAY_SEED = 2108


def pos_short_census() -> Any:
    """Bag and lid both empty at a refill — the only fixture with a short census.

    The composition is a fixed pair of seeds, found once by search and pinned
    here so regeneration is reproducible [V2-11]. Reaching a refill with both
    bag and lid empty *requires* a census below 100 [0001 E1-37]; with a full
    one there are always at least 40 tiles in bag + lid at a refill.
    """
    rng = random.Random(SHORT_COMPOSE_SEED)
    counts = [0] * engine.NUM_COLORS
    for _ in range(rng.randrange(24, 44)):
        counts[rng.randrange(engine.NUM_COLORS)] += 1
    tiles = [c for c in range(engine.NUM_COLORS) for _ in range(counts[c])]
    # `sample` rather than `shuffle`: the patch above must only ever see the
    # oracle's own shuffles [V2-32].
    tiles = rng.sample(tiles, len(tiles))
    s = pose()
    for i in range(engine.NUM_FACTORIES):
        for k in range(engine.FACTORY_SIZE):
            s.factories[i][tiles[i * engine.FACTORY_SIZE + k]] += 1
    s.bag = tiles[engine.NUM_FACTORIES * engine.FACTORY_SIZE :]
    s.recount()
    return s


def pos_untouched_centre() -> Any:
    s = pose()
    for i in range(engine.NUM_FACTORIES):
        s.factories[i][i] = 4  # every display monochrome: nothing ever reaches the centre
    top_up_bag(s)
    return s


def pos_column_and_colour() -> Any:
    s = pose()
    wall = s.walls[0]
    for col in (1, 2, 3, 4):
        wall[col] = 1  # row 0, all but colour 0's cell
    for r in (1, 2, 3, 4):
        wall[r * 5] = 1  # column 0
        wall[r * 5 + r] = 1  # colour 0's cells in rows 1..4
    s.pl_color[0][0] = 0
    s.pl_count[0][0] = 1
    s.factories[0][1] = 1
    s.factories[1][2] = 1
    top_up_bag(s)
    return s


def positions(commit: str, date: str | None) -> list[tuple[str, dict[str, Any]]]:
    fl = 5  # FLOOR destination
    return [
        make_position(
            "position-01-two-runs",
            "A tile that joins a horizontal and a vertical run at once [0001 E1-24]: "
            "colour 0 resolves into (2,2) with (2,1)/(2,3) and (1,2)/(3,2) already "
            "placed, so it scores 3 + 3 rather than 1.",
            pos_two_runs,
            [act(0, 3, fl), act(1, 4, fl)],
            6,
            commit,
            date,
        ),
        make_position(
            "position-02-cascade",
            "Two pattern lines resolving top-down, the later scoring off the earlier "
            "[0001 E1-25]: row 0 places colour 1 at (0,1), then row 1 places colour 0 "
            "at (1,1) and scores 2 for the vertical run row 0 just created.",
            pos_cascade,
            [act(0, 2, fl), act(1, 2, fl)],
            6,
            commit,
            date,
        ),
        make_position(
            "position-03-overfull-floor",
            "A floor pushed past seven occupied slots while the marker is held "
            "[0001 E1-20], [0001 E1-26], [0001 E1-27]: player 0 has seven floor tiles "
            "and then takes the marker, so occupancy reaches 8, the extra tile goes "
            "straight to the lid, and the penalty stops at the seventh slot (-14). "
            "Player 1's take of four onto a five-slot floor exercises the partial "
            "spill in the same round.",
            pos_overfull_floor,
            [act(5, 1, fl), act(0, 2, fl), act(1, 3, fl)],
            6,
            commit,
            date,
        ),
        make_position(
            "position-04-clamped-penalty",
            "A penalty far larger than the score [0001 E1-28]: player 0 holds a full "
            "floor against a score of 3, so the round ends at 0 rather than -11, and "
            "no debt carries into the next round.",
            pos_clamped_penalty,
            [act(0, 1, fl), act(1, 2, fl)],
            8,
            commit,
            date,
        ),
        make_position(
            "position-05-empty-bag-and-lid",
            "Bag and lid running dry [0001 E1-33], [0001 E1-34], [0001 E1-37]. Short "
            "census by necessity, not by accident: at any refill of a lawfully dealt "
            "game at least 40 tiles sit in bag + lid, so a refill that deals nothing "
            "is reachable only from a census below 100 [0001 E1-37]. This fixture "
            "holds far fewer, and runs three round transitions — a lid recycle that "
            "shuffles, then a deal that stops part-way and leaves displays short, "
            "then a refill that deals nothing at all and ends the game with "
            "`exhausted` set.",
            pos_short_census,
            [],
            120,
            commit,
            date,
            census="short",
            then=prefer_lines,
            play_seed=SHORT_PLAY_SEED,
        ),
        make_position(
            "position-06-untouched-centre",
            "A round in which nobody takes from the centre [0001 E1-31]: every display "
            "is monochrome, so no tile is ever pushed into the centre and the marker "
            "never leaves it. The next round starts with the player who did not move "
            "last, preserving alternation.",
            pos_untouched_centre,
            [act(0, 0, 3), act(1, 1, 3), act(2, 2, fl), act(3, 3, fl), act(4, 4, fl)],
            6,
            commit,
            date,
        ),
        make_position(
            "position-07-column-and-colour",
            "The end-of-game bonuses [0001 E1-38]: one tile completes wall row 0, "
            "column 0 and colour 0 at once, ending the game and scoring 2 + 7 + 10 on "
            "top of the round's 10 for the two five-long runs.",
            pos_column_and_colour,
            [act(0, 1, fl), act(1, 2, fl)],
            0,
            commit,
            date,
        ),
    ]


# --------------------------------------------------------------------------
# Writing
# --------------------------------------------------------------------------


def write_vector(path: Path, vec: dict[str, Any]) -> None:
    """One JSON file, laid out so a human can find a ply when a test fails.

    Top-level fields go one per line and each shuffle and each ply gets its own
    line; everything is otherwise compact, because a pretty-printed full state
    per ply would multiply the repository by ten. Emission is deterministic:
    dictionary order is insertion order, and no value here is a float.
    """
    items = list(vec.items())
    out: list[str] = ["{"]
    for i, (key, value) in enumerate(items):
        tail = "," if i < len(items) - 1 else ""
        head = f"  {json.dumps(key)}: "
        if key in ("shuffles", "plies"):
            if not value:
                out.append(f"{head}[]{tail}")
                continue
            out.append(f"{head}[")
            for j, element in enumerate(value):
                comma = "," if j < len(value) - 1 else ""
                out.append("    " + json.dumps(element, separators=(",", ":")) + comma)
            out.append(f"  ]{tail}")
        else:
            out.append(head + json.dumps(value, separators=(",", ":")) + tail)
    out.append("}")
    path.write_text("\n".join(out) + "\n", encoding="utf-8")


def git_field(checkout: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(checkout), *args],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--ludometer", required=True, type=Path, help="path to a ludometer checkout"
    )
    parser.add_argument(
        "--out", required=True, type=Path, help="output directory for the vector files"
    )
    parser.add_argument(
        "--games", type=int, default=30, help="number of full-game vectors [V2-13]"
    )
    parser.add_argument(
        "--commit", default=None, help="override the recorded oracle revision [V2-12]"
    )
    parser.add_argument(
        "--date", default=None, help="override the recorded commit date [V2-11]"
    )
    args = parser.parse_args(argv)

    checkout: Path = args.ludometer.resolve()
    if not (checkout / "ludometer" / "azul" / "engine.py").is_file():
        parser.error(f"{checkout} does not look like a ludometer checkout")
    sys.path.insert(0, str(checkout))

    global engine
    import ludometer.azul.engine as engine_module  # noqa: PLC0415

    engine = engine_module

    commit = args.commit or git_field(checkout, "rev-parse", "HEAD")
    date = args.date or git_field(checkout, "show", "-s", "--format=%cd", "--date=short", "HEAD")

    out_dir: Path = args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("*.json"):
        stale.unlink()

    written = 0
    for seed in range(args.games):
        policy = GAME_POLICIES[seed % len(GAME_POLICIES)]
        vec = make_game(seed, policy, commit, date)
        write_vector(out_dir / f"game-{seed:02d}.json", vec)
        written += 1
        print(
            f"game-{seed:02d}  {policy.__name__:<13} "
            f"plies {len(vec['plies']):>3}  shuffles {len(vec['shuffles'])}  "
            f"scores {vec['final']['scores']}"
        )

    for name, vec in positions(commit, date):
        write_vector(out_dir / f"{name}.json", vec)
        written += 1
        print(
            f"{name:<34} plies {len(vec['plies']):>3}  "
            f"shuffles {len(vec['shuffles'])}  scores {vec['final']['scores']}"
        )

    print(f"wrote {written} vectors to {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
