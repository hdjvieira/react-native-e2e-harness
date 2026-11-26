import { driver } from '@wdio/globals'
import { appId, config } from './config.js'
import { adb, androidAppInfo, iosAppInfo } from './device.js'
import { measure, record } from './timing.js'
import {
  acceptIosAlert,
  allMatching,
  ANDROID_ALLOW,
  deepLink,
  deviceSerial,
  devLink,
  exists,
  hideKeyboard,
  inFront,
  tap,
  waitFor,
  waitForAny,
  waitGone,
} from './ui.js'

// Back to the app's starting screen (`home` in the config) before a test:
// the one known place every test begins from. The fastest way that works:
// with the app in front and a debug build, a JS reload through the dev link
// (same fresh JS state as a cold start, at a fraction of the time, since the
// native app keeps running); anything else (the app in the background or
// crashed, a release build, no dev link) gets a cold launch. On the way it
// walks through onboarding, closes what lands on top, and answers permission
// prompts. Restarting also rules out the Fast Refresh trap: a debug app that
// was just hot-reloaded can keep stale state that makes a working button do
// nothing.

const app = () => appId(driver.isAndroid ? 'android' : 'ios')
const home = () => {
  const h = config().home
  if (!h) throw new Error('restartApp needs `home` in the e2e config')
  return h
}

/** what every launch sends: LogBox out of the way, plus the app's own switches */
function launchLink() {
  const extra = config().devLink?.launch
  return devLink(['logbox=off', extra].filter(Boolean).join('&'))
}

/** opens the app: through the dev link when there is one (it becomes the launch URL) */
async function open() {
  const link = launchLink()
  if (link) await deepLink(link)
  else await driver.activateApp(app())
}

/** kills the app and opens it again: the slow, always-works way */
async function coldLaunch() {
  await driver.terminateApp(app())
  await open()
}

/** how long a JS reload may take to tear the old screen down */
const RELOAD_GONE_TIMEOUT = 8000

let reloadable: boolean | undefined

/**
 * Whether a reload can work here, asked once per spec file: only a debug
 * build with a dev link has the switch, and a release build would ignore the
 * link and cost the whole RELOAD_GONE_TIMEOUT before every cold start.
 */
function canReload() {
  if (!config().devLink) return false
  reloadable ??= !!(
    driver.isAndroid
      ? androidAppInfo(deviceSerial())
      : iosAppInfo(deviceSerial())
  )?.debuggable
  return reloadable
}

async function launch(cold: boolean) {
  const started = Date.now()
  const root = home().root ?? 'app-root'
  if (!cold && canReload() && (await inFront()) && (await exists(root))) {
    // iOS: a JS reload with a text field focused can crash the app in React
    // Native (the field's blur sent into the torn-down surface). Blur it first
    if (driver.isIOS) await hideKeyboard()
    await deepLink(`${launchLink()}&reload=${started}`)
    // the old screen must be gone before the start screen can count as new
    const reloaded = await waitGone(root, RELOAD_GONE_TIMEOUT).then(
      () => true,
      () => false,
    )
    if (reloaded) return { mode: 'reload', started }
  }
  await coldLaunch()
  return { mode: 'cold', started }
}

async function toHome(cold: boolean) {
  const { mode, started } = await launch(cold)
  const h = home()
  const timeout = h.timeout ?? 150000
  const through = h.through ?? []
  const overlays = h.overlays ?? []
  const steps = through.map(step => (typeof step === 'string' ? step : step.id))
  const deadline = Date.now() + timeout
  let relaunched = false

  while (Date.now() < deadline) {
    // iOS: answering a system alert is only tried when nothing expected shows
    // within a few seconds (looking for one costs seconds when none is up)
    const seen = await waitForAny(
      [...steps, ...overlays, ...ANDROID_ALLOW, h.ready],
      driver.isAndroid ? 60000 : 8000,
    ).catch(async error => {
      if (!driver.isAndroid && (await acceptIosAlert())) return undefined
      // a crashed app (iOS: not in the foreground) is relaunched at once
      const gone = !driver.isAndroid && !(await inFront())
      if (!gone && !driver.isAndroid && Date.now() < deadline - timeout * 0.6) {
        return undefined
      }
      if (relaunched) {
        // a debug build's cold start on a phone takes longer than one wait
        if (!driver.isAndroid && Date.now() < deadline) return undefined
        throw new Error(
          `the app did not reach "${h.ready}" after a restart (${Math.round((Date.now() - started) / 1000)}s, relaunched once${gone ? ', the app had quit' : ''}): ${(error as Error).message}`,
        )
      }
      // once: a start that hung or crashed gets a fresh launch
      relaunched = true
      await coldLaunch()
      return undefined
    })
    if (!seen) continue

    if (seen === h.ready) {
      // something can still land on top of the starting screen
      await driver.pause(1500)
      const late = await waitForAny(
        [...overlays, ...ANDROID_ALLOW, h.ready],
        1000,
      )
      if (late !== h.ready) continue
      // the launch link again, in case a launch ever lost it
      const link = launchLink()
      if (link) {
        await deepLink(link)
        await driver.pause(500)
      }
      record(`restart (${mode})`, Date.now() - started)
      return
    }

    const step = through.find(s => typeof s !== 'string' && s.id === seen)
    try {
      if (step && typeof step !== 'string') await step.tap()
      else await tap(seen)
    } catch (error) {
      // iOS: a system alert that came up after the button was seen hides the
      // app's tree: answer it, go round
      if (driver.isAndroid || !(await acceptIosAlert())) throw error
      continue
    }
    await driver.pause(1500)
  }
  throw new Error(
    `the app did not reach "${h.ready}" in ${Math.round(timeout / 1000)}s (one relaunch included)`,
  )
}

/** the next restart may be skipped: the app was just left fresh on its starting screen */
let fresh = false

/**
 * Tells the next restartApp() the app is already fresh on its starting
 * screen (a sign-in helper that just restarted and checked it), so the next
 * test's restart can be skipped.
 */
export function markFresh() {
  fresh = true
}

/**
 * Brings the app to its starting screen, fresh. `cold`: kill it and start it
 * again even where a JS reload would do, for a test of the start itself.
 */
export async function restartApp({ cold = false } = {}) {
  if (fresh && !cold) {
    fresh = false
    record('restart (skipped: already fresh)', 0)
    return
  }
  fresh = false
  await toHome(cold)
  await home().after?.()
}

/**
 * Android: wipes the app's data and opens it, a new install as far as the
 * app can tell (signed out, settings reset, runtime permissions never
 * asked), then waits for `waitForId` (the first onboarding screen). Never on
 * a developer's own phone without their OK.
 */
export function freshInstall(waitForId: string) {
  return measure('fresh install', async () => {
    if (!driver.isAndroid) throw new Error('freshInstall is Android only')
    await driver.terminateApp(app())
    adb(['shell', 'pm', 'clear', app()], deviceSerial())
    fresh = false
    await open()
    await waitFor(waitForId, 60000)
  })
}

/** for a step in `home.through` that picks something first: tap the first match */
export async function tapFirstMatching(pattern: string) {
  const [first] = await allMatching(pattern)
  if (!first) throw new Error(`nothing matches "${pattern}"`)
  await first.click()
}
