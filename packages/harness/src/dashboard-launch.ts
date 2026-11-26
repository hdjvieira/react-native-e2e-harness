import { join, resolve } from 'node:path'
import { config } from './config.js'
import { openInBrowser, serverEnv, startInWindow } from './window.js'

// A run shows itself on the dashboard: started in a window of its own if it
// isn't running, then opened on this run in the browser, unless a dashboard
// page is already open (that one follows the new run by itself). E2E_UI=off
// (and CI) leave it all out; `attached` is a run the dashboard started.

// a page polls every second or so: one heard from lately is still open
const PAGE_OPEN_MS = 6000

const port = () =>
  Number(process.env.E2E_DASHBOARD_PORT) || config().dashboard?.port || 4777

type Health = { lastVisit: number; dir?: string }

async function health(): Promise<Health | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port()}/api/health`, {
      signal: AbortSignal.timeout(800),
    })
    return res.ok ? ((await res.json()) as Health) : undefined
  } catch {
    return undefined
  }
}

// two checkouts share the default port: a dashboard started from the other
// one reads the other one's out/ and would never see this run
const sameDir = (a: string, b: string) => {
  const caseless = process.platform === 'win32' || process.platform === 'darwin'
  const norm = (p: string) => (caseless ? resolve(p).toLowerCase() : resolve(p))
  return norm(a) === norm(b)
}

/** the dashboard up, and showing run `stamp` */
export async function showOnDashboard(stamp: string) {
  const mode = process.env.E2E_UI
  if (mode === 'off' || process.env.CI) return
  const base = `http://127.0.0.1:${port()}`
  try {
    let up = await health()
    if (up?.dir && !sameDir(up.dir, config().dir)) {
      console.log(
        `dashboard: port ${port()} is serving another checkout (${up.dir}); close that window or set E2E_DASHBOARD_PORT`,
      )
      return
    }
    if (!up) {
      const log = join(config().outDir, 'dashboard.log')
      startInWindow({
        title: `e2e dashboard :${port()}`,
        command: 'npx e2e-harness dashboard',
        cwd: config().dir,
        log,
        // the server outlives this run: none of its one-off settings
        env: serverEnv(['E2E_DASHBOARD_PORT']),
      })
      console.log(`dashboard log: ${log}`)
      for (let i = 0; i < 25 && !up; i++) {
        await new Promise(r => setTimeout(r, 400))
        up = await health()
      }
      if (!up) {
        console.log('the dashboard did not start: npx e2e-harness dashboard')
        return
      }
    }
    if (mode === 'attached') return
    // the health check is not a visit: lastVisit is the page's own polling
    if (Date.now() - up.lastVisit > PAGE_OPEN_MS) {
      openInBrowser(`${base}/#run=${stamp}`)
    }
    console.log(`dashboard: ${base}/#run=${stamp}`)
  } catch (e) {
    console.log(`the dashboard did not open: ${(e as Error).message}`)
  }
}
