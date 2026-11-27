import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The app's side of the harness: one `e2e.config.ts` in its e2e folder.
//
//   // e2e/e2e.config.ts
//   import { defineConfig } from 'react-native-e2e-harness'
//   export default defineConfig({
//     dir: import.meta.dirname,
//     android: { package: 'com.example.app' },
//     ios: { bundleId: 'com.example.app' },
//   })
//
// Importing that file makes it the current config in this process: the WDIO
// launcher and its workers (through wdio.conf.ts), and the CLI. Everything in
// the harness reads it lazily, at call time, never at import time.

export type Platform = 'android' | 'ios'

/** what a run tells the app's hooks */
export type PreflightContext = {
  platform: Platform
  /** adb serial or iOS UDID */
  serial: string
  /** a phone in hand rather than an emulator or simulator */
  realDevice: boolean
  app: AppInfo
}

export type AppInfo = {
  version?: string
  versionCode?: string
  /** when it was installed, where the platform says */
  updated?: string
  /** a debug build: loads its JS from Metro */
  debuggable?: boolean
}

export type HarnessConfig = {
  /** the e2e folder (where this config, the specs and `out/` live) */
  dir: string
  /** the app's repo root, for Metro and git; default: the folder above `dir` */
  appDir?: string

  android?: {
    package: string
    /** default: `<package>.MainActivity` */
    activity?: string
    /** runtime permissions granted on an emulator before a run */
    permissions?: string[]
  }
  ios?: {
    bundleId: string
    /** the app's executable name (`MyApp` for `MyApp.app`), to kill it on a phone */
    executable?: string
    /** Apple team that signs WebDriverAgent for a physical iPhone (or E2E_IOS_TEAM) */
    teamId?: string
    /** simctl privacy services granted on a simulator, e.g. `location-always` */
    permissions?: string[]
  }

  /** spec files, relative to `dir`; default `specs/**\/*.e2e.ts` */
  specs?: string
  /** spec globs a device run leaves out (API-only specs, say) */
  exclude?: string[]
  /** run folders; default `<dir>/out` */
  outDir?: string

  /** the git ref releases are cut from: names a run's release and decides pruning */
  mainRef?: string

  appium?: { port?: number }
  /** Metro for debug builds; `false` for an app without it */
  metro?:
    | {
        port?: number
        /** the command that starts it, run in `appDir`; default `npx react-native start` */
        start?: string
      }
    | false

  env?: {
    /** secrets and settings, git-ignored; default `.env.e2e` in `dir` */
    file?: string
    /** the committed manual of every key, `# [required]` / `# [optional]`; default `.env.e2e.example` */
    example?: string
  }

  /**
   * The app's known starting screen, which restartApp() brings it back to
   * before a test: how to tell it is there, and what to get through on the
   * way (onboarding, prompts).
   */
  home?: {
    /** a testID that is only there once the starting screen is ready */
    ready: string
    /**
     * screens on the way, in any order: a testID to tap whenever it shows,
     * or one with its own way through
     */
    through?: (string | { id: string; tap: () => Promise<void> })[]
    /**
     * things that can land on top of the starting screen after it showed (a
     * promo, a rating prompt): the testID of what closes each
     */
    overlays?: string[]
    /**
     * a testID present whenever the app's UI is up (the root view): how a
     * restart knows the app is in front and can be reloaded rather than
     * cold-started. Default `app-root`
     */
    root?: string
    /** runs after every restart, e.g. to put the app in the language specs assert */
    after?: () => Promise<void>
    /** longest a restart may take, ms; default 150000 */
    timeout?: number
  }

  /**
   * The app's dev-only link (react-native-e2e-harness/in-app): reloads its JS
   * between tests instead of a cold start, keeps LogBox out of the way, closes
   * the keyboard on iOS. Without it every restart is a cold start.
   */
  devLink?: {
    /** e.g. `myapp://e2e`, as passed to createE2ESwitches in the app */
    url: string
    /** switches every launch sends, e.g. `mapA11y=off`; `logbox=off` is always sent */
    launch?: string
  }

  /** where a path given to openLink() points, e.g. `https://example.com` */
  webBase?: string

  /** the app's WebdriverIO config (`e2e-harness run`, the dashboard), relative to `dir`; default wdio.conf.ts */
  wdioConfig?: string

  /**
   * specs that need no device (an API the app relies on), run with plain
   * Mocha by `e2e-harness api`; add their glob to `exclude` too
   */
  api?: {
    specs: string
    /** per-test timeout, ms; default 60000 */
    timeout?: number
  }

  /** the local run dashboard (e2e-harness dashboard) */
  dashboard?: {
    /** default 4777; E2E_DASHBOARD_PORT overrides */
    port?: number
    /** the name in its top bar, e.g. the app's */
    title?: string
    /** what the app's own tags mean (`#slow`: 'Takes minutes'), shown on their chips */
    tags?: Record<string, string>
  }

  hooks?: {
    /** extra checks before a run; returns notes for the summary, throws to stop it */
    preflight?: (context: PreflightContext) => Promise<string[] | void>
    /**
     * removes anything a test left behind on a backend (start and end of a
     * run); returns what it removed
     */
    sweep?: () => Promise<string[]>
  }

  /** per-test timeout, ms; default 240000 */
  testTimeout?: number
  /** retries for a failed test; default 1 */
  retries?: number
  /** no answer from the app in this long means it froze; default 45000 */
  freezeMs?: number

  /** extra Appium capabilities per platform */
  capabilities?: {
    android?: Record<string, unknown>
    ios?: Record<string, unknown>
  }
}

export type ResolvedConfig = Required<
  Pick<
    HarnessConfig,
    | 'dir'
    | 'appDir'
    | 'specs'
    | 'exclude'
    | 'outDir'
    | 'mainRef'
    | 'testTimeout'
    | 'retries'
    | 'freezeMs'
    | 'wdioConfig'
  >
> &
  Omit<HarnessConfig, 'metro' | 'appium' | 'env'> & {
    appium: { port: number }
    metro: { port: number; start: string } | false
    env: { file: string; example: string }
  }

let current: ResolvedConfig | undefined

/** fills in the defaults and makes this the config of the process */
export function defineConfig(config: HarnessConfig): ResolvedConfig {
  const dir = resolve(config.dir)
  const inDir = (path: string) => (isAbsolute(path) ? path : join(dir, path))
  if (!config.android && !config.ios) {
    throw new Error('e2e config: set android, ios, or both')
  }
  const resolved: ResolvedConfig = {
    ...config,
    dir,
    appDir: config.appDir ? inDir(config.appDir) : resolve(dir, '..'),
    specs: config.specs ?? 'specs/**/*.e2e.ts',
    exclude: config.exclude ?? [],
    outDir: inDir(config.outDir ?? 'out'),
    mainRef: config.mainRef ?? 'origin/main',
    testTimeout: config.testTimeout ?? 240000,
    retries: config.retries ?? 1,
    freezeMs: Number(process.env.E2E_FREEZE_MS) || config.freezeMs || 45000,
    wdioConfig: config.wdioConfig ?? 'wdio.conf.ts',
    appium: { port: config.appium?.port ?? 4723 },
    metro:
      config.metro === false
        ? false
        : {
            port: config.metro?.port ?? 8081,
            start: config.metro?.start ?? 'npx react-native start',
          },
    env: {
      file: inDir(config.env?.file ?? '.env.e2e'),
      example: inDir(config.env?.example ?? '.env.e2e.example'),
    },
  }
  current = resolved
  if (existsSync(resolved.env.file)) process.loadEnvFile(resolved.env.file)
  return resolved
}

/** the current config; throws when no config file was imported */
export function config(): ResolvedConfig {
  if (!current) {
    throw new Error(
      'no e2e config: import your e2e.config.ts (defineConfig) before using the harness',
    )
  }
  return current
}

/** the platform this run is on: E2E_PLATFORM, else Android when configured */
export function platform(): Platform {
  const wanted = process.env.E2E_PLATFORM
  const c = config()
  if (wanted === 'ios' || wanted === 'android') {
    if (!c[wanted])
      throw new Error(`E2E_PLATFORM=${wanted}, but the config has no ${wanted}`)
    return wanted
  }
  return c.android ? 'android' : 'ios'
}

/** the app id on this platform: Android package or iOS bundle id */
export function appId(on: Platform = platform()) {
  const c = config()
  const id = on === 'android' ? c.android?.package : c.ios?.bundleId
  if (!id) throw new Error(`the config has no ${on} app`)
  return id
}

const CONFIG_NAMES = [
  'e2e.config.ts',
  'e2e.config.mts',
  'e2e.config.js',
  'e2e.config.mjs',
]

/**
 * Where the app's config is, looked for from `from` (the current folder):
 * there; then the nearest package.json's `"e2e-harness": { "config": … }`,
 * so one `"e2e": "e2e-harness"` script works from the app's root; then the
 * usual folders (`e2e/`, `__e2eTests__/`) beside that package.json.
 */
export function findConfig(from = process.cwd()) {
  const here = CONFIG_NAMES.map(name => join(from, name)).find(existsSync)
  if (here) return here
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      const field = (
        JSON.parse(readFileSync(manifest, 'utf8')) as {
          'e2e-harness'?: { config?: string }
        }
      )['e2e-harness']?.config
      if (field) return resolve(dir, field)
      const usual = ['e2e', '__e2eTests__']
        .flatMap(folder => CONFIG_NAMES.map(name => join(dir, folder, name)))
        .find(existsSync)
      if (usual) return usual
    }
    if (dirname(dir) === dir) return undefined
  }
}

/**
 * Loads the app's config (or the path given) for a process that isn't WDIO:
 * the CLI. TypeScript configs need the tsx loader, which the CLI registers.
 */
export async function loadConfig(path?: string) {
  const file = path ? resolve(path) : findConfig()
  if (!file || !existsSync(file)) {
    throw new Error(
      path
        ? `no e2e config at ${path}`
        : 'no e2e config found: run from the e2e folder, set "e2e-harness": { "config": "<path>" } in package.json, or pass --config',
    )
  }
  const module = (await import(pathToFileURL(file).href)) as {
    default?: ResolvedConfig
  }
  if (!current && module.default) current = module.default
  return config()
}

/** this package's own folder, for its bundled files */
export const PACKAGE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
)
