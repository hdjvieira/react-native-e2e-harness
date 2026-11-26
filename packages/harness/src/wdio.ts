import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { browser } from '@wdio/globals'
import { SevereServiceError } from 'webdriverio'
import { runCleanups } from './cleanup.js'
import { appId, config, platform, type ResolvedConfig } from './config.js'
import { iphoneCapabilities, isEmulator } from './device.js'
import {
  clearCurrentRun,
  emit,
  readEvents,
  readJsonLines,
  readPlan,
  setCurrentRun,
  specKey,
  writePlan,
} from './events.js'
import { showOnDashboard } from './dashboard-launch.js'
import { takeNeedsPerson } from './needs-person.js'
import {
  type DeviceKind,
  discoverTests,
  forPlatform,
  plan,
  planArgsFrom,
  platformGrep,
  type PlannedTest,
  TargetTagError,
} from './plan.js'
import { preflight } from './preflight.js'
import { currentGit, fetchMain, prune, releaseOf, writeRun } from './reports.js'
import { type Sweep, type TestResult, writeSummary } from './summary.js'
import { measure, record as recordTiming } from './timing.js'
import { describeFreeze, frozeInTest, watchApp, watching } from './watchdog.js'

// One run: preflight and sweep first, the specs one at a time on one device,
// then the sweep again and a single summary (out/<run>/summary.md), headed by
// what was tested: the release, the app build, the branch and commit
// (out/<run>/run.json). Old reports nobody needs any more are pruned as a run
// starts (reports.ts).
//
//   // wdio.conf.ts
//   import { createWdioConfig } from 'react-native-e2e-harness'
//   import harness from './e2e.config.ts'
//   export const config = createWdioConfig(harness)
//
//   wdio run wdio.conf.ts                                    every spec
//   wdio run wdio.conf.ts --spec specs/login.e2e.ts           one spec
//   wdio run wdio.conf.ts --mochaOpts.grep "#slow" --mochaOpts.invert   skip a tag
//
// Tags are #-words in test titles (plan.ts): #android / #ios and the device
// tags decide where a test runs; any other tag can be grepped for.

const runDir = () => process.env.E2E_RUN_DIR!

/** one attempt in results.jsonl; a failure also saves the screen and the UI tree */
async function record(result: TestResult) {
  // WDIO's Mocha adapter reports 0 retries on every attempt, so count them here
  result.retries = readJsonLines<TestResult>(
    join(runDir(), 'results.jsonl'),
  ).filter(r => r.title === result.title).length
  if (!result.passed && !result.skipped) {
    // the hash keeps names apart: a long describe alone fills the slug
    const id = createHash('sha1').update(result.title).digest('hex').slice(0, 8)
    const base = join(
      runDir(),
      `${slug(result.title).slice(0, 60)}-${id}-attempt${result.retries + 1}`,
    )
    await browser.saveScreenshot(`${base}.png`).catch(() => {})
    await pageSource()
      .then(source => source && writeFileSync(`${base}.xml`, source))
      .catch(() => {})
    result.artifacts = base
  }
  appendFileSync(join(runDir(), 'results.jsonl'), JSON.stringify(result) + '\n')
}

/**
 * The UI tree, for a failure's artifacts. On iOS a full dump works out every
 * element's `visible`, which on a large screen can take minutes: it is left
 * out, and the dump given 20 s. The screenshot says what was visible anyway.
 */
async function pageSource() {
  if (browser.isAndroid) return browser.getPageSource()
  await browser
    .updateSettings({ pageSourceExcludedAttributes: 'visible' })
    .catch(() => {})
  return Promise.race([
    browser.getPageSource(),
    new Promise<undefined>(resolve => setTimeout(resolve, 20000)),
  ])
}

const slug = (title: string) =>
  title
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)

/** keys of the tests this worker has ended for good: a hook leaves them alone */
const ended = new Set<string>()

// the run's plan, by Mocha's full title: a suite also holds the tests a grep
// leaves out, and those must not be ended as skipped or failed
let planned: Set<string> | undefined
const isPlanned = (test: Mocha.Test) => {
  planned ??= new Set(
    readPlan(runDir()).map((t: PlannedTest) => `${t.describe} ${t.title}`),
  )
  return !planned.size || planned.has(test.fullTitle())
}

/** a run stopped from outside: what its hooks would still write must not read as failures */
const stoppedFromOutside = () =>
  readEvents(runDir()).some(e => e.type === 'run-end' && e.stopped)

/** the tests in `suite` and the describes inside it still to end */
function notEnded(suite: Mocha.Suite): Mocha.Test[] {
  return [
    ...suite.tests.filter(
      t => isPlanned(t) && !ended.has(`${t.parent?.title} > ${t.title}`),
    ),
    ...suite.suites.flatMap(notEnded),
  ]
}

/**
 * The tests a before or beforeEach hook decided for, which never get a
 * beforeTest or afterTest of their own: a skip in a before (all) skips its
 * whole describe, in a beforeEach only the test it was for; a failure in
 * either ends the rest of the describe, nested ones included (Mocha's rules).
 */
function decidedBy(context: Mocha.Context, hookName: string, skipped: boolean) {
  const hook = context?.test as Mocha.Hook | undefined
  const each = /each/i.test(hookName)
  if (each && skipped) return context?.currentTest ? [context.currentTest] : []
  return hook?.parent ? notEnded(hook.parent) : []
}

async function sweep(): Promise<string[]> {
  return (await config().hooks?.sweep?.()) ?? []
}

async function cleanUpAfter() {
  const cleanup = await runCleanups()
  if (cleanup.done.length || cleanup.failed.length) {
    appendFileSync(
      join(runDir(), 'cleanup.jsonl'),
      JSON.stringify(cleanup) + '\n',
    )
    emit({ type: 'cleanup', ...cleanup })
  }
}

function capabilities(c: ResolvedConfig): WebdriverIO.Capabilities {
  if (platform() === 'ios') {
    // the debug app is installed (never reinstalled or reset), and the specs
    // launch it themselves. The first session builds WebDriverAgent onto the
    // device, which takes minutes
    return {
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:bundleId': appId('ios'),
      'appium:noReset': true,
      'appium:autoLaunch': false,
      'appium:newCommandTimeout': 300,
      'appium:wdaLaunchTimeout': 600000,
      'appium:wdaConnectionTimeout': 600000,
      'appium:reduceMotion': true,
      // an app that never stops animating (a map, a spinner) would stall
      // every command waiting for an idle UI
      'appium:waitForIdleTimeout': 0,
      ...c.capabilities?.ios,
    } as WebdriverIO.Capabilities
  }
  const pkg = appId('android')
  return {
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:appPackage': pkg,
    'appium:appActivity': c.android?.activity ?? `${pkg}.MainActivity`,
    // never reinstall or clear the app: specs bring it to a known screen themselves
    'appium:noReset': true,
    'appium:autoLaunch': false,
    'appium:newCommandTimeout': 300,
    'appium:disableWindowAnimation': true,
    'appium:ignoreHiddenApiPolicyError': true,
    // waiting for an idle UI on an app that never stops animating eats up to
    // 10 s per command. On UiAutomator2 it is a setting, not a capability
    'appium:settings': { waitForIdleTimeout: 0 },
    ...c.capabilities?.android,
  } as WebdriverIO.Capabilities
}

/** the WebdriverIO config for the app's wdio.conf.ts */
export function createWdioConfig(
  harness: ResolvedConfig,
  overrides: Partial<WebdriverIO.Config> = {},
): WebdriverIO.Config {
  const c = harness
  return {
    runner: 'local',
    hostname: '127.0.0.1',
    port: c.appium.port,
    path: '/',
    specs: [join(c.dir, c.specs).replace(/\\/g, '/')],
    exclude: c.exclude.map(glob => join(c.dir, glob).replace(/\\/g, '/')),
    maxInstances: 1,
    capabilities: [capabilities(c)],
    logLevel: 'warn',
    outputDir: join(c.outDir, 'wdio-logs'),
    framework: 'mocha',
    // retries are listed in the summary, never hidden
    mochaOpts: { ui: 'bdd', timeout: c.testTimeout, retries: c.retries },
    waitforTimeout: 10000,
    connectionRetryCount: 1,
    reporters: ['spec'],
    ...overrides,

    async onPrepare(_config, caps) {
      // a launcher that names the run can follow it from the first line
      const stamp =
        process.env.E2E_RUN_STAMP ||
        new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      process.env.E2E_RUN_DIR = join(c.outDir, stamp)
      mkdirSync(runDir(), { recursive: true })
      setCurrentRun({ run: stamp, pid: process.pid, started: Date.now() })
      const on = platform()
      // the run's tests: the platform's now, its kind of device's once the
      // preflight has picked the device (the plan is written again then)
      let tests: PlannedTest[] | undefined
      try {
        tests = plan(discoverTests(), planArgsFrom(process.argv))
        writePlan(runDir(), forPlatform(tests, on))
      } catch (e) {
        if (e instanceof TargetTagError) {
          // a test that could run nowhere: stop before touching a device
          const error = (e as Error).message
          process.env.E2E_PREFLIGHT_FAILED = error
          emit({ type: 'run-end', error })
          clearCurrentRun(stamp)
          throw new SevereServiceError(error)
        }
        console.log(`no plan for this run: ${(e as Error).message}`)
      }
      await showOnDashboard(stamp)
      emit({ type: 'stage', stage: 'preflight' })

      process.env.E2E_RUN_STARTED = `${Date.now()}`
      // a failed preflight must stop the run: a plain throw here is only
      // logged, and the specs would start anyway on a device that isn't ready
      const { app, notes, serial, realDevice } = await measure(
        'preflight',
        preflight,
      ).catch(e => {
        const error = `preflight FAILED: ${e.message}`
        process.env.E2E_PREFLIGHT_FAILED = error
        emit({ type: 'run-end', error })
        clearCurrentRun(stamp)
        throw new SevereServiceError(error)
      })
      const platformName = (caps as WebdriverIO.Capabilities[])[0]?.platformName
      // the workers read these in beforeSession: what onPrepare writes into
      // the capabilities never reaches them
      process.env.E2E_UDID = serial
      process.env.E2E_IOS_REAL = on === 'ios' && realDevice ? '1' : ''
      // a phone or a simulator/emulator: which device-tagged tests run
      const kind: DeviceKind =
        on === 'ios'
          ? realDevice
            ? 'device'
            : 'virtual'
          : isEmulator(serial)
            ? 'virtual'
            : 'device'
      process.env.E2E_DEVICE_KIND = kind
      if (tests) writePlan(runDir(), forPlatform(tests, on, kind))

      fetchMain()
      const git = currentGit()
      writeRun({
        run: stamp,
        platform: platformName,
        app,
        git,
        release: releaseOf(git.commit),
        results: [],
      })
      const pruned = prune(stamp)
      if (pruned.length) notes.push(`pruned old reports: ${pruned.join(', ')}`)
      emit({
        type: 'run-start',
        device: serial,
        platform: `${platformName ?? ''}`,
      })

      emit({ type: 'stage', stage: 'sweep (start)' })
      const swept = await measure('sweep (start)', sweep)
      writeFileSync(
        join(runDir(), 'preflight.json'),
        JSON.stringify({ notes, sweptAtStart: swept }, null, 2),
      )
      console.log(`preflight OK\n- ${notes.join('\n- ')}`)
      emit({ type: 'stage', stage: 'tests' })
      if (swept.length) console.log(`swept before the run: ${swept.join(', ')}`)
    },

    // a spec whose worker or session never starts has no test events at all:
    // these say it was tried, and how its worker ended
    onWorkerStart(_cid, _caps, specs) {
      emit({ type: 'spec-start', specs: specs.map(specKey) })
    },

    onWorkerEnd(_cid, exitCode, specs) {
      if (stoppedFromOutside()) return
      const keys = specs.map(specKey)
      emit({ type: 'spec-end', specs: keys, exitCode })
      if (!exitCode) return
      // a spec that left no result at all gets one line, so a session that
      // never started can't read as a clean run. A spec whose tests failed
      // exits 1 too, but it has its results already
      const results = readJsonLines<TestResult>(join(runDir(), 'results.jsonl'))
      const tests = readPlan(runDir())
      for (const spec of keys) {
        const describes = tests
          .filter(t => t.spec === spec)
          .map(t => t.describe)
        const reported = results.some(r =>
          describes.some(d => r.title.startsWith(`${d} > `)),
        )
        if (!describes.length || reported) continue
        appendFileSync(
          join(runDir(), 'results.jsonl'),
          JSON.stringify({
            title: `${spec} > session`,
            passed: false,
            error: `spec did not run: exit ${exitCode}`,
            retries: 0,
            seconds: 0,
          } satisfies TestResult) + '\n',
        )
      }
    },

    // the device the preflight chose, for this worker's session
    beforeSession(wdioConfig, caps) {
      // the other platform's and the other kind of device's tests never start
      wdioConfig.mochaOpts = {
        ...wdioConfig.mochaOpts,
        ...platformGrep(
          wdioConfig.mochaOpts ?? {},
          platform(),
          process.env.E2E_DEVICE_KIND as DeviceKind | undefined,
        ),
      }
      const capabilitiesHere = caps as WebdriverIO.Capabilities &
        Record<string, unknown>
      if (process.env.E2E_UDID)
        capabilitiesHere['appium:udid'] = process.env.E2E_UDID
      if (process.env.E2E_IOS_REAL)
        Object.assign(capabilitiesHere, iphoneCapabilities())
    },

    // every request to the app is timed: a frozen app is killed and its test
    // fails as "app froze", rather than sitting out Mocha's timeout
    before() {
      watchApp(browser, process.env.E2E_UDID ?? '', runDir())
    },

    beforeTest(test) {
      watching(`${test.parent} > ${test.title}`)
      emit({ type: 'test-start', key: `${test.parent} > ${test.title}` })
    },

    beforeHook(test, _context, hookName) {
      const describe = test.parent || test.title
      emit({
        type: 'hook-start',
        key: describe,
        describe,
        hook: hookName ?? 'hook',
      })
    },

    async afterTest(test, context, { error, passed, retries, duration }) {
      const froze = frozeInTest()
      // Mocha retries while currentRetry() < retries(). The attempt is the one
      // `test` was copied from as it began (a late end of a timed-out attempt
      // must not speak for the retry running now); the limit is the live one,
      // as this.retries(0) changes it during the body
      const live = (context as Mocha.Context | undefined)?.test as
        | (Mocha.Test & { currentRetry(): number })
        | undefined
      const attempt =
        (test as { _currentRetry?: number })._currentRetry ??
        live?.currentRetry() ??
        0
      const title = `${test.parent} > ${test.title}`
      // WDIO reports a skipped test as not passed, with no error
      const skipped = !passed && !error
      const result: TestResult = {
        title,
        passed,
        skipped,
        needsPerson: skipped ? takeNeedsPerson(title) : undefined,
        // the request that failed when the app was killed says nothing useful
        error:
          !passed && froze
            ? describeFreeze(froze)
            : error?.message?.split('\n')[0],
        retries: retries.attempts,
        seconds: Math.round(duration / 1000),
      }
      await record(result)
      const final =
        !live || passed || !!result.skipped || attempt >= live.retries()
      if (final) ended.add(result.title)
      emit({
        type: 'test-end',
        key: result.title,
        passed: result.passed,
        skipped: result.skipped,
        needsPerson: result.needsPerson,
        error: result.error,
        seconds: result.seconds,
        retries: result.retries,
        final,
        artifacts: result.artifacts,
      })
      recordTiming('test body', duration)
      // undo the test's public writes at once, whether it passed or not
      await cleanUpAfter()
    },

    // a before/beforeEach hook that fails or skips ends its tests without any
    // beforeTest or afterTest: they are ended here, or a live view would wait
    // for them forever. A failed afterEach does the same to the rest of its
    // describe (Mocha aborts the suite and drops a retry still owed)
    async afterHook(test, context, { duration, error, passed }, hookName) {
      recordTiming(`hook: ${hookName ?? 'hook'}`, duration ?? 0)
      if (passed) return
      const hook = hookName ?? 'hook'
      const parent = test.parent ?? test.title
      const key = `${parent} > ${hook}`
      const skipped = !error
      const message = error?.message?.split('\n')[0]
      // a skip in an afterEach comes after its test ended: nothing to decide
      if (/^before/i.test(hook) || (hook === 'afterEach' && !skipped)) {
        for (const t of decidedBy(context as Mocha.Context, hook, skipped)) {
          const testKey = `${t.parent?.title} > ${t.title}`
          ended.add(testKey)
          emit({
            type: 'test-end',
            key: testKey,
            passed: false,
            skipped,
            error: skipped
              ? `skipped by its ${hook} hook`
              : `${hook} failed: ${message ?? ''}`,
            seconds: 0,
            retries: 0,
            // Mocha never retries a test its hook decided for
            final: true,
          })
        }
      }
      if (skipped) {
        emit({ type: 'hook-skip', key, hook, parent })
        return
      }
      await record({
        title: key,
        passed: false,
        error: message,
        retries: 0,
        seconds: 0,
      })
      emit({ type: 'hook-fail', key, hook, parent, error: message })
      // a hook can write too: undo it now, not at the end-of-run sweep, or
      // what it left breaks the specs after it
      await cleanUpAfter()
    },

    async onComplete() {
      // onPrepare already ended the run and said why; nothing ran to sum up
      if (process.env.E2E_PREFLIGHT_FAILED) return
      if (stoppedFromOutside()) return
      emit({ type: 'stage', stage: 'sweep (end)' })
      const result: Sweep = { swept: [] }
      await measure('sweep (end)', sweep).then(
        removed => (result.swept = removed),
        e => (result.error = (e as Error).message),
      )
      emit({
        type: 'cleanup',
        done: result.swept.map(item => `sweep at the end: ${item}`),
        failed: result.error ? [`sweep at the end: ${result.error}`] : [],
      })
      const runSeconds = Math.round(
        (Date.now() - Number(process.env.E2E_RUN_STARTED)) / 1000,
      )
      const summary = writeSummary(runDir(), runSeconds, result)
      emit({ type: 'run-end', summary: summary.path })
      clearCurrentRun(runDir().split(/[\\/]/).pop()!)
      console.log(`\n${summary.text}\n\nsummary: ${summary.path}`)
    },
  }
}
