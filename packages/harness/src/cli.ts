#!/usr/bin/env node
import { register } from 'tsx/esm/api'
import { dirname, relative, sep } from 'node:path'
import { loadConfig } from './config.js'

// e2e-harness <command> [--config <path>]
//
//   run [...]          the specs on a device (--spec, --grep, --invert, or any
//                      WebdriverIO option)
//   api                the specs that need no device, with plain Mocha
//   preflight          get the device, Appium and Metro ready, or say why not
//   sweep              run the app's sweep hook (what tests left on a backend)
//   tests              list the device tests and their tags
//   reports [--prune]  each run's release and results, and which can go
//   dashboard          the local run dashboard, until its window closes
//   device <cmd>       the app on an Android device, one command at a time
//   ios-device <cmd>   the app on an iPhone, one command at a time
//   slow-net ...       a slow or dead network for chosen hosts (Android)
//
// Run it from anywhere in the app: the config is found from the current folder
// or the app's package.json ("e2e-harness": { "config": "…" }), or pass --config.

const USAGE = `usage: e2e-harness <command> [--config <path>]
  init [--dir e2e]    the e2e folder and package.json entries, for a new app
  ai [--tool agents]  the e2e runbook for an AI assistant (claude, agents, cursor, copilot)
  run [--spec <file>]... [--grep <re>] [--invert]   run the specs on a device
  api                 the specs that need no device (config api.specs)
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

  // these two work before there is a config
  if (command === 'init') {
    const { describeInit, init } = await import('./init.js')
    const at = rest.indexOf('--dir')
    console.log(
      describeInit(init({ folder: at >= 0 ? rest[at + 1] : undefined })),
    )
    return
  }
  if (command === 'ai') {
    const { TOOLS, writeFor } = await import('./ai.js')
    const { appRoot } = await import('./init.js')
    const { findConfig } = await import('./config.js')
    const at = rest.indexOf('--tool')
    const tool = (at >= 0 ? rest[at + 1] : 'agents') as (typeof TOOLS)[number]
    if (!TOOLS.includes(tool))
      throw new Error(`--tool: one of ${TOOLS.join(', ')}`)
    const appDir = appRoot()
    const found = configPath ?? findConfig()
    const folder = found
      ? relative(appDir, dirname(found)).split(sep).join('/')
      : undefined
    console.log(`wrote ${writeFor(tool, appDir, folder)}`)
    return
  }
  if (command !== 'slow-net') await loadConfig(configPath)

  switch (command) {
    case 'run': {
      const { runNode, wdioArgs, wdioBin } = await import('./runner.js')
      process.exitCode = await runNode([wdioBin(), ...wdioArgs(rest)])
      return
    }
    case 'api': {
      const { config } = await import('./config.js')
      const { mochaBin, runNode } = await import('./runner.js')
      const api = config().api
      if (!api) throw new Error('no api specs: set api.specs in the e2e config')
      process.exitCode = await runNode([
        '--import',
        import.meta.resolve('tsx'),
        mochaBin(),
        '--timeout',
        String(api.timeout ?? 60000),
        api.specs,
        ...rest,
      ])
      return
    }
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
