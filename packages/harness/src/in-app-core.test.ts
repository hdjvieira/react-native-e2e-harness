import assert from 'node:assert/strict'
import { it } from 'node:test'
import { isSwitchLink, parseLink, queryPairs } from './in-app-core.js'

const flags = {
  mapStats: { default: false },
  mapA11y: { default: true, keepOnReload: true },
  nonce: { default: '' },
}

it('answers its own link only', () => {
  assert.ok(isSwitchLink('myapp://e2e', 'myapp://e2e'))
  assert.ok(isSwitchLink('myapp://e2e?logbox=off', 'myapp://e2e'))
  assert.ok(!isSwitchLink('myapp://e2e-other?x=1', 'myapp://e2e'))
  assert.ok(!isSwitchLink('myapp://map', 'myapp://e2e'))
  assert.ok(!isSwitchLink(null, 'myapp://e2e'))
})

it('reads the built-in switches, flags and actions', () => {
  const parsed = parseLink(
    'myapp://e2e?logbox=off&mapA11y=off&mapStats=on&nonce=a%20b&reload=17&keyboard=dismiss&map=1.5,2,3&unknown=1',
    flags,
    ['map'],
  )
  assert.deepEqual(parsed, {
    logboxOff: true,
    dismissKeyboard: true,
    reload: '17',
    flags: { mapA11y: false, mapStats: true, nonce: 'a b' },
    actions: [['map', '1.5,2,3']],
  })
})

it('ignores a value a flag cannot take, and clears a string flag with off', () => {
  assert.deepEqual(
    parseLink('x://e2e?mapStats=maybe&nonce=off', flags, []).flags,
    {
      nonce: '',
    },
  )
  assert.deepEqual(queryPairs('x://e2e?a&b=1#frag'), [
    ['a', ''],
    ['b', '1'],
  ])
})
