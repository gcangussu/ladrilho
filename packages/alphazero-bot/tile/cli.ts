/**
 * `pnpm -F alphazero-bot tile <command>`: our master against the AI of
 * danluu.com/game/tile. See tile/README.md.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { availableParallelism, tmpdir } from 'node:os';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainThread, workerData } from 'node:worker_threads';
import { buildRelease } from '../eval/crate.js';
import { binary, LOG, MILESTONES, PACKAGE, RUNS, milestoneCheckpoint, parseMilestonePath } from '../eval/paths.js';
import { BUILDS, checkUpdates, defaultCacheDir, ensureCache, fetchAll, loadSettings, readManifest, type Build } from './assets.js';
import { configPath, runMatch, table, workerMain } from './match.js';
import { loadTheirs, MCTS_SOLVER_MIN_SIMS, parseTheirSpec, specLabel, type TheirOptions } from './theirs.js';
import { solverCheck, summariseCheck } from './solvercheck.js';
import { verify } from './verify.js';

const USAGE = `usage: pnpm -F alphazero-bot tile <command> [options]

commands
  play            play a match; the options below
  verify          check the position translation against their engine, ply by ply
  solver-check    grade their endgame solver's moves and their minimax's against an exact search
  fetch           download their player into the cache (play and verify do this when it is missing)
  check-updates   ask the site whether any cached file changed; writes nothing
  update          re-download everything
  info            what is cached, and the settings read from it

play options
  --us <n,...>          our simulations per move              (default: the shipped playSimulations)
  --them <spec,...>     their budget per move                 (default: nnue:100000)
                          nnue:<nodes>      the page's default AI: NNUE minimax, a node budget
                          nnue-ms:<ms>      the same, on a clock as the page runs it (not repeatable)
                          mcts:<sims>       the page's alternate AI: PUCT over the policy/value net
                        any of them @<threads>: the page's threaded mode (not repeatable); with 3 or
                        more threads their endgame solver can run (mcts: at 4096 sims or more)
  --tail race|on|off    threaded minimax and the endgame solver from round 5: race, the page's
                        default path (default); on, the solver probed first; off, minimax alone
  --tail-ms <ms>        the probe's time limit on a node budget (default 1000)
  --games <n>           games per (us, them) pair, rounded up to even: each deal from both seats (default 100)
  --seed <n>            first deal's seed                     (default 1)
  --workers <n>         games at once         (default: cores - 1, or cores / their threads)
  --endgame <nodes>     our endgame proof's node cap, [0011 Z11-76] (default 0: off)
  --checkpoint <c>      run/generation, or a checkpoint path   (default: web/shipped.json)
  --config <path>       the run config, when the checkpoint is not a logged milestone
  --out <path>          results prefix: <path>.jsonl per game, <path>.json summary (default runs/tile/<time>)
  --no-build            do not run cargo build --release first

solver-check options
  --games <n>           games of their minimax against itself to take positions from (default 30)
  --play-nodes <n>      that minimax's node budget                                (default 100000)
  --nodes <n>           their threaded minimax's budget at each position          (default 1000000)
  --threads <n>         their threads at each position                            (default: cores)
  --tail-ms <ms>        the solver probe's time limit                             (default 1000)
  --max-nodes <n>       the exact search's node limit per move                    (default 3000000)

common options
  --cache <dir>         where their files are kept            (default ${defaultCacheDir()})
  --build <b>           their WASM build: ${Object.keys(BUILDS).join(', ')} (default simd)
  --games, --seed       for verify too (default 20 games)
`;

const log = (s: string) => process.stderr.write(`${s}\n`);
const sha256File = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

interface Milestone {
  checkpoint: string;
  config: Record<string, unknown>;
  label: string;
}

function resolveCheckpoint(arg: string | undefined, configArg: string | undefined): Milestone {
  let path: string;
  if (arg === undefined) {
    const shipped = JSON.parse(readFileSync(join(PACKAGE, 'web', 'shipped.json'), 'utf8')) as { run: string; generation: number };
    path = milestoneCheckpoint(shipped.run, shipped.generation);
  } else if (/^[A-Za-z0-9_-]+\/\d+$/.test(arg)) {
    const [run, g] = arg.split('/');
    path = milestoneCheckpoint(run, Number(g));
  } else {
    path = resolve(arg);
  }
  if (!existsSync(path)) throw new Error(`no checkpoint at ${path}`);
  if (configArg !== undefined) {
    return { checkpoint: path, config: JSON.parse(readFileSync(configArg, 'utf8')), label: path };
  }
  if (!path.startsWith(MILESTONES)) throw new Error(`${path} is not a logged milestone: pass --config`);
  const { run, generation } = parseMilestonePath(path);
  const entries = JSON.parse(readFileSync(LOG, 'utf8')) as { kind: string; run: string; generation: number; config: Record<string, unknown> }[];
  const entry = entries.find((e) => e.kind === 'milestone' && e.run === run && e.generation === generation);
  if (entry === undefined) throw new Error(`${run}/${generation} is not in milestones/log.json: pass --config`);
  return { checkpoint: path, config: entry.config, label: `${run}/${generation}` };
}

function list(s: string): string[] {
  return s.split(',').map((x) => x.trim()).filter((x) => x !== '');
}

function gitCommit(): string | null {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PACKAGE }).toString().trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: PACKAGE }).toString().trim() !== '';
    return dirty ? `${head}+dirty` : head;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values: v } = parseArgs({
    args: rest,
    options: {
      cache: { type: 'string' },
      build: { type: 'string', default: 'simd' },
      us: { type: 'string' },
      them: { type: 'string', default: 'nnue:100000' },
      games: { type: 'string' },
      seed: { type: 'string', default: '1' },
      workers: { type: 'string' },
      checkpoint: { type: 'string' },
      config: { type: 'string' },
      out: { type: 'string' },
      tail: { type: 'string', default: 'race' },
      'tail-ms': { type: 'string', default: '1000' },
      'play-nodes': { type: 'string', default: '100000' },
      nodes: { type: 'string', default: '1000000' },
      threads: { type: 'string' },
      'max-nodes': { type: 'string', default: '3000000' },
      endgame: { type: 'string', default: '0' },
      'no-build': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (command === undefined || v.help || command === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  const cacheDir = resolve(v.cache ?? defaultCacheDir());
  if (!(v.build in BUILDS)) throw new Error(`--build must be one of ${Object.keys(BUILDS).join(', ')}`);
  const build = v.build as Build;
  const int = (s: string, name: string) => {
    const n = Number(s);
    if (!Number.isInteger(n)) throw new Error(`--${name} must be an integer, not "${s}"`);
    return n;
  };

  switch (command) {
    case 'fetch': {
      log(`fetching into ${cacheDir}`);
      await fetchAll(cacheDir, log);
      return;
    }
    case 'update': {
      log(`re-fetching into ${cacheDir}`);
      const before = readManifest(cacheDir);
      const after = await fetchAll(cacheDir, log);
      const changed = Object.keys(after.files).filter((f) => before?.files[f]?.sha256 !== after.files[f].sha256);
      log(changed.length === 0 ? 'nothing changed' : `changed: ${changed.join(', ')}`);
      return;
    }
    case 'check-updates': {
      const r = await checkUpdates(cacheDir);
      if (r.changed.length === 0) {
        process.stdout.write('up to date\n');
        return;
      }
      for (const c of r.changed) process.stdout.write(`changed  ${c.file}  ${c.was.slice(0, 12)} -> ${c.now.slice(0, 12)}\n`);
      for (const s of r.settingsChanged) process.stdout.write(`setting  ${s.key}: ${JSON.stringify(s.was)} -> ${JSON.stringify(s.now)}\n`);
      process.stdout.write('run `tile update` to take them\n');
      process.exitCode = 1;
      return;
    }
    case 'info': {
      const m = readManifest(cacheDir);
      if (m === null) {
        process.stdout.write(`nothing cached at ${cacheDir}\n`);
        return;
      }
      process.stdout.write(`${cacheDir}\nfetched ${m.fetchedAt} from ${m.source}\n`);
      for (const [f, r] of Object.entries(m.files)) process.stdout.write(`  ${f.padEnd(24)} ${String(r.bytes).padStart(8)}  ${r.sha256}\n`);
      process.stdout.write(`${JSON.stringify(loadSettings(cacheDir), null, 2)}\n`);
      return;
    }
    case 'verify': {
      await ensureCache(cacheDir, log);
      const t = await loadTheirs(cacheDir, build, 1, { tail: 'off', tailMs: 0 });
      const r = verify(t, int(v.games ?? '20', 'games'), int(v.seed, 'seed'), log);
      process.stdout.write(
        `${r.games} games, ${r.plies} plies, ${r.roundEnds} round ends, ${r.terminals} game ends: ${r.disagreements.length} disagreements\n`,
      );
      for (const d of r.disagreements.slice(0, 50)) process.stdout.write(`  ${d}\n`);
      if (r.disagreements.length > 0) process.exitCode = 1;
      return;
    }
    case 'solver-check': {
      await ensureCache(cacheDir, log);
      const threads = v.threads !== undefined ? int(v.threads, 'threads') : availableParallelism();
      if (threads < 3) throw new Error('their solver needs at least 3 threads');
      const t = await loadTheirs(cacheDir, build, threads, { tail: 'on', tailMs: int(v['tail-ms'], 'tail-ms') });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const out = resolve(v.out ?? join(RUNS, 'tile', `solver-check-${stamp}`));
      log(`writing ${out}.jsonl`);
      const rows = solverCheck(
        t,
        {
          games: int(v.games ?? '30', 'games'),
          seed: int(v.seed, 'seed'),
          playNodes: int(v['play-nodes'], 'play-nodes'),
          nodes: int(v.nodes, 'nodes'),
          threads,
          tailMs: int(v['tail-ms'], 'tail-ms'),
          maxNodes: int(v['max-nodes'], 'max-nodes'),
          out,
        },
        log,
      );
      const summary = summariseCheck(rows);
      writeFileSync(`${out}.txt`, `${summary}\n`);
      process.stdout.write(`${summary}\n`);
      return;
    }
    case 'play': {
      const manifest = await ensureCache(cacheDir, log);
      const settings = loadSettings(cacheDir);
      if (settings.fallbacks.length > 0) log(`warning: their page no longer declares ${settings.fallbacks.join(', ')}; using the values it had`);
      const m = resolveCheckpoint(v.checkpoint, v.config);
      const shipped = m.config.playSimulations;
      const us = v.us !== undefined ? list(v.us).map((x) => int(x, 'us')) : typeof shipped === 'number' ? [shipped] : [];
      if (us.length === 0) throw new Error('--us is needed: the config has no playSimulations');
      const them = list(v.them).map(parseTheirSpec);
      let games = int(v.games ?? '100', 'games');
      games += games % 2;
      const threads = Math.max(...them.map((t) => t.threads));
      if (v.tail !== 'race' && v.tail !== 'on' && v.tail !== 'off') throw new Error('--tail must be race, on or off');
      const options: TheirOptions = { tail: v.tail, tailMs: int(v['tail-ms'], 'tail-ms') };
      for (const t of them) {
        if (t.kind === 'mcts' && t.threads >= 3 && t.sims < MCTS_SOLVER_MIN_SIMS) {
          log(`note: ${specLabel(t)} is below ${MCTS_SOLVER_MIN_SIMS} simulations, where their MCTS does not try the endgame solver`);
        }
      }
      const cores = availableParallelism();
      const workers =
        v.workers !== undefined ? int(v.workers, 'workers') : threads > 1 ? Math.max(1, Math.floor(cores / threads)) : Math.max(1, cores - 1);
      const bin = v['no-build'] ? binary('release') : buildRelease();
      if (!existsSync(bin)) throw new Error(`no binary at ${bin}: drop --no-build`);
      const endgame = int(v.endgame, 'endgame');
      const dir = mkdtempSync(join(tmpdir(), 'azul-tile-'));
      const configs: Record<number, string> = {};
      for (const n of us) {
        configs[n] = configPath(dir, n);
        writeFileSync(configs[n], JSON.stringify({ ...m.config, playSimulations: n, playEndgameNodes: endgame }));
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const out = resolve(v.out ?? join(RUNS, 'tile', stamp));
      const pkg = BUILDS[build];
      const header = {
        date: new Date().toISOString(),
        commit: gitCommit(),
        ours: { checkpoint: m.label, checkpointSha256: sha256File(m.checkpoint), simulations: us, endgameNodes: endgame },
        theirs: {
          source: manifest.source,
          fetchedAt: manifest.fetchedAt,
          build,
          wasmSha256: manifest.files[`${pkg}/wasm_bg.wasm`].sha256,
          modelSha256: manifest.files['model.safetensors'].sha256,
          nnueSha256: manifest.files['nnue.nnue'].sha256,
          settings,
          budgets: them.map(specLabel),
          threads,
          tail: options,
          repeatable: threads === 1 && them.every((t) => t.kind !== 'nnue-ms'),
        },
        games,
        seed: int(v.seed, 'seed'),
        workers,
      };
      log(`ours ${m.label} at ${us.join(', ')} simulations${endgame > 0 ? `, endgame proof ${endgame} nodes` : ''}; theirs ${them.map(specLabel).join(', ')}; ${games} games each, ${workers} at once`);
      log(`writing ${out}.jsonl`);
      const cells = await runMatch(
        { games, seed: header.seed, us, them, workers, out, header, cacheDir, build, binary: bin, checkpoint: m.checkpoint, configs, threads, options },
        log,
      );
      process.stdout.write(`${table(cells)}\n`);
      process.stdout.write(`summary: ${out}.json\n`);
      return;
    }
    default:
      process.stdout.write(USAGE);
      process.exitCode = 2;
  }
}

if (!isMainThread && (workerData as { role?: string } | null)?.role === 'tile-worker') {
  await workerMain();
} else {
  main().catch((e: unknown) => {
    log(String(e instanceof Error ? e.message : e));
    process.exitCode = 1;
  });
}
