import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'

// The dashboard's settings, read once: the dashboard runs as a process of
// its own, started by `e2e-harness dashboard` after the app's config loaded.

export const E2E_DIR = config().dir
export const OUT_DIR = config().outDir
export const APPIUM_PORT = config().appium.port
const metro = config().metro
export const METRO_PORT = metro ? metro.port : undefined
export const DASHBOARD_PORT =
  Number(process.env.E2E_DASHBOARD_PORT) || config().dashboard?.port || 4777
export const TITLE = config().dashboard?.title ?? basename(config().appDir)
/** the app's WebdriverIO config, run by the dashboard's Run button */
export const WDIO_CONFIG = config().wdioConfig
/** the app's own tags and what they mean */
export const APP_TAGS = config().dashboard?.tags ?? {}

const here = dirname(fileURLToPath(import.meta.url))
/** the page's files: next to the package's dist/ and src/ */
export const PUBLIC = join(here, '..', '..', 'dashboard', 'public')

/** this package's CLI, as a command line for a child process */
export function cliCommand(args: string[]) {
  const ext = extname(fileURLToPath(import.meta.url))
  const cli = join(here, '..', `cli${ext}`)
  return [
    process.execPath,
    ...(ext === '.ts' ? ['--import', import.meta.resolve('tsx')] : []),
    cli,
    ...args,
  ]
}

export { wdioBin } from '../runner.js'
