import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { androidActivity, appId, config } from '../config.js'
import { metroOwner, servesThisApp } from '../device.js'
import { AdbSession, adbCli } from './adb-session.js'
import {
  acceptPermissionDialogs,
  dismissDevOverlays,
  parseAllNodes,
  PERMISSION_ALLOW,
  type UiNode,
  within,
} from './source.js'
import { isAppiumUp, newSession, Session } from './wd.js'

// The app on a connected Android device, one command at a time, checked by
// testID rather than by screenshot: a quick check that is not (yet) a spec.
export const ANDROID_USAGE = `e2e-harness device <command>
  preflight            device, app build, Metro (which checkout), port reverse
  ids [--all]          testIDs on screen (--all: off-screen and system ones too)
  has <id>             exit 0 when present, 1 when not
  wait <id> [ms]       until present (default 15000)
  gone <id> [ms]       until absent (default 15000)
  watch <ms> <id..>    log each id appearing and disappearing, with epoch ms
  tap <id>             tap the topmost visible match; <prefix>* for dynamic ids
                       [--watch <ms> <id..>] then watch those in the same process
  text <id>            the text of the element and everything inside it
  type <id> <text>     focus the field and type
  back | hide-keyboard | allow
  deeplink <url>       open a URL through the app's intent filters
  launch | restart     start the app / force-stop and start it
  clear --yes          DESTRUCTIVE: wipe the app's data, relaunch
  jslog [n] [regex]    the last n ReactNativeJS logcat lines (default 40)
  shot <file.png>      screenshot: a last resort, expensive to read
  end                  close the cached Appium session

Backend: Appium when a server answers, adb otherwise (DEVICE_BACKEND=adb|appium
forces one). Several devices: set ANDROID_SERIAL.`

type AnySession = Session | AdbSession

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

class Usage extends Error {}
const usage = (message: string): never => {
  throw new Usage(message)
}

// one cached session per device: a session belongs to the device Appium opened it on
const sessionFile = () =>
  join(
    tmpdir(),
    `e2e-harness-android-session-${process.env.ANDROID_SERIAL || 'only-device'}`,
  )

async function connect(): Promise<AnySession> {
  const pkg = appId('android')
  // several devices and no ANDROID_SERIAL: adb refuses to guess, Appium would pick one itself
  const attached = adbCli(['devices'])
    .split('\n')
    .slice(1)
    .filter(l => /\tdevice$/.test(l.trim()))
  if (attached.length > 1 && !process.env.ANDROID_SERIAL) {
    usage(
      `${attached.length} devices attached: set ANDROID_SERIAL to the one to drive`,
    )
  }
  const forced = process.env.DEVICE_BACKEND
  if (forced === 'adb' || (forced !== 'appium' && !(await isAppiumUp())))
    return new AdbSession(pkg)
  if (existsSync(sessionFile())) {
    const s = new Session(readFileSync(sessionFile(), 'utf8').trim())
    try {
      await s.source()
      return s
    } catch {
      unlinkSync(sessionFile())
    }
  }
  const id = await newSession({
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:appPackage': pkg,
    'appium:appActivity': androidActivity(),
    // attach to whatever state the app is in: never reinstall, clear or relaunch
    'appium:noReset': true,
    'appium:dontStopAppOnReset': true,
    'appium:autoLaunch': false,
    'appium:newCommandTimeout': 600,
    'appium:disableWindowAnimation': true,
    'appium:ignoreHiddenApiPolicyError': true,
    ...(process.env.ANDROID_SERIAL && {
      'appium:udid': process.env.ANDROID_SERIAL,
    }),
  })
  writeFileSync(sessionFile(), id)
  return new Session(id)
}

async function screen(s: AnySession) {
  const all = parseAllNodes(await s.source(), appId('android'))
  // the first node with bounds is the window root: the screen's size
  const root = all.find(n => n.bounds)?.bounds ?? { w: 1080, h: 2400 }
  const visible = (n: UiNode) =>
    !!n.bounds &&
    n.bounds.w > 0 &&
    n.bounds.h > 0 &&
    n.bounds.x < root.w &&
    n.bounds.x + n.bounds.w > 0 &&
    n.bounds.y < root.h &&
    n.bounds.y + n.bounds.h > 0
  return { all, nodes: all.filter(n => n.testID), visible }
}

const matcher = (id: string) =>
  id.endsWith('*')
    ? (n: UiNode) => n.testID.startsWith(id.slice(0, -1))
    : (n: UiNode) => n.testID === id

// Stacked screens reuse ids (every page has its own back button) and screens
// below stay mounted, so the first match is often on a page underneath. The
// last visible one in document order is the one on top.
async function topmost(s: AnySession, id: string) {
  const { nodes, visible } = await screen(s)
  const hits = nodes.filter(matcher(id)).filter(visible)
  return hits[hits.length - 1]
}

// for short-lived states (a loader) a separate `has` call is too slow to catch
async function watch(s: AnySession, ms: number, ids: string[]) {
  const seen = new Map(ids.map(id => [id, false]))
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const { nodes } = await screen(s)
    for (const id of ids) {
      const now = nodes.some(matcher(id))
      if (now !== seen.get(id))
        console.log(`${now ? '+' : '-'} ${id} at ${Date.now()}`)
      seen.set(id, now)
    }
  }
}

async function waitUntil(
  s: AnySession,
  id: string,
  present: boolean,
  ms: number,
) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if ((await screen(s)).nodes.some(matcher(id)) === present)
      return Date.now() - t0
    await sleep(400)
  }
  return -1
}

/** opens the app with the dev link when there is one, so no LogBox toast ever shows */
function launch() {
  const pkg = appId('android')
  const link = config().devLink
  if (link) {
    const query = ['logbox=off', link.launch].filter(Boolean).join('&')
    // one remote command, so the device's shell doesn't split the URL on '&'
    adbCli([
      'shell',
      `am start -a android.intent.action.VIEW -d '${link.url}?${query}' ${pkg}`,
    ])
  } else {
    adbCli([
      'shell',
      'monkey',
      '-p',
      pkg,
      '-c',
      'android.intent.category.LAUNCHER',
      '1',
    ])
  }
}

async function preflight() {
  const fail: string[] = []
  const warn: string[] = []
  const info: string[] = []
  let devices: string[]
  try {
    devices = adbCli(['devices'])
      .split('\n')
      .slice(1)
      .filter(l => /\tdevice$/.test(l.trim()))
  } catch {
    return {
      fail: ['adb not found (set ANDROID_HOME or put adb on PATH)'],
      warn,
      info,
    }
  }
  if (!devices.length)
    fail.push('no device attached in state "device" (adb devices)')
  if (devices.length > 1 && !process.env.ANDROID_SERIAL)
    fail.push(
      `${devices.length} devices attached: set ANDROID_SERIAL to pick one`,
    )
  if (fail.length) return { fail, warn, info }
  const prop = (name: string) => adbCli(['shell', 'getprop', name]).trim()
  info.push(
    `device ${process.env.ANDROID_SERIAL || devices[0].split('\t')[0]} (${prop('ro.product.model')}, Android ${prop('ro.build.version.release')})`,
  )

  const pkg = appId('android')
  const dump = adbCli(['shell', 'dumpsys', 'package', pkg])
  if (!/versionName=/.test(dump)) {
    fail.push(`${pkg} is not installed`)
    return { fail, warn, info }
  }
  const version = dump.match(/versionName=(\S+)/)?.[1]
  const code = dump.match(/versionCode=(\d+)/)?.[1]
  const debuggable = /flags=\[[^\]]*DEBUGGABLE/.test(dump)
  info.push(
    `app ${version} (${code}), ${debuggable ? 'debug' : 'RELEASE'} build`,
  )
  if (!debuggable)
    warn.push(
      'release build: it runs its own bundle, so local JS changes are NOT on the device',
    )

  const metro = config().metro
  if (debuggable && metro) {
    const owner = metroOwner(metro.port)
    if (!owner) fail.push(`Metro is not running on ${metro.port}`)
    else if (servesThisApp(owner))
      info.push(`Metro on ${metro.port} serves this app (${config().appDir})`)
    else
      fail.push(
        `Metro on ${metro.port} is NOT serving this app (${config().appDir}): ${owner}`,
      )
    if (!new RegExp(`tcp:${metro.port}`).test(adbCli(['reverse', '--list']))) {
      adbCli(['reverse', `tcp:${metro.port}`, `tcp:${metro.port}`])
      info.push(`adb reverse tcp:${metro.port} was missing: set it`)
    }
  }
  info.push(
    `backend: ${process.env.DEVICE_BACKEND || ((await isAppiumUp()) ? 'appium' : 'adb (no Appium server)')}`,
  )
  return { fail, warn, info }
}

/** runs one command; returns the exit code */
export async function androidCommand(cmd: string | undefined, args: string[]) {
  try {
    return await run(cmd, args)
  } catch (e) {
    if (e instanceof Usage) {
      console.error(e.message)
      return 2
    }
    throw e
  }
}

async function run(cmd: string | undefined, args: string[]): Promise<number> {
  const pkg = appId('android')
  switch (cmd) {
    case 'preflight': {
      const { fail, warn, info } = await preflight()
      for (const l of info) console.log(`ok    ${l}`)
      for (const l of warn) console.log(`WARN  ${l}`)
      for (const l of fail) console.log(`FAIL  ${l}`)
      return fail.length ? 1 : 0
    }
    case 'launch':
      launch()
      return 0
    case 'restart':
      adbCli(['shell', 'am', 'force-stop', pkg])
      launch()
      return 0
    case 'clear': {
      if (!args.includes('--yes'))
        usage(
          'clear wipes the app data (signs the user out, resets settings): pass --yes once that is agreed',
        )
      adbCli(['shell', 'pm', 'clear', pkg])
      const metro = config().metro
      if (metro) {
        try {
          adbCli(['reverse', `tcp:${metro.port}`, `tcp:${metro.port}`])
        } catch {
          // no Metro to reach
        }
      }
      launch()
      console.log('app data cleared, app relaunched')
      return 0
    }
    case 'deeplink':
      if (!args[0]) usage('usage: deeplink <url>')
      adbCli([
        'shell',
        `am start -a android.intent.action.VIEW -d '${args[0]}' ${pkg}`,
      ])
      return 0
    case 'jslog': {
      const n = Number(args[0]) || 40
      const re = args[1] ? new RegExp(args[1], 'i') : null
      const lines = adbCli(
        ['logcat', '-d', '-s', 'ReactNativeJS:V'],
        64 * 1024 * 1024,
      )
        .split('\n')
        .filter(l => l.trim() && (!re || re.test(l)))
      console.log(lines.slice(-n).join('\n'))
      return 0
    }
    case 'end':
      if (existsSync(sessionFile())) {
        await new Session(readFileSync(sessionFile(), 'utf8').trim())
          .quit()
          .catch(() => {})
        unlinkSync(sessionFile())
      }
      return 0
    case undefined:
    case 'help':
      console.log(ANDROID_USAGE)
      return cmd ? 0 : 2
  }

  const s = await connect()
  if (cmd !== 'shot') await dismissDevOverlays(s, pkg)
  switch (cmd) {
    case 'ids': {
      const { nodes, visible } = await screen(s)
      const shown = args.includes('--all')
        ? nodes
        : nodes.filter(visible).filter(n => !n.testID.includes(':id/'))
      for (const id of [...new Set(shown.map(n => n.testID))]) console.log(id)
      const redbox = nodes.find(n => n.testID === 'catalyst_redbox_title')
      const root = config().home?.root ?? 'app-root'
      if (redbox)
        console.log(
          `NOTE  RED BOX: ${redbox.text.split('\n')[0]} (jslog for the JS side; restart once fixed)`,
        )
      else if (nodes.some(n => PERMISSION_ALLOW.test(n.testID)))
        console.log(
          'NOTE  an Android permission dialog is showing (allow accepts it)',
        )
      else if (!nodes.some(n => n.testID === root))
        console.log(
          `NOTE  no ${root}: the app is not in front (don't tap or press Back: it lands on the launcher)`,
        )
      return 0
    }
    case 'has':
      return (await screen(s)).nodes.some(matcher(args[0])) ? 0 : 1
    case 'wait':
    case 'gone': {
      const ms = Number(args[1]) || 15000
      const took = await waitUntil(s, args[0], cmd === 'wait', ms)
      console.log(
        took < 0
          ? `timeout after ${ms}ms`
          : `${cmd === 'wait' ? 'present' : 'gone'} after ${took}ms (at ${Date.now()})`,
      )
      return took < 0 ? 1 : 0
    }
    case 'watch':
      await watch(s, Number(args[0]) || 10000, args.slice(1))
      return 0
    case 'tap': {
      const n = await topmost(s, args[0])
      if (!n?.bounds) return usage(`not on screen: ${args[0]}`)
      await s.tap(n.bounds.x + n.bounds.w / 2, n.bounds.y + n.bounds.h / 2)
      // epoch ms, so a later wait reads as "how long after the tap"
      console.log(`tapped at ${Date.now()}`)
      // a separate watch command takes seconds to start: long enough to miss a loader
      const w = args.indexOf('--watch')
      if (w > -1)
        await watch(s, Number(args[w + 1]) || 10000, args.slice(w + 2))
      return 0
    }
    case 'text': {
      const { all } = await screen(s)
      const found = all.find(matcher(args[0]))
      if (!found?.bounds) return usage(`not on screen: ${args[0]}`)
      // the element and every node inside it (React Native puts a label on a child Text)
      const inside = all.filter(n => within(n.bounds, found.bounds!))
      console.log(
        [...new Set(inside.map(n => n.text || n.desc).filter(Boolean))].join(
          ' | ',
        ),
      )
      return 0
    }
    case 'type':
      if (args.length < 2) usage('usage: type <id> <text>')
      await s.type(args[0], args.slice(1).join(' '))
      return 0
    case 'back':
      await s.back()
      return 0
    case 'hide-keyboard':
      await s.hideKeyboard()
      return 0
    case 'allow':
      console.log(
        `accepted ${await acceptPermissionDialogs(s)} permission dialog(s)`,
      )
      return 0
    case 'shot':
      if (!args[0]) usage('usage: shot <file.png>')
      await s.screenshot(args[0])
      console.log(args[0])
      return 0
    default:
      return usage(`unknown command: ${cmd}\n\n${ANDROID_USAGE}`)
  }
}
