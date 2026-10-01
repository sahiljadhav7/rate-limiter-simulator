/**
 * The newest Demand the slider asked for, waiting for the next animation frame. Dragging fires
 * many input events a frame; applying only the newest keeps the control timeline to one entry
 * per frame at most (.scratch/controls/spec.md decision 4).
 */
export interface PendingDemand {
  /** Keeps `demandRps`, replacing any value not yet taken. */
  set(demandRps: number): void
  /** The value waiting, which is then cleared, or null if the slider has not moved. */
  take(): number | null
}

export function createPendingDemand(): PendingDemand {
  let waiting: number | null = null
  return {
    set(demandRps) {
      waiting = demandRps
    },
    take() {
      const value = waiting
      waiting = null
      return value
    },
  }
}
