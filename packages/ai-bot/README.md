# ai-bot — the expert


`packages/ai-bot` is a port of the AlphaZero-style Azul player in
[cestpasphoto/alpha-zero-general](https://github.com/cestpasphoto/alpha-zero-general) — its
network, its trained weights, its search (100 simulations a move) and the tree it keeps for a
whole game — onto this engine, as a fourth difficulty called `expert`. It lives beside `bot`
rather than inside it: `bot` is code we can read and explain, and weights we cannot are kept
apart from it. Spec 0008 has the details, including the fixtures that prove the port matches the
original move for move.

```bash
pnpm -F ai-bot test              # fast suite, including parity with the original's recorded outputs
pnpm -F ai-bot gate              # 200 games against `sharp`, plus the expert-vs-expert null; ~50 minutes
pnpm -F ai-bot fixtures          # re-record from the original Python program; needs `uv`. Deliberate
pnpm -F ai-bot weights           # regenerate src/weights.ts from the checkpoint. Deliberate
```

**It ships only if it beats `sharp`.** The gate plays it against `sharp` at shipped budgets and
passes at a winrate of 60% or more; a full run writes `packages/ai-bot/gate/baseline.json`,
which is committed whether it passed or not, and the interface offers `expert` if and only if
that file says `passed: true`.

**It does not pass today.** Its first gate won 72% (143 of 200), but that was measured against a
`sharp` whose root search could break a tie on an alpha-beta bound and play a strictly worse
move ([B4-30]). With that fixed, the rerun over the same seeds reads:

| | Winrate | Lower bound | W / L / D | Mean score (expert – `sharp`) |
| --- | --- | --- | --- | --- |
| First gate, old `sharp` | 72.0% | 66.5% | 143 / 55 / 2 | 43.5 – 36.4 |
| Rerun, fixed `sharp` | **45.0%** | 39.3% | 88 / 108 / 4 | 41.0 – 45.4 |

The null (expert against itself) is 42.75% both times. The expert is deterministic and did not
change, so the same player on the same deals going from 72% to 45% is the measure of how much
stronger the fix made `sharp` at its shipped budget — which the ladder, at reduced budgets and
with the fix in both of its players, cannot say. So `expert` is currently withdrawn from the interface, and a URL naming it
is discarded like any other unknown setting. The package, its suite and its gate stay, so a
stronger expert can be measured the same way.

The weights and the network are from alpha-zero-general (MIT, Surag Nair; the Azul port by
cestpasphoto); see [`LICENSE.alpha-zero-general`](LICENSE.alpha-zero-general).
