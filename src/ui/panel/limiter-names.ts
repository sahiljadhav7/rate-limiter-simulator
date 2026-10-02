import type { KeyBy, LimiterSpec } from '../../sim/index.ts'

/** Each Limiter algorithm's name, as the panel's pill and text use it. */
export const ALGORITHM_NAMES: Readonly<Record<LimiterSpec['algo'], string>> = {
  'token-bucket': 'Token bucket',
  'sliding-counter': 'Sliding window counter',
}

/** Each algorithm's name short enough for a phone's tab (spec decision 9 of .scratch/polish/). */
export const SHORT_ALGORITHM_NAMES: Readonly<Record<LimiterSpec['algo'], string>> = {
  'token-bucket': 'Token bucket',
  'sliding-counter': 'Sliding window',
}

/** What each key scope means, as the panel's pill says it. */
export const KEY_SCOPE_NAMES: Readonly<Record<KeyBy, string>> = {
  global: 'Global',
  client: 'Per client',
}
