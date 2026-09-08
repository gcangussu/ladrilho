# packages/engine

The engine is a TypeScript port of [RemiFabre/ludometer](https://github.com/RemiFabre/ludometer)'s
`ludometer/azul/engine.py`. Treat it as the oracle for correctness; `spec/0001-engine-core.md` is
the authority on what was actually built.

ludometer ships **no recorded test vectors** — its `tests/test_engine.py` is hand-written tests plus
self-play fuzz runs. Our move-by-move fixtures were *generated* by driving that engine, per spec
0002; they are committed, so the suite needs neither network nor Python. Don't go looking upstream
for files that aren't there.
