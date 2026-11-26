import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { OUT_DIR } from './env.js'
import { readCurrentRun } from '../events.js'
import type { PlannedTest } from '../plan.js'
import { resultsOf, RUN_FORMAT, type RunRecord } from '../reports.js'
import { isLive } from './control.js'
import {
  finalise,
  historyKey,
  hookOf,
  outcomes,
  readRun,
  runs,
  type History,
  type RunState,
} from './data.js'

// What the Overview, Run history, Flaky tests and Module matrix pages show:
// every run folder boiled down to one line (its result, device, release,
// duration), and the views across runs built from those lines.

// a run with no events yet and no launcher is still starting, until this long
const LOST_AFTER_MS = 120_000

// what a run writes while it runs. Not run.json, and not the folder itself:
// run.json can be rewritten long after the run (a conversion), which moves
// the folder's mtime too, and a run would read as days long
const WRITTEN_WHILE_RUNNING = [
  'results.jsonl',
  'timing.jsonl',
  'preflight.json',
  'freezes.jsonl',
  'wdio.log',
  'plan.json',
]

/** a run with no events: when it last wrote something of its own */
function lastWrite(stamp: string) {
  let newest = 0
  for (const file of WRITTEN_WHILE_RUNNING) {
    try {
      newest = Math.max(newest, statSync(join(OUT_DIR, stamp, file)).mtimeMs)
    } catch {
      // not written (yet)
    }
  }
  return newest || statSync(join(OUT_DIR, stamp)).mtimeMs
}

/** a run folder's name is its start, in UTC (toISOString with - for :) */
export const stampTime = (stamp: string) =>
  Date.parse(stamp.replace(/T(\d\d)-(\d\d)-(\d\d)$/, 'T$1:$2:$3Z'))

/**
 * A run as the page shows it: whether its launcher is still there, and
 * whether it is lost (nothing will end its open tests now: their clocks stop
 * and they count as failed, as on the run's own page).
 */
export function settle(stamp: string) {
  const state = readRun(stamp)
  const current = readCurrentRun()
  // a launcher killed from outside never writes its end
  const alive = current?.run === stamp && isLive(current)
  const lastSign = state.events.at(-1)?.at ?? lastWrite(stamp)
  const lost =
    !state.ended &&
    !alive &&
    (state.events.length > 0 || Date.now() - lastSign > LOST_AFTER_MS)
  if (lost) finalise(state, 'run lost')
  return { state, alive, lost, lastSign }
}

/**
 * run.json as the run wrote it, in a format this harness reads; never filled
 * in here. Anything else reads as a run with nothing known about it
 */
export function runInfo(stamp: string): Partial<RunRecord> | undefined {
  try {
    const record = JSON.parse(
      readFileSync(join(OUT_DIR, stamp, 'run.json'), 'utf8'),
    ) as Partial<RunRecord>
    return record.format && record.format <= RUN_FORMAT ? record : undefined
  } catch {
    return undefined
  }
}

/** the device the preflight picked, for runs from before run-start said it */
export function preflightDevice(stamp: string) {
  try {
    const { notes } = JSON.parse(
      readFileSync(join(OUT_DIR, stamp, 'preflight.json'), 'utf8'),
    ) as { notes?: string[] }
    // "device emulator-5554 (booted it)"
    const note = notes?.find(n => /^device \S/.test(n))
    return note?.split(/\s+/)[1]
  } catch {
    return undefined
  }
}

// iPhones and simulators are named by UDIDs; anything else is adb's serial
const IOS_ID =
  /^[0-9a-f]{8}-[0-9a-f]{16}$|^[0-9a-f]{40}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type Platform = 'android' | 'ios'

const platformOf = (
  said: string | undefined,
  device: string | undefined,
): { platform?: Platform; guessed?: boolean } => {
  if (said) return { platform: /ios/i.test(said) ? 'ios' : 'android' }
  if (!device) return {}
  return { platform: IOS_ID.test(device) ? 'ios' : 'android', guessed: true }
}

export type RunStatus =
  | 'running'
  | 'passed'
  | 'failed'
  | 'stopped'
  | 'lost'
  | 'preflight'

/** a run in one line: what Run history lists and the Overview sums up */
export type RunSummary = {
  run: string
  /** ms */
  started: number
  ended?: number
  status: RunStatus
  /** why it ended before its tests (a failed preflight) */
  error?: string
  device?: string
  platform?: Platform
  /** no platform in run.json (older runs): read off the device's serial */
  platformGuessed?: boolean
  release?: string
  branch?: string
  commit?: string
  dirty?: boolean
  /** the commit is HEAD at the run's start, written after the fact */
  approximate?: boolean
  app?: RunRecord['app']
  /** tests in the run (its plan, else those with a result) */
  total: number
  passed: number
  failed: number
  skipped: number
  /** passed on their retry */
  flaky: number
  /** still to run or running (a live run) */
  open: number
  /** failed before/after hooks: they end no test of their own */
  hookFailures: number
  /** how long it took, in seconds (to now for a live run) */
  seconds?: number
  /** the spec files its tests come from */
  specs: string[]
  summary: boolean
}

/** a run's tests, for the matrix: spec, and how each ended */
type Digest = {
  summary: RunSummary
  tests: { key: string; spec?: string; status: string; error?: string }[]
}

function statusOf(
  state: RunState,
  alive: boolean,
  lost: boolean,
  failed: number,
): RunStatus {
  if (!state.ended && alive) return 'running'
  if (state.ended?.stopped) return 'stopped'
  if (state.ended?.error) return 'preflight'
  if (lost) return 'lost'
  if (!state.ended) return 'running'
  // an after hook's failure ends no test, but the run did not go clean
  return failed || state.hookFailures.length ? 'failed' : 'passed'
}

/** the summary line's total, for runs that kept only summary.md */
function summarySeconds(stamp: string) {
  try {
    const text = readFileSync(join(OUT_DIR, stamp, 'summary.md'), 'utf8')
    const m = /## Timing \((\d+)m(\d+)s in all\)/.exec(text)
    return m ? Number(m[1]) * 60 + Number(m[2]) : undefined
  } catch {
    return undefined
  }
}

function digest(stamp: string, specOf: (key: string) => string | undefined) {
  const { state, alive, lost, lastSign } = settle(stamp)
  const info = runInfo(stamp)
  const c = { passed: 0, failed: 0, skipped: 0, open: 0, flaky: 0 }
  const tests: Digest['tests'] = []
  let hookFailures = state.hookFailures.length
  for (const test of state.plan) {
    const s = state.states.get(test.key)
    // a test cut short by Stop never got to pass or fail: the run's own page
    // still shows it failed with 'stopped', but here it is not an app failure
    const cutShort =
      state.ended?.stopped &&
      s?.status === 'failed' &&
      'error' in s &&
      s.error === 'stopped'
    const status = cutShort ? 'skipped' : (s?.status ?? 'queued')
    if (status === 'passed') c.passed++
    else if (status === 'failed') c.failed++
    else if (status === 'skipped') c.skipped++
    else c.open++
    if (s && 'flaky' in s && s.flaky) c.flaky++
    tests.push({
      key: test.key,
      spec: test.spec || specOf(test.key),
      status,
      error: s && 'error' in s ? s.error : undefined,
    })
  }
  let total = state.plan.length
  // runs from before results.jsonl: summary.md is all there is
  if (!total && !state.events.length) {
    for (const r of resultsOf(join(OUT_DIR, stamp))) {
      // a failed hook, or a session that never started: not a test
      if (hookOf(r.title)) {
        if (r.status === 'fail') hookFailures++
        continue
      }
      total++
      if (r.status === 'pass') c.passed++
      else if (r.status === 'fail') c.failed++
      else c.skipped++
      tests.push({
        key: r.title,
        spec: specOf(r.title),
        status:
          r.status === 'pass'
            ? 'passed'
            : r.status === 'fail'
              ? 'failed'
              : 'skipped',
      })
    }
  }
  const device = state.device ?? preflightDevice(stamp)
  const { platform, guessed } = platformOf(info?.platform, device)
  const started = state.started ?? stampTime(stamp)
  const end = state.ended?.at ?? (lost ? lastSign : undefined)
  const status = statusOf(state, alive, lost, c.failed + hookFailures)
  const seconds =
    info?.timing?.runSeconds ??
    (end
      ? (end - started) / 1000
      : status === 'running'
        ? (Date.now() - started) / 1000
        : summarySeconds(stamp))
  const summary: RunSummary = {
    run: stamp,
    started,
    ended: end,
    status,
    error: state.ended?.error,
    device,
    platform,
    platformGuessed: guessed || undefined,
    release: info?.release,
    branch: info?.git?.branch,
    commit: info?.git?.commit,
    dirty: info?.git?.dirty,
    app: info?.app,
    total,
    ...c,
    hookFailures,
    seconds: seconds === undefined ? undefined : Math.round(seconds),
    specs: [...new Set(tests.map(t => t.spec).filter(Boolean) as string[])],
    summary: existsSync(join(OUT_DIR, stamp, 'summary.md')),
  }
  return { summary, tests, settled: !!state.ended || lost }
}

// an ended run's digest is kept until one of its files changes
const FILES = ['events.jsonl', 'results.jsonl', 'run.json', 'summary.md']
const digests = new Map<string, { sig: string; digest: Digest }>()

function signature(stamp: string) {
  return FILES.map(file => {
    try {
      const s = statSync(join(OUT_DIR, stamp, file))
      return `${s.size}:${s.mtimeMs}`
    } catch {
      return '-'
    }
  }).join('|')
}

/**
 * Every run, oldest first. `tests` names each test's spec file: the specs
 * as they are now, for runs whose plan didn't say (older runs).
 */
export function readDigests(tests: PlannedTest[]): Digest[] {
  // matched without platform tags: a test keeps its spec when one is dropped
  const byKey = new Map(tests.map(t => [historyKey(t.key), t.spec]))
  const byDescribe = new Map(tests.map(t => [historyKey(t.describe), t.spec]))
  const specOf = (raw: string) => {
    const key = historyKey(raw)
    return (
      byKey.get(key) ??
      byDescribe.get(key.slice(0, Math.max(0, key.lastIndexOf(' > '))))
    )
  }
  const out: Digest[] = []
  const all = runs()
  for (const stamp of all) {
    const sig = signature(stamp)
    const kept = digests.get(stamp)
    if (kept && kept.sig === sig) {
      out.push(kept.digest)
      continue
    }
    try {
      const { summary, tests, settled } = digest(stamp, specOf)
      const d = { summary, tests }
      if (settled) digests.set(stamp, { sig, digest: d })
      else digests.delete(stamp)
      out.push(d)
    } catch {
      // a folder half written or removed while being read: next time
    }
  }
  // folders pruned since
  for (const stamp of digests.keys())
    if (!all.includes(stamp)) digests.delete(stamp)
  return out
}

// --- the Overview's figures -------------------------------------------------

/** how many recent runs the pass rate and the average duration look at */
export const WINDOW = 20

export type Kpis = {
  /** the newest result of every test that ran in the window's runs */
  passRate: { passed: number; executed: number; runs: number }
  /** the newest run on each device */
  newest: {
    runs: string[]
    executed: number
    passed: number
    failed: number
    hookFailures: number
  }
  /** finished runs (passed or failed) in the window */
  duration: { average?: number; runs: number }
}

export function kpis(digests: Digest[], platform?: Platform): Kpis {
  const mine = digests.filter(d => !platform || d.summary.platform === platform)
  const ended = mine.filter(
    d => d.summary.status !== 'running' && d.summary.status !== 'preflight',
  )
  const window = ended.slice(-WINDOW)
  // newest first, so the first result seen for a test is its newest
  const newestResult = new Map<string, string>()
  for (const d of [...window].reverse()) {
    for (const t of d.tests) {
      if (t.status !== 'passed' && t.status !== 'failed') continue
      const key = historyKey(t.key)
      if (!newestResult.has(key)) newestResult.set(key, t.status)
    }
  }
  const executed = newestResult.size
  const passed = [...newestResult.values()].filter(s => s === 'passed').length

  const perDevice = new Map<string, Digest>()
  for (const d of ended) perDevice.set(d.summary.device ?? '?', d)
  const newest = [...perDevice.values()].map(d => d.summary)

  const finished = window.filter(
    d =>
      (d.summary.status === 'passed' || d.summary.status === 'failed') &&
      d.summary.seconds,
  )
  const average = finished.length
    ? finished.reduce((sum, d) => sum + (d.summary.seconds ?? 0), 0) /
      finished.length
    : undefined
  return {
    passRate: { passed, executed, runs: window.length },
    newest: {
      runs: newest.map(s => s.run),
      executed: newest.reduce((n, s) => n + s.passed + s.failed, 0),
      passed: newest.reduce((n, s) => n + s.passed, 0),
      failed: newest.reduce((n, s) => n + s.failed, 0),
      hookFailures: newest.reduce((n, s) => n + s.hookFailures, 0),
    },
    duration: {
      average: average === undefined ? undefined : Math.round(average),
      runs: finished.length,
    },
  }
}

// --- flaky tests --------------------------------------------------------------

/** how many of a test's recent runs the flaky view weighs */
export const FLAKY_WINDOW = 10

export type FlakyTest = {
  key: string
  spec?: string
  /** runs in the window where it failed or needed its retry */
  unstable: number
  /** its runs in the window (skips left out) */
  of: number
  failed: number
  retried: number
  /** the same runs as `of`, oldest first */
  recent: { run: string; status: string; seconds: number }[]
  lastFailure?: { run: string; error?: string; retried: boolean }
}

/**
 * Tests whose recent runs mix passes and failures, or that passed only on
 * their retry: the ones that can't be trusted either way. A test that fails
 * every time is broken, not flaky, and is left out.
 */
export function flakyTests(history: History, tests: PlannedTest[]) {
  // history keys carry no platform tags (historyKey): nor do these
  const byKey = new Map(tests.map(t => [historyKey(t.key), t.spec]))
  const byDescribe = new Map(tests.map(t => [historyKey(t.describe), t.spec]))
  const out: FlakyTest[] = []
  for (const [key, attempts] of history) {
    if (hookOf(key)) continue
    // skips say nothing either way: the count and the strip both leave them
    // out, so every square on the strip is one of the n in 'k of n'
    const window = outcomes(attempts)
      .filter(o => !o.skipped)
      .slice(-FLAKY_WINDOW)
    const failed = window.filter(o => !o.passed).length
    const retried = window.filter(o => o.flaky).length
    const passed = window.filter(o => o.passed).length
    if (!retried && !(failed && passed)) continue
    const last = [...window].reverse().find(o => !o.passed || o.flaky)
    // a pass on retry carries no error: its failed first attempt does
    const firstAttempt =
      last && attempts.find(a => a.run === last.run && !a.passed && !a.skipped)
    out.push({
      key,
      spec:
        byKey.get(key) ??
        byDescribe.get(key.slice(0, Math.max(0, key.lastIndexOf(' > ')))),
      unstable: failed + retried,
      of: window.length,
      failed,
      retried,
      recent: window.map(o => ({
        run: o.run,
        status: o.passed ? (o.flaky ? 'flaky' : 'passed') : 'failed',
        seconds: o.seconds,
      })),
      lastFailure: last && {
        run: last.run,
        error: last.passed ? firstAttempt?.error : last.error,
        retried: last.passed,
      },
    })
  }
  // the most often unstable first; a tie goes to the one that wobbled last
  return out.sort(
    (a, b) =>
      b.unstable / b.of - a.unstable / a.of ||
      b.unstable - a.unstable ||
      (b.lastFailure?.run ?? '').localeCompare(a.lastFailure?.run ?? ''),
  )
}

// --- the module matrix ----------------------------------------------------------

export type MatrixCell = {
  run: string
  started: number
  passed: number
  failed: number
  skipped: number
  /** tests the run never reached (it was stopped or lost first) */
  open: number
  total: number
  failures: { key: string; error?: string }[]
}

/**
 * Spec files by device: each spec's newest run on each device, as long as at
 * least one of its tests passed or failed there (a run stopped before the
 * spec began says nothing about it).
 */
export function matrix(digests: Digest[], tests: PlannedTest[]) {
  const specs = [...new Set(tests.map(t => t.spec))].sort()
  const counts = new Map(
    specs.map(spec => [spec, tests.filter(t => t.spec === spec).length]),
  )
  const devices = new Map<string, Platform | undefined>()
  const cells: Record<string, Record<string, MatrixCell>> = {}
  for (const d of digests) {
    const s = d.summary
    if (s.status === 'running' || !s.device) continue
    if (!devices.has(s.device) || s.platform) devices.set(s.device, s.platform)
    const bySpec = new Map<string, Digest['tests']>()
    for (const t of d.tests) {
      if (!t.spec) continue
      bySpec.set(t.spec, [...(bySpec.get(t.spec) ?? []), t])
    }
    for (const [spec, list] of bySpec) {
      const ran = list.filter(
        t => t.status === 'passed' || t.status === 'failed',
      )
      if (!ran.length)
        continue
        // oldest first: a newer run overwrites
      ;(cells[spec] ??= {})[s.device] = {
        run: s.run,
        started: s.started,
        passed: list.filter(t => t.status === 'passed').length,
        failed: list.filter(t => t.status === 'failed').length,
        skipped: list.filter(t => t.status === 'skipped').length,
        open: list.filter(
          t => !['passed', 'failed', 'skipped'].includes(t.status),
        ).length,
        total: list.length,
        failures: list
          .filter(t => t.status === 'failed')
          .map(t => ({ key: t.key, error: t.error })),
      }
    }
  }
  // specs no longer there but run once still show, at the end
  const gone = Object.keys(cells)
    .filter(spec => !counts.has(spec))
    .sort()
  return {
    specs: [
      ...specs.map(spec => ({ spec, tests: counts.get(spec) ?? 0 })),
      ...gone.map(spec => ({ spec, tests: 0, gone: true })),
    ],
    devices: [...devices].map(([id, platform]) => ({ id, platform })),
    cells,
  }
}
