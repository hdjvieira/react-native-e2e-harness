import { execFileSync, spawn } from 'node:child_process'
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { cliCommand, E2E_DIR, OUT_DIR, WDIO_CONFIG, wdioBin } from './env.js'
import {
  adb,
  appiumCanReach,
  avdBootable,
  avdOf,
  connectedDevices,
  iphones,
  listAvds,
  simulatorsWithApp,
  startEmulator,
  startSimulator,
} from '../device.js'
import {
  clearCurrentRun,
  type CurrentRun,
  emit,
  readCurrentRun,
} from '../events.js'
import { grepFor, type PlannedTest } from '../plan.js'

// Starting, stopping and cleaning after runs from the dashboard.

export type Device = {
  id: string
  label: string
  platform: 'android' | 'ios'
  /** the phone's own name (ro.product.model, or the iPhone's name) */
  model?: string
  /** how the machine reaches it */
  connection: 'cable' | 'wifi' | 'emulator' | 'simulator'
  /** false: seen, but a run can't use it (`why` says why) */
  usable: boolean
  why?: string
}

/** an emulator or simulator that isn't running, which the page can start */
export type Startable = {
  /** the AVD's name, or the simulator's UDID */
  id: string
  name: string
  platform: 'android' | 'ios'
}

/** a device seen connected once, by serial: runs only record the serial */
export type KnownDevice = {
  model?: string
  platform: 'android' | 'ios'
  emulator?: boolean
  seen: number
}

// devices seen connected, kept so a page can name a phone that is unplugged
// now by its model, not by its serial alone
const KNOWN = join(OUT_DIR, 'devices.json')

export function knownDevices(): Record<string, KnownDevice> {
  try {
    return JSON.parse(readFileSync(KNOWN, 'utf8'))
  } catch {
    return {}
  }
}

function remember(list: Device[]) {
  const known = knownDevices()
  let changed = false
  for (const device of list) {
    const before = known[device.id]
    const model = device.model ?? before?.model
    // written when something new is learnt, or once an hour for `seen`
    if (
      !before ||
      before.model !== model ||
      Date.now() - before.seen > 3_600_000
    ) {
      known[device.id] = {
        model,
        platform: device.platform,
        emulator: device.id.startsWith('emulator-') || undefined,
        seen: Date.now(),
      }
      changed = true
    }
  }
  if (!changed) return
  try {
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(KNOWN, JSON.stringify(known, null, 2))
  } catch {
    // a name is a nicety: the page falls back to the serial
  }
}

/**
 * The devices seen now: adb's (phones on a cable or wireless debugging, and
 * emulators), and on a Mac the iPhones Xcode is connected to and the booted
 * simulators the app is on. An iPhone on Wi-Fi only is listed but not usable:
 * since iOS 17 Appium reaches a phone only on a cable.
 */
export function devices(): Device[] {
  const list: Device[] = []
  try {
    for (const serial of connectedDevices()) {
      let model = ''
      try {
        model = adb([
          '-s',
          serial,
          'shell',
          'getprop',
          'ro.product.model',
        ]).trim()
      } catch {
        // offline or unauthorised: the serial alone
      }
      const emulator = serial.startsWith('emulator-')
      list.push({
        id: serial,
        model: (emulator && avdOf(serial)) || model || undefined,
        label: emulator
          ? `${serial} (emulator)`
          : model
            ? `${model} (${serial})`
            : serial,
        platform: 'android',
        // wireless debugging: ip:port, or the mDNS name adb pair gives
        connection: emulator
          ? 'emulator'
          : /:\d+$|_adb-tls-connect/.test(serial)
            ? 'wifi'
            : 'cable',
        usable: true,
      })
    }
  } catch {
    // no adb on this machine
  }
  if (process.platform === 'darwin') {
    try {
      // paired but out of reach (asleep, away) aren't listed at all
      for (const phone of iphones().filter(p => p.connected)) {
        const usable = appiumCanReach(phone)
        list.push({
          id: phone.udid,
          label: `${phone.name} (iPhone)`,
          platform: 'ios',
          model: phone.name,
          connection: phone.wired ? 'cable' : 'wifi',
          usable,
          why: usable
            ? undefined
            : `Only on Wi-Fi: since iOS 17 Appium reaches a phone only on a cable (iOS ${phone.iosMajor}). Plug it in, then Refresh`,
        })
      }
    } catch {
      // no devicectl
    }
    for (const sim of simulatorsWithApp().filter(s => s.state === 'Booted')) {
      list.push({
        id: sim.udid,
        label: `${sim.name} (simulator)`,
        platform: 'ios',
        model: sim.name,
        connection: 'simulator',
        usable: true,
      })
    }
  }
  remember(list)
  return list
}

/**
 * Something accepts connections on this local port (Appium's 4723, Metro's
 * 8081). Both loopback addresses are tried: Node servers may listen on the
 * IPv6 one only. Opening and closing a socket is all it does.
 */
export async function listening(port: number, ms = 700) {
  const one = (host: string) =>
    new Promise<boolean>(resolve => {
      const socket = connect({ port, host })
      const done = (up: boolean) => {
        socket.destroy()
        resolve(up)
      }
      socket.setTimeout(ms, () => done(false))
      socket.once('connect', () => done(true))
      socket.once('error', () => done(false))
    })
  const [v4, v6] = await Promise.all([one('127.0.0.1'), one('::1')])
  return v4 || v6
}

export const newStamp = () =>
  new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

/**
 * Starts a run of `tests` on `device`, named `stamp` so the dashboard can
 * follow it from its first line. Its output goes to out/<run>/wdio.log.
 */
export function startRun(tests: PlannedTest[], device: Device | undefined) {
  const stamp = newStamp()
  const dir = join(OUT_DIR, stamp)
  mkdirSync(dir, { recursive: true })
  const specs = [...new Set(tests.map(test => test.spec))]
  const args = [
    wdioBin(),
    'run',
    WDIO_CONFIG,
    ...specs.flatMap(spec => ['--spec', spec]),
    '--mochaOpts.grep',
    grepFor(tests),
  ]
  const env: NodeJS.ProcessEnv = { ...process.env }
  // one-off debug switches and the folder of some other run must not carry
  // over from whatever terminal started this server
  for (const key of ['E2E_CHAIN_STOP', 'E2E_FREEZE_MS', 'E2E_RUN_DIR']) {
    delete env[key]
  }
  Object.assign(env, {
    E2E_UI: 'attached',
    E2E_RUN_STAMP: stamp,
    FORCE_COLOR: '0',
  })
  // the device picked, over whatever .env.e2e names (an empty key stays
  // empty: the env file never overrides what is set)
  if (device?.connection === 'simulator') {
    Object.assign(env, {
      E2E_PLATFORM: 'ios',
      E2E_SIMULATOR: device.id,
      E2E_IOS_UDID: '',
    })
  } else if (device?.platform === 'ios') {
    Object.assign(env, { E2E_PLATFORM: 'ios', E2E_IOS_UDID: device.id })
  } else if (device) {
    Object.assign(env, {
      E2E_PLATFORM: 'android',
      E2E_ANDROID_DEVICE: device.id,
    })
  }
  const log = createWriteStream(join(dir, 'wdio.log'))
  const child = spawn(process.execPath, args, {
    cwd: E2E_DIR,
    env,
    // its own process group on macOS, so a stop takes the workers too
    detached: process.platform !== 'win32',
    windowsHide: true,
  })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  return { stamp, child }
}

/**
 * Whether `pid` is still a WDIO launcher. A pid alone can't be trusted: once
 * the launcher is gone the system hands the number to another process, which
 * would then look like a live run, and Stop would kill its tree.
 */
function isLauncher(pid: number): boolean | undefined {
  try {
    const command =
      process.platform === 'win32'
        ? execFileSync(
            'powershell',
            [
              '-NoProfile',
              '-Command',
              `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
            ],
            { encoding: 'utf8', windowsHide: true, timeout: 10000 },
          )
        : execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
            encoding: 'utf8',
          })
    // no command line at all: a process we may not read, so we can't tell
    return command.trim() ? /wdio/i.test(command) : undefined
  } catch {
    // ps found no such pid (exit 1): not a launcher; PowerShell failing to
    // answer says nothing either way
    return process.platform === 'win32' ? undefined : false
  }
}

// the page polls every second and PowerShell takes most of one to start: the
// launcher check is kept a while per run and pid
const LAUNCHER_TTL_MS = 15000
const launcherChecks = new Map<
  string,
  { at: number; launcher: boolean | undefined }
>()

/** the pid is there and, as far as can be told, still the run's launcher */
function launcherState(current: CurrentRun) {
  try {
    process.kill(current.pid, 0)
  } catch (e) {
    // EPERM: it exists, but belongs to someone else
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false
  }
  const key = `${current.run}:${current.pid}`
  const known = launcherChecks.get(key)
  if (known && Date.now() - known.at < LAUNCHER_TTL_MS) return known.launcher
  const launcher = isLauncher(current.pid)
  launcherChecks.set(key, { at: Date.now(), launcher })
  return launcher
}

/**
 * The run named in current.json is going on: its launcher is still there.
 * When the command line can't be read, the pid is trusted, so a live run
 * never shows as lost for it.
 */
export function isLive(current: CurrentRun) {
  return launcherState(current) !== false
}

/** the run going on, if its launcher is still alive */
export function liveRun() {
  const current = readCurrentRun()
  return current && isLive(current) ? current : undefined
}

/**
 * Stops run `run` if it is the one going on, workers included (stopping
 * only the launcher leaves WDIO's workers driving the device), and runs the
 * sweep its skipped clean-ups leave to. A run that has ended already is left
 * as it is: it is not marked stopped, and current.json (which may name a
 * newer run by now) is not touched.
 */
export async function stopRun(
  run: string,
): Promise<{ stopped: false } | { stopped: true; sweep: string }> {
  const current = readCurrentRun()
  if (current?.run !== run) return { stopped: false }
  // checked afresh, not from the cache: this is about to kill a tree. A pid
  // that is someone else's now is never killed; one whose command line
  // can't be read is still the run's as far as anyone knows
  launcherChecks.delete(`${current.run}:${current.pid}`)
  if (launcherState(current) === false) return { stopped: false }
  // said before the kill: a launcher that shuts down in order (macOS) checks
  // for it and writes nothing more, and the page reads it as stopped at once
  emit({ type: 'run-end', stopped: true }, join(OUT_DIR, run))
  clearCurrentRun(run)
  killTree(current.pid)
  return { stopped: true, sweep: await sweep() }
}

/** every process under `root`, from one snapshot of the process table */
function descendants(root: number): number[] {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], {
    encoding: 'utf8',
  })
  const children = new Map<number, number[]>()
  for (const line of out.trim().split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    children.set(ppid, [...(children.get(ppid) ?? []), pid])
  }
  const all: number[] = []
  const walk = (pid: number) =>
    (children.get(pid) ?? []).forEach(child => {
      all.push(child)
      walk(child)
    })
  walk(root)
  return all
}

function killTree(pid: number) {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', `${pid}`, '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch {
      // already gone
    }
    return
  }
  // the launcher's own workers only, listed before anything is signalled:
  // once it dies they are re-parented and the link to it is lost (a pkill
  // by command line took every WDIO worker on the machine)
  let tree: number[] = []
  try {
    tree = descendants(pid)
  } catch {
    // no ps: the process group still takes them, if it was one
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  for (const child of tree) {
    try {
      process.kill(child, 'SIGTERM')
    } catch {
      // ended with the group
    }
  }
}

/** the clean-up sweep on its own (e2e-harness sweep) */
export function sweep(): Promise<string> {
  return new Promise(resolve => {
    const [command, ...args] = cliCommand(['sweep'])
    const child = spawn(command, args, { cwd: E2E_DIR, windowsHide: true })
    let out = ''
    child.stdout.on('data', data => (out += data))
    child.stderr.on('data', data => (out += data))
    child.on('close', code =>
      resolve(code ? `sweep FAILED: ${out.trim()}` : out.trim()),
    )
  })
}

/** a screenshot or a UI tree, in the system's own viewer */
export function openFile(path: string) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '""', path], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [path], {
      detached: true,
      stdio: 'ignore',
    }).unref()
  }
}

/**
 * The emulators and simulators that could be started: AVDs not running
 * whose system image is installed, and
 * (on a Mac) iPhone simulators the app is installed on that aren't booted.
 */
export function startable(running: Device[]): Startable[] {
  const up = new Set(running.map(d => d.model))
  const list: Startable[] = listAvds()
    .filter(avd => !up.has(avd) && avdBootable(avd))
    .map(avd => ({ id: avd, name: avd, platform: 'android' }))
  if (process.platform === 'darwin') {
    for (const sim of simulatorsWithApp()) {
      if (sim.state !== 'Booted')
        list.push({ id: sim.udid, name: sim.name, platform: 'ios' })
    }
  }
  return list
}

/** starts one; it shows up among the devices once booted */
export function startVirtual(item: Startable) {
  if (item.platform === 'ios') startSimulator(item.id)
  else startEmulator(item.id)
}
