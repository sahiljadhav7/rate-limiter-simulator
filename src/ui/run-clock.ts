import { createContext } from 'react'

/**
 * How simulated time is moving: the run's speed and whether it is paused. Anything that moves
 * with simulated time (the edge dashes) reads it, without the panels passing it down.
 */
export const RunClockContext = createContext<{ readonly speed: number; readonly paused: boolean }>({
  speed: 1,
  paused: false,
})
