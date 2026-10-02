import { describe, expect, it } from 'vitest'
import {
  HIDDEN_NOTICE,
  HIDDEN_NOTICE_MS,
  hiddenNotice,
  NO_NOTICE,
  type HiddenNoticeEvent,
} from '../src/ui/hidden-notice.ts'

/** The notice's text after `events`, from no notice. */
const after = (...events: HiddenNoticeEvent[]) =>
  events.reduce(hiddenNotice, NO_NOTICE).shownAtMs === null ? null : HIDDEN_NOTICE

describe('hiddenNotice', () => {
  it('shows on return after the tab was hidden while playing', () => {
    expect(after({ kind: 'hidden', playing: true })).toBeNull()
    expect(after({ kind: 'hidden', playing: true }, { kind: 'visible', simMs: 20_000 })).toBe(
      HIDDEN_NOTICE,
    )
  })

  it('shows nothing when the run was already paused', () => {
    expect(after({ kind: 'hidden', playing: false }, { kind: 'visible', simMs: 20_000 })).toBeNull()
  })

  it('goes once the run has advanced 5 simulated seconds since the return', () => {
    const back = [
      { kind: 'hidden', playing: true },
      { kind: 'visible', simMs: 20_000 },
    ] as const
    expect(HIDDEN_NOTICE_MS).toBe(5000)
    expect(after(...back, { kind: 'tick', simMs: 24_999 })).toBe(HIDDEN_NOTICE)
    expect(after(...back, { kind: 'tick', simMs: 25_000 })).toBeNull()
  })

  it('goes on any control', () => {
    expect(
      after(
        { kind: 'hidden', playing: true },
        { kind: 'visible', simMs: 20_000 },
        { kind: 'control' },
      ),
    ).toBeNull()
  })

  it('keeps one notice, timed from the latest return, when the tab is hidden again', () => {
    const state = [
      { kind: 'hidden', playing: true },
      { kind: 'visible', simMs: 20_000 },
      { kind: 'tick', simMs: 23_000 },
      { kind: 'hidden', playing: true },
      { kind: 'visible', simMs: 23_000 },
    ] satisfies HiddenNoticeEvent[]
    expect(state.reduce(hiddenNotice, NO_NOTICE).shownAtMs).toBe(23_000)
    expect(after(...state, { kind: 'tick', simMs: 26_000 })).toBe(HIDDEN_NOTICE)
  })
})
