/**
 * The two action encodings [A8-11].
 *
 * Both programs encode an action as `source * 30 + color * 6 + destination`,
 * with destination 5 for the floor. They differ only in where the centre sits:
 * our engine numbers the displays `0..4` and the centre 5 ([0001 E1-6]), the
 * original numbers the centre 0 and the displays `1..5`. So the translation is
 * a rotation of the source by one, and colour and destination pass through.
 */

/** Our action to theirs. */
export function toTheirAction(action: number): number {
  const source = (action / 30) | 0;
  return ((source + 1) % 6) * 30 + (action - source * 30);
}

/** Their action to ours: the rotation of {@link toTheirAction} run backwards. */
export function fromTheirAction(theirs: number): number {
  const source = (theirs / 30) | 0;
  return ((source + 5) % 6) * 30 + (theirs - source * 30);
}
