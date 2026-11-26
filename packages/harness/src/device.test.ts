import assert from 'node:assert/strict'
import { it } from 'node:test'
import { servesThisApp } from './device.js'

it("tells this checkout's Metro from a sibling's", () => {
  const owner =
    'node C:\\work\\app\\node_modules\\@react-native-community\\cli\\build\\bin.js start'
  assert.ok(servesThisApp(owner, 'C:\\work\\app'))
  assert.ok(!servesThisApp(owner, 'C:\\work\\ap'))
  assert.ok(!servesThisApp(owner.replace('app', 'app-alt'), 'C:\\work\\app'))
  assert.ok(
    servesThisApp('node cli.js start (cwd /Users/me/app)', '/Users/me/app'),
  )
  assert.ok(
    !servesThisApp(
      'node cli.js start (cwd /Users/me/app-alt)',
      '/Users/me/app',
    ),
  )
})
