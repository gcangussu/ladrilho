/**
 * A structural comparison that names the first field that differs.
 *
 * `expect(a).toEqual(b)` would do the same job, but a replay compares a full
 * state after every one of ~2 900 plies and the assertion machinery is the
 * expensive part of that. This returns `null` for equal values and a path
 * otherwise, so the harness pays for a formatted diff only when something is
 * actually wrong — and then still hands the two states to `expect` for the
 * readable output.
 */
export function deepDiff(got: unknown, want: unknown, path = ''): string | null {
  if (Array.isArray(want)) {
    if (!Array.isArray(got)) return `${path}: expected an array, got ${typeof got}`;
    if (got.length !== want.length) {
      return `${path}: length ${got.length}, expected ${want.length}`;
    }
    for (let i = 0; i < want.length; i++) {
      const d = deepDiff(got[i], want[i], `${path}[${i}]`);
      if (d !== null) return d;
    }
    return null;
  }
  if (want !== null && typeof want === 'object') {
    if (got === null || typeof got !== 'object' || Array.isArray(got)) {
      return `${path}: expected an object`;
    }
    const wantKeys = Object.keys(want as object);
    const gotKeys = Object.keys(got as object);
    // Key *order* matters: it is part of the canonical form [0001 E1-62].
    if (gotKeys.length !== wantKeys.length || gotKeys.some((k, i) => k !== wantKeys[i])) {
      return `${path}: keys [${gotKeys.join(',')}], expected [${wantKeys.join(',')}]`;
    }
    for (const key of wantKeys) {
      const d = deepDiff(
        (got as Record<string, unknown>)[key],
        (want as Record<string, unknown>)[key],
        path === '' ? key : `${path}.${key}`,
      );
      if (d !== null) return d;
    }
    return null;
  }
  if (Object.is(got, want)) return null;
  return `${path}: ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`;
}
