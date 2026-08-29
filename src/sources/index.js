/**
 * Source registry.
 *
 * There is one source today and the interface exists anyway, because the whole
 * resilience story rests on it: when Meta changes something, the repair is
 * confined to one adapter and the output contract does not move. The Graph API
 * adapter, when it lands, plugs in here and produces byte-identical records.
 *
 * See docs/CONTRACT.md §5 for the interface every adapter implements.
 */
import * as weblibrary from './weblibrary.js';

export const SOURCES = {
  [weblibrary.name]: weblibrary,
};

export const SOURCE_NAMES = Object.keys(SOURCES);

/** The source used when the input does not ask for anything else. */
export const DEFAULT_SOURCE = weblibrary.name;

/**
 * Pick the adapter for a run.
 *
 * `graph_api` is deliberately not selectable yet: it covers only political ads
 * and EU-targeted ads, so silently routing a commercial query through it would
 * return an empty result set that looks like a bug. Asking for it gets an
 * honest error instead.
 */
export function resolveSource(name = DEFAULT_SOURCE) {
  const key = String(name || DEFAULT_SOURCE).toLowerCase();
  const source = SOURCES[key];
  if (!source) {
    throw new Error(
      `Unknown source "${name}". Available: ${SOURCE_NAMES.join(', ')}.`,
    );
  }
  return source;
}
