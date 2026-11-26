import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ChainLine } from './chain.js'
import { readJsonLines } from './events.js'
import { describeRun, readRun, resultsOf, writeRun } from './reports.js'
import { readTimings, totals } from './timing.js'
import { describeFreeze, type Freeze } from './watchdog.js'

// The end of a run: out/<run>/summary.md, read by a person or an agent, and
// the results and timing written into run.json.

export type TestResult = {
  title: string
  passed: boolean
  /** this.skip(): the spec decided the check doesn't apply */
  skipped?: boolean
  /** ended by needsPerson(): what someone has to do on the device first */
  needsPerson?: string
  error?: string
  retries: number
  seconds: number
  /** the failure's screenshot and UI tree, without extension */
  artifacts?: string
}

export type Sweep = { swept: string[]; error?: string }

export function writeSummary(runDir: string, runSeconds: number, sweep: Sweep) {
  const lines = (file: string) => readJsonLines(join(runDir, file))
  // a retried test logs one line per attempt: the last one is its result
  const attempts = lines('results.jsonl') as TestResult[]
  const results = [...new Map(attempts.map(r => [r.title, r])).values()]
  const cleanups = lines('cleanup.jsonl') as {
    done: string[]
    failed: string[]
  }[]
  // never just a flaky retry: a user's app would have frozen the same way
  const freezes = lines('freezes.jsonl') as Freeze[]
  const chainLines = lines('chain.jsonl') as ChainLine[]
  const starts = (title: string) =>
    chainLines
      .filter(c => c.title === title)
      .map(c => (c.reason ? `${c.start}: ${c.reason}` : c.start))
  const chainCounts = (['continued', 'rebuilt', 'retried'] as const)
    .map(
      start =>
        [start, chainLines.filter(c => c.start === start).length] as const,
    )
    .filter(([, count]) => count)
    .map(([start, count]) => `${count} ${start}`)

  const passed = results.filter(r => r.passed)
  const waiting = results.filter(r => r.needsPerson)
  const skipped = results.filter(r => r.skipped && !r.needsPerson)
  const failed = results.filter(r => !r.passed && !r.skipped)
  const verdict = (r: TestResult) =>
    r.passed
      ? 'PASS'
      : r.needsPerson
        ? 'NEEDS A PERSON'
        : r.skipped
          ? 'SKIP'
          : 'FAIL'
  const retried = attempts.filter(
    r => !r.passed && results.find(f => f.title === r.title)?.passed,
  )
  const timing = totals(readTimings(runDir))
  const record = readRun(basename(runDir))
  writeRun({
    ...record,
    results: resultsOf(runDir),
    timing: { runSeconds, steps: timing },
  })
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? '' : 's'}`

  const text = [
    `# e2e run ${record.run}`,
    '',
    describeRun(record),
    '',
    `**${passed.length} passed, ${failed.length} failed**${waiting.length ? `, ${waiting.length} need a person first` : ''}${skipped.length ? `, ${skipped.length} skipped` : ''}${retried.length ? `, ${retried.length} passed on retry` : ''}`,
    '',
    ...results.map(
      r =>
        `- ${verdict(r)} ${r.title} (${r.seconds}s${r.retries ? `, retry ${r.retries}` : ''}${starts(r.title).length ? `; ${starts(r.title).join(' → ')}` : ''})${r.needsPerson ? `\n  - ${r.needsPerson}` : ''}${r.error ? `\n  - ${r.error}` : ''}${r.artifacts ? `\n  - screen + UI tree: ${r.artifacts}.png/.xml` : ''}`,
    ),
    // not passed and not failed: what someone has to do before the next run
    ...(waiting.length
      ? [
          '',
          `## Needs a person first (${waiting.length})`,
          ...[...new Set(waiting.map(r => r.needsPerson))].map(
            what =>
              `- ${what} (${plural(waiting.filter(r => r.needsPerson === what).length, 'test')})`,
          ),
        ]
      : []),
    ...(retried.length
      ? ['', '## Retried', ...retried.map(r => `- ${r.title}: ${r.error}`)]
      : []),
    ...(freezes.length
      ? [
          '',
          `## App froze (${freezes.length})`,
          ...freezes.map(f => `- ${f.test}: ${describeFreeze(f)}`),
        ]
      : []),
    ...(chainCounts.length
      ? ['', `Chained tests: ${chainCounts.join(', ')}`]
      : []),
    '',
    '## Clean-up',
    ...cleanups.flatMap(c => c.done.map(label => `- ${label}`)),
    ...cleanups.flatMap(c =>
      c.failed.map(failure => `- **FAILED** ${failure}`),
    ),
    `- sweep at the end: ${sweep.error ? `**FAILED** ${sweep.error}` : sweep.swept.length ? sweep.swept.join(', ') : 'nothing left behind'}`,
    '',
    // judge every speed-up by these, per platform
    `## Timing (${Math.floor(runSeconds / 60)}m${runSeconds % 60}s in all)`,
    '',
    '| step | times | total | average |',
    '|---|---|---|---|',
    ...timing.map(
      t =>
        `| ${t.label} | ${t.count} | ${t.totalSeconds}s | ${t.averageSeconds}s |`,
    ),
  ].join('\n')
  const path = join(runDir, 'summary.md')
  writeFileSync(path, text + '\n')
  return { path, text }
}
