"""A reference for test:grzhx ([0013 G13-51]): their own search driven directly,
not through the host, on a manual game dealt the same tiles, so the host's
moves can be held to it.

Reads one JSON request on stdin and writes one JSON answer:

  {"mode": "pipeline", "settings": {...}, "seeds": [match, game, seat],
   "events": [["deal", tiles] | ["search", ply] | ["step", action], ...]}
      -> {"actions": [the native action at each "search", in order]}

  {"mode": "trees", "settings": {...}, "seed": n, "events": [...]}
      -> {"action": their evaluate_tree_counts vote at the end of the events}

Run with grzhx/host/venv.sh, beside host.py, whose seed mixing it uses.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'host'))
import host as H  # noqa: E402  — our host module, for `mix` and the settings' names


def main():
    req = json.load(sys.stdin)
    sys.path.insert(0, str(Path(req['repo']) / 'python'))
    import numpy as np
    import torch
    from azul import Batch
    from azul_ai.evaluate import load_actor
    from azul_ai.optimized_search import FrozenActor, PipelineSearch, Tuning
    from azul_ai.search import SearchConfig
    from azul_ai.search_decision import rank_search_actions

    torch.set_num_threads(1)
    actor = FrozenActor(load_actor(req['actor'], 'cpu'), 'cpu', bf16=False)
    r = req['settings']
    config = SearchConfig(simulations=int(r['simulations']), **{f: r[k] for k, f in H.KEYS_SEARCH.items()})
    tuning = Tuning(**{f: r[k] for k, f in H.KEYS_TUNING.items()})
    match_seed, game_seed, seat = req['seeds']
    env = Batch(1, threads=1, seed=0, library=req['library'])
    env.manual_reset(H.mix(H.DOMAIN_GAME, match_seed, game_seed, seat))
    deals = 0
    if req['mode'] == 'pipeline':
        search = PipelineSearch(env, actor, config, tuning, threads=1, queues=1, graphs=False)
        out = []
        for kind, value in req['events']:
            if kind == 'deal':
                env.manual_deal([int(t) for t in value])
                deals += 1
            elif kind == 'step':
                env.manual_step(int(value))
            else:
                actions, _, _ = search.run(H.mix(H.DOMAIN_MOVE, match_seed, game_seed, seat, int(value)), tree_version=deals)
                out.append(int(actions[0]))
        print(json.dumps({'actions': out}))
        return
    for kind, value in req['events']:
        if kind == 'deal':
            env.manual_deal([int(t) for t in value])
            deals += 1
        elif kind == 'step':
            env.manual_step(int(value))
    trees = int(r['trees'])
    copy = Batch(trees, threads=1, seed=0, library=req['library'])
    snapshot = env.snapshot(0)
    for t in range(trees):
        copy.restore(t, snapshot)
    search = PipelineSearch(copy, actor, config, tuning, threads=1, queues=1, graphs=False)
    actions, policies, _ = search.run(int(req['seed']), tree_version=deals)
    votes = np.zeros(180, np.int64)
    action, _, _ = rank_search_actions(actions[:trees], policies[:trees].mean(0), votes, limit=1)
    print(json.dumps({'action': int(action)}))


if __name__ == '__main__':
    main()
