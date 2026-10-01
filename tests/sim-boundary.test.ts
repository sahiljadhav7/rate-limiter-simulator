import { describe, expect, it } from 'vitest'

/**
 * The engine in src/sim, and the runner in src/runner that drives it, must only use the
 * simulated clock and the seeded RNG streams. One wall-clock read or unseeded random draw
 * makes replays drift with no error, so any mention of these APIs in either folder fails the
 * build. Comments count too: a hit in a comment is cheap to reword, and a scanner that skips
 * comments is easy to fool.
 */
const FORBIDDEN = [
  'Date.now',
  'Math.random',
  'performance.now',
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
] as const

// Vite resolves this at transform time, so the test needs no Node file APIs or types.
const simSources = import.meta.glob<string>('../src/sim/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
})
const runnerSources = import.meta.glob<string>('../src/runner/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
})

function findViolations(sources: Record<string, string>): string[] {
  const violations: string[] = []
  for (const [path, text] of Object.entries(sources)) {
    text.split('\n').forEach((line, index) => {
      for (const api of FORBIDDEN) {
        const pattern = new RegExp(`\\b${api.replace('.', '\\s*\\.\\s*')}\\b`)
        if (pattern.test(line)) {
          violations.push(`${path.replace('../', '')}:${index + 1} uses ${api}`)
        }
      }
    })
  }
  return violations
}

describe('src/sim boundary', () => {
  it('has source files to check, so the scan cannot pass vacuously', () => {
    expect(Object.keys(simSources).length).toBeGreaterThan(0)
  })

  it('never reads the wall clock, uses unseeded randomness or schedules real timers', () => {
    expect(findViolations(simSources)).toEqual([])
  })
})

describe('src/runner boundary', () => {
  it('has source files to check, so the scan cannot pass vacuously', () => {
    expect(Object.keys(runnerSources).length).toBeGreaterThan(0)
  })

  it('never reads the wall clock, uses unseeded randomness or schedules real timers', () => {
    // The UI's frame loop passes the wall time in; the runner never reads it.
    expect(findViolations(runnerSources)).toEqual([])
  })

  it('imports only the engine through its public surface, and its own files', () => {
    const imports: string[] = []
    for (const [path, text] of Object.entries(runnerSources)) {
      for (const [, from] of text.matchAll(/\bfrom\s+'([^']+)'/g)) {
        if (from !== '../sim/index.ts' && !from?.startsWith('./')) {
          imports.push(`${path.replace('../', '')} imports ${from}`)
        }
      }
    }
    expect(imports).toEqual([])
  })
})
