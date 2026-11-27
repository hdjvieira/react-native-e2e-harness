import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, it } from 'node:test'
import { androidActivity, appId, defineConfig } from './config.js'
import { createWdioConfig } from './wdio.js'

const app = mkdtempSync(join(tmpdir(), 'harness-flex-'))
mkdirSync(join(app, 'e2e'))
after(() => rmSync(app, { recursive: true, force: true }))

it("picks the variant's app id, and the activity from the code's package", () => {
  defineConfig({
    dir: join(app, 'e2e'),
    android: {
      package: { debug: 'com.app.debug', release: 'com.app' },
      namespace: 'com.app',
    },
  })
  assert.equal(appId('android'), 'com.app.debug')
  assert.equal(androidActivity(), 'com.app.MainActivity')
  process.env.E2E_VARIANT = 'release'
  assert.equal(appId('android'), 'com.app')
  process.env.E2E_VARIANT = 'staging'
  assert.throws(
    () => appId('android'),
    /no android app id for the variant "staging"/,
  )
  delete process.env.E2E_VARIANT
})

it("starts Expo's Metro for an Expo app", () => {
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ dependencies: { expo: '^54.0.0' } }),
  )
  const expo = defineConfig({
    dir: join(app, 'e2e'),
    android: { package: 'a.b' },
  })
  assert.deepEqual(expo.metro, {
    port: 8081,
    start: 'npx expo start --dev-client',
  })
  writeFileSync(join(app, 'package.json'), '{}')
  const plain = defineConfig({
    dir: join(app, 'e2e'),
    android: { package: 'a.b' },
  })
  assert.deepEqual(plain.metro, { port: 8081, start: 'npx react-native start' })
})

it('writes JUnit XML unless told not to, and takes more reporters', () => {
  const names = (reports?: object) =>
    (
      createWdioConfig(
        defineConfig({
          dir: join(app, 'e2e'),
          android: { package: 'a.b' },
          reports,
        }),
      ).reporters ?? []
    ).map(r => (Array.isArray(r) ? r[0] : r))
  assert.deepEqual(names(), ['spec', 'junit'])
  assert.deepEqual(names({ junit: false, reporters: ['dot'] }), ['spec', 'dot'])
})
