import { describe, expect, it } from 'vitest'
import contextMd from '../CONTEXT.md?raw'
import { SCENARIOS } from '../src/ui/scenarios/index.ts'
import { GLOSSARY } from '../src/ui/notes/glossary.ts'
import { firstNote, secondNote } from '../src/ui/notes/scenario-notes.ts'

/**
 * Each Scenario explains itself in two handwritten notes (.scratch/ship/spec.md decision 8): what
 * to watch and why, then what it models and leaves out. The student reads them, so they are
 * checked like the numbers are.
 */

/**
 * The longest first note, in characters: about four lines of Caveat at 20px in a 600px note
 * (DESIGN.md "Handwritten note": two to four short lines).
 */
const FIRST_NOTE_MAX = 320

/**
 * Every word CONTEXT.md lists under _Avoid_. An entry qualified in brackets, such as "retry (as
 * a noun for the Attempt itself)", is fine in other senses, so it is left out.
 */
const AVOIDED = [...contextMd.matchAll(/^_Avoid_: (.+)$/gm)].flatMap(([, list]) =>
  list!
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => !entry.includes('(')),
)

describe('Scenario notes', () => {
  it('reads the avoided words from CONTEXT.md', () => {
    // A guard against a parser that finds nothing and so checks nothing.
    expect(AVOIDED).toContain('preset')
    expect(AVOIDED).toContain('dropped')
    expect(AVOIDED).not.toContain('retry (as a noun for the Attempt itself)')
  })

  describe.each(SCENARIOS.map((scenario) => [scenario.title, scenario] as const))(
    '%s',
    (_, scenario) => {
      it('has all four texts, none empty', () => {
        for (const text of [scenario.lesson, scenario.why, scenario.models, scenario.leavesOut]) {
          expect(text.trim()).not.toBe('')
        }
      })

      it(`keeps the first note under ${FIRST_NOTE_MAX} characters`, () => {
        expect(firstNote(scenario).length).toBeLessThan(FIRST_NOTE_MAX)
      })

      it.each(AVOIDED)('never says %j', (word) => {
        const text = [firstNote(scenario), secondNote(scenario)].join(' ')
        expect(text).not.toMatch(new RegExp(`\\b${word}\\b`, 'i'))
      })
    },
  )

  it('writes the first note as lesson then why, and the second as Models then Leaves out', () => {
    const scenario = SCENARIOS[0]
    expect(firstNote(scenario)).toBe(`${scenario.lesson} ${scenario.why}`)
    expect(secondNote(scenario)).toBe(
      `Models: ${scenario.models} Leaves out: ${scenario.leavesOut}`,
    )
  })
})

describe('The glossary', () => {
  // Every number a student reads in a panel, a node or a card (ticket 06).
  it.each([
    'Demand',
    'Offered Load',
    'Allowed',
    'Rejected',
    'Delayed',
    'Goodput',
    'Retry Amplification',
    'Wasted Work',
    'Busy',
    'Most waiting',
    'Lost',
    'Shed',
    'Timed out',
    'p50, p95 and p99',
    'Baseline p99',
  ])('defines %s', (term) => {
    expect(GLOSSARY.map((entry) => entry.term)).toContain(term)
  })

  // Sentence case: a capital after the first letter only in a term CONTEXT.md defines.
  const contextTerms = [...contextMd.matchAll(/^\*\*(.+?)\*\*:/gm)].map(([, term]) => term)
  it.each(GLOSSARY.map((entry) => entry.term))('%s is in sentence case', (term) => {
    if (contextTerms.includes(term)) return
    expect(term.slice(1)).not.toMatch(/[A-Z]/)
  })

  it.each(GLOSSARY.map((entry) => [entry.term, entry.definition] as const))(
    '%s reads as plain sentences',
    (_, definition) => {
      expect(definition).toMatch(/^[A-Z]/)
      expect(definition).toMatch(/\.$/)
      expect(definition).not.toMatch(/—/)
    },
  )

  it.each(AVOIDED)('never says %j', (word) => {
    const text = GLOSSARY.map((entry) => `${entry.term} ${entry.definition}`).join(' ')
    expect(text).not.toMatch(new RegExp(`\\b${word}\\b`, 'i'))
  })
})
