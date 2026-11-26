import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonLines } from './events.js'

// How long each piece of a run takes, so every speed-up is judged by numbers
// (and per platform: one that helps on Android may not on iOS).
//
// Helpers wrap their slow steps in `measure()` (restarts, sign-ins, opening a
// screen); the runner adds the hooks and the test bodies, and the summary
// totals them per label. Lines go to out/<run>/timing.jsonl.

export type Timing = { label: string; ms: number }

export function record(label: string, ms: number) {
  const runDir = process.env.E2E_RUN_DIR
  if (runDir)
    appendFileSync(
      join(runDir, 'timing.jsonl'),
      JSON.stringify({ label, ms }) + '\n',
    )
}

/**
 * Runs `step` and records how long it took under `label` (or under what
 * `label` returns, for a step that only knows its kind once done, such as a
 * restart that was a reload or a cold start).
 */
export async function measure<T>(
  label: string | ((result: T) => string),
  step: () => Promise<T>,
): Promise<T> {
  const started = Date.now()
  const result = await step()
  record(
    typeof label === 'string' ? label : label(result),
    Date.now() - started,
  )
  return result
}

export const readTimings = (runDir: string) =>
  readJsonLines<Timing>(join(runDir, 'timing.jsonl'))

export type TimingTotals = {
  label: string
  count: number
  totalSeconds: number
  averageSeconds: number
}[]

/** per label: how many times, in total and on average; slowest first */
export function totals(timings: Timing[]): TimingTotals {
  const byLabel = new Map<string, number[]>()
  for (const { label, ms } of timings) {
    byLabel.set(label, [...(byLabel.get(label) ?? []), ms])
  }
  return [...byLabel.entries()]
    .map(([label, values]) => {
      const total = values.reduce((sum, ms) => sum + ms, 0)
      return {
        label,
        count: values.length,
        totalSeconds: Math.round(total / 100) / 10,
        averageSeconds: Math.round(total / values.length / 100) / 10,
      }
    })
    .sort((a, b) => b.totalSeconds - a.totalSeconds)
}
