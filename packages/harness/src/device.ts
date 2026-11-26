import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type AppInfo, appId, config } from './config.js'
import { startInWindow } from './window.js'

// Host-side device plumbing: adb and the emulator, simctl and the iOS
// simulator, devicectl and a physical iPhone, Appium and Metro. Nothing here
// talks to the app's UI; that happens inside a WebdriverIO session.

const sdk = () =>
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Android', 'sdk')
    : process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk')
      : join(homedir(), 'Android', 'Sdk'))
const emulatorBin = () => join(sdk(), 'emulator', 'emulator')

export const sleep = (ms: number) =>
  new Promise(resolve => setTimeout(resolve, ms))

// ---- Android ----------------------------------------------------------------

export function adb(args: string[], serial?: string) {
  return execFileSync('adb', serial ? ['-s', serial, ...args] : args, {
    encoding: 'utf8',
    timeout: 60000,
    // a phone's logcat dump runs to several MB: past the 1 MB default,
    // execFileSync throws
    maxBuffer: 64 * 1024 * 1024,
  }).trim()
}

export const isEmulator = (serial: string) => serial.startsWith('emulator-')

export function connectedDevices() {
  return adb(['devices'])
    .split(/\r?\n/)
    .slice(1)
    .map(line => line.split(/\s+/))
    .filter(([, state]) => state === 'device')
    .map(([serial]) => serial)
}

/** the device to run on: the one asked for, else a running emulator, else one booted here */
export async function resolveAndroidDevice(wanted?: string, avd?: string) {
  const devices = connectedDevices()
  if (wanted) {
    if (!devices.includes(wanted)) {
      throw new Error(
        `E2E_ANDROID_DEVICE ${wanted} is not connected (adb devices: ${devices.join(', ') || 'none'})`,
      )
    }
    return { serial: wanted, booted: false }
  }
  const running = devices.find(isEmulator)
  if (running) return { serial: running, booted: false }
  return { serial: await bootEmulator(avd), booted: true }
}

/** the AVDs on this machine; none without the SDK */
export function listAvds() {
  try {
    return execFileSync(emulatorBin(), ['-list-avds'], {
      encoding: 'utf8',
      timeout: 15000,
    })
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('INFO'))
  } catch {
    return []
  }
}

/**
 * Whether the AVD's system image is installed: an AVD outlives the image it
 * was made with and then can't boot. Unknown counts as bootable.
 */
export function avdBootable(name: string) {
  try {
    const ini = readFileSync(
      join(homedir(), '.android', 'avd', `${name}.avd`, 'config.ini'),
      'utf8',
    )
    const sysdir = /^image\.sysdir\.1\s*=\s*(.+)$/m.exec(ini)?.[1].trim()
    return !sysdir || existsSync(join(sdk(), sysdir))
  } catch {
    return true
  }
}

/** the AVD a running emulator was started from */
export function avdOf(serial: string) {
  try {
    return adb(['emu', 'avd', 'name'], serial).split(/\r?\n/)[0].trim()
  } catch {
    return undefined
  }
}

/** starts the AVD and returns at once; the emulator draws its own window */
export function startEmulator(name: string) {
  spawn(emulatorBin(), ['-avd', name, '-no-boot-anim', '-no-audio'], {
    detached: true,
    stdio: 'ignore',
  }).unref()
}

async function bootEmulator(avd?: string) {
  const avds = listAvds()
  const name = avd ?? avds.find(avdBootable)
  if (!name || !avds.includes(name)) {
    throw new Error(
      `no AVD "${avd ?? ''}" to boot (emulator -list-avds: ${avds.join(', ') || 'none'})`,
    )
  }
  startEmulator(name)
  for (let i = 0; i < 90; i++) {
    await sleep(2000)
    const serial = connectedDevices().find(isEmulator)
    if (!serial) continue
    try {
      if (adb(['shell', 'getprop', 'sys.boot_completed'], serial) === '1')
        return serial
    } catch {
      // still coming up
    }
  }
  throw new Error(`emulator ${name} did not boot in 3 minutes`)
}

/** the installed app, or undefined */
export function androidAppInfo(serial: string): AppInfo | undefined {
  const pkg = appId('android')
  const dump = adb(['shell', 'dumpsys', 'package', pkg], serial)
  if (!dump.includes(`Package [${pkg}]`)) return undefined
  return {
    version: /versionName=(\S+)/.exec(dump)?.[1],
    versionCode: /versionCode=(\d+)/.exec(dump)?.[1],
    updated: /lastUpdateTime=(.+)/.exec(dump)?.[1]?.trim(),
    debuggable: /pkgFlags=\[[^\]]*DEBUGGABLE/.test(dump),
  }
}

/**
 * Emulators only: grants what the app would otherwise ask for in a system
 * prompt mid-test (`android.permissions` in the config). A permission that
 * isn't a runtime one on this API level is skipped.
 */
export function grantAndroidPermissions(serial: string) {
  const granted: string[] = []
  for (const permission of config().android?.permissions ?? []) {
    try {
      adb(['shell', 'pm', 'grant', appId('android'), permission], serial)
      granted.push(permission)
    } catch {
      // not a runtime permission on this API level
    }
  }
  return granted
}

// Android 14+ "Use stylus to write in text fields" (unset means on): Gboard
// takes Appium's injected taps for a stylus and shows its handwriting toolbar
// instead of the keyboard
export const stylusHandwritingOff = (serial: string) =>
  adb(
    ['shell', 'settings', 'get', 'secure', 'stylus_handwriting_enabled'],
    serial,
  ) === '0'

export function setStylusHandwritingOff(serial: string) {
  adb(
    ['shell', 'settings', 'put', 'secure', 'stylus_handwriting_enabled', '0'],
    serial,
  )
}

/**
 * The package that opens an ordinary https link nobody claims, or undefined
 * when there is no default and Android would show a chooser.
 */
export function defaultBrowser(serial: string) {
  const out = adb(
    [
      'shell',
      'cmd',
      'package',
      'resolve-activity',
      '--brief',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      'https://example.com',
    ],
    serial,
  )
  const pkg = (out.split(/\r?\n/).pop() ?? '').split('/')[0]
  return pkg && pkg !== 'android' && !pkg.includes('resolver') ? pkg : undefined
}

/**
 * Wi-Fi and mobile data on or off. Emulators only, never a developer's own
 * phone. A spec that turns it off turns it back on in an afterEach.
 */
export function setNetwork(serial: string, on: boolean) {
  if (!isEmulator(serial)) {
    throw new Error(
      `refusing to toggle the network on ${serial}: emulators only`,
    )
  }
  const state = on ? 'enable' : 'disable'
  adb(['shell', 'svc', 'wifi', state], serial)
  adb(['shell', 'svc', 'data', state], serial)
}

// ---- iOS simulator (macOS) --------------------------------------------------

export function simctl(args: string[]) {
  return execFileSync('xcrun', ['simctl', ...args], {
    encoding: 'utf8',
    timeout: 180000,
  }).trim()
}

type Simulator = { udid: string; name: string; state: string }

function simulators(): Simulator[] {
  try {
    const { devices } = JSON.parse(
      simctl(['list', 'devices', 'available', '--json']),
    ) as { devices: Record<string, Simulator[]> }
    return Object.values(devices).flat()
  } catch {
    return []
  }
}

/**
 * The iPhone simulators the app is installed on, booted or not. Read from
 * the simulator's own folders: simctl answers about installed apps only on
 * a booted one.
 */
export function simulatorsWithApp(): Simulator[] {
  const bundleId = appId('ios')
  const installedOn = (udid: string) => {
    const apps = join(
      homedir(),
      'Library/Developer/CoreSimulator/Devices',
      udid,
      'data/Containers/Bundle/Application',
    )
    try {
      return readdirSync(apps).some(dir => {
        try {
          return readFileSync(
            join(
              apps,
              dir,
              '.com.apple.mobile_container_manager.metadata.plist',
            ),
          ).includes(bundleId)
        } catch {
          return false
        }
      })
    } catch {
      return false
    }
  }
  return simulators().filter(
    d => d.name.startsWith('iPhone') && installedOn(d.udid),
  )
}

/** boots the simulator and brings the Simulator app up on it */
export function startSimulator(udid: string) {
  try {
    simctl(['boot', udid])
  } catch {
    // booted already
  }
  execFileSync('open', [
    '-a',
    'Simulator',
    '--args',
    '-CurrentDeviceUDID',
    udid,
  ])
}

/**
 * The simulator to run on: the one asked for (name or UDID), else an iPhone
 * with the app installed (a booted one first), else a booted iPhone, else the
 * first available, booted here. Several can be booted at once, so being
 * booted isn't enough.
 */
export function resolveSimulator(wanted?: string) {
  const bundleId = appId('ios')
  const all = simulators()
  const iPhones = all.filter(d => d.name.startsWith('iPhone'))
  const hasApp = (d: Simulator) => {
    try {
      simctl(['get_app_container', d.udid, bundleId])
      return true
    } catch {
      return false
    }
  }
  const booted = iPhones.filter(d => d.state === 'Booted')
  const simulator = wanted
    ? all.find(d => d.udid === wanted || d.name === wanted)
    : (booted.find(hasApp) ?? iPhones.find(hasApp) ?? booted[0] ?? iPhones[0])
  if (!simulator) {
    throw new Error(
      `no simulator ${wanted ?? 'iPhone'} (xcrun simctl list devices available)`,
    )
  }
  const bootedHere = simulator.state !== 'Booted'
  if (bootedHere) {
    simctl(['boot', simulator.udid])
    simctl(['bootstatus', simulator.udid])
  }
  return { serial: simulator.udid, name: simulator.name, booted: bootedHere }
}

/**
 * The installed app, or undefined: on a simulator from its bundle, on a
 * physical iPhone from devicectl. A simulator's debug build has no bundled
 * JS (main.jsbundle): it loads it from Metro. On a phone the bundle can't be
 * listed, so an app a developer built and installed counts as a debug build;
 * a TestFlight or App Store install doesn't.
 */
export function iosAppInfo(udid: string): AppInfo | undefined {
  if (!isSimulator(udid)) return iphoneAppInfo(udid)
  let path: string
  try {
    path = simctl(['get_app_container', udid, appId('ios')])
  } catch {
    return undefined
  }
  const plist = (key: string) => {
    try {
      return execFileSync(
        'plutil',
        ['-extract', key, 'raw', join(path, 'Info.plist')],
        { encoding: 'utf8' },
      ).trim()
    } catch {
      return undefined
    }
  }
  return {
    version: plist('CFBundleShortVersionString'),
    versionCode: plist('CFBundleVersion'),
    updated: statSync(path).mtime.toISOString(),
    debuggable: !existsSync(join(path, 'main.jsbundle')),
  }
}

const simulatorUdids = new Map<string, boolean>()

/** a simulator's UDID, as opposed to a physical iPhone's */
export function isSimulator(udid: string) {
  if (!simulatorUdids.has(udid)) {
    let found = false
    try {
      found = simctl(['list', 'devices', '--json']).includes(`"${udid}"`)
    } catch {
      // no simctl: not a Mac with Xcode, so not a simulator either
    }
    simulatorUdids.set(udid, found)
  }
  return simulatorUdids.get(udid)!
}

/**
 * Grants what the app would otherwise ask for in a system alert
 * (`ios.permissions` in the config, simctl privacy services such as
 * `location-always`). Notifications can't be granted this way.
 */
export function grantIosPermissions(udid: string) {
  const services = config().ios?.permissions ?? []
  for (const service of services) {
    simctl(['privacy', udid, 'grant', service, appId('ios')])
  }
  return services
}

// ---- physical iPhone (macOS) ------------------------------------------------

export function devicectl(args: string[]) {
  return execFileSync('xcrun', ['devicectl', ...args], {
    encoding: 'utf8',
    timeout: 60000,
  })
}

export type Iphone = {
  udid: string
  /** devicectl's own id (CoreDevice), which E2E_IOS_UDID also takes */
  identifier: string
  name: string
  /** on a cable: the only way Appium reaches an iPhone on iOS 17 or later */
  wired: boolean
  /** paired and reachable right now (devicectl's tunnel is up) */
  connected: boolean
  iosMajor: number
}

/** the iPhones Xcode knows, connected or not */
export function iphones(): Iphone[] {
  type Listed = {
    identifier?: string
    hardwareProperties: { udid?: string; deviceType?: string }
    deviceProperties: { name?: string; osVersionNumber?: string }
    connectionProperties: { transportType?: string; tunnelState?: string }
  }
  let listed: Listed[]
  try {
    listed = JSON.parse(
      devicectl(['list', 'devices', '--quiet', '--json-output', '-']),
    ).result.devices
  } catch {
    return []
  }
  return listed
    .filter(d => d.hardwareProperties.deviceType === 'iPhone')
    .map(d => ({
      udid: d.hardwareProperties.udid ?? '',
      identifier: d.identifier ?? '',
      name: d.deviceProperties.name ?? 'iPhone',
      wired: d.connectionProperties.transportType === 'wired',
      connected: d.connectionProperties.tunnelState === 'connected',
      iosMajor: Number(d.deviceProperties.osVersionNumber?.split('.')[0] ?? 0),
    }))
    .filter(d => d.udid)
}

/**
 * Whether Appium can open a session on it. Since iOS 17 a phone on Wi-Fi only
 * talks to Xcode's own tunnel, which Appium's device lookup doesn't see, so
 * it needs the cable; an older iOS on the network is still reachable.
 */
export const appiumCanReach = (phone: Iphone) =>
  phone.connected && (phone.wired || phone.iosMajor < 17)

function iphoneAppInfo(udid: string): AppInfo | undefined {
  type App = {
    bundleVersion?: string
    version?: string
    builtByDeveloper?: boolean
  }
  let apps: App[]
  try {
    apps = JSON.parse(
      devicectl([
        'device',
        'info',
        'apps',
        '--device',
        udid,
        '--bundle-id',
        appId('ios'),
        '--quiet',
        '--json-output',
        '-',
      ]),
    ).result.apps
  } catch {
    return undefined
  }
  const app = apps[0]
  if (!app) return undefined
  return {
    version: app.version,
    versionCode: app.bundleVersion,
    debuggable: !!app.builtByDeveloper,
  }
}

/**
 * What a session on a physical iPhone needs on top of the simulator's: the
 * WebDriverAgent Appium builds onto the phone is signed with the app's team
 * (`ios.teamId`, or E2E_IOS_TEAM), under a bundle id of its own. The first
 * session builds it (about a minute); later ones reuse it.
 */
export function iphoneCapabilities() {
  const team = process.env.E2E_IOS_TEAM || config().ios?.teamId
  if (!team) {
    throw new Error(
      'a physical iPhone needs a team to sign WebDriverAgent: set ios.teamId in the e2e config or E2E_IOS_TEAM',
    )
  }
  return {
    'appium:xcodeOrgId': team,
    'appium:xcodeSigningId': 'Apple Development',
    'appium:updatedWDABundleId': `${appId('ios')}.wdarunner`,
    'appium:allowProvisioningDeviceRegistration': true,
  }
}

/** kills the app on a phone (the watchdog, when the driver itself is stuck) */
export function killIphoneApp(udid: string) {
  const executable = config().ios?.executable
  if (!executable)
    return 'could not be killed: set ios.executable in the e2e config'
  type Listed = { executable?: string; processIdentifier?: number }
  const processes: Listed[] = JSON.parse(
    devicectl([
      'device',
      'info',
      'processes',
      '--device',
      udid,
      '--quiet',
      '--json-output',
      '-',
    ]),
  ).result.runningProcesses
  const app = processes.find(p => p.executable?.includes(`/${executable}.app/`))
  if (!app?.processIdentifier) return 'not running any more'
  devicectl([
    'device',
    'process',
    'terminate',
    '--device',
    udid,
    '--pid',
    String(app.processIdentifier),
    '--kill',
    '--quiet',
  ])
  return 'killed with devicectl'
}

// ---- Appium and Metro -------------------------------------------------------

async function answers(url: string) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    return res.ok ? await res.text() : undefined
  } catch {
    return undefined
  }
}

const logFile = (name: string) => join(config().outDir, `${name}.log`)

/** Appium on its port, started (and left running for the next run) if it doesn't answer */
export async function ensureAppium() {
  const { port } = config().appium
  const url = `http://127.0.0.1:${port}/status`
  if (await answers(url)) return { started: false }
  // warn, not the default debug: a long suite's debug log runs to hundreds of MB
  startInWindow({
    title: `e2e: Appium ${port}`,
    command: `appium --port ${port} --log-level warn`,
    cwd: config().appDir,
    log: logFile('appium'),
  })
  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    if (await answers(url)) return { started: true }
  }
  throw new Error(`Appium did not start on ${port}: see ${logFile('appium')}`)
}

/**
 * Metro for a debug build, started (and left running) if it isn't up, and
 * reachable from the device. A release build carries its own bundle.
 */
export async function ensureMetro(serial: string, on: 'android' | 'ios') {
  const metro = config().metro
  if (!metro) return { started: false }
  const { started } = await ensureMetroUp()
  // the iOS simulator shares the host's localhost
  if (on === 'android')
    adb(['reverse', `tcp:${metro.port}`, `tcp:${metro.port}`], serial)
  return { started }
}

/** Metro up and serving this app, started if it isn't: no device involved */
export async function ensureMetroUp() {
  const metro = config().metro
  if (!metro) return { started: false }
  const url = `http://localhost:${metro.port}/status`
  // a Metro already up may be another checkout's: the run would test that
  // checkout's code while every check passed. An owner that can't be read is
  // let through rather than blocking the run
  const running = !!(await answers(url))?.includes('running')
  const owner = running ? metroOwner(metro.port) : ''
  if (owner && !servesThisApp(owner)) {
    throw new Error(
      `Metro on ${metro.port} is NOT serving this app (${config().appDir}): ${owner}. Stop it, or run from that checkout`,
    )
  }
  if (running) return { started: false }
  startInWindow({
    title: `e2e: Metro ${metro.port}`,
    command: metro.start,
    cwd: config().appDir,
    log: logFile('metro'),
  })
  for (let i = 0; i < 60 && !(await answers(url)); i++) await sleep(1000)
  if (!(await answers(url))) {
    throw new Error(`Metro did not start: see ${logFile('metro')}`)
  }
  return { started: true }
}

/** the command line (and cwd, off Windows) of whatever listens on the port, or '' */
export function metroOwner(port: number) {
  try {
    if (process.platform === 'win32') {
      const ps =
        `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
        'if ($c) { (Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)").CommandLine }'
      return execFileSync('powershell', ['-NoProfile', '-Command', ps], {
        encoding: 'utf8',
      }).trim()
    }
    const pid = execFileSync(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')[0]
    if (!pid) return ''
    const command = execFileSync('ps', ['-o', 'command=', '-p', pid], {
      encoding: 'utf8',
    }).trim()
    const cwd = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
    })
      .split('\n')
      .find(l => l.startsWith('n'))
      ?.slice(1)
    return `${command} (cwd ${cwd})`
  } catch {
    return ''
  }
}

/**
 * Whether a Metro owner (metroOwner()) is this app's checkout. A sibling
 * checkout's path can start with this one's (`app` vs `app-alt`), so compare
 * with a trailing separator.
 */
export function servesThisApp(owner: string, appDir = config().appDir) {
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  const dir = norm(appDir).replace(/\/$/, '')
  return norm(owner).includes(`${dir}/`) || norm(owner).endsWith(`(cwd ${dir})`)
}
