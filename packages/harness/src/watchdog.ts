import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { appId, config } from './config.js'
import { adb, isSimulator, killIphoneApp, simctl } from './device.js'

// A frozen app holds Appium's request open, and the test sits out Mocha's
// timeout, then its retry often does the same: minutes per freeze. So every
// request to the app is timed: one with no answer in `freezeMs` means the app
// froze. The app is then killed from outside (the driver itself is stuck
// behind it), which fails the waiting request at once; the test fails with
// "app froze", and its retry starts it over on a fresh app.
//
// A freeze is never retried away silently: each one is a line in
// freezes.jsonl and its own section of the summary, with the test and the
// step, since a user's app would have frozen the same way.

/**
 * Requests that may rightly take longer: a session (building WebDriverAgent
 * onto a phone takes minutes) and the UI tree, which the failure artifacts
 * give a timeout of their own
 */
const UNWATCHED = new Set(['newSession', 'deleteSession', 'getPageSource'])

export type Freeze = {
  test: string
  /** the request that had no answer, e.g. elementClick */
  command: string
  /** the selector last looked up before it, which names the step */
  after?: string
  seconds: number
  /** how the app was killed, or why it couldn't be */
  killed: string
}

let currentTest = ''
let freeze: Freeze | undefined

/** the test now running, for the freeze record */
export function watching(test: string) {
  currentTest = test
  freeze = undefined
}

/** the freeze in the test that just ended, if there was one */
export const frozeInTest = () => freeze

/** starts timing the session's requests */
export function watchApp(
  driver: WebdriverIO.Browser,
  udid: string,
  runDir: string,
) {
  const freezeMs = config().freezeMs
  const pending: { command: string; timer: NodeJS.Timeout }[] = []
  let lastLookup: string | undefined
  // one freeze is one kill: the requests still waiting on the dead app, and
  // those sent before the test gives up, time out too. Quiet until the app
  // is opened again
  let killed = false

  driver.on('command', ({ command, body }) => {
    const { script, value } = (body ?? {}) as {
      script?: string
      value?: string
    }
    if (command === 'findElement' || command === 'findElements') {
      if (typeof value === 'string') lastLookup = value
    }
    if (
      command === 'activateApp' ||
      command === 'launchApp' ||
      script === 'mobile: deepLink' ||
      script === 'mobile: activateApp' ||
      script === 'mobile: launchApp'
    ) {
      killed = false
    }
    if (UNWATCHED.has(command)) return
    const after = lastLookup
    const timer = setTimeout(() => {
      if (killed) return
      killed = true
      freeze = {
        test: currentTest,
        command,
        after,
        seconds: freezeMs / 1000,
        killed: killApp(driver, udid),
      }
      appendFileSync(
        join(runDir, 'freezes.jsonl'),
        JSON.stringify(freeze) + '\n',
      )
      console.log(describeFreeze(freeze))
    }, freezeMs)
    pending.push({ command, timer })
  })

  // requests answer in order, but a tree read the artifacts gave up on can
  // still be out: a result settles the oldest request of its kind
  driver.on('result', ({ command }) => {
    const index = pending.findIndex(p => p.command === command)
    if (index < 0) return
    clearTimeout(pending[index].timer)
    pending.splice(index, 1)
  })
}

/** what a freeze reads as, as a test's error */
export function describeFreeze({ command, after, seconds, killed }: Freeze) {
  return `app froze: no answer to ${command}${after ? ` after "${short(after)}"` : ''} in ${seconds}s (${killed})`
}

/** a testID as it is; a long selector cut short */
const short = (selector: string) =>
  selector.length > 60 ? `${selector.slice(0, 57)}...` : selector

/** kills the app without the driver, which is waiting on it */
function killApp(driver: WebdriverIO.Browser, udid: string) {
  try {
    if (driver.isAndroid) {
      adb(['shell', 'am', 'force-stop', appId('android')], udid)
      return 'killed with adb'
    }
    if (isSimulator(udid)) {
      simctl(['terminate', udid, appId('ios')])
      return 'killed with simctl'
    }
    return killIphoneApp(udid)
  } catch (e) {
    return `could not be killed: ${(e as Error).message.split('\n')[0]}`
  }
}
