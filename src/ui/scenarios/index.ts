import type { Scenario } from '../../runner/scenario.ts'
import { backendOverloadScenario } from './backend-overload.ts'
import { goodputCollapseScenario } from './goodput-collapse.ts'
import { noisyNeighborScenario } from './noisy-neighbor.ts'
import { retryStormScenario } from './retry-storm.ts'

/** Every Scenario, in the picker's order; the first loads by default. */
export const SCENARIOS: readonly [Scenario, ...Scenario[]] = [
  backendOverloadScenario,
  noisyNeighborScenario,
  retryStormScenario,
  goodputCollapseScenario,
]
