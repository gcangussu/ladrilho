"""The host ([0013 G13-8] to [G13-13], [G13-17], [G13-24], [G13-25], [G13-28]).

Our program, not theirs: it puts their cached `python/` directory on the
import path and drives their own modules and their library's exported
functions, unchanged. It speaks line-delimited JSON on stdin and stdout, one
request then one answer, and writes nothing else to stdout.

Per game it keeps a *lockstep* game: their manual game, dealt only the tiles
our engine dealt and stepped only by the moves played, which their search
plays on. At every ply it also imports our position into a scratch
environment and compares the two, so a translation or rules difference is
found where it happens.

    venv.sh grzhx/host/host.py --repo <cache>/repo --library <libazul> \\
        --actor <actor.pt> --actor-sha256 <hex>
"""

import argparse
import hashlib
import json
import sys
import time
from dataclasses import asdict, fields
from pathlib import Path

# Bounded below by our own seeds: every seed handed to their search is mixed
# from these by `mix`, never taken from our engine's shuffler ([G13-13]).
DOMAIN_MOVE = 0x6772_7A68_786D_6F76  # "grzhxmov"
DOMAIN_GAME = 0x6772_7A68_7867_616D  # "grzhxgam"
MASK = (1 << 64) - 1

KEYS_SEARCH = {
    'candidates': 'candidates', 'maxDepth': 'max_depth', 'chanceInitial': 'chance_initial',
    'chanceCap': 'chance_cap', 'valueScale': 'value_scale', 'maxvisitInit': 'maxvisit_init',
    'gumbelScale': 'gumbel_scale',
}
KEYS_TUNING = {
    'qMode': 'q_mode', 'subtreeReuse': 'subtree_reuse', 'cacheCapacity': 'cache_capacity',
    'symmetricCache': 'symmetric_cache', 'qFloor': 'q_floor', 'chanceCoefficient': 'chance_coefficient',
    'chanceExponent': 'chance_exponent', 'chanceSensitivity': 'chance_sensitivity',
    'afterstatePrior': 'afterstate_prior',
}
KEYS_HOST = {'trees': 1, 'threads': 1, 'torchThreads': 1, 'chunk': 1024}


class Disagreement(Exception):
    def __init__(self, comparison, **details):
        super().__init__(comparison)
        self.comparison, self.details = comparison, details


def mix(*words):
    """splitmix64 over the words, in order: the seeds of [G13-13]."""
    z = 0
    for w in words:
        z = (z + 0x9E3779B97F4A7C15 + (int(w) & MASK)) & MASK
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK
        z = z ^ (z >> 31)
    return z


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


class Host:
    def __init__(self, args):
        sys.path.insert(0, str(Path(args.repo) / 'python'))
        global np, torch, Batch, load_actor, FrozenActor, PipelineSearch, Tuning, SearchConfig, rank_search_actions
        import numpy as np
        import torch
        from azul import Batch
        from azul_ai.evaluate import load_actor
        from azul_ai.optimized_search import FrozenActor, PipelineSearch, Tuning
        from azul_ai.search import SearchConfig
        from azul_ai.search_decision import rank_search_actions

        got = sha256_file(args.actor)
        if got != args.actor_sha256:
            raise SystemExit(f'the actor {args.actor} has sha256 {got}, not the pinned {args.actor_sha256} ([G13-9])')
        self.library = args.library
        self.checkpoint = torch.load(args.actor, map_location='cpu', weights_only=False)
        self.model = load_actor(args.actor, 'cpu')
        self.actor = FrozenActor(self.model, 'cpu', bf16=False)
        self.actor_sha256 = got
        self.cells = {}
        self.game = None
        self.scratch = Batch(1, threads=1, seed=0, library=self.library)

    # -- settings ([G13-23] to [G13-25]) ---------------------------------

    def resolve(self, cell):
        """Every setting of theirs for one cell, and where each came from."""
        recorded_search = self.checkpoint.get('search') or {}
        recorded_tuning = self.checkpoint.get('tuning') or {}
        given = dict(cell.get('settings') or {})
        unknown = set(given) - set(KEYS_SEARCH) - set(KEYS_TUNING) - set(KEYS_HOST) - {'build'}
        if unknown:
            raise ValueError(f'unknown setting(s) of theirs: {", ".join(sorted(unknown))}')
        search_defaults = asdict(SearchConfig())
        tuning_defaults = asdict(Tuning())
        resolved, source = {}, {}
        for key, field in KEYS_SEARCH.items():
            if key in given:
                resolved[key], source[key] = given[key], 'given'
            elif key == 'gumbelScale':
                resolved[key], source[key] = 0.0, 'audit_ai.py plays gumbel_scale 0'
            elif field in recorded_search:
                resolved[key], source[key] = recorded_search[field], "the actor's recorded search"
            else:
                resolved[key], source[key] = search_defaults[field], 'their SearchConfig default'
        for key, field in KEYS_TUNING.items():
            if key in given:
                resolved[key], source[key] = given[key], 'given'
            elif field in recorded_tuning:
                resolved[key], source[key] = recorded_tuning[field], "the actor's recorded tuning"
            else:
                resolved[key], source[key] = tuning_defaults[field], 'their Tuning default'
        for key, default in KEYS_HOST.items():
            resolved[key], source[key] = (given[key], 'given') if key in given else (default, 'default')
        budget = cell['budget']
        if budget['kind'] == 'sims':
            simulations = budget['n']
            if simulations is None:
                if 'simulations' not in recorded_search:
                    raise ValueError("--them must be given: the actor records no search.simulations ([G13-24])")
                simulations = recorded_search['simulations']
                source['simulations'] = "the actor's recorded search"
            else:
                source['simulations'] = 'given'
            resolved['simulations'] = int(simulations)
            ceiling = resolved['simulations']
        else:
            if resolved['trees'] != 1:
                raise ValueError('a clock of theirs takes trees 1: their timed search is one root ([G13-25])')
            resolved['clockMs'] = int(budget['n'])
            ceiling = resolved['chunk']
        if resolved['candidates'] > ceiling:
            resolved['candidates'], source['candidates'] = ceiling, f"clamped to {ceiling}, as their programs clamp it ([G13-24])"
        if (resolved['trees'] > 1 or budget['kind'] == 'ms') and resolved['subtreeReuse']:
            resolved['subtreeReuse'], source['subtreeReuse'] = 0, '0 with trees > 1 or a clock, as their programs set it ([G13-24])'
        return resolved, source

    def search_parts(self, r):
        sims = r['simulations'] if 'simulations' in r else r['chunk']
        config = SearchConfig(simulations=int(sims), **{f: r[k] for k, f in KEYS_SEARCH.items()})
        tuning = Tuning(**{f: r[k] for k, f in KEYS_TUNING.items()})
        return config, tuning

    def make_search(self, r, env):
        config, tuning = self.search_parts(r)
        return PipelineSearch(env, self.actor, config, tuning, threads=int(r['threads']), queues=1, graphs=False)

    def on_configure(self, msg):
        out, threads = [], set()
        for cell in msg['cells']:
            try:
                resolved, source = self.resolve(cell)
                # [G13-25]: their own library judges the settings.
                width = resolved['trees']
                env = Batch(width, threads=1, seed=0, library=self.library)
                try:
                    self.make_search(resolved, env).close()
                finally:
                    env.close()
            except Exception as e:  # noqa: BLE001 — their refusals are ValueError and RuntimeError alike
                return {'refused': cell['id'], 'message': str(e)}
            threads.add(resolved['torchThreads'])
            self.cells[cell['id']] = resolved
            out.append({'id': cell['id'], 'settings': resolved, 'source': source})
        if len(threads) > 1:
            return {'refused': None, 'message': 'torchThreads must be the same in every cell: it is one process setting'}
        torch.set_num_threads(int(threads.pop()) if threads else 1)
        return {'cells': out}

    # -- a game ([G13-12], [G13-13]) -------------------------------------

    def on_game(self, msg):
        self.close_game()
        r = self.cells[msg['cell']]
        seed = mix(DOMAIN_GAME, msg['matchSeed'], msg['seed'], msg['seat'])
        lockstep = Batch(1, threads=1, seed=seed & 0xFFFFFFFF, library=self.library)
        lockstep.manual_reset(seed)
        g = {'cell': r, 'lockstep': lockstep, 'seeds': (msg['matchSeed'], msg['seed'], msg['seat']),
             'ply': 0, 'deals': 0, 'scores': [0, 0], 'envs': [], 'search': None}
        if 'clockMs' in r:
            g['copy'] = Batch(1, threads=1, seed=0, library=self.library)
            g['envs'].append(g['copy'])
            g['search'] = self.make_search(r, g['copy'])
        elif r['trees'] > 1:
            g['copy'] = Batch(r['trees'], threads=int(r['threads']), seed=0, library=self.library)
            g['envs'].append(g['copy'])
            g['search'] = self.make_search(r, g['copy'])
        else:
            g['search'] = self.make_search(r, lockstep)
        self.game = g
        return {'ok': True}

    def close_game(self):
        g, self.game = self.game, None
        if g is None:
            return
        if g['search'] is not None:
            g['search'].close()
        for env in g['envs']:
            env.close()
        g['lockstep'].close()

    def lockstep_view(self):
        obs, masks, players = self.game['lockstep'].observe()
        return np.ctypeslib.as_array(obs).copy(), np.ctypeslib.as_array(masks).copy(), int(players[0])

    def on_deal(self, msg):
        g = self.game
        tiles = [int(t) for t in msg['tiles']]
        try:
            g['lockstep'].manual_deal(tiles)
        except ValueError as e:
            raise Disagreement('manual_deal refused our deal', tiles=tiles, error=str(e)) from e
        # Their local player bumps its actor's version after a manual deal, and
        # every search runs under that version. Here the count of deals is the
        # version each search is run under (`tree_version`), so nothing
        # searched before a deal is reused after it, as there.
        g['deals'] += 1
        return {'ok': True}

    def on_ply(self, msg):
        g = self.game
        imported = msg['imported']
        try:
            self.scratch.import_public(0, **imported)
        except ValueError as e:
            raise Disagreement('import_public refused our position', imported=imported, error=str(e)) from e
        io, im, ip = (np.ctypeslib.as_array(a).copy() for a in self.scratch.observe())
        lo, lm, lp = self.lockstep_view()
        details = {'importedObservation': io.tolist(), 'lockstepObservation': lo.tolist(),
                   'importedMask': np.flatnonzero(im).tolist(), 'lockstepMask': np.flatnonzero(lm).tolist(),
                   'importedPlayer': int(ip[0]), 'lockstepPlayer': lp}
        if int(ip[0]) != lp:
            raise Disagreement('the player to move differs between imported and lockstep', **details)
        if not np.array_equal(io.view(np.uint32), lo.view(np.uint32)):
            raise Disagreement('observations differ between imported and lockstep', **details)
        if not np.array_equal(im, lm):
            raise Disagreement('legal masks differ between imported and lockstep', **details)
        if sorted(details['lockstepMask']) != sorted(int(a) for a in msg['legal']):
            raise Disagreement("their legal moves differ from our engine's", ours=sorted(msg['legal']), **details)
        if [int(s) for s in msg['scores']] != g['scores']:
            raise Disagreement("their scores differ from our engine's", ours=msg['scores'], theirs=g['scores'], **details)
        g['ply'] = int(msg['ply'])
        return {'ok': True}

    def on_move(self, _msg):
        g = self.game
        r = g['cell']
        match_seed, game_seed, seat = g['seeds']
        seed = mix(DOMAIN_MOVE, match_seed, game_seed, seat, g['ply'])
        started = time.perf_counter()
        if 'clockMs' in r:
            out = self.clocked(g, r, seed, started)
        elif r['trees'] > 1:
            snapshot = g['lockstep'].snapshot(0)
            for tree in range(r['trees']):
                g['copy'].restore(tree, snapshot)
            actions, policies, values = g['search'].run(seed, tree_version=g['deals'])
            votes = np.zeros(180, np.int64)
            action, _, _ = rank_search_actions(actions[:r['trees']], policies[:r['trees']].mean(0), votes, limit=1)
            out = {'action': int(action), 'simulations': int(g['search'].metrics.get('simulations', 0)),
                   'value': float(np.mean(values[:r['trees']])), 'trees': [int(a) for a in actions[:r['trees']]]}
        else:
            actions, _, values = g['search'].run(seed, tree_version=g['deals'])
            out = {'action': int(actions[0]), 'simulations': int(g['search'].metrics.get('simulations', 0)),
                   'value': float(values[0])}
        out['ms'] = (time.perf_counter() - started) * 1000.0
        out['reused'] = int(g['search'].metrics.get('reused_nodes', 0))
        return out

    def clocked(self, g, r, seed, started):
        """[G13-28]: their advice mode's chunks, voted when finished; the
        chunk in flight at the deadline is abandoned, the first never."""
        budget_s = r['clockMs'] / 1000.0
        snapshot = g['lockstep'].snapshot(0)
        accumulated = np.zeros(180, np.float64)
        votes = np.zeros(180, np.int64)
        chunk_actions, values = [], []
        selected = None
        while True:
            g['copy'].restore(0, snapshot)
            deadline = None if not chunk_actions else time.monotonic() + max(0.0, budget_s - (time.perf_counter() - started))
            index = len(chunk_actions)
            result = g['search'].run(mix(seed, index), deadline=deadline, tree_version=g['deals'])
            if g['search'].deadline_reached:
                break  # the chunk in flight, abandoned: it plays no part
            actions, policies, vals = result
            chunk_actions.append(int(actions[0]))
            values.append(float(vals[0]))
            accumulated += policies[0]
            selected, _, _ = rank_search_actions(actions, accumulated / len(chunk_actions), votes, limit=1)
            if time.perf_counter() - started >= budget_s or (len(chunk_actions) + 1) * r['chunk'] > 65536 * 1024:
                break
        elapsed = time.perf_counter() - started
        return {'action': int(selected), 'simulations': len(chunk_actions) * r['chunk'], 'value': float(np.mean(values)),
                'chunks': len(chunk_actions), 'chunkActions': chunk_actions,
                'tally': {str(a): int(n) for a, n in enumerate(votes) if n},
                'overrun': max(0.0, (elapsed - budget_s) * 1000.0)}

    def on_step(self, msg):
        g = self.game
        action = int(msg['action'])
        try:
            result = g['lockstep'].manual_step(action)
        except ValueError as e:
            raise Disagreement('manual_step failed', action=action, error=str(e)) from e
        if result.invalid_action:
            raise Disagreement('their engine refuses a move ours applied', action=action)
        g['scores'] = [int(result.scores[0]), int(result.scores[1])]
        winner = None
        if result.terminated:
            winner = -1 if result.reward == 0 else (int(result.actor) if result.reward > 0 else 1 - int(result.actor))
        return {'scores': g['scores'], 'roundFinished': bool(result.round_finished),
                'terminated': bool(result.terminated), 'winner': winner}

    def on_hello(self, _msg):
        import numpy
        return {'actorSha256': self.actor_sha256, 'library': self.library,
                'torch': torch.__version__, 'numpy': numpy.__version__,
                'iteration': self.checkpoint.get('iteration')}

    def handle(self, msg):
        kind = msg.get('type')
        handler = {'hello': self.on_hello, 'configure': self.on_configure, 'game': self.on_game,
                   'deal': self.on_deal, 'ply': self.on_ply, 'move': self.on_move, 'step': self.on_step}.get(kind)
        if handler is None:
            raise SystemExit(f'unknown request {kind!r}')
        if kind in ('deal', 'ply', 'move', 'step') and self.game is None:
            raise SystemExit(f'request {kind!r} before a game')
        try:
            return handler(msg)
        except Disagreement as d:
            return {'disagreement': d.comparison, 'details': d.details}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--repo', required=True)
    p.add_argument('--library', required=True)
    p.add_argument('--actor', required=True)
    p.add_argument('--actor-sha256', required=True)
    args = p.parse_args()
    out = sys.stdout
    sys.stdout = sys.stderr  # nothing but answers reaches stdout ([G13-10])
    host = Host(args)
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            raise SystemExit(f'malformed request: {e}') from e
        answer = host.handle(msg)
        out.write(json.dumps(answer, allow_nan=False) + '\n')
        out.flush()
    host.close_game()


if __name__ == '__main__':
    main()
