// Writes a test makes on a shared backend are undone by the run, never left
// for a person:
// - a spec registers the clean-up BEFORE the write, so a write that half
//   happened (posted, then the assertion failed) is still undone;
// - a clean-up should verify: the thing is gone, not just a 200;
// - the app's `sweep` hook runs at the start and the end of every run and
//   removes anything the test accounts left, so a crashed or killed run is
//   cleaned by the next one.

type Cleanup = { label: string; run: () => Promise<void> }

const pending: Cleanup[] = []

/** undo a write after the test; call it before the write */
export function registerCleanup(label: string, run: () => Promise<void>) {
  pending.push({ label, run })
}

/**
 * Runs every registered clean-up, newest first (after each test, passed or
 * not). A failed one is reported, and the end-of-run sweep has another go.
 */
export async function runCleanups() {
  const done: string[] = []
  const failed: string[] = []
  while (pending.length) {
    const { label, run } = pending.pop()!
    try {
      await run()
      done.push(label)
    } catch (e) {
      failed.push(`${label}: ${(e as Error).message}`)
    }
  }
  return { done, failed }
}
