/**
 * The notice after a hidden tab (.scratch/polish/spec.md decision 17). A browser gives a hidden
 * tab no animation frames, so the run stops while it is hidden (frame-clock.ts) and every number
 * stands still. Back in view, a student could take the gap for the simulation; the notice says
 * what happened. Pure, so its lifetime is tested without a browser.
 */

/** What the notice says. */
export const HIDDEN_NOTICE = 'Paused while this tab was hidden'

/** How long the notice stays, in ms of simulated time after the return. */
export const HIDDEN_NOTICE_MS = 5000

export interface HiddenNoticeState {
  /** Hidden while playing, and not back yet. */
  readonly pending: boolean
  /** The simulated time it was shown at, or null when it is not showing. */
  readonly shownAtMs: number | null
}

export type HiddenNoticeEvent =
  | { readonly kind: 'hidden'; readonly playing: boolean }
  | { readonly kind: 'visible'; readonly simMs: number }
  | { readonly kind: 'tick'; readonly simMs: number }
  /** Any control: the student is back at the controls, so the notice has done its job. */
  | { readonly kind: 'control' }

export const NO_NOTICE: HiddenNoticeState = { pending: false, shownAtMs: null }

/** The notice's state after `event`. */
export function hiddenNotice(
  state: HiddenNoticeState,
  event: HiddenNoticeEvent,
): HiddenNoticeState {
  switch (event.kind) {
    case 'hidden':
      return event.playing ? { ...state, pending: true } : state
    case 'visible':
      return state.pending ? { pending: false, shownAtMs: event.simMs } : state
    case 'tick':
      return state.shownAtMs !== null && event.simMs - state.shownAtMs >= HIDDEN_NOTICE_MS
        ? NO_NOTICE
        : state
    case 'control':
      return NO_NOTICE
  }
}
