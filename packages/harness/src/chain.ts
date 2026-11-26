import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { record } from './timing.js'

// Chained tests: a test carries on from the screen the test before it left,
// instead of starting the app over and walking back to where it begins. It
// stays a valid test because each one:
// - names where it begins (`Start`): a cheap check that the app is there,
//   and `arrive()`, the fastest way there from anywhere (a restart included);
// - carries on only when the chained test before it passed AND the check
//   holds; otherwise it arrives first, so a failure upstream costs one
//   rebuild here, not a cascade of failures that aren't this test's;
// - arrives again before a retry: a retry never trusts the screen its failed
//   attempt left.
// The first test of a chain always arrives. Keep terminal steps (leaving the
// flow, anything destructive) last.
//
// Every test's start (continued / rebuilt / retried) goes into the summary
// and the timing table, so it shows whether chaining pays.
//
// E2E_CHAIN_STOP=1, for debugging: the first failure ends the chain, with no
// retry, and the tests after it skip, leaving the screen as the failure left
// it.

export type Start = {
  /**
   * Is the app at this starting point now? A position (which screen or step,
   * what the previous test is known to have left there), never what the test
   * itself asserts, or a regression would pass as "start missed".
   */
  check: () => Promise<boolean>
  /** gets there from anywhere */
  arrive: () => Promise<void>
}

export type ChainStart = 'continued' | 'rebuilt' | 'retried'

/** one line per attempt in out/<run>/chain.jsonl */
export type ChainLine = { title: string; start: ChainStart; reason?: string }

/**
 * A chain of tests, in the order they are declared; one per spec file is
 * typical, and it may run through several describes as long as nothing
 * between them moves the app (a describe's before() must leave the screen
 * as it is).
 *
 *   const chained = chain()
 *   chained('edits the title', atEditor, async () => { ... })
 */
export function chain() {
  const stop = process.env.E2E_CHAIN_STOP === '1'
  /** the chained test before passed: its screen can be trusted */
  let intact = false
  /** a chained test has run: a broken chain is now a failure's doing */
  let begun = false
  let stopped = false
  const attempts = new Map<string, number>()

  return function chained(
    title: string,
    start: Start,
    body: (this: Mocha.Context) => Promise<void>,
  ) {
    it(title, async function () {
      const name = `${this.test?.parent?.title} > ${title}`
      const attempt = attempts.get(name) ?? 0
      attempts.set(name, attempt + 1)
      if (stop) {
        this.retries(0)
        if (stopped) this.skip()
      }

      const wasIntact = intact
      const begunChain = begun
      intact = false
      begun = true
      try {
        const startedAt = Date.now()
        let line: ChainLine
        if (attempt > 0) {
          line = { title: name, start: 'retried' }
        } else if (!wasIntact) {
          const reason = begunChain ? 'the test before failed' : 'chain start'
          line = { title: name, start: 'rebuilt', reason }
        } else if (await start.check().catch(() => false)) {
          line = { title: name, start: 'continued' }
        } else {
          line = { title: name, start: 'rebuilt', reason: 'start check missed' }
        }
        if (line.start !== 'continued') await start.arrive()
        record(`chain: ${line.start}`, Date.now() - startedAt)
        if (process.env.E2E_RUN_DIR) {
          appendFileSync(
            join(process.env.E2E_RUN_DIR, 'chain.jsonl'),
            JSON.stringify(line) + '\n',
          )
        }

        await body.call(this)
        intact = true
      } catch (error) {
        if (stop) stopped = true
        throw error
      }
    })
  }
}
