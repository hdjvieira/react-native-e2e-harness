import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSource } from './source.js'

// An adb-only stand-in for the Appium session, for when no Appium server
// runs. Slower per call (every source() is a fresh `uiautomator dump`), and
// that dump refuses screens that never go idle, so Appium stays the better
// backend. Never both at once: an Appium session holds the uiautomator
// service, and the dump then fails.

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
const ADB = sdk ? join(sdk, 'platform-tools', 'adb') : 'adb'

/**
 * adb on ANDROID_SERIAL's device (adb reads it itself). Always bounded: a
 * wedged adb server makes every call hang, `adb devices` included.
 */
export function adbCli(args: string[], maxBuffer = 16 * 1024 * 1024) {
  try {
    return execFileSync(ADB, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
      maxBuffer,
    })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new Error(
        `adb ${args[0]} hung for 30s: the adb server is wedged; kill every adb process and run \`adb start-server\``,
      )
    }
    throw e
  }
}

const DUMP = '/sdcard/e2e-harness-ui.xml'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export class AdbSession {
  constructor(private readonly appPackage: string) {}
  async quit() {}
  async source() {
    let last: unknown
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const out = adbCli(['shell', 'uiautomator', 'dump', DUMP])
        if (!/dumped to/i.test(out)) throw new Error(out.trim())
        return adbCli(['exec-out', 'cat', DUMP])
      } catch (e) {
        // "could not get idle state": something is animating; give it a moment
        last = e
        await sleep(700)
      }
    }
    const error = last as { stderr?: string; message?: string }
    throw new Error(
      `uiautomator dump failed: ${String(error?.stderr || error?.message).trim()}`,
    )
  }
  async screenshot(file?: string) {
    const buf = execFileSync(ADB, ['exec-out', 'screencap', '-p'], {
      maxBuffer: 64 * 1024 * 1024,
    })
    if (file) writeFileSync(file, buf)
    return buf
  }
  async tap(x: number, y: number) {
    adbCli([
      'shell',
      'input',
      'tap',
      String(Math.round(x)),
      String(Math.round(y)),
    ])
  }
  async back() {
    adbCli(['shell', 'input', 'keyevent', 'KEYCODE_BACK'])
  }
  async hideKeyboard() {
    if (/mInputShown=true/.test(adbCli(['shell', 'dumpsys', 'input_method'])))
      await this.back()
  }
  async click(testID: string) {
    const n = parseSource(await this.source(), this.appPackage).find(
      n => n.testID === testID && n.bounds,
    )
    if (!n) throw new Error(`no element with testID "${testID}"`)
    await this.tap(n.bounds!.x + n.bounds!.w / 2, n.bounds!.y + n.bounds!.h / 2)
  }
  async type(testID: string, text: string) {
    await this.click(testID)
    await sleep(400)
    // `input text` splits on spaces; %s is its escape for one
    adbCli(['shell', 'input', 'text', text.replace(/ /g, '%s')])
  }
}
