import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import {
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from 'node:path'
import {
  APPIUM_PORT,
  DASHBOARD_PORT,
  E2E_DIR,
  METRO_PORT,
  OUT_DIR,
  PUBLIC,
  TITLE,
} from './env.js'
import { ensureAppium, ensureMetroUp } from '../device.js'
import { discoverTests, leftOutByTarget, type PlannedTest } from '../plan.js'
import {
  devices,
  knownDevices,
  listening,
  liveRun,
  startRun,
  startable,
  startVirtual,
  stopRun,
  type Device,
  type Startable,
} from './control.js'
import {
  attempts,
  estimates,
  eta,
  historyKey,
  outcomes,
  onScreenIds,
  readHistory,
  readReviewed,
  runs,
  toggleReviewed,
  type Estimates,
  type History,
} from './data.js'
import {
  flakyTests,
  kpis,
  matrix,
  preflightDevice,
  readDigests,
  runInfo,
  settle,
  WINDOW,
  FLAKY_WINDOW,
} from './history.js'

// The e2e dashboard: a small local server (e2e-harness dashboard, or opened
// by a run: dashboard-launch.ts) and one page (dashboard/public/), plain HTML
// and JS with no build step. Everything it shows comes from the run folders
// (out/<run>/), which the runner writes as it goes (events.ts); the page polls.

export { DASHBOARD_PORT }

/**
 * When the page last polled: a run opens a new tab only if none is open.
 * Only the page's own polling counts (current and runs), never the runner's
 * health check, which would otherwise count as a visit every time.
 */
let lastVisit = 0

// history is every run's results: read again at most every few seconds
let cache: { at: number; history: History; est: Estimates } | undefined
function past() {
  if (!cache || Date.now() - cache.at > 5000) {
    const history = readHistory()
    cache = { at: Date.now(), history, est: estimates(history) }
  }
  return cache
}

// a run's own estimates leave the run out (see estimates()), kept as long
let runEst: { at: number; run: string; est: Estimates } | undefined
function estimatesFor(run: string) {
  if (!runEst || runEst.run !== run || Date.now() - runEst.at > 5000) {
    runEst = { at: Date.now(), run, est: estimates(past().history, run) }
  }
  return runEst.est
}

/** a run, ready for the page: its tests' states and estimates, and the ETA */
function runPayload(stamp: string) {
  const { state, alive, lost, lastSign } = settle(stamp)
  const est = estimatesFor(stamp)
  const info = runInfo(stamp)
  const device = state.device ?? preflightDevice(stamp)
  const tests = state.plan.map(test => ({
    ...test,
    state: state.states.get(test.key),
    estimate: Math.round(est.test(test.key)),
  }))
  return {
    run: stamp,
    device,
    stage: state.stage,
    step: state.step,
    prep: state.prep,
    started: state.started,
    ended: state.ended,
    running: !state.ended && alive,
    lost,
    lostAt: lost ? lastSign : undefined,
    tests,
    extra: state.extra,
    cleanups: state.cleanups,
    freezes: state.freezes,
    hookFailures: state.hookFailures,
    eta: alive ? eta(state, est) : undefined,
    // the time bar: each attempt's start and end
    attempts: attempts(state),
    // what it ran against (run.json): the header line of the run's page
    info: info && {
      release: info.release,
      platform: info.platform,
      app: info.app,
      git: info.git,
    },
    model: device ? knownDevices()[device]?.model : undefined,
    summary: existsSync(join(OUT_DIR, stamp, 'summary.md')),
    now: Date.now(),
  }
}

// the runs boiled down (history.ts): every few seconds at most, as the
// history above. Ended runs are kept in history.ts until their files change
let digestCache:
  | { at: number; digests: ReturnType<typeof readDigests> }
  | undefined
function allDigests() {
  if (!digestCache || Date.now() - digestCache.at > 4000) {
    digestCache = { at: Date.now(), digests: readDigests(allTests()) }
  }
  return digestCache.digests
}

/** every run, newest first, and the Overview's figures per platform */
function historyPayload() {
  const digests = allDigests()
  return {
    runs: digests.map(d => d.summary).reverse(),
    kpis: {
      all: kpis(digests),
      android: kpis(digests, 'android'),
      ios: kpis(digests, 'ios'),
    },
    window: WINDOW,
    // the devices' names: Run history polls this, and /api/devices would ask
    // adb (blocking this server) every few seconds just for them
    known: knownDevices(),
    now: Date.now(),
  }
}

/** devices connected now (adb asks each for its model): kept a few seconds */
let devicesCache: { at: number; list: Device[] } | undefined
function connected(fresh = false) {
  if (fresh || !devicesCache || Date.now() - devicesCache.at > 5000) {
    devicesCache = { at: Date.now(), list: devices() }
  }
  return devicesCache.list
}

/** emulators and simulators that aren't running: kept as long as devices */
let startableCache: { at: number; list: Startable[] } | undefined
function startableNow(fresh = false) {
  if (fresh || !startableCache || Date.now() - startableCache.at > 5000) {
    startableCache = { at: Date.now(), list: startable(connected(fresh)) }
  }
  return startableCache.list
}

/** what a run needs besides this server: Appium and Metro listening */
async function statusPayload() {
  const [appium, metro] = await Promise.all([
    listening(APPIUM_PORT),
    METRO_PORT ? listening(METRO_PORT) : Promise.resolve(false),
  ])
  return {
    server: { up: true, port: DASHBOARD_PORT, dir: E2E_DIR, title: TITLE },
    appium: { up: appium, port: APPIUM_PORT },
    // an app without Metro: the page leaves its pill out
    metro: METRO_PORT ? { up: metro, port: METRO_PORT } : undefined,
    now: Date.now(),
  }
}

// the specs' tests, from Mocha's dry run (half a second): kept a little
let testsCache: { at: number; tests: PlannedTest[] } | undefined
function allTests() {
  if (!testsCache || Date.now() - testsCache.at > 15000) {
    testsCache = { at: Date.now(), tests: discoverTests() }
  }
  return testsCache.tests
}

/** every test with how it has been doing: the Tests view */
function testsPayload() {
  const { est, history } = past()
  const reviewed = readReviewed()
  const tests = allTests().map(test => {
    const ran = outcomes(history.get(historyKey(test.key)))
    const last = ran.at(-1)
    return {
      ...test,
      estimate: Math.round(est.test(test.key)),
      last: last && {
        run: last.run,
        status: last.skipped ? 'skipped' : last.passed ? 'passed' : 'failed',
        seconds: last.seconds,
        flaky: last.flaky,
        error: last.error,
        reviewed: reviewed[test.key] === last.run,
      },
      // newest last: the strip of recent results
      recent: ran.slice(-8).map(o => ({
        run: o.run,
        status: o.skipped
          ? 'skipped'
          : o.passed
            ? o.flaky
              ? 'flaky'
              : 'passed'
            : 'failed',
        seconds: o.seconds,
      })),
    }
  })
  // what a run costs besides its tests' bodies, for the page's estimate:
  // per test (beforeEach/afterEach), per describe, and per run
  return {
    tests,
    perTest: est.overhead,
    setup: est.setup,
    overhead: est.start + est.end,
    // the tags a run leaves out, by platform and kind of device (a phone, or
    // a simulator / emulator); none with E2E_ALL_PLATFORMS
    leaves: leftOutByTarget(),
  }
}

/**
 * The run this server started last, until its launcher exits. A new run is
 * in current.json only once its launcher reaches onPrepare, seconds after the
 * spawn: until then liveRun() can't see it, and a second click (the other
 * view, another tab) would start a second run on the same device.
 */
let launching: string | undefined

/** a run is going on, or this server has just started one */
const busy = () => !!(launching || liveRun())

/**
 * Starts a run of these tests, unless one is going on (one device, one run).
 * `queue`: while one is going on, keep this run in the queue instead (it
 * starts by itself when the runs before it have ended); `label` is how the
 * page names it there.
 */
function launch(
  keys: string[],
  deviceId?: string,
  { queue = false, label = '' } = {},
) {
  if (busy()) {
    if (!queue)
      return {
        status: 409,
        body: { error: 'A run is going on already: stop it first.' },
      }
    if (!keys.length)
      return { status: 400, body: { error: 'No known test to run.' } }
    const item = queued.add(keys, deviceId, label)
    return {
      status: 200,
      body: { queued: item.id, position: queued.items.length },
    }
  }
  const byKey = new Map(allTests().map(test => [test.key, test]))
  const tests = keys
    .map(key => byKey.get(key))
    .filter((t): t is PlannedTest => !!t)
  if (!tests.length)
    return { status: 400, body: { error: 'No known test to run.' } }
  const device: Device | undefined = deviceId
    ? connected(true).find(d => d.id === deviceId)
    : undefined
  if (deviceId && !device) {
    return { status: 400, body: { error: `${deviceId} is not connected.` } }
  }
  if (device && !device.usable) {
    return { status: 400, body: { error: `${device.model}: ${device.why}.` } }
  }
  const { stamp, child } = startRun(tests, device)
  launching = stamp
  const done = () => {
    cache = undefined
    digestCache = undefined
    if (launching === stamp) launching = undefined
  }
  digestCache = undefined
  child.on('exit', done)
  // a launcher that never spawned sends no exit
  child.on('error', done)
  return { status: 200, body: { run: stamp, tests: tests.length } }
}

// --- the queue ----------------------------------------------------------------------
// Runs set up while another one goes on. They wait in out/queue.json (so a
// restarted server keeps them) and start one at a time, in order, each once
// the run before it has ended. A run that can't start (its device gone, its
// tests renamed) stays at the head with the reason, and holds the queue until
// the dev retries or removes it: the runs behind it may need the same device.

type QueueItem = {
  id: string
  keys: string[]
  device?: string
  label: string
  addedAt: number
  /** why it could not start: the queue waits on it */
  error?: string
}

const QUEUE_FILE = join(OUT_DIR, 'queue.json')

const queued = {
  items: [] as QueueItem[],
  load() {
    try {
      const items = JSON.parse(readFileSync(QUEUE_FILE, 'utf8'))
      if (Array.isArray(items)) this.items = items
    } catch {
      // no queue yet
    }
  },
  save() {
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(QUEUE_FILE, JSON.stringify(this.items, null, 2))
  },
  add(keys: string[], device: string | undefined, label: string) {
    const item: QueueItem = {
      id: randomUUID().slice(0, 8),
      keys,
      device,
      label: label || `${keys.length} test${keys.length === 1 ? '' : 's'}`,
      addedAt: Date.now(),
    }
    this.items.push(item)
    this.save()
    return item
  },
  remove(id: string) {
    const before = this.items.length
    this.items = this.items.filter(item => item.id !== id)
    if (this.items.length !== before) this.save()
    return this.items.length !== before
  },
  retry(id: string) {
    const item = this.items.find(i => i.id === id)
    if (!item) return false
    delete item.error
    this.save()
    return true
  },
}

/** the queue's head, started once nothing is going on */
function startNext() {
  const next = queued.items[0]
  if (!next || next.error || busy()) return
  const { status, body } = launch(next.keys, next.device)
  if (status === 200) {
    queued.items.shift()
  } else {
    next.error = (body as { error?: string }).error ?? `answer ${status}`
  }
  queued.save()
}

/** the queue for the page: each run's tests by count, its device's name */
function queuePayload() {
  const known = knownDevices()
  return {
    items: queued.items.map(item => ({
      id: item.id,
      label: item.label,
      tests: item.keys.length,
      device: item.device,
      model: item.device ? known[item.device]?.model : undefined,
      addedAt: item.addedAt,
      error: item.error,
    })),
    now: Date.now(),
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.xml': 'text/xml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
}

// a failure's screenshot and UI tree are written once and never again: the
// browser may keep them, so a redrawn page doesn't fetch them anew
const KEPT = new Set(['.png', '.xml'])

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * `file` lies inside `root`. path.relative compares as the file system does
 * (case-insensitively on Windows), and a separator boundary is implied: a
 * sibling folder named like `root` plus more is outside.
 */
function inside(root: string, file: string) {
  const rel = relative(root, file)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

/** a file under `root`, never outside it, and never a folder */
function sendFile(
  res: ServerResponse,
  root: string,
  path: string,
  kept = false,
) {
  const file = normalize(join(root, path))
  if (!inside(root, file) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end()
    return
  }
  // read before the head goes out: a failed read must still get an answer
  let body: Buffer | string = readFileSync(file)
  // the page carries the app's name
  if (file === join(PUBLIC, 'index.html'))
    body = body.toString('utf8').replaceAll('{{TITLE}}', escapeHtml(TITLE))
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control':
      kept && KEPT.has(extname(file)) ? 'max-age=3600' : 'no-store',
  })
  res.end(body)
}

const isRun = (stamp: string) =>
  /^\d{4}-\d\d-\d\dT[\d-]+$/.test(stamp) && existsSync(join(OUT_DIR, stamp))

export function startServer(port = DASHBOARD_PORT) {
  const server = createServer(async (req, res) => {
    try {
      let url: URL
      let parts: string[]
      try {
        url = new URL(req.url ?? '/', 'http://localhost')
        parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      } catch {
        // a malformed address (a bad %-escape): an answer, not a crash
        return send(res, 400, { error: 'bad url' })
      }
      if (parts[0] !== 'api') {
        // the page and its files; artifacts under /files/<run>/<file>
        if (parts[0] === 'files' && parts[1] && isRun(parts[1])) {
          return sendFile(
            res,
            join(OUT_DIR, parts[1]),
            parts.slice(2).join('/'),
            true,
          )
        }
        return sendFile(res, PUBLIC, parts.join('/') || 'index.html')
      }
      const [, what, stamp, action] = parts

      // the last real visit, and which checkout this server reads: the two
      // clones share the default port
      if (what === 'health')
        return send(res, 200, { ok: true, lastVisit, dir: E2E_DIR })

      // the run going on, else the newest one
      if (what === 'current') {
        lastVisit = Date.now()
        const live = liveRun()?.run
        return send(res, 200, {
          run: live ?? runs().at(-1),
          live: !!live,
          // runs waiting their turn (the queue)
          queued: queued.items.length,
        })
      }

      if (what === 'queue') {
        if (!stamp) return send(res, 200, queuePayload())
        if (
          req.method === 'POST' &&
          (action === 'remove' || action === 'retry')
        ) {
          const done =
            action === 'remove' ? queued.remove(stamp) : queued.retry(stamp)
          if (!done) return send(res, 404, { error: 'Not in the queue.' })
          if (action === 'retry') startNext()
          return send(res, 200, queuePayload())
        }
      }

      if (what === 'tests') return send(res, 200, testsPayload())
      // start an emulator or a simulator; it joins the devices once booted
      if (what === 'devices' && stamp === 'start' && req.method === 'POST') {
        const body = await readBody(req)
        const item = startableNow(true).find(
          s => s.id === body.id && s.platform === body.platform,
        )
        if (!item)
          return send(res, 400, {
            error: `${body.id} is not an emulator or simulator that can start.`,
          })
        startVirtual(item)
        startableCache = undefined
        return send(res, 200, { started: item.name })
      }

      if (what === 'devices') {
        return send(res, 200, {
          devices: connected(url.searchParams.has('fresh')),
          preferred: process.env.E2E_ANDROID_DEVICE || process.env.E2E_IOS_UDID,
          // emulators and simulators the page can start
          startable: startableNow(url.searchParams.has('fresh')),
          // every device seen connected once, by serial: names for the
          // devices runs recorded (they record the serial only)
          known: knownDevices(),
          now: Date.now(),
        })
      }
      // a status pill clicked: start what it shows down, in a window of its
      // own (Terminal on macOS), and answer once it listens
      if (what === 'status' && stamp === 'start' && req.method === 'POST') {
        const body = await readBody(req)
        try {
          if (body.what === 'appium') await ensureAppium()
          else if (body.what === 'metro') await ensureMetroUp()
          else
            return send(res, 400, { error: `Nothing to start: ${body.what}` })
        } catch (e) {
          return send(res, 500, { error: (e as Error).message })
        }
        return send(res, 200, await statusPayload())
      }
      if (what === 'status') return send(res, 200, await statusPayload())
      if (what === 'history') return send(res, 200, historyPayload())
      if (what === 'flaky') {
        return send(res, 200, {
          tests: flakyTests(past().history, allTests()),
          window: FLAKY_WINDOW,
        })
      }
      if (what === 'matrix') {
        return send(res, 200, {
          ...matrix(allDigests(), allTests()),
          known: knownDevices(),
        })
      }

      // a new run of the tests picked on the Tests view
      if (what === 'runs' && !stamp && req.method === 'POST') {
        const body = await readBody(req)
        const { status, body: out } = launch(body.keys ?? [], body.device, {
          queue: !!body.queue,
          label: typeof body.label === 'string' ? body.label.slice(0, 200) : '',
        })
        return send(res, status, out)
      }

      if (what === 'runs' && stamp && isRun(stamp)) {
        // the run's failed tests again, on the same device
        if (action === 'rerun-failed' && req.method === 'POST') {
          const body = await readBody(req)
          // the failures the page counts: a lost run's cut-off tests too
          const run = runPayload(stamp)
          const failed = run.tests
            .filter(test => test.state?.status === 'failed')
            .map(test => test.key)
          const { status, body: out } = launch(
            failed,
            body.device ?? run.device,
            {
              queue: !!body.queue,
              label: `The ${failed.length} failed in ${stamp}`,
            },
          )
          return send(res, status, out)
        }
        if (action === 'rerun' && req.method === 'POST') {
          // tests of this run picked by key (one test, or all of them),
          // whatever they ended with
          const body = await readBody(req)
          const run = runPayload(stamp)
          const all = run.tests.map(test => test.key)
          const keys = Array.isArray(body.keys)
            ? all.filter(key => body.keys.includes(key))
            : all
          if (!keys.length) {
            return send(res, 400, {
              error: 'None of these tests is in this run.',
            })
          }
          const one = run.tests.find(test => test.key === keys[0])
          const { status, body: out } = launch(
            keys,
            body.device ?? run.device,
            {
              queue: !!body.queue,
              label:
                keys.length === 1
                  ? `${one?.title ?? keys[0]} (again, from ${stamp})`
                  : keys.length === all.length
                    ? `All ${keys.length} of ${stamp}`
                    : `${keys.length} tests of ${stamp}`,
            },
          )
          return send(res, status, out)
        }
        if (!action && req.method === 'GET') {
          lastVisit = Date.now()
          return send(res, 200, runPayload(stamp))
        }
        if (action === 'stop' && req.method === 'POST') {
          const result = await stopRun(stamp)
          return result.stopped
            ? send(res, 200, { sweep: result.sweep })
            : send(res, 409, {
                error: 'This run is not going on: nothing was stopped.',
              })
        }
        if (action === 'screen' && req.method === 'GET') {
          // what was on screen at a failure, as testIDs. The artifacts sit
          // right in the run's folder: one name, nothing above or below it
          const runDir = join(OUT_DIR, stamp)
          const artifacts = resolve(
            runDir,
            url.searchParams.get('artifacts') ?? '',
          )
          const rel = relative(runDir, artifacts)
          if (!inside(runDir, artifacts) || /[\\/]/.test(rel)) {
            return send(res, 400, { error: 'not this run' })
          }
          return send(res, 200, { ids: onScreenIds(join(runDir, rel)) })
        }
      }

      if (what === 'reviewed') {
        if (req.method === 'POST') {
          const body = await readBody(req)
          return send(res, 200, toggleReviewed(body.key, body.run))
        }
        return send(res, 200, readReviewed())
      }

      send(res, 404, { error: 'unknown' })
    } catch (e) {
      // a head already out (a file half sent): all that is left is to close
      if (res.headersSent) res.destroy()
      else send(res, 500, { error: (e as Error).message })
    }
  })
  server.listen(port, '127.0.0.1')
  // the queue: kept across restarts, its head started once nothing runs
  queued.load()
  const queueTimer = setInterval(startNext, 3000)
  server.on('close', () => clearInterval(queueTimer))
  return server
}

function readBody(req: import('node:http').IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => (data += chunk))
    req.on('error', reject)
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (e) {
        reject(e)
      }
    })
  })
}

/** `e2e-harness dashboard`: serves until the window is closed */
export function runDashboard() {
  // the window stays up whatever one request does
  process.on('unhandledRejection', e => console.error(e))
  startServer()
    .on('listening', () =>
      console.log(
        `e2e dashboard: http://127.0.0.1:${DASHBOARD_PORT}  (${E2E_DIR}; close this window to stop it)`,
      ),
    )
    .on('error', e => {
      // most likely the port: another checkout's dashboard, or this one's
      console.error(`the dashboard could not start: ${e.message}`)
      process.exitCode = 1
    })
}

function escapeHtml(text: string) {
  return text.replace(
    /[&<>"']/g,
    c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  )
}
