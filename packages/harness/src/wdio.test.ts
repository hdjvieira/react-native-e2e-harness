import assert from 'node:assert/strict'
import { it } from 'node:test'
import harness from '../fixtures/e2e/e2e.config.js'
import { createWdioConfig } from './wdio.js'

it('builds the WebdriverIO config from the app config', () => {
  const config = createWdioConfig(harness)
  const [caps] = config.capabilities as Record<string, unknown>[]
  assert.equal(caps['appium:appPackage'], 'com.example.fixture')
  assert.equal(caps['appium:appActivity'], 'com.example.fixture.MainActivity')
  assert.equal(config.port, 4723)
  assert.match(
    String(config.specs?.[0]),
    /fixtures\/e2e\/specs\/\*\*\/\*\.e2e\.ts$/,
  )
  assert.match(String(config.exclude?.[0]), /fixtures\/e2e\/specs\/api\/\*\*$/)
  assert.deepEqual(config.mochaOpts, { ui: 'bdd', timeout: 240000, retries: 1 })
})
