import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

// `e2e-harness init`: the e2e folder and the package.json entries an app
// needs, with its app ids read from its own project. Never overwrites a
// file: what is there already is kept and listed as such.

export type InitOptions = {
  /** the e2e folder, relative to the app's root; default `e2e` */
  folder?: string
}

export type InitResult = {
  appDir: string
  folder: string
  created: string[]
  kept: string[]
  packageJson: string[]
  notes: string[]
}

/** the app's root: the nearest folder with a package.json */
export function appRoot(from = process.cwd()) {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir
    if (dirname(dir) === dir)
      throw new Error('no package.json here or above: run it inside the app')
  }
}

/** how the app runs its scripts, from its lockfile */
export function packageManager(appDir: string) {
  if (existsSync(join(appDir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (
    existsSync(join(appDir, 'bun.lockb')) ||
    existsSync(join(appDir, 'bun.lock'))
  )
    return 'bun'
  if (existsSync(join(appDir, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

const read = (path: string) =>
  existsSync(path) ? readFileSync(path, 'utf8') : undefined

/** the app ids, from Expo's app.json or the native projects */
export function detectApp(appDir: string) {
  const found: {
    androidPackage?: string
    androidNamespace?: string
    iosBundleId?: string
    iosExecutable?: string
    scheme?: string
  } = {}
  try {
    const expo = JSON.parse(read(join(appDir, 'app.json')) ?? '{}').expo
    if (expo) {
      found.androidPackage = expo.android?.package
      found.iosBundleId = expo.ios?.bundleIdentifier
      found.scheme = Array.isArray(expo.scheme) ? expo.scheme[0] : expo.scheme
    }
  } catch {
    // not JSON: leave it
  }
  const gradle =
    read(join(appDir, 'android/app/build.gradle')) ??
    read(join(appDir, 'android/app/build.gradle.kts'))
  if (gradle) {
    found.androidPackage ??= /applicationId\s*=?\s*["']([\w.]+)["']/.exec(
      gradle,
    )?.[1]
    const namespace = /namespace\s*=?\s*["']([\w.]+)["']/.exec(gradle)?.[1]
    if (namespace && namespace !== found.androidPackage)
      found.androidNamespace = namespace
  }
  const ios = join(appDir, 'ios')
  const project = existsSync(ios)
    ? readdirSync(ios).find(name => name.endsWith('.xcodeproj'))
    : undefined
  if (project) {
    const pbx = read(join(ios, project, 'project.pbxproj')) ?? ''
    const ids = [...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/g)]
      .map(m => m[1])
      .filter(id => !/tests?$/i.test(id) && !id.includes('$('))
    found.iosBundleId ??= ids[0]
    found.iosExecutable = project.replace(/\.xcodeproj$/, '')
  }
  return found
}

function configFile(app: ReturnType<typeof detectApp>) {
  const android = app.androidPackage
    ? `  android: { package: '${app.androidPackage}'${app.androidNamespace ? `, namespace: '${app.androidNamespace}'` : ''} },\n`
    : ''
  const ios = app.iosBundleId
    ? `  ios: { bundleId: '${app.iosBundleId}'${app.iosExecutable ? `, executable: '${app.iosExecutable}'` : ''} },\n`
    : ''
  const missing =
    android || ios
      ? ''
      : `  // no app id found in the project: set yours\n  android: { package: 'com.example.app' },\n`
  return `import { defineConfig } from 'react-native-e2e-harness'

export default defineConfig({
  dir: import.meta.dirname,
${android}${ios}${missing}  // the screen every test starts from: a testID that is only there once it
  // is ready, and what to tap through on the way (onboarding, prompts)
  home: { ready: 'home-screen' },
  // the app's dev-only link once it calls createE2ESwitches (debug builds):
  // fast restarts and switches from tests. Without it, restarts are cold
  // devLink: { url: '${app.scheme ?? 'myapp'}://e2e' },
})
`
}

const FILES: Record<string, (app: ReturnType<typeof detectApp>) => string> = {
  'e2e.config.ts': configFile,
  'wdio.conf.ts':
    () => `import { createWdioConfig } from 'react-native-e2e-harness'
import harness from './e2e.config.ts'

export const config = createWdioConfig(harness)
`,
  'tsconfig.json': () =>
    JSON.stringify(
      {
        compilerOptions: {
          target: 'es2022',
          module: 'nodenext',
          moduleResolution: 'nodenext',
          allowImportingTsExtensions: true,
          noEmit: true,
          strict: true,
          skipLibCheck: true,
          // Mocha's and WebdriverIO's come with the harness: none of the
          // app's own (Jest's would clash)
          types: [],
        },
        include: ['**/*.ts'],
        exclude: ['out'],
      },
      null,
      2,
    ) + '\n',
  '.gitignore': () => 'out/\n.env.e2e\n',
  '.env.e2e.example':
    () => `# Settings and secrets for a run. Copy to .env.e2e (git-ignored) and fill in.
# Keys under "# [required]" stop a run when missing.

# [optional]
# an adb serial; empty means an emulator, booted when none runs
E2E_ANDROID_DEVICE=
# the AVD to boot
E2E_AVD=
# a physical iPhone's UDID; empty means the one on a cable, if any
E2E_IOS_UDID=
`,
  'specs/app.e2e.ts':
    () => `import { restartApp, waitFor } from 'react-native-e2e-harness'

describe('The app', () => {
  beforeEach(() => restartApp())

  it('starts on its home screen', async () => {
    await waitFor('home-screen')
  })
})
`,
  'support/README.md': () => `# Your helpers

The app's own e2e code goes here: signing in, your backend's API, clean-ups,
helpers for your screens. Specs import it (\`../support/...\`), and
e2e.config.ts can call it from its hooks (\`sweep\`, \`preflight\`, \`home.after\`).
`,
}

export function init(
  { folder = 'e2e' }: InitOptions = {},
  from = process.cwd(),
): InitResult {
  const appDir = appRoot(from)
  const dir = join(appDir, folder)
  const app = detectApp(appDir)
  const result: InitResult = {
    appDir,
    folder,
    created: [],
    kept: [],
    packageJson: [],
    notes: [],
  }

  for (const [name, content] of Object.entries(FILES)) {
    const path = join(dir, name)
    const shown = `${folder}/${name}`
    if (existsSync(path)) {
      result.kept.push(shown)
      continue
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content(app))
    result.created.push(shown)
  }

  const manifestPath = join(appDir, 'package.json')
  const raw = readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(raw) as {
    scripts?: Record<string, string>
    'e2e-harness'?: { config?: string }
  }
  if (!manifest.scripts?.e2e) {
    manifest.scripts = { ...manifest.scripts, e2e: 'e2e-harness' }
    result.packageJson.push('scripts.e2e: "e2e-harness"')
  } else if (!manifest.scripts.e2e.includes('e2e-harness')) {
    result.notes.push(
      `package.json already has an "e2e" script (${manifest.scripts.e2e}): run the harness as npx e2e-harness, or rename yours`,
    )
  }
  if (!manifest['e2e-harness']) {
    manifest['e2e-harness'] = { config: `${folder}/e2e.config.ts` }
    result.packageJson.push(`e2e-harness.config: "${folder}/e2e.config.ts"`)
  }
  if (result.packageJson.length) {
    const indent = /^( +|\t)"/m.exec(raw)?.[1] ?? '  '
    writeFileSync(manifestPath, JSON.stringify(manifest, null, indent) + '\n')
  }

  if (!app.androidPackage && !app.iosBundleId)
    result.notes.push(
      `no app id found (android/app/build.gradle, ios/*.xcodeproj, app.json): set it in ${folder}/e2e.config.ts`,
    )
  const tsconfig = read(join(appDir, 'tsconfig.json'))
  if (tsconfig && !tsconfig.includes(`"${folder}`))
    result.notes.push(
      `leave ${folder}/ out of the app's tsconfig.json ("exclude": ["${folder}"]): its Mocha types clash with Jest's`,
    )
  return result
}

/** what init did, and what to do next, for the terminal */
export function describeInit(result: InitResult) {
  const run = packageManager(result.appDir)
  const e2e =
    run === 'npm'
      ? 'npm run e2e --'
      : run === 'yarn'
        ? 'yarn e2e'
        : `${run} e2e`
  const lines = [
    `in ${relative(process.cwd(), result.appDir) || '.'}:`,
    ...result.created.map(f => `  + ${f}`),
    ...result.kept.map(f => `  = ${f} (already there, kept)`),
    ...result.packageJson.map(f => `  ~ package.json ${f}`),
    ...result.notes.map(n => `  ! ${n}`),
    '',
    'next:',
    `  1. set home.ready in ${result.folder}/e2e.config.ts to a testID of your start screen`,
    '  2. optional, for fast restarts: createE2ESwitches in the app (README: In the app)',
    `  3. ${e2e} preflight, then ${e2e} run`,
    `  4. for your AI assistant: ${e2e} ai --tool claude|agents|cursor|copilot`,
  ]
  return lines.join('\n')
}
