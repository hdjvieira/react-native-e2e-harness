import { execFileSync } from 'node:child_process'
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { config } from './config.js'
import { readJsonLines } from './events.js'
import { globToRegex } from './plan.js'

// What each run in out/ was run against, and when a run's report can go.
//
// Every run writes out/<run>/run.json: the app installed on the device, the
// git branch and commit the code came from, and its release:
// - "1.4.0": the commit shipped in that release (the first tag holding it);
// - ">1.4.0 (in main, unreleased)": merged after the last tag;
// - ">1.4.0 (unreleased)": not in the main branch yet (a feature branch).
//   This is what a debug build's own version can't say: a branch keeps the
//   version of the last release until the next one bumps it.
//
// A report is pruned at the start of a run (or with `e2e-harness reports
// --prune`) once its code is in the main branch and nothing in it is still
// worth reading: every test passed, or each one that failed has passed in a
// later run (fixed), or its describe no longer exists in the specs (the check
// was removed). A failure that never passed again is a bug still open: its
// report stays, screenshots and all. Nobody has to mark anything by hand.

export type Status = 'pass' | 'fail' | 'skip'

export type RunInfo = {
  /** Android or iOS: a speed-up proven on one may not hold on the other */
  platform?: string
  app?: {
    version?: string
    versionCode?: string
    debuggable?: boolean
  }
  git: {
    branch?: string
    commit?: string
    /** uncommitted changes: a debug build runs whatever Metro serves */
    dirty?: boolean
  }
  release: string
}

/**
 * The version of what a run writes (run.json, results.jsonl, events.jsonl,
 * the tags in titles). Bump it with any change an older run can't be read
 * as, and teach readRun to convert the older format: runs outlive releases
 * of the harness.
 */
export const RUN_FORMAT = 1

export type RunRecord = RunInfo & {
  /** RUN_FORMAT when written; set by writeRun */
  format?: number
  run: string
  results: { title: string; status: Status }[]
  /** where the run's time went */
  timing?: {
    runSeconds: number
    steps: { label: string; count: number; totalSeconds: number }[]
  }
}

function git(...args: string[]) {
  try {
    return execFileSync('git', args, {
      cwd: config().appDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30000,
    }).trim()
  } catch {
    return undefined
  }
}

/** E2E_MAIN_REF stands in for the main ref (e.g. HEAD), to try the pruning rules */
const mainRef = () => process.env.E2E_MAIN_REF ?? config().mainRef

/** how the runner names a failed hook's result */
export const HOOKS = ['before', 'beforeEach', 'after', 'afterEach', 'hook']

/** best effort: the release labels and the pruning read the main ref */
export function fetchMain() {
  const [remote, ...branch] = mainRef().split('/')
  if (branch.length) git('fetch', '-q', remote, branch.join('/'))
}

function isInMain(commit: string) {
  return git('merge-base', '--is-ancestor', commit, mainRef()) !== undefined
}

/** the release a commit belongs to, as far as the main ref and its tags tell */
export function releaseOf(commit?: string) {
  const latest = git('describe', '--tags', '--abbrev=0', mainRef()) ?? '?'
  if (!commit || !isInMain(commit)) return `>${latest} (unreleased)`
  const shipped = git('tag', '--contains', commit, '--sort=creatordate')
    ?.split('\n')
    .filter(Boolean)[0]
  return shipped ?? `>${latest} (in main, unreleased)`
}

/** where the code under test comes from, right now */
export function currentGit(): RunInfo['git'] {
  return {
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    commit: git('rev-parse', '--short', 'HEAD'),
    dirty: !!git('status', '--porcelain', '--untracked-files=no'),
  }
}

/** one line for the top of summary.md */
export function describeRun({ app, git, platform, release }: RunInfo) {
  const appText = app
    ? `app ${app.version ?? '?'}${app.versionCode ? ` (${app.versionCode})` : ''}${app.debuggable ? ', debug' : ''}`
    : 'app unknown'
  const code = `${git.branch ?? '?'} @ ${git.commit ?? '?'}${git.dirty ? ' + uncommitted changes' : ''}`
  return `Release ${release} · ${platform ?? '?'} · ${appText} · ${code}`
}

/** the run folders in out/, oldest first */
export function runDirs() {
  const { outDir } = config()
  return existsSync(outDir)
    ? readdirSync(outDir)
        .filter(name => /^\d{4}-\d{2}-\d{2}T/.test(name))
        .filter(name => statSync(join(outDir, name)).isDirectory())
        .sort()
    : []
}

/** the last attempt of each test, from a run's results.jsonl */
export function resultsOf(dir: string): RunRecord['results'] {
  const attempts = readJsonLines<{
    title: string
    passed: boolean
    skipped?: boolean
  }>(join(dir, 'results.jsonl'))
  const last = new Map(attempts.map(r => [r.title, r]))
  return [...last.values()].map(r => ({
    title: r.title,
    status: r.passed ? 'pass' : r.skipped ? 'skip' : 'fail',
  }))
}

export function readRun(run: string): RunRecord {
  const file = join(config().outDir, run, 'run.json')
  if (existsSync(file)) {
    const record = JSON.parse(readFileSync(file, 'utf8')) as RunRecord
    if (record.format === undefined) {
      throw new Error(
        `${run}: run.json has no format: written by something else than this harness`,
      )
    }
    if (record.format > RUN_FORMAT) {
      throw new Error(
        `${run}: written by a newer harness (format ${record.format}, this one reads ${RUN_FORMAT}): update react-native-e2e-harness`,
      )
    }
    return record
  }
  // a run that died before writing it: what its results say, no more
  return {
    format: RUN_FORMAT,
    run,
    git: {},
    release: '?',
    results: resultsOf(join(config().outDir, run)),
  }
}

export function writeRun(record: RunRecord) {
  writeFileSync(
    join(config().outDir, record.run, 'run.json'),
    JSON.stringify({ ...record, format: RUN_FORMAT }, null, 2),
  )
}

/** the specs' source today, to tell whether a describe or test still exists */
function specSources() {
  const { dir, specs } = config()
  const pattern = globToRegex(specs)
  const files: string[] = []
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const path = join(folder, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (pattern.test(relative(dir, path).replace(/\\/g, '/')))
        files.push(path)
    }
  }
  walk(dir)
  return files.map(file => readFileSync(file, 'utf8')).join('\n')
}

/**
 * The reports to delete. `keep` is a run still in progress: never pruned,
 * but its passes count as fixes.
 */
export function prunable(keep?: string) {
  // a run this harness can't read is kept, never guessed at
  const runs = runDirs().flatMap(run => {
    try {
      return [readRun(run)]
    } catch {
      return []
    }
  })
  const sources = specSources()
  const literal = (text: string) =>
    sources.includes(`'${text}'`) ||
    sources.includes(`"${text}"`) ||
    sources.includes(`\`${text}\``)
  // a run in progress has no results in run.json yet: read its attempts
  const results = (record: RunRecord) =>
    record.results.length
      ? record.results
      : resultsOf(join(config().outDir, record.run))

  /** a failure that still says something: not fixed since, and the check still exists */
  const isOpen = (title: string, later: RunRecord[]) => {
    const [describe, ...rest] = title.split(' > ')
    const test = rest.join(' > ')
    const laterResults = later.flatMap(results)
    // passed since, even after moving to another describe
    if (
      laterResults.some(
        o =>
          o.status === 'pass' &&
          (o.title === title || o.title.endsWith(` > ${test}`)),
      )
    ) {
      return false
    }
    // the whole describe was removed or renamed
    if (!literal(describe)) return false
    // a failed hook: fixed once its describe passes
    if (HOOKS.includes(test)) {
      return !laterResults.some(
        o => o.title.startsWith(`${describe} > `) && o.status === 'pass',
      )
    }
    // a renamed or removed test: neither in the source (titles built with
    // ${…} never are) nor run since under the same name
    return literal(test) || laterResults.some(o => o.title === title)
  }

  return runs.flatMap(record => {
    if (record.run === keep) return []
    if (!record.git.commit || !isInMain(record.git.commit)) return []
    const later = runs.filter(other => other.run > record.run)
    const open = results(record).filter(
      r => r.status === 'fail' && isOpen(r.title, later),
    )
    return open.length ? [] : [record.run]
  })
}

export function prune(keep?: string) {
  const runs = prunable(keep)
  for (const run of runs)
    rmSync(join(config().outDir, run), { recursive: true, force: true })
  return runs
}
