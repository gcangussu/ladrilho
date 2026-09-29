/**
 * The TypeScript engine as the driver sees it: its package root and nothing
 * deeper [C10-3]. A type, so that the suite can hand the driver a mutated copy
 * of the engine in place of the real one [C10-38].
 */

import type * as EngineModule from 'engine';

export type Engine = typeof EngineModule;
