import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { it } from 'node:test'

const fixture = join(import.meta.dirname, '..', 'fixtures', 'e2e')

it('lists the device tests of an app, minus its exclude', () => {
  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx', join(import.meta.dirname, 'cli.ts'), 'tests'],
    { cwd: fixture, encoding: 'utf8' },
  )
  assert.deepEqual(out.trim().split(/\r?\n/), [
    'specs/account/sign-in.e2e.ts  Sign in > signs in with email',
    'specs/account/sign-in.e2e.ts  Sign in > signs in with a phone #android  [#android]',
  ])
})
