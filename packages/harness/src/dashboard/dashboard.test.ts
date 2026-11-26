import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import harness from '../../fixtures/e2e/e2e.config.js'
import type { PlannedTest } from '../plan.js'
import { historyKey, hookOf, readHistory, readRun } from './data.js'
import { flakyTests, readDigests, runInfo } from './history.js'

// two finished runs of the same two tests: `stable` passes both times,
// `wobbly` fails then passes, and the second run has a failed beforeEach
const plan: PlannedTest[] = [
  {
    key: 'Login > stable',
    spec: 'specs/login.e2e.ts',
    describe: 'Login',
    title: 'stable',
    tags: [],
  },
  {
    key: 'Login > wobbly #android',
    spec: 'specs/login.e2e.ts',
    describe: 'Login',
    title: 'wobbly #android',
    tags: ['#android'],
  },
]
const runs = ['2001-01-01T00-00-00', '2001-01-02T00-00-00']
const folders = runs.map(run => join(harness.outDir, run))

function writeRun(
  dir: string,
  run: string,
  wobblyPassed: boolean,
  hookFailed: boolean,
) {
  mkdirSync(dir, { recursive: true })
  const at = Date.parse(`${run.slice(0, 10)}T00:00:00Z`)
  const lines = (rows: object[]) =>
    rows.map(r => JSON.stringify(r)).join('\n') + '\n'
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan))
  writeFileSync(
    join(dir, 'run.json'),
    JSON.stringify({
      format: 1,
      run,
      platform: 'Android',
      git: {},
      release: '?',
      results: [],
    }),
  )
  writeFileSync(
    join(dir, 'results.jsonl'),
    lines([
      { title: 'Login > stable', passed: true, retries: 0, seconds: 3 },
      {
        title: 'Login > wobbly #android',
        passed: wobblyPassed,
        error: wobblyPassed ? undefined : 'boom',
        retries: 0,
        seconds: 4,
      },
      ...(hookFailed
        ? [
            {
              title: 'Login > beforeEach',
              passed: false,
              error: 'setup',
              retries: 0,
              seconds: 0,
            },
          ]
        : []),
    ]),
  )
  writeFileSync(
    join(dir, 'events.jsonl'),
    lines([
      { at, type: 'run-start', device: 'emulator-5554', platform: 'Android' },
      { at: at + 1, type: 'stage', stage: 'tests' },
      { at: at + 2, type: 'test-start', key: 'Login > stable' },
      {
        at: at + 3000,
        type: 'test-end',
        key: 'Login > stable',
        passed: true,
        seconds: 3,
        retries: 0,
        final: true,
      },
      { at: at + 3001, type: 'test-start', key: 'Login > wobbly #android' },
      {
        at: at + 7000,
        type: 'test-end',
        key: 'Login > wobbly #android',
        passed: wobblyPassed,
        error: wobblyPassed ? undefined : 'boom',
        seconds: 4,
        retries: 0,
        final: true,
      },
      ...(hookFailed
        ? [
            {
              at: at + 7000,
              type: 'hook-fail',
              key: 'Login > beforeEach',
              hook: 'beforeEach',
              parent: 'Login',
              error: 'setup',
            },
          ]
        : []),
      { at: at + 7001, type: 'run-end', summary: join(dir, 'summary.md') },
    ]),
  )
  writeFileSync(join(dir, 'summary.md'), '# run\n')
}

writeRun(folders[0], runs[0], false, false)
writeRun(folders[1], runs[1], true, true)
after(() =>
  folders.forEach(dir => rmSync(dir, { recursive: true, force: true })),
)

describe('dashboard data', () => {
  it('keeps a test history through its target tags, and hooks out of the tests', () => {
    assert.equal(historyKey('Login > wobbly #android'), 'Login > wobbly')
    assert.equal(historyKey('Login > slow #slow'), 'Login > slow #slow')
    assert.equal(hookOf('Login > beforeEach'), 'beforeEach')
    assert.equal(hookOf('specs/login.e2e.ts > session'), 'session')
    assert.equal(hookOf('Login > stable'), undefined)
  })

  it('reads a run from its events: every test ended, the run over', () => {
    const state = readRun(runs[0])
    assert.equal(state.states.get('Login > stable')?.status, 'passed')
    assert.equal(state.states.get('Login > wobbly #android')?.status, 'failed')
    assert.ok(state.ended)
  })

  it('finds the test that both failed and passed as flaky, never the stable one', () => {
    const flaky = flakyTests(readHistory(), plan).map(f => f.key)
    assert.ok(flaky.some(key => key.startsWith('Login > wobbly')))
    assert.ok(!flaky.some(key => key.startsWith('Login > stable')))
  })

  it('sums each run up, counting a failed hook apart from the tests', () => {
    const digests = readDigests(plan).filter(d => runs.includes(d.summary.run))
    assert.equal(digests.length, 2)
    const second = digests.find(d => d.summary.run === runs[1])!
    // both tests passed, the failed beforeEach still fails the run
    assert.deepEqual(
      second.tests.map(t => t.status),
      ['passed', 'passed'],
    )
    assert.equal(second.summary.status, 'failed')
  })

  it('reads only run.json files it knows the format of', () => {
    assert.equal(runInfo(runs[0])?.format, 1)
    writeFileSync(
      join(folders[0], 'run.json'),
      JSON.stringify({ run: runs[0] }),
    )
    assert.equal(runInfo(runs[0]), undefined)
  })
})
