// What every page of the dashboard shares: escaping, times, the API, and the
// marks (status pills, result bars, last-runs strips) with what they mean.

export const esc = s =>
  String(s ?? '').replace(
    /[&<>"']/g,
    c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  )

export function duration(seconds) {
  if (seconds == null || isNaN(seconds)) return '–'
  seconds = Math.max(0, Math.round(seconds))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

export const clock = ms =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** the full date and time, for hover texts */
export const exact = ms =>
  new Date(ms).toLocaleString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

/** "3 min ago", "yesterday", "12 Oct" */
export function ago(ms, now = Date.now()) {
  if (!ms) return '–'
  const s = Math.max(0, (now - ms) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  if (s < 2 * 86400) return 'yesterday'
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`
  return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' })
}

/** a relative time with the exact one on hover */
export const when = (ms, now) =>
  ms
    ? `<span class="when" title="${esc(exact(ms))}">${esc(ago(ms, now))}</span>`
    : '<span class="muted" title="not known">–</span>'

/** a run folder's name is its start time, in UTC */
export const stampTime = stamp =>
  Date.parse(stamp.replace(/T(\d\d)-(\d\d)-(\d\d)$/, 'T$1:$2:$3Z'))

export async function api(path, options) {
  const res = await fetch(`/api/${path}`, options)
  if (!res.ok) {
    let message = `${path}: ${res.status}`
    try {
      message = (await res.json()).error ?? message
    } catch {}
    throw Object.assign(new Error(message), { status: res.status })
  }
  return res.json()
}

export const post = (path, body) =>
  api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

/** an endpoint this server doesn't have: started before the page was updated */
export const oldServer = e =>
  e.status === 404
    ? '<p class="muted center">This dashboard server is older than the page: restart it (close its window, then <code>npx e2e-harness dashboard</code>) to see this.</p>'
    : `<p class="muted center">The dashboard server isn't answering (${esc(e.message)}). Start it with <code>npx e2e-harness dashboard</code>.</p>`

// a run is a folder named by its start time; anything else in the address
// (a typo, a `../`) is no run at all
export const RUN = /^\d{4}-\d\d-\d\dT[\d-]+$/

/** a test title without the tags, which show as chips */
export const plain = title =>
  String(title ?? '')
    .replace(/\s*[#@][\w-]+/g, '')
    .trim()

/** the tags in a title, as #-tags (a past run's may be @-tags) */
export const tagsOf = title => [
  ...new Set(
    (String(title ?? '').match(/[#@][\w-]+/g) ?? []).map(tag =>
      tag.replace(/^@/, '#'),
    ),
  ),
]

export function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback
  } catch {
    return fallback
  }
}
export function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}

// --- a test's marks -------------------------------------------------------------

export const ICONS = {
  queued: '·',
  running: '▶',
  retrying: '↻',
  passed: '✓',
  flaky: '✓',
  failed: '✗',
  skipped: '–',
  never: '·',
}

export const ICON_TITLES = {
  queued: 'Queued: not started yet',
  running: 'Running now',
  retrying:
    'Failed once: its retry is running or still to come (every test gets one retry)',
  passed: 'Passed',
  flaky: 'Passed on its retry, after failing the first time',
  failed: 'Failed (its retry failed too, or it got none)',
  skipped:
    'Skipped: the test or its before hook decided it does not apply here (wrong platform, release-only), or the run stopped before it',
  never: 'Never run on this machine',
}

/** `about` says whose result it is, where nothing else on the page does */
export const icon = (status, about = '') =>
  `<span class="icon ${esc(status)}" title="${esc(`${about}${ICON_TITLES[status] ?? status}`)}">${ICONS[status] ?? '·'}</span>`

// --- a run's marks --------------------------------------------------------------

export const RUN_STATUS = {
  running: ['Running', 'The run is going on now'],
  passed: [
    'Passed',
    'Every test that ran passed (some may have needed their retry; skips are fine)',
  ],
  failed: ['Failed', 'At least one test, or a before/after hook, failed'],
  stopped: ['Stopped', 'Stopped from the dashboard before it finished'],
  lost: [
    'Lost',
    'It ended without a summary: its launcher was killed, crashed or the machine slept. Tests it never finished count as failed',
  ],
  preflight: [
    'Preflight failed',
    'No test ran: the preflight found the device, the app, Metro or Appium not ready',
  ],
}

export const pill = (status, text) => {
  const [label, title] = RUN_STATUS[status] ?? [status, status]
  return `<span class="pill ${esc(status)}" title="${esc(title)}">${esc(text ?? label)}</span>`
}

/**
 * A small stacked bar of a run's results, with passed/total beside it.
 * Hover says the counts.
 */
export function resultBar(r, { label = true } = {}) {
  const total = r.total || r.passed + r.failed + r.skipped || 0
  const pct = n => (total ? (n / total) * 100 : 0)
  const title = `${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped${r.open ? `, ${r.open} not run yet` : ''} of ${total} test${total === 1 ? '' : 's'}${r.flaky ? ` (${r.flaky} passed only on retry)` : ''}`
  return `<span class="rbar-wrap" title="${esc(title)}">
    <span class="rbar">
      <i class="p-pass" style="width:${pct(r.passed)}%"></i><i class="p-fail" style="width:${pct(r.failed)}%"></i><i class="p-skip" style="width:${pct(r.skipped)}%"></i>
    </span>
    ${label ? `<span class="rbar-n">${r.passed}/${total}</span>` : ''}
  </span>`
}

/** a test's recent results as squares, oldest left */
export const strip = (recent, duration) =>
  `<span class="strip">${recent
    .map(
      r =>
        `<i class="dot ${esc(r.status)}" title="${esc(`${r.run}: ${STRIP_WORDS[r.status] ?? r.status}${r.seconds != null ? `, ${duration(r.seconds)}` : ''}`)}"></i>`,
    )
    .join('')}</span>`

const STRIP_WORDS = {
  passed: 'passed',
  failed: 'failed',
  flaky: 'passed on retry',
  skipped: 'skipped',
}

/** skips: false where the squares leave out the runs that skipped the test */
export const stripLegend = ({
  skips = true,
} = {}) => `<div class="legend" title="Each square is one run of the test">
  <span class="legend-title">Last runs:</span>
  <span><i class="dot passed"></i>passed</span>
  <span><i class="dot failed"></i>failed</span>
  <span><i class="dot flaky"></i>passed on retry</span>
  ${skips ? '<span><i class="dot skipped"></i>skipped</span>' : '<span class="muted" title="A skip says nothing either way, so it is not counted here">runs that skipped it are left out</span>'}
  <span class="muted">oldest left → newest right</span>
</div>`

// --- devices --------------------------------------------------------------------

/** a device's name: its model when ever seen connected, else its serial */
export function deviceName(id, known = {}, connected = []) {
  if (!id) return 'unknown device'
  const now = connected.find(d => d.id === id)
  const model = now?.model ?? known[id]?.model
  if (id.startsWith('emulator-'))
    return model ? `${model} emulator` : 'Android emulator'
  return model ?? id
}

export const platformName = p =>
  p === 'ios' ? 'iOS' : p === 'android' ? 'Android' : 'platform unknown'

/** the tags' meanings, for their chips */
export const TAGS = {
  // where a test runs: the run and Run tests leave it out by these
  // (plan.ts); E2E_ALL_PLATFORMS=1 keeps every one of them
  '#android':
    'Needs Android (adb, the Android browser or Back): a run on iOS leaves it out by itself (E2E_ALL_PLATFORMS=1 keeps it)',
  '#ios':
    'Needs iOS: a run on Android leaves it out by itself (E2E_ALL_PLATFORMS=1 keeps it)',
  '#on-android-emulator-only':
    'When running on Android, only the run on an emulator runs it: a run on an Android phone leaves it out by itself. Runs on iOS are not affected (E2E_ALL_PLATFORMS=1 keeps it)',
  '#on-android-device-only':
    'When running on Android, only the run on a phone runs it: a run on an Android emulator leaves it out by itself. Runs on iOS are not affected (E2E_ALL_PLATFORMS=1 keeps it)',
  '#on-ios-simulator-only':
    'When running on iOS, only the run on the simulator runs it: a run on an iPhone leaves it out by itself. Runs on Android are not affected (E2E_ALL_PLATFORMS=1 keeps it)',
  '#on-ios-device-only':
    'When running on iOS, only the run on a physical iPhone runs it: a run on a simulator leaves it out by itself. Runs on Android are not affected (E2E_ALL_PLATFORMS=1 keeps it)',
}
/** the app's own tags (the config's dashboard.tags), from the server's status */
const appTags = {}
export function setAppTags(tags) {
  Object.assign(appTags, tags ?? {})
}
export const tagTitle = tag =>
  TAGS[tag] ?? appTags[tag] ?? `A tag in the test titles (${tag})`
export const tagChip = tag =>
  `<span class="tag" title="${esc(tagTitle(tag))}">${esc(tag)}</span>`

/**
 * Run tests' two tabs, shown while a run goes on or runs wait in the queue:
 * the live run (#live) and the set-up of the next run (#launch), which then
 * goes in the queue. `current` is the shell's /api/current.
 */
export function runTabs(active, current) {
  const live = !!current?.live
  const waiting = current?.queued ?? 0
  if (!live && !waiting && active !== 'live') return ''
  const tab = (page, label, title) =>
    `<a href="#${page}" class="${active === page ? 'on' : ''}" ${active === page ? 'aria-current="page"' : ''} title="${esc(title)}">${label}</a>`
  return `<nav class="seg run-tabs" aria-label="Run tests">
    ${tab(
      'live',
      `${live ? '<span class="spinner" aria-hidden="true"></span>' : ''}Live run`,
      live
        ? 'The run going on now: every test as it happens'
        : 'No run is going on now',
    )}
    ${tab(
      'launch',
      `${live ? 'Set up the next run' : 'Set up a run'}${waiting ? ` <span class="count">${waiting} queued</span>` : ''}`,
      live
        ? 'Pick the next run: it waits in the queue and starts when the runs before it have ended'
        : 'Pick a device and the tests, and start a run',
    )}
  </nav>`
}
