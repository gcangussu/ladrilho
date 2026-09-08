# packages/ui

`packages/ui` implements `spec/0003-web-interface.md`. Its organising rule is that **the interface
contains no rule**: everything about legality and scoring is asked of the engine. Two structures
exist to keep that true, and both are enforced by tests — don't route around them.

- `src/game.ts` is the only module that holds an `AzulState` or calls `apply`. The state is not
  exported. Components read the published, plain-data view model and nothing else.
- `test/source.test.ts` fails the build on a list of forbidden shapes in `src/` (a hard-coded wall
  table, the penalty ladder, `% 5`, the action multipliers, `apply` outside the state module).
  `test/property.test.tsx` plays whole games through the rendered DOM against a parallel engine,
  which is what catches a re-implemented rule that the matcher cannot see.

## Solid v2

Solid **v2** differs from the widely-documented v1, and the differences cause silent bugs rather
than errors. All of these bit this codebase:

- Writes are **staged**: reading a signal straight after setting it returns the previous value.
  `flush()` commits. Never derive state from a signal you just wrote; tests must `flush()` before
  asserting on the DOM.
- `<For keyed={false}>` hands its callback an **accessor**. Unwrap it inside JSX, not in the
  callback body — a read outside a tracking scope freezes the value forever, and only a multi-ply
  test notices.
- `<Repeat count={n}>` is the idiom for fixed-position cells.
- Gone: `onMount` (use `onSettled`), `batch`, `classList` (use `class={['a', {b: cond}]}`),
  `Index`, `createMutable`. `createEffect` is two-phase: `createEffect(() => dep(), v => {…})`.
- The web runtime is `@solidjs/web`, and `jsxImportSource` points there. Stores come from `solid-js`.
- Enumerated ARIA attributes (`aria-disabled`, `aria-pressed`) take string literals, not booleans.

When this section and <https://v2.solidjs.com> disagree, the documentation is right and this is
stale.
