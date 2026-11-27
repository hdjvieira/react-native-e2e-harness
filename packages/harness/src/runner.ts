import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'

// Starting the tools the harness depends on (WebdriverIO's launcher, Mocha)
// as the app has them installed: `e2e-harness run` and `api`, and the
// dashboard's Run button.

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * A file inside an installed package, looked for in node_modules from the
 * app's e2e folder up, then from this package up: packages' `exports` often
 * hide their bin files from require.resolve.
 */
export function installedFile(path: string) {
  for (const start of [config().dir, HERE]) {
    for (let dir = start; ; dir = dirname(dir)) {
      const file = join(dir, 'node_modules', path)
      if (existsSync(file)) return file
      if (dirname(dir) === dir) break
    }
  }
  throw new Error(`${path.split('/').slice(0, 2).join('/')} is not installed`)
}

export const wdioBin = () => installedFile('@wdio/cli/bin/wdio.js')
export const mochaBin = () => installedFile('mocha/bin/mocha.js')

/** the app's WebdriverIO config, relative to its e2e folder */
export const wdioConfigFile = () => config().wdioConfig

/**
 * `e2e-harness run` arguments as WebdriverIO's: plain `--spec`, `--grep` and
 * `--invert`; anything else passes through as it is.
 */
export function wdioArgs(args: string[]) {
  const out = ['run', wdioConfigFile()]
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s)
    const value = () => inline ?? args[++i]
    if (flag === '--spec') out.push('--spec', value())
    else if (flag === '--grep') out.push('--mochaOpts.grep', value())
    else if (flag === '--invert') out.push('--mochaOpts.invert')
    else out.push(args[i])
  }
  return out
}

/** runs a node script in the app's e2e folder, attached to this terminal; resolves to its exit code */
export function runNode(args: string[]) {
  return new Promise<number>(resolve => {
    const child = spawn(process.execPath, args, {
      cwd: config().dir,
      stdio: 'inherit',
    })
    child.on('close', code => resolve(code ?? 1))
  })
}
