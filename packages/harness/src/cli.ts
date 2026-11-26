#!/usr/bin/env node
import { register } from 'tsx/esm/api'
import { loadConfig } from './config.js'

// e2e-harness <command> [--config <path>]
//
//   preflight          get the device, Appium and Metro ready, or say why not
//   sweep              run the app's sweep hook (what tests left on a backend)
//   tests              list the device tests and their tags
//   reports [--prune]  each run's release and results, and which can go
//   dashboard          the local run dashboard, until its window closes
//   device <cmd>       the app on an Android device, one command at a time
//   ios-device <cmd>   the app on an iPhone, one command at a time
//   slow-net ...       a slow or dead network for chosen hosts (Android)
//
// Run it from the app's e2e folder (where e2e.config.ts is), or pass --config.

const USAGE = `usage: e2e-harness <command> [--config <path>]
  preflight           get the device, Appium and Metro ready, or say why not
  sweep               run the app's sweep hook
  tests               the device tests and their tags
  reports [--prune]   each run's release and results, and which can go
  dashboard           the local run dashboard (keeps running)
  device <cmd>        the app on an Android device (device help)
  ios-device <cmd>    the app on an iPhone (ios-device help)
  slow-net ...        a slow or dead network for chosen hosts on Android`

async function main(argv: string[]) {
  const at = argv.indexOf('--config')
  const configPath = at >= 0 ? argv[at + 1] : undefined
  if (at >= 0) argv = [...argv.slice(0, at), ...argv.slice(at + 2)]
  const [command, ...rest] = argv
  // the app's config is TypeScript
  register()
  if (command !== 'slow-net') await loadConfig(configPath)

  switch (command) {
    case 'dashboard': {
      const { runDashboard } = await import('./dashboard/server.js')
      runDashboard()
      return
    }
    case 'device': {
      const { androidCommand } = await import('./device-cli/android.js')
      process.exitCode = await androidCommand(rest[0], rest.slice(1))
      return
    }
    case 'ios-device': {
      const { iosCommand } = await import('./device-cli/ios.js')
      process.exitCode = await iosCommand(rest[0], rest.slice(1))
      return
    }
    case 'slow-net': {
      const { slowNet } = await import('./device-cli/slow-net.js')
      slowNet(rest)
      return
    }
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
