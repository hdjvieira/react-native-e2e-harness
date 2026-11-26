import assert from 'node:assert/strict'
import { it } from 'node:test'
import { totals } from './timing.js'

it('totals per label, slowest first', () => {
  assert.deepEqual(
    totals([
      { label: 'restart', ms: 1000 },
      { label: 'sign in', ms: 5000 },
      { label: 'restart', ms: 3000 },
    ]),
    [
      { label: 'sign in', count: 1, totalSeconds: 5, averageSeconds: 5 },
      { label: 'restart', count: 2, totalSeconds: 4, averageSeconds: 2 },
    ],
  )
})
