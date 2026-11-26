import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appId } from '../config.js'
import { iphoneCapabilities } from '../device.js'
import { newSession, Session } from './wd.js'

// The app on a connected iPhone, one command at a time, through Appium's
// XCUITest driver: the iOS counterpart of the Android device commands.
export const IOS_USAGE = `e2e-harness ios-device <command>
  start                 new session (the first builds WebDriverAgent on the phone, ~1 min)
  activate              bring the app to the front
  link <url>            open a URL in the app (no "Open in...?" prompt)
  has <id..>            whether each testID is in the tree
  wait <id> [ms]        until present (default 10000), with how long it took
  tap <id>              tap the element
  tap-at <x> <y>        tap a point, in points (a 2x screenshot's pixels / 2)
  text <id> [n]         its label, n times a second apart (a live readout)
  rect <id>             its frame in points: x y width height
  double-tap [x y]      double tap the screen centre (or x, y): a map zooms in
  two-finger-tap [x y]  two-finger tap: a map zooms out
  drag <dx> <dy> [x y]  drag from the centre (or x, y) by that many points
  shot <file.png>       screenshot: a last resort, expensive to read
  end                   close the session

The phone: E2E_IOS_UDID, else the only one connected. E2E_IOS_NEW_WDA=1
reinstalls WebDriverAgent (needed after the phone stopped automation).`

const sessionFile = () => join(tmpdir(), 'e2e-harness-ios-session.txt')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function session() {
  if (!existsSync(sessionFile()))
    throw new Error('no session: e2e-harness ios-device start')
  return new Session(readFileSync(sessionFile(), 'utf8').trim())
}

function udid() {
  if (process.env.E2E_IOS_UDID) return process.env.E2E_IOS_UDID
  // connected physical devices only: `xctrace` lists them as
  // "<name> (<iOS>) (<udid>)" under "== Devices ==", above the offline ones
  const out = execFileSync('xcrun', ['xctrace', 'list', 'devices'], {
    encoding: 'utf8',
  })
  const physical = out.split(/== (Devices Offline|Simulators) ==/)[0]
  const found = [
    ...physical.matchAll(/\(\d+(?:\.\d+)*\) \(([0-9A-F-]{20,})\)/g),
  ].map(m => m[1])
  if (found.length !== 1) {
    throw new Error(
      `${found.length} physical devices connected: set E2E_IOS_UDID (xcrun xctrace list devices)`,
    )
  }
  return found[0]
}

async function point(s: Session, args: string[]) {
  if (args.length >= 2) return { x: Number(args[0]), y: Number(args[1]) }
  const { width, height } = await s.windowRect()
  return { x: Math.round(width / 2), y: Math.round(height / 2) }
}

/** runs one command; returns the exit code */
export async function iosCommand(cmd: string | undefined, args: string[]) {
  const started = Date.now()
  const bundleId = appId('ios')
  switch (cmd) {
    case 'start': {
      const id = await newSession({
        platformName: 'iOS',
        'appium:automationName': 'XCUITest',
        'appium:udid': udid(),
        'appium:bundleId': bundleId,
        // attach to the app as it is: never reinstall, reset or relaunch it
        'appium:noReset': true,
        'appium:autoLaunch': false,
        'appium:newCommandTimeout': 1800,
        'appium:wdaLaunchTimeout': 600000,
        'appium:wdaConnectionTimeout': 600000,
        'appium:waitForIdleTimeout': 0,
        ...iphoneCapabilities(),
        ...(process.env.E2E_IOS_NEW_WDA && { 'appium:useNewWDA': true }),
      })
      writeFileSync(sessionFile(), id)
      console.log('session', id)
      break
    }
    case 'activate':
      await session().execute('mobile: activateApp', [{ bundleId }])
      break
    case 'link':
      await session().execute('mobile: deepLink', [{ url: args[0], bundleId }])
      break
    case 'has':
      for (const id of args)
        console.log(id, (await session().findAll(id, true)).length > 0)
      break
    case 'wait': {
      const ms = Number(args[1] ?? 10000)
      const s = session()
      for (;;) {
        if ((await s.findAll(args[0], true)).length) {
          console.log(`${args[0]} after ${Date.now() - started} ms`)
          break
        }
        if (Date.now() - started > ms)
          throw new Error(`timeout waiting for ${args[0]}`)
        await sleep(250)
      }
      break
    }
    case 'tap':
      await session().click(args[0], true)
      break
    case 'tap-at':
      await session().tap(Number(args[0]), Number(args[1]))
      break
    case 'text': {
      const s = session()
      for (let i = 0; i < Number(args[1] ?? 1); i++) {
        if (i) await sleep(1000)
        console.log(await s.text(args[0], true))
      }
      break
    }
    case 'rect': {
      const r = await session().rect(args[0], true)
      console.log(r.x, r.y, r.width, r.height)
      break
    }
    case 'double-tap':
    case 'two-finger-tap': {
      const s = session()
      const { x, y } = await point(s, args)
      await (cmd === 'double-tap' ? s.doubleTap(x, y) : s.twoFingerTap(x, y))
      break
    }
    case 'drag': {
      const s = session()
      const { x, y } = await point(s, args.slice(2))
      await s.drag(x, y, x + Number(args[0]), y + Number(args[1]))
      break
    }
    case 'shot':
      await session().screenshot(args[0])
      break
    case 'end':
      if (existsSync(sessionFile())) {
        await session()
          .quit()
          .catch(() => {})
        unlinkSync(sessionFile())
      }
      break
    default:
      console.log(IOS_USAGE)
      return cmd ? 2 : 0
  }
  console.log(`(${Date.now() - started} ms)`)
  return 0
}
