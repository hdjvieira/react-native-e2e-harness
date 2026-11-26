import { $, $$, driver } from '@wdio/globals'
import { appId, config } from './config.js'

// The app's UI by testID, inside a WebdriverIO session, the same on Android
// and iOS. Hard-won rules:
// - a testID is a plain resource-id on Android (no package prefix) and the
//   accessibility id on iOS;
// - an element scrolled out of view is still in the tree, so "exists" is not
//   "visible": tap only what is on screen (scrollTo);
// - never press Back, or tap blindly, while the app isn't in front: the input
//   lands on the launcher;
// - a disabled button swallows a tap and nothing throws: after a tap that
//   should open something, wait for that thing's own testID.

export function byId(testID: string) {
  return driver.isAndroid
    ? `android=new UiSelector().resourceId("${testID}")`
    : `~${testID}`
}

export const el = (testID: string) => $(byId(testID))

export async function waitFor(testID: string, timeout = 10000) {
  await el(testID).waitForExist({
    timeout,
    timeoutMsg: `"${testID}" never appeared (${timeout / 1000}s)`,
  })
  return el(testID)
}

export async function waitGone(testID: string, timeout = 10000) {
  await el(testID).waitForExist({
    timeout,
    reverse: true,
    timeoutMsg: `"${testID}" is still there after ${timeout / 1000}s`,
  })
}

export const exists = (testID: string) => el(testID).isExisting()

/**
 * Waits for the element and taps it. `settle`: wait until it stops moving
 * first, for something still sliding in (iOS drops a tap on a row of an
 * action sheet that is still coming up).
 */
export async function tap(
  testID: string,
  { timeout = 10000, settle = false } = {},
) {
  const target = await waitFor(testID, timeout)
  if (settle) await waitStill(target)
  await target.click()
}

/** waits until the element stops moving: two reads of its place agree */
export async function waitStill(
  target: { getLocation: () => Promise<{ x: number; y: number }> },
  timeout = 3000,
) {
  let last = ''
  await driver
    .waitUntil(
      async () => {
        const { x, y } = await target.getLocation()
        const place = `${x},${y}`
        const still = place === last
        last = place
        return still
      },
      { timeout, interval: 100 },
    )
    // still moving after that: go on, and let the test say what failed
    .catch(() => {})
}

/**
 * Taps `testID` until `opens` appears, up to three times. iOS drops touches
 * while a screen or modal is still animating in, and `hittable` says true
 * throughout, so it can't be waited for. Use it for the first tap on
 * something that has just opened.
 */
export async function tapUntil(testID: string, opens: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    // a tap that took can be slow to show on a busy screen, and what it
    // opened may cover `testID`: with it gone, wait instead of tapping again
    if (attempt > 0 && !(await exists(testID))) {
      await waitFor(opens)
      return
    }
    await tap(testID)
    const opened = await waitFor(opens, 3000).then(
      () => true,
      () => false,
    )
    if (opened) return
  }
  throw new Error(`"${opens}" did not appear after three taps on "${testID}"`)
}

export async function text(testID: string) {
  return (await waitFor(testID)).getText()
}

/**
 * A button's label. Android reports a pressable container's text as empty:
 * what it reads out is its content-desc (React Native builds it from the
 * children); iOS calls the same thing the accessibility label.
 */
export async function label(testID: string) {
  const target = await waitFor(testID)
  return (
    (await target.getAttribute(driver.isAndroid ? 'content-desc' : 'label')) ??
    ''
  )
}

/** the element's box, and whether all of it is inside the window */
export async function onScreen(testID: string) {
  const target = await waitFor(testID, 5000)
  const rect = { ...(await target.getLocation()), ...(await target.getSize()) }
  const { height, width } = await driver.getWindowSize()
  const inside =
    rect.y >= 0 &&
    rect.x >= 0 &&
    rect.y + rect.height <= height &&
    rect.x + rect.width <= width
  return { rect, inside }
}

export async function swipe(fromY: number, toY: number, x?: number) {
  const { width } = await driver.getWindowSize()
  const at = x ?? Math.round(width / 2)
  await driver
    .action('pointer', { parameters: { pointerType: 'touch' } })
    .move({ x: at, y: fromY })
    .down()
    .move({ x: at, y: toY, duration: 400 })
    .up()
    .perform()
  await driver.pause(600)
}

/**
 * Scrolls until the element sits clear of the page's top bar and the bottom
 * edge. `page` is a testID of the page itself, waited for first: a page that
 * hasn't rendered has nothing to scroll to, and swiping blindly overshoots.
 *
 * Android leaves rows far outside the viewport out of the tree, so an element
 * that isn't there yet is looked for further down; once it is there, its box
 * says which way to go. iOS lists a page's rows whether on screen or not, so
 * one missing there fails after a short wait, unless the list is `growing`
 * (it loads more as it scrolls).
 */
export async function scrollTo(
  testID: string,
  page: string,
  { maxSwipes = 8, growing = false } = {},
) {
  await waitFor(page, 15000)
  const { height } = await driver.getWindowSize()
  const top = height * 0.12
  const bottom = height * 0.9
  let lastY: number | undefined
  for (let i = 0; i <= maxSwipes; i++) {
    if (!(await exists(testID))) {
      if (!driver.isAndroid && !growing) {
        if (
          await waitFor(testID, 3000).then(
            () => true,
            () => false,
          )
        )
          continue
        throw new Error(`"${testID}" is not on "${page}"`)
      }
      await swipe(Math.round(height * 0.7), Math.round(height * 0.4))
      continue
    }
    const { inside, rect } = await onScreen(testID)
    if (rect.y >= top && rect.y + rect.height <= bottom) return el(testID)
    // the page's end: it can't scroll any further, and the element is in view
    if (rect.y === lastY && inside) return el(testID)
    lastY = rect.y
    if (rect.y < top) {
      await swipe(Math.round(height * 0.35), Math.round(height * 0.65))
    } else {
      await swipe(Math.round(height * 0.7), Math.round(height * 0.4))
    }
  }
  throw new Error(`"${testID}" is not on screen after ${maxSwipes} swipes`)
}

const escapeRegex = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** a predicate string literal takes backslash escapes of its own */
const predicateLiteral = (text: string) => text.replace(/[\\']/g, '\\$&')

/**
 * Every element whose testID matches the regex (the whole id must match):
 * UiAutomator's resource-id matcher, or an XCUITest predicate (ICU regex).
 */
export function allMatching(pattern: string) {
  return driver.isAndroid
    ? $$(`android=new UiSelector().resourceIdMatches("${pattern}")`)
    : $$(`-ios predicate string:name MATCHES '${predicateLiteral(pattern)}'`)
}

/** an element's testID */
export async function testIdOf(element: {
  getAttribute: (name: string) => Promise<string | null>
}) {
  return (
    (await element.getAttribute(driver.isAndroid ? 'resource-id' : 'name')) ??
    ''
  )
}

/**
 * The first of these testIDs to appear, earlier in the list winning a tie.
 * One lookup per poll for all of them: one lookup per id walks a large,
 * animating tree so often that a late screen can be missed for a minute.
 */
export async function waitForAny(testIDs: string[], timeout = 10000) {
  const pattern = `^(${testIDs.map(escapeRegex).join('|')})$`
  let found: string | undefined
  await driver.waitUntil(
    async () => {
      const ids = new Set<string>()
      for (const match of await allMatching(pattern)) {
        ids.add(await testIdOf(match))
      }
      found = testIDs.find(testID => ids.has(testID))
      return !!found
    },
    { timeout, timeoutMsg: `none of ${testIDs.join(', ')} appeared` },
  )
  return found!
}

/**
 * The element whose testID matches the regex and whose text is exactly
 * `text` (a list row found by what it says), on either platform.
 */
export function matchingWithText(pattern: string, text: string) {
  return driver.isAndroid
    ? $(
        `android=new UiSelector().resourceIdMatches("${pattern}").text("${text}")`,
      )
    : $(
        `-ios predicate string:name MATCHES '${predicateLiteral(pattern)}' AND label == '${predicateLiteral(text)}'`,
      )
}

/**
 * iOS: the element whose testID matches the regex and whose accessibility
 * label contains `text`. A row that is one accessibility element (its label
 * joins its parts) hides those parts from XCUITest, so the row is what can be
 * found by what it says.
 */
export function rowContaining(pattern: string, text: string) {
  return $(
    `-ios predicate string:name MATCHES '${predicateLiteral(pattern)}' AND label CONTAINS '${predicateLiteral(text)}'`,
  )
}

/** the adb serial or iOS UDID of the device this session drives */
export function deviceSerial() {
  const caps = driver.capabilities as Record<string, unknown>
  return String(caps['appium:udid'] ?? caps.udid ?? caps.deviceUDID)
}

/** the app is the one on screen (iOS app state 4: running in the foreground) */
export async function inFront() {
  const id = appId(driver.isAndroid ? 'android' : 'ios')
  return driver.isAndroid
    ? (await driver.getCurrentPackage()) === id
    : (await driver.queryAppState(id)) === 4
}

/** the "allow" buttons of Android's permission prompts */
export const ANDROID_ALLOW = [
  'com.android.permissioncontroller:id/permission_allow_foreground_only_button',
  'com.android.permissioncontroller:id/permission_allow_button',
]

/** system prompts' allow buttons, best first */
const ALLOW_LABELS = [
  'Allow Full Access',
  'Allow While Using App',
  'Allow',
  'OK',
]

/**
 * iOS: a system alert over the app (notifications, tracking, a permission
 * the preflight couldn't grant) takes every tap until answered: accept it
 * with the most permissive answer. The app's own dialogs are views, not
 * alerts, so they are never touched. False when there was none.
 */
export async function acceptIosAlert() {
  let buttons: string[]
  try {
    buttons = await driver.execute('mobile: alert', { action: 'getButtons' })
  } catch {
    return false
  }
  const allow = ALLOW_LABELS.find(label => buttons.includes(label))
  await driver
    .execute('mobile: alert', {
      action: 'accept',
      ...(allow && { buttonLabel: allow }),
    })
    .catch(() => {})
  await driver.pause(500)
  return true
}

/** opens a link in the app, as Android's intent or iOS's openurl */
export function deepLink(url: string) {
  return driver.isAndroid
    ? driver.execute('mobile: deepLink', { url, package: appId('android') })
    : driver.execute('mobile: deepLink', { url, bundleId: appId('ios') })
}

/**
 * Sends a link to the app, as a tap on it elsewhere would: a path on the
 * config's `webBase` (`/products/42`) or a full link.
 */
export async function openLink(link: string) {
  if (!link.startsWith('/')) return deepLink(link)
  const base = config().webBase
  if (!base)
    throw new Error(`openLink("${link}"): set webBase in the e2e config`)
  return deepLink(base.replace(/\/$/, '') + link)
}

/** a switch on the app's dev link (in-app.ts), or undefined without one */
export function devLink(query: string) {
  const link = config().devLink
  if (!link) return undefined
  return `${link.url}?${query}`
}

/**
 * Closes the keyboard if it is up. iOS goes through the app's dev link
 * (`keyboard=dismiss`): WebDriverAgent often finds no key to close it with on
 * an iPhone, and Return adds a line in a multiline field.
 */
export async function hideKeyboard() {
  if (!(await driver.isKeyboardShown())) return
  const link = devLink('keyboard=dismiss')
  if (driver.isAndroid || !link) {
    await driver.hideKeyboard()
    return
  }
  await deepLink(link)
  await driver.waitUntil(async () => !(await driver.isKeyboardShown()), {
    timeout: 5000,
    timeoutMsg: 'the keyboard did not close',
  })
}

const SHARE_SHEET = `-ios predicate string:name == 'ActivityListView'`

/**
 * The system share sheet is up. Android: another app's activity in front of
 * ours. iOS: a view controller inside the app, named "ActivityListView".
 */
export async function shareSheetOpen() {
  return driver.isAndroid ? !(await inFront()) : $(SHARE_SHEET).isExisting()
}

/** waits for the system share sheet, then closes it without sharing */
export async function closeShareSheet() {
  await driver.waitUntil(shareSheetOpen, {
    timeout: 10000,
    timeoutMsg: 'the share sheet never opened',
  })
  if (driver.isAndroid) {
    // another app's chooser: Back closes it and lands back in ours
    await driver.back()
  } else {
    // no Close button to find: flick it down, as a person would. A tap on
    // the dimmed area above can reach the page behind
    const sheet = await $(SHARE_SHEET)
    await driver.execute('mobile: swipe', {
      direction: 'down',
      elementId: sheet.elementId,
      velocity: 2500,
    })
    if (await shareSheetClosed(2000)) return
    // on some phones the swipe does nothing: drag from the sheet's header
    // down past most of its height
    const { x, y } = await sheet.getLocation()
    const { width, height } = await sheet.getSize()
    const from = { x: Math.round(x + width / 2), y: Math.round(y + 50) }
    await driver.performActions([
      {
        type: 'pointer',
        id: 'finger',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, ...from },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 100 },
          {
            type: 'pointerMove',
            duration: 600,
            x: from.x,
            y: from.y + Math.round(height * 0.85),
          },
          { type: 'pause', duration: 300 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ])
    await driver.releaseActions()
  }
  if (!(await shareSheetClosed(10000)))
    throw new Error('the share sheet did not close')
}

const shareSheetClosed = (timeout: number) =>
  driver
    .waitUntil(async () => !(await shareSheetOpen()), { timeout })
    .then(
      () => true,
      () => false,
    )
