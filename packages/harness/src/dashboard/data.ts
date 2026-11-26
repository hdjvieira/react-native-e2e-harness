import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { OUT_DIR } from './env.js'
import { readEvents, readPlan, type RunEvent } from '../events.js'
import { isTargetTag, type PlannedTest, tagsIn } from '../plan.js'
import { HOOKS } from '../reports.js'
import { readTimings } from '../timing.js'
import type { Freeze } from '../watchdog.js'

// What the dashboard knows about tests and runs: everything comes from the
// run folders (out/<run>/), which every run writes anyway.

export type Attempt = {
  run: string
  passed: boolean
  skipped?: boolean
  needsPerson?: string
  error?: string
  seconds: number
  retries: number
  artifacts?: string
}

type ResultLine = Omit<Attempt, 'run'> & { title: string }

/**
 * The hook a result line stands for, when it is not a test: wdio.conf.ts
 * writes `<describe> > beforeEach` (and the other hooks) when a hook fails,
 * and `<spec> > session` when a spec's session never started. Neither is a
 * test, and counting them as one skews every pass rate.
 */
export function hookOf(title: string) {
  const at = title.lastIndexOf(' > ')
  if (at < 0) return undefined
  const last = title.slice(at + 3)
  return HOOKS.includes(last) || last === 'session' ? last : undefined
}

/** run folders, oldest first */
export function runs() {
  if (!existsSync(OUT_DIR)) return []
  return readdirSync(OUT_DIR, { withFileTypes: true })
    .filter(
      entry => entry.isDirectory() && /^\d{4}-\d\d-\d\dT/.test(entry.name),
    )
    .map(entry => entry.name)
    .sort()
}

function lines<T>(file: string): T[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as T]
      } catch {
        return []
      }
    })
}

export type History = Map<string, Attempt[]>

/**
 * A test's key across runs: its full title without the platform and device
 * tags, so a test keeps its history when one is added or dropped
 */
export const historyKey = (key: string) =>
  key.replace(/ (#[\w-]+)(?=\s|$)/g, (tag: string, name: string) =>
    isTargetTag(name) ? '' : tag,
  )

/** every recorded attempt of every test, oldest first, by test key */
export function readHistory(): History {
  const history: History = new Map()
  for (const run of runs()) {
    for (const line of lines<ResultLine>(join(OUT_DIR, run, 'results.jsonl'))) {
      const { title, ...attempt } = line
      const key = historyKey(title)
      history.set(key, [...(history.get(key) ?? []), { run, ...attempt }])
    }
  }
  return history
}

/** a test's result per run (the last attempt of each), newest last */
export function outcomes(attempts: Attempt[] = []) {
  const byRun = new Map<string, Attempt & { flaky: boolean }>()
  for (const attempt of attempts) {
    const earlier = byRun.get(attempt.run)
    byRun.set(attempt.run, {
      ...attempt,
      // failed, then passed on its retry
      flaky: !!earlier && !earlier.passed && attempt.passed,
    })
  }
  return [...byRun.values()]
}

const median = (values: number[]) => {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

export type Estimates = {
  /** a test's own typical duration, in seconds */
  test: (key: string) => number
  /**
   * what every test costs besides its body: its beforeEach and afterEach
   * hooks, app restarts included (they run inside those hooks), in seconds
   */
  overhead: number
  /** a describe's before and after hooks (sign-ins, uploads), in seconds */
  setup: number
  /** the start-up (preflight, sweep) and the sweep at the end, in seconds */
  start: number
  end: number
}

/**
 * Typical durations from past runs: each test's median attempt, the hooks
 * around tests and describes, start-up and end sweep. A test never run
 * counts as the median of all tests. `exclude` leaves a run out of its own
 * estimates, so they say how long a test takes elsewhere: a run measured
 * against itself always looks on pace.
 */
export function estimates(history: History, exclude?: string): Estimates {
  const perTest = new Map<string, number>()
  const all: number[] = []
  for (const [key, attempts] of history) {
    const seconds = attempts
      .filter(a => !a.skipped && a.run !== exclude)
      .map(a => a.seconds)
    const typical = median(seconds)
    if (typical !== undefined) {
      perTest.set(key, typical)
      all.push(...seconds)
    }
  }
  const fallback = median(all) ?? 60

  const timings = runs()
    .filter(run => run !== exclude)
    .flatMap(run => readTimings(join(OUT_DIR, run)))
  const msOf = (label: string) =>
    timings.filter(t => t.label === label).map(t => t.ms)
  const average = (label: string, fallbackSeconds: number) => {
    const ms = msOf(label)
    return ms.length
      ? ms.reduce((a, b) => a + b, 0) / ms.length / 1000
      : fallbackSeconds
  }
  // beforeEach/afterEach spread over every test body that ran: only some
  // describes have them, so an average per hook would overcount
  const bodies = msOf('test body').length
  const eachMs = [...msOf('hook: beforeEach'), ...msOf('hook: afterEach')]
  const overhead = bodies
    ? eachMs.reduce((a, b) => a + b, 0) / bodies / 1000
    : 0
  return {
    test: key => perTest.get(historyKey(key)) ?? fallback,
    overhead,
    setup: average('hook: before', 30) + average('hook: after', 0),
    start: average('preflight', 5) + average('sweep (start)', 5),
    end: average('sweep (end)', 5),
  }
}

export type TestState =
  | { status: 'queued' }
  | { status: 'running'; since: number }
  | {
      /**
       * failed once, its retry owed (rerun: the retry is running now). Not
       * `seconds`: that field marks a test as done (eta(), the page)
       */
      status: 'retrying'
      since: number
      error?: string
      artifacts?: string
      firstSeconds?: number
      rerun?: boolean
    }
  | {
      status: 'passed' | 'failed' | 'skipped'
      seconds: number
      error?: string
      artifacts?: string
      flaky: boolean
      /** a skip by needsPerson(): what someone has to do on the device first */
      needsPerson?: string
    }

export type RunState = {
  run: string
  plan: PlannedTest[]
  events: RunEvent[]
  states: Map<string, TestState>
  stage?: string
  /** what the run is doing between tests: a describe's before hook */
  step?: string
  /** the setup going on, to mark it in the list: a describe's before hook
   * (`setup`) or the beforeEach of its next test (`next`) */
  prep?: { kind: 'setup' | 'next'; describe: string; since: number }
  started?: number
  /** when the tests stage began, to measure this run's own pace */
  testsStarted?: number
  ended?: { at: number; stopped?: boolean; summary?: string; error?: string }
  device?: string
  cleanups: { done: string[]; failed: string[] }
  freezes: Freeze[]
  /** tests that ran although the plan didn't list them (a grep it missed) */
  extra: string[]
  /**
   * hooks that failed: an after hook's failure ends no test, but counts
   * (`session`: a spec whose session never started, in older runs)
   */
  hookFailures: {
    key: string
    hook: string
    error?: string
    /** its screen and UI tree, as results.jsonl names them */
    artifacts?: string
  }[]
}

type Final = Extract<TestState, { seconds: number }>

/**
 * Ends every test still open: running or owing a retry (failed, `reason`),
 * and those never started (`queued`, if given).
 */
export function finalise(state: RunState, reason: string, queued?: Final) {
  for (const [key, test] of state.states) {
    if (test.status === 'running') {
      state.states.set(key, {
        status: 'failed',
        seconds: 0,
        error: reason,
        flaky: false,
      })
    } else if (test.status === 'retrying') {
      state.states.set(key, {
        status: 'failed',
        seconds: test.firstSeconds ?? 0,
        // a retry cut short: the reason; one never begun: attempt 1's error
        error: test.rerun ? reason : test.error,
        artifacts: test.artifacts,
        flaky: false,
      })
    } else if (test.status === 'queued' && queued) {
      state.states.set(key, queued)
    }
  }
}

/** a run as its folder says it is now */
export function readRun(run: string): RunState {
  const dir = join(OUT_DIR, run)
  const events = readEvents(dir)
  // runs from before the dashboard have no plan and no events: their
  // results are all there is, which is enough to show how each test ended
  const results = lines<ResultLine>(join(dir, 'results.jsonl'))
  const plan = readPlan(dir)
  if (!plan.length && !events.length) return fromResults(run, results)
  const states = new Map<string, TestState>(
    plan.map(test => [test.key, { status: 'queued' }]),
  )
  const state: RunState = {
    run,
    plan,
    events,
    states,
    cleanups: { done: [], failed: [] },
    freezes: lines<Freeze>(join(dir, 'freezes.jsonl')),
    extra: [],
    hookFailures: [],
  }
  const failedOnce = new Set<string>()
  // one test at a time (maxInstances 1): the one that started last
  let current: string | undefined

  // A before hook that failed or skipped ends its describe's tests, which
  // never start. The runner sends a test-end for each; this is for anything
  // it missed. The plan's describe is
  // the whole chain of titles, the hook's parent its own title only.
  const settle = (
    event: { key: string; hook: string; parent?: string },
    status: 'failed' | 'skipped',
    error: string,
  ) => {
    const parent =
      event.parent ?? event.key.slice(0, event.key.lastIndexOf(' > '))
    for (const test of plan) {
      const s = states.get(test.key)
      if (!` ${test.describe} `.includes(` ${parent} `)) continue
      if (s?.status === 'queued' || s?.status === 'retrying') {
        states.set(test.key, { status, seconds: 0, error, flaky: false })
      }
    }
  }

  for (const event of events) {
    state.started ??= event.at
    // the first run-end decides: a launcher stopped on macOS still shuts
    // down in order and its late spec-end or summary would rewrite the stop.
    // Clean-ups are still worth listing
    if (state.ended && event.type !== 'cleanup') continue
    switch (event.type) {
      case 'stage':
        state.stage = event.stage
        state.step = undefined
        state.prep = undefined
        if (event.stage === 'tests') state.testsStarted = event.at
        break
      case 'run-start':
        state.device = event.device
        break
      case 'spec-start':
        state.step = `starting the session: ${event.specs.join(', ')}`
        break
      case 'spec-end':
        state.step = undefined
        state.prep = undefined
        // a worker that died before its tests (no session, a crash): they
        // would wait forever. A spec whose tests failed exits 1 too, but its
        // tests have their states by now
        if (event.exitCode !== 0) {
          for (const test of plan) {
            if (
              event.specs.includes(test.spec) &&
              states.get(test.key)?.status === 'queued'
            ) {
              states.set(test.key, {
                status: 'failed',
                seconds: 0,
                error: `spec did not run: exit ${event.exitCode}`,
                flaky: false,
              })
            }
          }
        }
        break
      case 'hook-start': {
        // older runs sent the hook's title, which starts with a quote
        const describe = event.describe ?? event.key.split(' > "')[0]
        if (event.hook === 'before') {
          state.step = `setting up: ${describe}`
          state.prep = { kind: 'setup', describe, since: event.at }
        } else if (event.hook === 'beforeEach') {
          state.step = `preparing the next test: ${describe}`
          state.prep = { kind: 'next', describe, since: event.at }
        }
        break
      }
      case 'test-start': {
        state.step = undefined
        state.prep = undefined
        if (!states.has(event.key)) state.extra.push(event.key)
        // anything else still open never got its end or its retry: Mocha
        // retries a test before it starts another (and with retries(0)
        // under E2E_CHAIN_STOP, or --mochaOpts.retries 0, none comes)
        for (const [key, s] of states) {
          if (key === event.key) continue
          if (s.status === 'running') {
            states.set(key, {
              status: 'failed',
              seconds: 0,
              error: 'never ended',
              flaky: false,
            })
          } else if (s.status === 'retrying') {
            states.set(key, {
              status: 'failed',
              seconds: s.firstSeconds ?? 0,
              error: s.rerun ? 'its retry never ended' : s.error,
              artifacts: s.artifacts,
              flaky: false,
            })
          }
        }
        const earlier = states.get(event.key)
        if (earlier?.status === 'retrying') {
          states.set(event.key, { ...earlier, since: event.at, rerun: true })
        } else if (earlier?.status === 'running') {
          // started again with no end: the attempt timed out and Mocha
          // retries it (its afterTest may still come, late)
          failedOnce.add(event.key)
          states.set(event.key, {
            status: 'retrying',
            since: event.at,
            error: 'timed out',
            firstSeconds: Math.round((event.at - earlier.since) / 1000),
            rerun: true,
          })
        } else {
          states.set(event.key, { status: 'running', since: event.at })
        }
        current = event.key
        break
      }
      case 'test-end': {
        const now = states.get(event.key)
        const failed = !event.passed && !event.skipped
        // older runs: a failed first attempt was retried (mochaOpts.retries 1)
        const final = event.final ?? event.retries !== 0
        if (failed && !final) {
          if (now?.status === 'running' && event.key === current) {
            failedOnce.add(event.key)
            states.set(event.key, {
              status: 'retrying',
              since: event.at,
              error: event.error,
              artifacts: event.artifacts,
              firstSeconds: event.seconds,
            })
            break
          }
          if (now?.status === 'retrying') {
            // the late end of a timed-out attempt, its retry under way: keep
            // its error and screen for the row, and wait for the retry
            states.set(event.key, {
              ...now,
              error: event.error ?? now.error,
              artifacts: event.artifacts ?? now.artifacts,
            })
            break
          }
          // a test that has ended already keeps its end
          if (now && 'seconds' in now) break
          // anything else (a late end of a test no longer current) is final
        }
        states.set(event.key, {
          status: event.skipped
            ? 'skipped'
            : event.passed
              ? 'passed'
              : 'failed',
          seconds: event.seconds,
          error: event.error,
          artifacts:
            event.artifacts ??
            (failed && now?.status === 'retrying' ? now.artifacts : undefined),
          flaky: event.passed && failedOnce.has(event.key),
          needsPerson: event.needsPerson,
        })
        break
      }
      case 'hook-fail':
        state.step = `${event.hook} failed: ${event.error ?? ''}`
        state.prep = undefined
        state.hookFailures.push({
          key: event.key,
          hook: event.hook,
          error: event.error,
          // the event names no screenshot; its results line does
          artifacts: [...results]
            .reverse()
            .find(r => r.title === event.key && !r.passed)?.artifacts,
        })
        // a failed afterEach aborts the rest of its describe too
        if (/^before/i.test(event.hook) || event.hook === 'afterEach') {
          settle(event, 'failed', `${event.hook} failed: ${event.error ?? ''}`)
        }
        break
      case 'hook-skip':
        // a beforeEach skip skips only its own test, which got its test-end
        if (event.hook === 'before') {
          settle(event, 'skipped', `skipped by its ${event.hook} hook`)
        }
        break
      case 'cleanup':
        state.cleanups = {
          done: [...state.cleanups.done, ...event.done],
          failed: [...state.cleanups.failed, ...event.failed],
        }
        break
      case 'run-end':
        state.ended = {
          at: event.at,
          stopped: event.stopped,
          summary: event.summary,
          error: event.error,
        }
        break
    }
  }
  // an ended run has nothing open: a test still "retrying" never got its
  // retry, and one never started is said so (failed when nothing explains it)
  if (state.ended) {
    const { stopped, error } = state.ended
    finalise(
      state,
      stopped ? 'stopped' : 'never ended',
      stopped
        ? {
            status: 'skipped',
            seconds: 0,
            error: 'stopped before it ran',
            flaky: false,
          }
        : error
          ? {
              status: 'skipped',
              seconds: 0,
              error: `not run: ${error}`,
              flaky: false,
            }
          : { status: 'failed', seconds: 0, error: 'never ran', flaky: false },
    )
  }
  return state
}

/** a run known only by its results.jsonl (one line per attempt) */
function fromResults(run: string, results: ResultLine[]): RunState {
  const plan: PlannedTest[] = []
  const states = new Map<string, TestState>()
  const hookFailures: RunState['hookFailures'] = []
  for (const result of results) {
    // a failed hook is not a test: it goes where a run with a plan puts it
    const hook = hookOf(result.title)
    if (hook) {
      if (!result.passed && !result.skipped) {
        hookFailures.push({
          key: result.title,
          hook,
          error: result.error,
          artifacts: result.artifacts,
        })
      }
      continue
    }
    const [describe, ...rest] = result.title.split(' > ')
    const title = rest.join(' > ') || describe
    if (!states.has(result.title)) {
      plan.push({
        key: result.title,
        spec: '',
        describe,
        title,
        tags: tagsIn(result.title),
      })
    }
    const earlier = states.get(result.title)
    states.set(result.title, {
      status: result.skipped ? 'skipped' : result.passed ? 'passed' : 'failed',
      seconds: result.seconds,
      error: result.error,
      artifacts: result.artifacts,
      needsPerson: result.needsPerson,
      flaky:
        result.passed &&
        !!earlier &&
        'seconds' in earlier &&
        !earlier.flaky &&
        earlier.status === 'failed',
    })
  }
  let ended: RunState['ended']
  try {
    const stat = statSync(join(OUT_DIR, run, 'summary.md'))
    ended = { at: stat.mtimeMs, summary: join(OUT_DIR, run, 'summary.md') }
  } catch {
    ended = undefined
  }
  return {
    run,
    plan,
    events: [],
    states,
    ended,
    cleanups: { done: [], failed: [] },
    freezes: lines<Freeze>(join(OUT_DIR, run, 'freezes.jsonl')),
    extra: [],
    hookFailures,
  }
}

export type Eta = { remaining: number; finishAt: number } | undefined

const clamp = (min: number, max: number, n: number) =>
  Math.min(max, Math.max(min, n))

/**
 * Seconds left in a run: the test running now (its typical time less what it
 * has taken), the queued ones with their beforeEach/afterEach and their
 * describes' setups, any retry still owed, and the end sweep; scaled by how
 * this run is going against past ones.
 */
export function eta(state: RunState, est: Estimates, now = Date.now()): Eta {
  if (state.ended || !state.plan.length) return undefined
  const done = state.plan.filter(t => {
    const s = state.states.get(t.key)
    // a test a hook ended (0 s) says nothing about the pace
    return s && 'seconds' in s && s.seconds > 0
  })
  const startedDescribes = new Set<string>()
  for (const test of state.plan) {
    const s = state.states.get(test.key)!
    if (s.status !== 'queued') startedDescribes.add(test.describe)
  }

  // How this run compares with the past (a slower phone, a busy network).
  // Best measured on the wall clock up to the last test that ended, which
  // takes in the hooks and session starts too; failing that, test bodies only
  let pace = 1
  const lastEnd = state.events.reduce(
    (at, e) => (e.type === 'test-end' ? Math.max(at, e.at) : at),
    0,
  )
  const doneDescribes = new Set(done.map(t => t.describe))
  const predicted =
    done.reduce((sum, t) => sum + est.test(t.key) + est.overhead, 0) +
    doneDescribes.size * est.setup
  if (
    state.testsStarted &&
    done.length >= 2 &&
    lastEnd > state.testsStarted &&
    predicted > 0
  ) {
    pace = clamp(0.6, 2.5, (lastEnd - state.testsStarted) / 1000 / predicted)
  } else {
    const ratios = done.map(t => {
      const s = state.states.get(t.key) as Final
      return s.seconds / est.test(t.key)
    })
    if (ratios.length) {
      pace = clamp(0.6, 1.8, ratios.reduce((a, b) => a + b, 0) / ratios.length)
    }
  }

  let remaining = 0
  if (
    !state.stage ||
    state.stage === 'preflight' ||
    state.stage === 'sweep (start)'
  ) {
    remaining += est.start
  }
  const pendingDescribes = new Set<string>()
  for (const test of state.plan) {
    const s = state.states.get(test.key)!
    const typical = (est.test(test.key) + est.overhead) * pace
    if (s.status === 'queued') {
      remaining += typical
      if (!startedDescribes.has(test.describe))
        pendingDescribes.add(test.describe)
    } else if (s.status === 'running') {
      remaining += Math.max(5, typical - (now - s.since) / 1000)
    } else if (s.status === 'retrying') {
      // its retry is owed (with the same beforeEach), or running now
      remaining += s.rerun
        ? Math.max(5, typical - (now - s.since) / 1000)
        : typical
    }
  }
  remaining += pendingDescribes.size * est.setup * pace + est.end
  return { remaining, finishAt: now + remaining * 1000 }
}

/**
 * Each test attempt on the wall clock, in the order they ran: the run page's
 * time bar. A retry is a second attempt of the same key; an attempt with no
 * end (cut off, or running now) ends where the next one starts, or not yet.
 */
export function attempts(state: RunState) {
  const out: { key: string; start: number; end?: number }[] = []
  for (const event of state.events) {
    if (state.ended && event.at > state.ended.at) break
    if (event.type === 'test-start') {
      const open = out[out.length - 1]
      if (open && open.end === undefined) open.end = event.at
      out.push({ key: event.key, start: event.at })
    } else if (event.type === 'test-end') {
      // the attempt it ends: the one that started `seconds` before it (a
      // timed-out attempt's late end comes while its retry runs)
      const began = event.at - (event.seconds ?? 0) * 1000
      let match: (typeof out)[number] | undefined
      for (const attempt of out) {
        if (attempt.key !== event.key || attempt.start > event.at) continue
        if (
          !match ||
          Math.abs(attempt.start - began) < Math.abs(match.start - began)
        )
          match = attempt
      }
      if (match && (match.end === undefined || match.end > event.at))
        match.end = event.at
    }
  }
  return out
}

// Failures the dev has looked at (`m` in the dashboard): by test key, the run
// whose failure was reviewed. A newer failure shows as new again.
const REVIEWED = join(OUT_DIR, 'reviewed.json')

export function readReviewed(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(REVIEWED, 'utf8'))
  } catch {
    return {}
  }
}

export function toggleReviewed(key: string, run: string) {
  const reviewed = readReviewed()
  if (reviewed[key] === run) delete reviewed[key]
  else reviewed[key] = run
  writeFileSync(REVIEWED, JSON.stringify(reviewed, null, 2))
  return reviewed
}

/**
 * What was on screen when a test failed, as text: the testIDs the UI tree
 * holds as displayed (a terminal can't show the screenshot itself).
 */
export function onScreenIds(artifacts: string) {
  const xml = `${artifacts}.xml`
  if (!existsSync(xml)) return []
  const source = readFileSync(xml, 'utf8')
  const ids = new Set<string>()
  // Android: resource-id; iOS: name
  for (const match of source.matchAll(
    /<[^>]*?(?:resource-id|name)="([^"]+)"[^>]*>/g,
  )) {
    const tag = match[0]
    if (/displayed="false"|visible="false"/.test(tag)) continue
    const id = match[1]
    if (id.startsWith('android:') || id.includes(':id/')) continue
    ids.add(id)
  }
  return [...ids]
}
