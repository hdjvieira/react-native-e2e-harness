import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, it } from 'node:test'
import '../fixtures/e2e/e2e.config.js'
import { findConfig } from './config.js'
import { wdioArgs } from './runner.js'

const app = mkdtempSync(join(tmpdir(), 'harness-app-'))
after(() => rmSync(app, { recursive: true, force: true }))

it('turns plain run options into WebdriverIO ones', () => {
  assert.deepEqual(
    wdioArgs([
      '--spec',
      'specs/a.e2e.ts',
      '--grep=#slow',
      '--invert',
      '--bail',
      '1',
    ]),
    [
      'run',
      'wdio.conf.ts',
      '--spec',
      'specs/a.e2e.ts',
      '--mochaOpts.grep',
      '#slow',
      '--mochaOpts.invert',
      '--bail',
      '1',
    ],
  )
})

it("finds the config from the app's package.json, anywhere below it", () => {
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ 'e2e-harness': { config: 'tests/e2e.config.ts' } }),
  )
  assert.equal(findConfig(app), join(app, 'tests', 'e2e.config.ts'))
  writeFileSync(join(app, 'package.json'), '{}')
  assert.equal(findConfig(app), undefined)
})
