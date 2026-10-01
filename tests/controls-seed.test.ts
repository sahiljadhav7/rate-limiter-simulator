import { describe, expect, it } from 'vitest'
import { parseSeed } from '../src/ui/controls/seed.ts'

describe('parseSeed', () => {
  it.each([
    ['42', 42],
    [' 7 ', 7],
    ['0', 0],
    ['4294967295', 4294967295],
  ])('reads %j as the seed %s', (text, seed) => {
    expect(parseSeed(text)).toBe(seed)
  })

  it.each(['', '-1', '1.5', '1e3', 'abc', '4294967296', '0x10'])(
    'gives null for %j, which is not a whole number from 0 to 4,294,967,295',
    (text) => {
      expect(parseSeed(text)).toBeNull()
    },
  )
})
