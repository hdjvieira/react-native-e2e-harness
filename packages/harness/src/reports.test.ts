import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, it } from 'node:test'
import harness from '../fixtures/e2e/e2e.config.js'
import { readRun, RUN_FORMAT, writeRun } from './reports.js'

const run = '2000-01-01T00-00-00'
const dir = join(harness.outDir, run)
mkdirSync(dir, { recursive: true })
after(() => rmSync(dir, { recursive: true, force: true }))

it('stamps run.json with its format and reads it back', () => {
  writeRun({ run, git: {}, release: '?', results: [] })
  assert.equal(readRun(run).format, RUN_FORMAT)
})

it('refuses a run.json it cannot read as its own', () => {
  writeFileSync(
    join(dir, 'run.json'),
    JSON.stringify({ run, format: RUN_FORMAT + 1 }),
  )
  assert.throws(() => readRun(run), /newer harness/)
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ run }))
  assert.throws(() => readRun(run), /no format/)
})
