import { describe, expect, it } from 'vitest'
import { nodeState } from '../src/ui/panel/node-state.ts'
import type { Finding } from '../src/sim/index.ts'

const overflow = (severity: Finding['severity']): Finding => ({
  id: 'queue-overflow',
  label: 'Queue overflow',
  kind: 'symptom',
  severity,
  startedAt: 9000,
  evidence: [
    { metric: 'Lost', value: '24.0%' },
    { metric: 'Shed', value: '120' },
  ],
  why: '',
  fixes: [],
  role: 'root-cause',
})

describe('nodeState', () => {
  it('is healthy with no Finding, for every node', () => {
    expect(nodeState([], 'backend')).toEqual({ severity: null, word: null, lost: null })
  })

  it('puts queue overflow on the Backend, with its word and the lost share from the evidence', () => {
    expect(nodeState([overflow('broken')], 'backend')).toEqual({
      severity: 'broken',
      word: 'FAILING',
      lost: '24.0%',
    })
    expect(nodeState([overflow('warn')], 'backend')).toMatchObject({
      severity: 'warn',
      word: 'STRUGGLING',
    })
    // The Limiter is doing its job: a Backend Finding never colours it.
    expect(nodeState([overflow('broken')], 'limiter').severity).toBeNull()
  })

  it('shows the worst Backend Finding, and the lost share even when the worst has none', () => {
    const saturation: Finding = {
      ...overflow('broken'),
      id: 'saturation',
      label: 'Backend saturation',
      evidence: [{ metric: 'Busy', value: '97%' }],
      role: 'contributing',
    }
    expect(nodeState([saturation, overflow('warn')], 'backend')).toEqual({
      severity: 'broken',
      word: 'FAILING',
      lost: '24.0%',
    })
  })

  it('puts a limit too tight on the Limiter and a retry storm on the Clients', () => {
    const cause = (id: Finding['id']): Finding => ({ ...overflow('warn'), id, kind: 'cause' })
    expect(nodeState([cause('limit-too-tight')], 'limiter').severity).toBe('warn')
    expect(nodeState([cause('retry-storm')], 'client').severity).toBe('warn')
    expect(
      nodeState([cause('limit-too-tight'), cause('retry-storm')], 'backend').severity,
    ).toBeNull()
  })
})
