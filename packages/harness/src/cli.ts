#!/usr/bin/env node
import { register } from 'tsx/esm/api'
import { loadConfig } from './config.js'

// e2e-harness <command> [--config <path>]
//
//   preflight          get the device, Appium and Metro ready, or say why not
//   sweep              run the app's sweep hook (what tests left on a backend)
//   tests              list the device tests and their tags
//   reports [--prune]  each run's release and results, and which can go
//
// Run it from the app's e2e folder (where e2e.config.ts is), or pass --config.

const USAGE = `usage: e2e-harness <preflight|sweep|tests|reports [--prune]> [--config <path>]`

async function main(argv: string[]) {
  const [command, ...rest] = argv
  const at = rest.indexOf('--config')
  const configPath = at >= 0 ? rest[at + 1] : undefined
  // the app's config is TypeScript
  register()
  await loadConfig(configPath)

  switch (command) {
    case 'preflight': {
      const { preflight } = await import('./preflight.js')
      const { notes } = await preflight()
      console.log(`preflight OK\n- ${notes.join('\n- ')}`)
      return
    }
    case 'sweep': {
      const { config } = await import('./config.js')
      const removed = (await config().hooks?.sweep?.()) ?? []
      console.log(
        removed.length
          ? `removed:\n- ${removed.join('\n- ')}`
          : 'nothing left behind',
      )
      return
    }
    case 'tests': {
      const { discoverTests } = await import('./plan.js')
      for (const test of discoverTests()) {
        console.log(
          `${test.spec}  ${test.key}${test.tags.length ? `  [${test.tags.join(' ')}]` : ''}`,
        )
      }
      return
    }
    case 'reports': {
      const { describeRun, fetchMain, prunable, prune, readRun, runDirs } =
        await import('./reports.js')
      fetchMain()
      const going = new Set(prunable())
      for (const run of runDirs()) {
        let record: ReturnType<typeof readRun>
        try {
          record = readRun(run)
        } catch (e) {
          console.log(`keep  ${run}  unreadable: ${(e as Error).message}`)
          continue
        }
        const count = (status: string) =>
          record.results.filter(r => r.status === status).length
        console.log(
          `${going.has(run) ? 'PRUNE' : 'keep '} ${run}  ${count('pass')} passed, ${count('fail')} failed  ${describeRun(record)}`,
        )
      }
      if (rest.includes('--prune')) {
        console.log(`\npruned ${prune().length} report(s)`)
      } else if (going.size) {
        console.log(`\n${going.size} report(s) can go: --prune deletes them`)
      }
      return
    }
    default:
      console.error(USAGE)
      process.exitCode = 2
  }
}

main(process.argv.slice(2)).catch(e => {
  console.error(`${(e as Error).message}`)
  process.exitCode = 1
})
