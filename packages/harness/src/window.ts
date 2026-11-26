import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'

// Servers the harness starts (Appium, Metro, the dashboard) keep running
// after the run, for the next one. They open in a terminal window of their
// own, titled, where the developer can see them and close them: a server
// started hidden can hold its port for days with nothing on screen to say
// so. Their output is also teed to a log, for the error messages.
// E2E_WINDOWS=off starts them detached instead (CI, a machine with no GUI).

/** a single-quoted literal for PowerShell or sh */
export const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const appleString = (s: string) =>
  `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/**
 * The environment a long-lived server gets: without the runner's own
 * NODE_OPTIONS (its TypeScript loader, which broke Metro's config loading)
 * and without per-run E2E_ settings, which would otherwise apply to every
 * run the server outlives. `keep` names E2E_ keys it still needs.
 */
export function serverEnv(keep: string[] = []) {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        keep.includes(key) ||
        (!key.startsWith('E2E_') && key !== 'NODE_OPTIONS'),
    ),
  ) as NodeJS.ProcessEnv
}

export type ServerStart = {
  /** the window's title */
  title: string
  /** a shell command line */
  command: string
  cwd: string
  /** appended to, so what the server said survives its window */
  log: string
  env?: NodeJS.ProcessEnv
}

/** starts a long-lived command in a window of its own; returns at once */
export function startInWindow({ title, command, cwd, log, env }: ServerStart) {
  mkdirSync(dirname(log), { recursive: true })
  const environment = env ?? serverEnv()
  if (process.env.E2E_WINDOWS !== 'off') {
    try {
      if (process.platform === 'win32') {
        const inner = `Set-Location ${psQuote(cwd)}; $Host.UI.RawUI.WindowTitle = ${psQuote(title)}; ${command} 2>&1 | Tee-Object -Append -FilePath ${psQuote(log)}`
        // waited for: Start-Process itself returns at once, and a detached,
        // hidden spawn never showed its window
        const result = spawnSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            `Start-Process powershell -ArgumentList '-NoExit','-Command',${psQuote(inner)}`,
          ],
          { stdio: 'ignore', env: environment },
        )
        if (result.status === 0) return
      } else if (process.platform === 'darwin') {
        // a fresh login shell: the runner's environment never reaches it
        const script = `cd ${shQuote(cwd)} && ${command} 2>&1 | tee -a ${shQuote(log)}`
        execFileSync('osascript', [
          '-e',
          `tell application "Terminal" to set custom title of (do script ${appleString(script)}) to ${appleString(title)}`,
        ])
        return
      }
    } catch {
      // no window to open: detached below
    }
  }
  const out = openSync(log, 'a')
  spawn(command, {
    cwd,
    detached: true,
    shell: true,
    env: environment,
    stdio: ['ignore', out, out],
  }).unref()
}

export function openInBrowser(url: string) {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  spawn(command, args as string[], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref()
}
