import { MAX_SEED } from '../../sim/index.ts'

/**
 * The seed typed into the seed field, or null unless it is a whole number from 0 to MAX_SEED
 * written in plain digits, so 1.5, 1e3 or 0x10 never quietly become another seed.
 */
export function parseSeed(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const seed = Number(trimmed)
  return seed <= MAX_SEED ? seed : null
}
