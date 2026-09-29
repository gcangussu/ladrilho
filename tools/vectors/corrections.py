"""Corrections to the oracle, one per ruling that found it wrong [0010 C10-32].

A correction is a small, named change to the oracle's *code* — a method or a
function replaced for the life of one recording, the way `dump_vectors.py`
already replaces `random.Random.shuffle` — and never an edit to a value after
the oracle produced it: a fixture is still the oracle's opinion, of the oracle
as corrected [0002 V2-10].

Every correction is installed for every vector the generator writes, and every
such vector lists them all in `generator.corrections` [0010 C10-33]. Each names
its ruling and its witness — the found vector recorded from that ruling's
disagreement — and the generator refuses to write anything if the witness comes
out the same with the correction removed [0010 C10-34]: that is a correction
the oracle no longer needs, or one that no longer reaches the code it names.

There are none yet. A new one looks like:

    def _ruling_1_marker(engine):
        original = engine.AzulState._end_round
        def corrected(self): ...
        engine.AzulState._end_round = corrected
        return lambda: setattr(engine.AzulState, "_end_round", original)

    CORRECTIONS.append(Correction("ruling-1-marker", 1, "found-01-marker", _ruling_1_marker))
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class Correction:
    #: `ruling-N-slug`, as the ruling's *Oracle* line names it.
    name: str
    #: The ruling's number in spec 0010's *Rulings*.
    ruling: int
    #: The found vector the correction is witnessed by, without `.json`.
    witness: str
    #: Patches the oracle module and returns the function that undoes it.
    install: Callable[[Any], Callable[[], None]]


CORRECTIONS: list[Correction] = []
