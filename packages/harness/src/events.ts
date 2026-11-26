import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import type { PlannedTest } from './plan.js'

// A run's live log: what the run is doing as it does it, one JSON line per
// event in out/<run>/events.jsonl. results.jsonl only gets a test once it has
// ended; this also says which one is running now and which stage the run is
// in. out/current.json names the run going on.

export type RunEvent = { at: number } & (
  | { type: 'run-start'; device?: string; platform?: string }
  | { type: 'stage'; stage: Stage }
  | { type: 'test-start'; key: string }
  | {
      type: 'test-end'
      key: string
      passed: boolean
      skipped?: boolean
      /** ended by needsPerson(): what someone has to do on the device first */
      needsPerson?: string
      error?: string
      seconds: number
      /** earlier attempts of this test in the run: 0 on the first */
      retries: number
      /**
       * no retry follows this attempt: it passed, was skipped, used up its
       * retries, or the test turned them off (this.retries(0))
       */
      final?: boolean
      artifacts?: string
    }
  | { type: 'hook-start'; key: string; hook: string; describe?: string }
  | {
      type: 'hook-fail'
      key: string
      hook: string
      /** the describe the hook belongs to */
      parent?: string
      error?: string
    }
  /** a before hook called this.skip(): its tests end without ever starting */
  | { type: 'hook-skip'; key: string; hook: string; parent?: string }
  /** a worker starting a spec's session, and its end (exit 0: it ran clean) */
  | { type: 'spec-start'; specs: string[] }
  | { type: 'spec-end'; specs: string[]; exitCode: number }
  | { type: 'cleanup'; done: string[]; failed: string[] }
  | {
      type: 'run-end'
      stopped?: boolean
      summary?: string
      /** why the run ended before its tests (a failed preflight) */
      error?: string
    }
)

export type Stage = 'preflight' | 'sweep (start)' | 'tests' | 'sweep (end)'

/** a spec as WDIO hands it over (a path or a file: URL), named as the plan names it */
export const specKey = (spec: string) =>
  relative(
    config().dir,
    spec.startsWith('file:') ? fileURLToPath(spec) : spec,
  ).replace(/\\/g, '/')

/** without an `at`, each member of the union keeps its own fields */
type Emitted = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, 'at'>
    : never
  : never

export function emit(event: Emitted, runDir = process.env.E2E_RUN_DIR) {
  if (!runDir) return
  appendFileSync(
    join(runDir, 'events.jsonl'),
    JSON.stringify({ at: Date.now(), ...event }) + '\n',
  )
}

/** a run's JSON-lines file, skipping a line still being written */
export function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
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

export const readEvents = (runDir: string) =>
  readJsonLines<RunEvent>(join(runDir, 'events.jsonl'))

/** the tests this run is to run, in order */
export function writePlan(runDir: string, tests: PlannedTest[]) {
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify(tests, null, 2))
}

export function readPlan(runDir: string): PlannedTest[] {
  try {
    return JSON.parse(readFileSync(join(runDir, 'plan.json'), 'utf8'))
  } catch {
    return []
  }
}

export type CurrentRun = { run: string; pid: number; started: number }

const currentFile = () => join(config().outDir, 'current.json')

/** the run going on: its folder name and the launcher's pid, to stop it */
export function setCurrentRun(current: CurrentRun | undefined) {
  mkdirSync(config().outDir, { recursive: true })
  writeFileSync(currentFile(), current ? JSON.stringify(current) : '{}')
}

/**
 * Clears current.json only while it still names `run`: a run that ends (or
 * is stopped) late must not wipe out a newer run that took the slot.
 */
export function clearCurrentRun(run: string) {
  if (readCurrentRun()?.run === run) setCurrentRun(undefined)
}

export function readCurrentRun(): CurrentRun | undefined {
  try {
    const current = JSON.parse(readFileSync(currentFile(), 'utf8'))
    return current.run ? current : undefined
  } catch {
    return undefined
  }
}
