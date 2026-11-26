import { basename } from 'node:path'
import { type AppInfo, config, platform } from './config.js'
import {
  androidAppInfo,
  appiumCanReach,
  ensureAppium,
  ensureMetro,
  grantAndroidPermissions,
  grantIosPermissions,
  iosAppInfo,
  iphones,
  isEmulator,
  resolveAndroidDevice,
  resolveSimulator,
  setStylusHandwritingOff,
  stylusHandwritingOff,
} from './device.js'
import { missingKeys } from './env.js'

// Runs before every run, and on its own (`e2e-harness preflight`). It fixes
// what it can (starts Appium and Metro, boots the emulator) and stops the
// run, with the reason, on what it can't: a run that is going to fail should
// fail in seconds, not twenty minutes in. Bringing the app to a known screen
// happens per spec, inside the session.
//
// The device, from the environment:
//   E2E_PLATFORM          android (default when configured) or ios
//   E2E_ANDROID_DEVICE    adb serial; empty means an emulator
//   E2E_AVD               the AVD to boot when no emulator is running
//   E2E_IOS_UDID          a physical iPhone; empty means one on a cable, if any
//   E2E_SIMULATOR         an iOS simulator's name or UDID

export const deviceSettings = () => ({
  serial: process.env.E2E_ANDROID_DEVICE || undefined,
  avd: process.env.E2E_AVD || undefined,
  iphone: process.env.E2E_IOS_UDID || undefined,
  simulator: process.env.E2E_SIMULATOR || undefined,
})

export type PreflightResult = {
  serial: string
  notes: string[]
  app: AppInfo
  realDevice: boolean
}

export async function preflight(): Promise<PreflightResult> {
  const notes: string[] = []

  const keys = missingKeys()
  if (keys.required.length) {
    const { file, example } = config().env
    throw new Error(
      `missing in ${basename(file)}: ${keys.required.join(', ')} (see ${basename(example)} for what each is and where to get it)`,
    )
  }
  if (keys.optional.length)
    notes.push(`optional keys not set: ${keys.optional.join(', ')}`)

  const result =
    platform() === 'ios'
      ? await preflightIos(notes)
      : await preflightAndroid(notes)

  const extra = await config().hooks?.preflight?.({
    platform: platform(),
    serial: result.serial,
    realDevice: result.realDevice,
    app: result.app,
  })
  if (extra) notes.push(...extra)
  return result
}

async function preflightAndroid(notes: string[]): Promise<PreflightResult> {
  const settings = deviceSettings()
  const { serial, booted } = await resolveAndroidDevice(
    settings.serial,
    settings.avd,
  )
  notes.push(`device ${serial}${booted ? ' (booted it)' : ''}`)

  const app = androidAppInfo(serial)
  if (!app) {
    throw new Error(
      `the app is not installed on ${serial}: build and install it on that device first`,
    )
  }
  notes.push(
    `app ${app.version}, installed ${app.updated}${app.debuggable ? ', debug' : ''}`,
  )

  if (isEmulator(serial)) {
    const granted = grantAndroidPermissions(serial)
    if (granted.length) notes.push(`granted ${granted.join(', ')}`)
  }

  if (!stylusHandwritingOff(serial)) {
    if (isEmulator(serial)) {
      setStylusHandwritingOff(serial)
      notes.push('turned off stylus handwriting (the keyboard would not show)')
    } else {
      notes.push(
        'stylus handwriting is on: keyboard tests will fail (Settings > System > Keyboard > ' +
          'turn off "Use stylus to write in text fields", or adb shell settings put secure ' +
          'stylus_handwriting_enabled 0)',
      )
    }
  }

  if ((await ensureAppium()).started) notes.push('started Appium')
  if (app.debuggable && (await ensureMetro(serial, 'android')).started)
    notes.push('started Metro')

  return { serial, notes, app, realDevice: !isEmulator(serial) }
}

/**
 * The same for iOS. A physical iPhone when one is asked for or on a cable,
 * else the simulator. An iPhone in sight that Appium can't reach stops the
 * run with the reason rather than fall back to a simulator nobody asked for.
 */
async function preflightIos(notes: string[]): Promise<PreflightResult> {
  const target = resolveIosTarget(notes)
  const { serial } = target

  const app = iosAppInfo(serial)
  if (!app) {
    throw new Error(
      `the app is not installed on ${target.name}: build and install it on that ${target.realDevice ? 'phone' : 'simulator'} first`,
    )
  }
  notes.push(
    `app ${app.version} (${app.versionCode})` +
      (app.updated ? `, installed ${app.updated}` : '') +
      (app.debuggable ? ', debug' : ''),
  )
  if (target.realDevice) {
    // nothing grants a permission on a phone from the Mac: answer the system
    // alerts in the app's restart, and a permission denied in Settings stays
    // denied
    notes.push('a physical iPhone: permissions as set on the phone')
  } else {
    const granted = grantIosPermissions(serial)
    if (granted.length) notes.push(`granted ${granted.join(', ')}`)
  }

  if ((await ensureAppium()).started) notes.push('started Appium')
  // a phone's debug build finds Metro on the Mac's network address itself
  if (app.debuggable && (await ensureMetro(serial, 'ios')).started)
    notes.push('started Metro')

  return { serial, notes, app, realDevice: target.realDevice }
}

function resolveIosTarget(notes: string[]) {
  const settings = deviceSettings()
  const phones = iphones()
  if (settings.iphone) {
    const phone = phones.find(
      p => p.udid === settings.iphone || p.identifier === settings.iphone,
    )
    if (!phone) {
      throw new Error(
        `E2E_IOS_UDID ${settings.iphone} is not an iPhone Xcode knows (xcrun devicectl list devices: its Identifier, or the hardware UDID)`,
      )
    }
    if (!appiumCanReach(phone)) {
      throw new Error(
        `${phone.name} is not reachable: ` +
          (phone.connected
            ? `connect it with a cable (iOS ${phone.iosMajor} on Wi-Fi is out of Appium's reach)`
            : 'unlock it, and connect it with a cable'),
      )
    }
    notes.push(`iPhone ${phone.name} ${phone.udid}`)
    return { serial: phone.udid, name: phone.name, realDevice: true }
  }
  if (!settings.simulator) {
    const reachable = phones.filter(appiumCanReach)
    if (reachable.length > 1) {
      throw new Error(
        `${reachable.length} iPhones connected (${reachable.map(p => p.name).join(', ')}): set E2E_IOS_UDID to one`,
      )
    }
    if (reachable.length === 1) {
      const [phone] = reachable
      notes.push(`iPhone ${phone.name} ${phone.udid}`)
      return { serial: phone.udid, name: phone.name, realDevice: true }
    }
    // a phone Xcode sees but Appium can't: say why, and let the developer
    // choose, rather than quietly running on a simulator
    const wireless = phones.filter(p => p.connected)
    if (wireless.length) {
      throw new Error(
        `${wireless.map(p => `${p.name} (iOS ${p.iosMajor})`).join(', ')} only on Wi-Fi: ` +
          'since iOS 17 Appium reaches a phone only on a cable. Plug it in, or set E2E_SIMULATOR ' +
          'to run on a simulator instead',
      )
    }
  }
  const { serial, name, booted } = resolveSimulator(settings.simulator)
  notes.push(`simulator ${name} ${serial}${booted ? ' (booted it)' : ''}`)
  return { serial, name, realDevice: false }
}
