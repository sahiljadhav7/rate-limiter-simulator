import { createContext } from 'react'

/**
 * Whether the run is paused. What moves with the run (the edge dashes) stops with it, read here
 * without the panels passing it down.
 */
export const RunPausedContext = createContext(false)
