// One run's page: each planned test as it happens. #live is the run going on
// (under Run tests, with the tab to set up the next run), #run=<stamp> a past
// one (under Run history). Drawn again only when something other than the clocks
// changed, so open details, the scroll and loaded screenshots stay put.

import { pickedDevice } from './launch.js'
import {
  api,
  clock,
  deviceName,
  duration,
  esc,
  exact,
  icon,
  pill,
  plain,
  post,
  runTabs,
  tagChip,
} from './util.js'

const state = {
  run: undefined, // the run on screen
  live: false, // on #live: the run going on, or the last one that was
  liveRun: undefined, // the last run #live saw going on
  data: undefined, // its last payload
  shownKey: undefined, // what the page shows was drawn from (see keyOf)
  open: new Set(), // test keys whose details are open
  current: undefined, // the test running or being prepared now
  autoOpened: new Set(), // opened because they ran: closed again when passed
  scrollTo: undefined, // a test to bring on screen at the next drawing
  screens: new Map(), // artifacts -> on-screen ids (undefined: being read, null: failed)
  reviewed: undefined,
  ctx: undefined,
}

// --- shared with the Overview and the shell -----------------------------------

/** the run's status: a class for the pill and its words */
export function runStatus(d) {
  if (d.running) return ['running', 'Running']
  if (d.ended?.stopped) return ['stopped', 'Stopped']
  if (d.ended?.error) return ['preflight', 'Preflight failed']
  if (d.lost) return ['lost', 'Ended without a summary']
  if (!d.ended) return ['running', 'Starting']
  // an after hook's failure ends no test, but the run did not go clean
  const failed =
    d.tests.some(t => t.state?.status === 'failed') || d.hookFailures?.length
  return failed ? ['failed', 'Finished with failures'] : ['passed', 'Passed']
}

export function counts(d) {
  const c = { passed: 0, failed: 0, skipped: 0, running: 0, queued: 0 }
  for (const t of d.tests) {
    const s = t.state?.status ?? 'queued'
    if (s === 'retrying') c.running++
    else c[s] = (c[s] ?? 0) + 1
  }
  return c
}

/** the run's time so far: to its end, or to its last sign of life if lost */
export const elapsedOf = d =>
  ((d.ended?.at ?? d.lostAt ?? d.now) - (d.started ?? d.now)) / 1000

export const etaValue = d =>
  d.eta ? `~${duration(d.eta.remaining)}` : d.running ? '…' : 'done'
export const etaSub = d =>
  d.eta
    ? `around ${clock(d.eta.finishAt)}`
    : d.ended
      ? `at ${clock(d.ended.at)}`
      : '&nbsp;'

const STAGES = [
  {
    stage: 'preflight',
    label: 'Preflight',
    title:
      'Checks the device, the installed app, Metro, Appium and the .env.e2e keys before anything runs',
  },
  {
    stage: 'sweep (start)',
    label: 'Sweep',
    title:
      "Clean-up sweep: the app's sweep hook removes what earlier runs left on a backend, before the tests",
  },
  { stage: 'tests', label: 'Tests', title: "The specs' tests, one at a time" },
  {
    stage: 'sweep (end)',
    label: 'Sweep',
    title: 'Clean-up sweep: removes anything the tests left on a backend',
  },
  {
    stage: 'summary',
    label: 'Summary',
    title:
      'Writes summary.md (results, retries, clean-ups, timing) and run.json',
  },
]

/** the run's stages as chips: done ✓, current (spinner), to do */
export function pipeline(d) {
  // runs from before events.jsonl say nothing about their stages
  if (!d.stage && !d.running && !d.ended?.summary) return ''
  const at = d.ended?.summary
    ? STAGES.length
    : Math.max(
        0,
        STAGES.findIndex(s => s.stage === d.stage),
      )
  const halted = !d.running && !d.ended?.summary
  return `<ol class="pipeline" aria-label="Stages of the run">${STAGES.map(
    (s, i) => {
      const status =
        i < at
          ? 'done'
          : i === at
            ? halted
              ? d.ended?.error
                ? 'failed'
                : 'halted'
              : 'current'
            : 'todo'
      const mark =
        status === 'done'
          ? '✓'
          : status === 'current'
            ? '<i class="spinner"></i>'
            : status === 'failed'
              ? '✗'
              : status === 'halted'
                ? '■'
                : ''
      const words = {
        done: 'done',
        current: 'going on now',
        todo: 'still to come',
        failed: 'failed here',
        halted: 'the run ended here (stopped or lost)',
      }[status]
      return `<li class="stage ${status}" title="${esc(`${s.label}: ${s.title}. ${words[0].toUpperCase()}${words.slice(1)}.`)}"><span class="stage-mark">${mark}</span>${esc(s.label)}</li>`
    },
  ).join('<li class="stage-sep" aria-hidden="true">→</li>')}</ol>`
}

/**
 * The run's progress bar, on the clock: from its start to its end, or to now
 * plus the ETA. Each test attempt in its outcome's colour, and what goes on
 * between them (start-up, setups, each test's beforeEach/afterEach, the end
 * sweep) in its own colour, since that takes time too. Runs from before the
 * time bar (no attempts) get the old bar, by counts.
 */
export function progress(d, c = counts(d)) {
  if (d.started && d.attempts) return timeBar(d, c)
  const total = d.tests.length || 1
  return `<div class="progress" title="${esc(`${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped, ${c.running} running, ${c.queued} queued, of ${d.tests.length}`)}">
    <span class="p-pass" style="width:${(c.passed / total) * 100}%"></span>
    <span class="p-fail" style="width:${(c.failed / total) * 100}%"></span>
    <span class="p-skip" style="width:${(c.skipped / total) * 100}%"></span>
    <span class="p-run" style="width:${(c.running / total) * 100}%"></span>
  </div>`
}

const STATUS_WORDS = {
  passed: 'passed',
  failed: 'failed',
  skipped: 'skipped',
  running: 'running',
  retrying: 'failed, retried',
}

function timeBar(d, c) {
  const start = d.started
  const end = d.ended?.at ?? d.lostAt ?? d.now
  const left = d.running && d.eta ? d.eta.remaining * 1000 : 0
  const total = Math.max(1, end - start + left)
  const byKey = new Map(d.tests.map(t => [t.key, t]))
  const parts = []
  let between = 0
  const part = (cls, from, to, tip) => {
    if (to <= from) return
    if (cls.startsWith('p-step')) between += to - from
    parts.push(
      `<span class="${cls}" style="width:${((to - from) / total) * 100}%" data-tip="${esc(`${tip} · ${duration((to - from) / 1000)}`)}"></span>`,
    )
  }
  const live = d.running ? ' live' : ''
  let at = start
  d.attempts.forEach((a, i) => {
    const from = Math.max(a.start, at)
    part(
      'p-step',
      at,
      from,
      i === 0
        ? 'Start-up: preflight, sweep, the session and the first setup'
        : 'Between tests: afterEach, the next beforeEach (an app restart), setups',
    )
    const next = d.attempts[i + 1]
    const to = Math.min(end, a.end ?? next?.start ?? end)
    const t = byKey.get(a.key)
    const status = t?.state?.status
    const again = d.attempts.slice(i + 1).some(b => b.key === a.key)
    const cls =
      a.end === undefined && !next && d.running
        ? 'p-run'
        : again
          ? 'p-retry'
          : status === 'passed'
            ? 'p-pass'
            : status === 'failed'
              ? 'p-fail'
              : status === 'skipped'
                ? 'p-skip'
                : 'p-run'
    const words =
      cls === 'p-run'
        ? 'running now'
        : again
          ? 'failed, retried'
          : (STATUS_WORDS[status] ?? status ?? 'ended')
    part(cls, from, to, `${plain(t?.title ?? a.key)}: ${words}`)
    at = Math.max(at, to)
  })
  part(
    `p-step${live}`,
    at,
    end,
    d.running
      ? d.attempts.length
        ? 'Now: cleaning up after a test, or preparing the next one'
        : 'Now: start-up (preflight, sweep, the session, the setup)'
      : 'End: the last afterEach, the sweep and the summary',
  )
  const spent = (end - start) / 1000
  const title = `${duration(spent)} so far${left ? `, ~${duration(left / 1000)} to go` : ''}. Of it, ${duration(between / 1000)} went to start-up, setups, preparing and cleaning up between tests. Green passed, red failed, amber a failed attempt that was retried, blue running, grey-blue the time between tests. (${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped, ${c.queued} queued, of ${d.tests.length})`
  return `<div class="progress timeline" id="run-progress" data-tip="${esc(title)}">${parts.join('')}</div>`
}

/** what the run ran against, from its run.json */
function infoLine(d) {
  const i = d.info ?? {}
  const g = i.git ?? {}
  const app = i.app
  const parts = []
  if (i.release)
    parts.push(
      `<span title="The release this code belongs to: a version means the commit shipped in it; '>x (unreleased)' means not in master yet">Release <b>${esc(i.release)}</b></span>`,
    )
  if (g.branch || g.commit)
    parts.push(
      `<span title="${esc(`The git branch and commit the run's code came from${g.approximate ? ' (approximate: HEAD at the run start, written after the fact)' : ''}`)}"><code>${esc(g.branch ?? '?')} @ ${esc(g.commit ?? '?')}</code>${g.dirty ? ' <span class="tag warn" title="The checkout had uncommitted changes: a debug build runs whatever Metro serves">uncommitted changes</span>' : ''}</span>`,
    )
  if (app)
    parts.push(
      `<span title="The app installed on the device: version (build number), and whether it was a debug build">app ${esc(app.version ?? '?')}${app.versionCode ? ` (${esc(app.versionCode)})` : ''}${app.debuggable ? ', debug' : ''}</span>`,
    )
  if (i.platform)
    parts.push(
      `<span title="The platform the run drove">${esc(i.platform)}</span>`,
    )
  if (d.device)
    parts.push(
      `<span title="${esc(`The device it ran on (serial ${d.device})`)}">on <b>${esc(d.model ?? deviceName(d.device))}</b> <code class="muted">${esc(d.device)}</code></span>`,
    )
  return parts.length
    ? `<div class="info-line">${parts.join('<span class="sep">·</span>')}</div>`
    : ''
}

/** a clock that ticks in place (see tick): how long since `since`, of ~`est` */
const ticking = (since, est, sep, suffix = '') =>
  `<span class="time" data-since="${since}" data-est="${est}" data-sep="${esc(sep)}" data-suffix="${esc(suffix)}" title="Time so far, of its usual time (~: the median of its past runs)">${duration((state.data.now - since) / 1000)}${esc(sep)}~${duration(est)}${esc(suffix)}</span>`

/**
 * What a drawing of the page depends on, less what moves every second (the
 * clocks and the ETA, which tick() writes in place): the page is drawn again
 * only when this changes.
 */
const keyOf = d =>
  JSON.stringify({ ...d, now: 0, eta: !!d.eta, reviewed: state.reviewed })

// --- the page ---------------------------------------------------------------------

export function show(ctx, route) {
  state.ctx = ctx
  state.live = !!route.live
  if (route.live) {
    // the run going on; with none, the one this page last showed live
    const current = ctx.shell.current
    route = { ...route, run: current?.live ? current.run : state.liveRun }
  }
  if (route.run !== state.run) {
    // another run on screen: nothing of the one before carries over
    state.run = route.run
    state.data = undefined
    state.open.clear()
    state.autoOpened.clear()
    state.current = undefined
  }
  state.shownKey = undefined
  if (state.data?.run === state.run) render()
  else ctx.main.innerHTML = '<p class="muted center">Loading the run…</p>'
}

// #live: a run started or ended, or the queue changed (the tabs count it)
export const onLive = ctx => {
  state.shownKey = undefined
  ctx.refreshSoon()
}

export async function refresh(ctx, still) {
  if (!state.reviewed) {
    state.reviewed = await api('reviewed').catch(() => ({}))
  }
  if (state.live) {
    const current = await api('current').catch(() => ctx.shell.current)
    if (!still()) return 0
    if (current?.live && current.run !== state.run) {
      // a new run went live (the queue's next one): show it from the start
      state.run = current.run
      state.data = undefined
      state.open.clear()
      state.autoOpened.clear()
      state.current = undefined
      state.shownKey = undefined
    }
    if (current?.live) state.liveRun = current.run
    if (!state.run) {
      ctx.main.innerHTML = noLiveRun(current)
      return 3000
    }
  }
  try {
    const d = await api(`runs/${state.run}`)
    if (!still() || d.run !== state.run) return 0
    // a failed test opens by itself once, so its reason is on screen
    for (const t of d.tests) {
      const before =
        state.data?.run === d.run && state.data.tests.find(x => x.key === t.key)
      if (
        t.state?.status === 'failed' &&
        before &&
        before.state?.status !== 'failed'
      ) {
        state.open.add(t.key)
      }
    }
    follow(d)
    state.data = d
    // drawn again only when something other than the clocks changed, and
    // not under the dev's hand: open details, scroll and screenshots stay
    if (keyOf(d) !== state.shownKey && !ctx.busy()) render()
    else tick(d)
    return d.running || (!d.ended && !d.lost) ? 1000 : 5000
  } catch (e) {
    if (!still()) return 0
    state.shownKey = undefined
    ctx.main.innerHTML =
      e.status === 404
        ? `<p class="muted center">There is no run ${esc(state.run)} in out/ (pruned, or a wrong address). <a href="#history">Run history</a></p>`
        : `<p class="muted center">The dashboard server isn't answering (${esc(e.message)}). Start it with <code>npx e2e-harness dashboard</code>.</p>`
    return e.status === 404 ? 30000 : 3000
  }
}

/** the test running now, else the one its beforeEach prepares */
function currentKey(d) {
  if (!d.running) return undefined
  const running = d.tests.find(
    t =>
      t.state?.status === 'running' ||
      (t.state?.status === 'retrying' && t.state.rerun),
  )
  if (running) return running.key
  if (d.prep?.kind !== 'next') return undefined
  return d.tests.find(
    t =>
      t.describe === d.prep.describe &&
      (t.state?.status ?? 'queued') === 'queued',
  )?.key
}

/**
 * The test going on is open, and brought on screen when it starts; it closes
 * again when it is done, unless it failed (its reason stays on screen).
 */
function follow(d) {
  const key = currentKey(d)
  if (key === state.current) return
  const before = state.current
  if (before && state.autoOpened.has(before)) {
    const status = d.tests.find(t => t.key === before)?.state?.status
    if (status !== 'failed' && status !== 'retrying') state.open.delete(before)
    state.autoOpened.delete(before)
  }
  if (key && !state.open.has(key)) {
    state.open.add(key)
    state.autoOpened.add(key)
  }
  state.current = key
  if (key) state.scrollTo = key
  // the open details changed: draw again
  state.shownKey = undefined
}

/** brings a test's row on screen, below the run's card (sticky on top) */
function scrollToTest(key) {
  const row = [...state.ctx.main.querySelectorAll('.test-row')].find(
    r => r.dataset.key === key,
  )
  if (!row) return
  const card = state.ctx.main.querySelector('.run-card')
  const topbar = document.querySelector('.topbar')?.offsetHeight ?? 0
  const sticky =
    card && getComputedStyle(card).position === 'sticky' ? card.offsetHeight : 0
  const box = row.closest('.test').getBoundingClientRect()
  const above = topbar + sticky + 16
  // already in full view: leave the page where it is
  if (box.top >= above && box.bottom <= innerHeight - 16) return
  scrollTo({ top: scrollY + box.top - above, behavior: 'smooth' })
}

function render() {
  const d = state.data
  const main = state.ctx?.main
  // a screen read can finish after the page moved on
  const here = state.live
    ? location.hash === '#live'
    : location.hash.includes(d?.run)
  if (!d || !main || d.run !== state.run || !here) return
  state.shownKey = keyOf(d)
  const [statusClass, statusText] = runStatus(d)
  const c = counts(d)
  const running =
    d.tests.find(t => t.state?.status === 'running') ??
    d.tests.find(t => t.state?.status === 'retrying')
  const flaky = d.tests.filter(t => t.state?.flaky).length

  const now = running
    ? `${icon(running.state.status)}<span class="what">${esc(plain(running.title))}</span>
       <span class="muted">${esc(plain(running.describe))}</span>
       ${ticking(running.state.since, running.estimate, ' of ', running.state.status === 'retrying' ? ' · retry' : '')}`
    : d.step
      ? `<span class="icon running" title="What the run is doing between tests">⚙</span><span class="what">${esc(plain(d.step))}</span>`
      : d.running && d.stage
        ? `<span class="icon running" title="The stage the run is in">⚙</span><span class="what">${esc(d.stage)}</span>`
        : ''

  const groups = []
  for (const t of d.tests) {
    let g = groups.find(g => g.describe === t.describe)
    if (!g) groups.push((g = { describe: t.describe, spec: t.spec, tests: [] }))
    g.tests.push(t)
  }

  const failedCleanups = d.cleanups.failed
  const hookFailures = d.hookFailures ?? []
  // a loaded screenshot is kept as it is, not loaded again on every drawing
  const shots = new Map(
    [...main.querySelectorAll('img[data-shot]')].map(img => [
      img.getAttribute('src'),
      img,
    ]),
  )
  const scroll = scrollY
  const ended = state.live && !d.running && (d.ended || d.lost)
  const waiting = state.ctx.shell.current?.queued ?? 0
  main.innerHTML = `
    ${state.live ? `<div class="page-head"><h1>Run tests</h1>${runTabs('live', state.ctx.shell.current)}</div>` : ''}
    ${ended ? `<div class="banner ended">This run has ended: it is in <a href="#run=${esc(d.run)}">Run history</a> now.${waiting ? ` The next run in the queue starts in a moment, and shows here.` : ' <a href="#launch">Set up a run</a>'}</div>` : ''}
    <section class="card run-card">
      <div class="run-head">
        <h1 title="${esc(d.started ? `Started ${exact(d.started)}` : 'The run folder in out/')}">Run ${esc(d.run)}</h1>
        ${pill(statusClass, statusText)}
        <div class="run-actions">
          ${d.running ? '<button class="danger" id="stop" title="Kills this run\'s launcher and its workers, then runs the clean-up sweep">Stop run</button>' : ''}
          ${!d.running && c.failed ? `<button class="primary" id="rerun" title="A new run of just the tests that failed here, on the device last picked on Run tests (else this run's)">Rerun the ${c.failed} failed</button>` : ''}
          ${!d.running && d.tests.length ? `<button id="rerun-all" title="A new run of ${d.tests.length === 1 ? 'this test' : `all ${d.tests.length} tests of this run`}, passed or not, on the device last picked on Run tests (else this run's)">${d.tests.length === 1 ? 'Run this test again' : `Rerun all ${d.tests.length}`}</button>` : ''}
          ${d.summary || d.ended?.summary ? `<a class="button" href="/files/${esc(d.run)}/summary.md" target="_blank" title="The run's own report: results, retries, clean-ups and where the time went">Summary</a>` : ''}
        </div>
      </div>
      ${infoLine(d)}
      ${pipeline(d)}
      ${d.ended?.error ? `<div class="error">${esc(d.ended.error)}</div>` : ''}
      ${progress(d, c)}
      <div class="stats">
        <div class="stat" title="Tests that have ended, of all the run plans to run"><div class="label">Tests</div><div class="value">${c.passed + c.failed + c.skipped}/${d.tests.length}</div><div class="sub">${c.queued} to go</div></div>
        <div class="stat" title="Passed, counting those that needed their retry"><div class="label">Passed</div><div class="value" style="color:var(--pass)">${c.passed}</div><div class="sub">${flaky ? `${flaky} on retry` : '&nbsp;'}</div></div>
        <div class="stat" title="Failed after their retry (or cut off by a stop, a lost run or a failed hook)"><div class="label">Failed</div><div class="value" style="color:var(--fail)">${c.failed}</div><div class="sub">${c.skipped ? `${c.skipped} skipped` : '&nbsp;'}</div></div>
        <div class="stat" title="Since the run started, to its end (or its last sign of life)"><div class="label">Elapsed</div><div class="value" id="elapsed">${duration(elapsedOf(d))}</div><div class="sub">since ${d.started ? clock(d.started) : '–'}</div></div>
        <div class="stat" title="Time left: each remaining test's usual time plus setups and the end sweep, scaled by how this run is going against past ones"><div class="label">ETA</div><div class="value" id="eta">${etaValue(d)}</div><div class="sub" id="eta-sub">${etaSub(d)}</div></div>
      </div>
      ${now ? `<div class="now">${now}</div>` : ''}
    </section>

    ${failedCleanups.length ? `<div class="banner fail" title="Something a test wrote on a backend could not be removed: remove it by hand">Clean-up FAILED: ${failedCleanups.map(esc).join(' · ')}</div>` : ''}
    ${hookFailures.length ? `<div class="banner fail" title="A before/after hook failed: it ends no test of its own, but the run is not clean">Hook failed: ${hookFailures.map(hookFailure(d.run)).join(' · ')}</div>` : ''}
    ${d.freezes.length ? `<div class="banner fail" title="The app stopped answering for a while: the watchdog killed it">The app froze ${d.freezes.length} time${d.freezes.length > 1 ? 's' : ''}: possibly an app bug (see below)</div>` : ''}
    ${d.extra.length ? `<div class="banner fail" title="The run's grep picked tests its plan didn't list">Ran but not in the plan: ${d.extra.map(esc).join(' · ')}</div>` : ''}

    <section class="card">
      <div class="legend" title="What the marks in front of each test mean">
        <span>${icon('passed')} passed</span><span><span class="tag flaky">passed on retry</span></span><span>${icon('failed')} failed</span><span>${icon('retrying')} retrying</span><span>${icon('running')} running</span><span>${icon('queued')} queued</span><span>${icon('skipped')} skipped</span><span><span class="tag warn">needs a person first</span></span>
        <span class="muted">· time: taken, or ~usual · click a test for its details</span>
        <span class="muted" title="The bar at the top runs on the clock: each test in its colour, and in dim blue the time around them (start-up, setups, each test's beforeEach and afterEach, the end sweep)"><i class="sw p-step"></i> top bar: start-up, preparing, cleaning up</span>
      </div>
      ${groups.map(renderGroup).join('') || '<p class="muted">No tests planned yet.</p>'}
    </section>

    <section class="side">
      <div class="card">
        <h2 title="What the tests and the sweeps removed from a backend after writing it">Clean-up</h2>
        ${
          d.cleanups.done.length || failedCleanups.length
            ? `<ul>${failedCleanups.map(f => `<li class="failed">FAILED ${esc(f)}</li>`).join('')}${d.cleanups.done.map(f => `<li>${esc(f)}</li>`).join('')}</ul>`
            : '<p class="muted">Nothing to clean up yet.</p>'
        }
      </div>
      <div class="card">
        <h2 title="Times the app stopped answering Appium and the watchdog killed it">App freezes</h2>
        ${
          d.freezes.length
            ? `<ul>${d.freezes.map(f => `<li><b>${esc(plain(f.test))}</b>: no answer to <code>${esc(f.command)}</code>${f.after ? ` after <code>${esc(f.after)}</code>` : ''} for ${esc(f.seconds)}s</li>`).join('')}</ul>`
            : '<p class="muted">None.</p>'
        }
      </div>
    </section>`

  for (const img of main.querySelectorAll('img[data-shot]')) {
    const kept = shots.get(img.getAttribute('src'))
    if (kept) img.replaceWith(kept)
  }
  if (scrollY !== scroll) scrollTo(0, scroll)

  document.getElementById('stop')?.addEventListener('click', stopRun)
  document.getElementById('rerun')?.addEventListener('click', rerunFailed)
  document
    .getElementById('rerun-all')
    ?.addEventListener('click', event => rerun(event.currentTarget))
  for (const button of main.querySelectorAll('[data-rerun]')) {
    button.addEventListener('click', event => {
      event.stopPropagation()
      rerun(button, [button.dataset.rerun])
    })
  }
  for (const row of main.querySelectorAll('.test-row')) {
    row.addEventListener('click', () => toggle(row.dataset.key))
  }
  for (const button of main.querySelectorAll('[data-review]')) {
    button.addEventListener('click', event => {
      event.stopPropagation()
      review(button.dataset.review)
    })
  }
  if (state.scrollTo) {
    scrollToTest(state.scrollTo)
    state.scrollTo = undefined
  }
  stickyCard()
  document.title = `${statusClass === 'running' ? '▶' : statusClass === 'passed' ? '✓' : '✗'} ${c.passed + c.failed + c.skipped}/${d.tests.length} · ${document.documentElement.dataset.title} e2e`
}

/** the moving parts only, written in place: the page is otherwise as drawn */
function tick(d) {
  const set = (id, html) => {
    const el = document.getElementById(id)
    if (el && el.innerHTML !== html) el.innerHTML = html
  }
  set('elapsed', duration(elapsedOf(d)))
  set('eta', etaValue(d))
  set('eta-sub', etaSub(d))
  for (const el of state.ctx.main.querySelectorAll('[data-elapsed]')) {
    el.textContent = duration((d.now - Number(el.dataset.elapsed)) / 1000)
  }
  for (const el of state.ctx.main.querySelectorAll('.time[data-since]')) {
    const { since, est, sep, suffix } = el.dataset
    el.textContent = `${duration((d.now - Number(since)) / 1000)}${sep}~${duration(Number(est))}${suffix}`
  }
  for (const el of state.ctx.main.querySelectorAll('.mini[data-since]')) {
    const [width, over] = miniFill(d, el.dataset.since, el.dataset.est)
    el.firstElementChild.style.width = `${width}%`
    el.classList.toggle('over', over)
  }
  // the time bar moves on with the clock; not while the mouse is on it
  const bar = document.getElementById('run-progress')
  if (bar && !bar.matches(':hover')) bar.outerHTML = progress(d)
}

/** a running test's share of its usual time; past it, full and marked */
function miniFill(d, since, est) {
  const share = (d.now - Number(since)) / 1000 / Math.max(1, Number(est))
  return [Math.min(100, share * 100), share > 1]
}

/**
 * The run's card stays on top as the page scrolls (CSS sticky); marked when
 * stuck, to draw it tighter. One listener for the page's life.
 */
let stickyBound = false
function stickyCard() {
  const mark = () => {
    const card = state.ctx?.main.querySelector('.run-card')
    if (!card) return
    const topbar = document.querySelector('.topbar')?.offsetHeight ?? 0
    card.classList.toggle(
      'stuck',
      scrollY > 0 && card.getBoundingClientRect().top <= topbar + 1,
    )
  }
  if (!stickyBound) {
    stickyBound = true
    addEventListener('scroll', mark, { passive: true })
  }
  mark()
}

// the setup going on, marked where it happens: a group's before hook on its
// heading, a beforeEach on the test it prepares (the group's next queued one)
let preparing
function renderGroup(g) {
  const d = state.data
  const prep = d.running && d.prep?.describe === g.describe ? d.prep : undefined
  preparing =
    prep?.kind === 'next'
      ? g.tests.find(t => (t.state?.status ?? 'queued') === 'queued')?.key
      : undefined
  const since =
    prep &&
    `<span class="time" data-elapsed="${prep.since}">${duration((d.now - prep.since) / 1000)}</span>`
  return `<div class="group">
    <h3>${esc(plain(g.describe))} <span class="mono muted" title="The spec file">${esc(g.spec)}</span>${
      prep?.kind === 'setup'
        ? ` <span class="prep" title="The group's before hook is running: what all its tests need first (signing in, setting data up...). How long it has taken so far.">⚙ setting up · ${since}</span>`
        : ''
    }</h3>
    ${g.tests.map(renderTest).join('')}
  </div>`
}

function renderTest(t) {
  const s = t.state ?? { status: 'queued' }
  const d = state.data
  const open = state.open.has(t.key)
  const prepping = t.key === preparing
  const time = prepping
    ? `<span class="time prep" title="Its beforeEach is running: the app restarts and opens the screen this test starts from. How long it has taken so far."><span data-elapsed="${d.prep.since}">${duration((d.now - d.prep.since) / 1000)}</span> preparing</span>`
    : s.status === 'running' || s.status === 'retrying'
      ? ticking(s.since, t.estimate, ' / ')
      : 'seconds' in s
        ? `<span class="time" title="How long it took">${duration(s.seconds)}</span>`
        : `<span class="time est" title="Its usual time (~: the median of its past runs, not measured in this run)">~${duration(t.estimate)}</span>`
  const reviewed = state.reviewed?.[t.key] === d.run
  const going = s.status === 'running' || (s.status === 'retrying' && s.rerun)
  const [fill, over] = going ? miniFill(d, s.since, t.estimate) : [0, false]
  const mini = prepping
    ? '<span class="mini prep" title="Being prepared: its beforeEach is running"><i></i></span>'
    : going
      ? `<span class="mini run${over ? ' over' : ''}" data-since="${s.since}" data-est="${t.estimate}" title="Time so far, of its usual time (past the end: slower than usual)"><i style="width:${fill}%"></i></span>`
      : 'seconds' in s
        ? `<span class="mini ${esc(s.flaky ? 'flaky' : s.status)}" title="Ended: ${esc(s.flaky ? 'passed on retry' : s.status)}"><i style="width:100%"></i></span>`
        : '<span class="mini" title="Not run yet"><i></i></span>'
  return `<div class="test ${esc(s.status)} ${prepping ? 'preparing' : ''} ${open ? 'open' : ''}">
    <div class="test-row" data-key="${esc(t.key)}" title="Click for the details">
      ${prepping ? '<span class="icon running" title="Being prepared: its beforeEach is running">⚙</span>' : icon(s.flaky ? 'flaky' : s.status)}
      <span>${esc(plain(t.title))}${s.flaky ? '<span class="tag flaky" title="It failed once and passed on its retry: flaky">passed on retry</span>' : ''}${s.needsPerson ? `<span class="tag warn" title="${esc(`Neither passed nor failed: ${s.needsPerson}, then run it again`)}">needs a person first</span>` : ''}${reviewed ? '<span class="tag" title="Someone looked at this failure and marked it">reviewed</span>' : ''}${t.tags.map(tagChip).join('')}</span>
      ${mini}
      ${time}
    </div>
    ${open ? renderDetail(t, s) : ''}
  </div>`
}

function renderDetail(t, s) {
  const d = state.data
  const parts = []
  if (s.error)
    parts.push(
      `<div class="error" title="The error it failed with">${esc(s.error)}</div>`,
    )
  if (s.artifacts) {
    const name = s.artifacts.split(/[\\/]/).pop()
    // has(): read already, or being read (undefined) or failed (null)
    if (!state.screens.has(s.artifacts)) loadScreen(s.artifacts, d.run)
    const ids = state.screens.get(s.artifacts)
    const png = `/files/${esc(d.run)}/${encodeURIComponent(name)}.png`
    parts.push(`<div class="shot">
      <a href="${png}" target="_blank" title="The screen when it failed: open full size"><img data-shot src="${png}" alt="the screen when it failed"></a>
      <div class="ids"><b>On screen</b> <span class="muted">(testIDs in the UI tree, visible ones only)</span>
        ${
          ids === null
            ? '<p class="muted">could not read the UI tree</p>'
            : ids
              ? ids.length
                ? `<ul>${ids.map(id => `<li>${esc(id)}</li>`).join('')}</ul>`
                : '<p class="muted">none found</p>'
              : '<p class="muted">reading…</p>'
        }
      </div>
    </div>
    <div class="links">
      <a href="${png}" target="_blank">screenshot</a>
      <a href="/files/${esc(d.run)}/${encodeURIComponent(name)}.xml" target="_blank" title="The whole UI tree Appium saw at the failure (XML)">UI tree</a>
    </div>`)
  }
  const ended = ['passed', 'failed', 'skipped'].includes(s.status)
  if (!parts.length) {
    parts.push(
      `<div class="muted">${t.key === preparing ? `Being prepared: its beforeEach restarts the app and opens the screen it starts from. Then it runs, usually ~${duration(t.estimate)}.` : s.status === 'queued' ? `Queued · usually ~${duration(t.estimate)}` : s.status === 'passed' ? 'Passed.' : s.status === 'skipped' ? (s.needsPerson ? `Needs a person first: ${esc(s.needsPerson)}. Neither passed nor failed; run it again once that is done.` : 'Skipped: the spec decided it does not apply.') : `Running now · usually ~${duration(t.estimate)}`}</div>`,
    )
  }
  const buttons = []
  if (ended)
    buttons.push(
      `<button data-rerun="${esc(t.key)}" title="A new run of this test alone, on the device last picked on Run tests (else this run's). While a run goes on, it waits in the queue.">Run this test again</button>`,
    )
  if (s.status === 'failed') {
    const reviewed = state.reviewed?.[t.key] === d.run
    buttons.push(
      `<button data-review="${esc(t.key)}" title="Marks this failure as looked at (a newer failure of the test shows as new again)">${reviewed ? 'Mark as not reviewed' : 'Mark as reviewed'}</button>`,
    )
  }
  if (buttons.length)
    parts.push(`<div class="detail-actions">${buttons.join('')}</div>`)
  return `<div class="detail">${parts.join('')}</div>`
}

/** a failed hook in the banner: what failed, why, and its screen if kept */
const hookFailure = run => h => {
  const name = h.artifacts?.split(/[\\/]/).pop()
  const files = name
    ? ` (<a href="/files/${esc(run)}/${encodeURIComponent(name)}.png" target="_blank" title="The screen when the hook failed">screen</a> · <a href="/files/${esc(run)}/${encodeURIComponent(name)}.xml" target="_blank" title="The whole UI tree Appium saw when the hook failed (XML)">UI tree</a>)`
    : ''
  const what =
    h.hook === 'session'
      ? `<span title="The spec's session never started: none of its tests ran">${esc(plain(h.key))}</span>`
      : esc(plain(h.key))
  return `${what}${h.error ? `: ${esc(h.error)}` : ''}${files}`
}

async function loadScreen(artifacts, run) {
  state.screens.set(artifacts, undefined) // being read
  try {
    const { ids } = await api(
      `runs/${run}/screen?artifacts=${encodeURIComponent(artifacts)}`,
    )
    state.screens.set(artifacts, ids)
  } catch {
    state.screens.set(artifacts, null)
    // read again a little later, not in a tight loop (the page is no longer
    // drawn every second, so the drawing that reads it is asked for here)
    setTimeout(() => {
      state.screens.delete(artifacts)
      render()
    }, 5000)
  }
  render()
}

function toggle(key) {
  if (state.open.has(key)) state.open.delete(key)
  else state.open.add(key)
  render()
}

async function review(key) {
  try {
    state.reviewed = await post('reviewed', { key, run: state.run })
  } catch (e) {
    alert(`Could not mark it: ${e.message}`)
  }
  render()
}

async function stopRun() {
  if (
    !confirm(
      'Stop this run? Its workers are killed and the sweep cleans up after it.',
    )
  )
    return
  const button = document.getElementById('stop')
  button.disabled = true
  button.textContent = 'Stopping…'
  try {
    const { sweep } = await post(`runs/${state.run}/stop`)
    alert(`Run stopped.\n\nSweep: ${sweep || 'nothing left behind'}`)
  } catch (e) {
    alert(
      e.status === 409
        ? 'This run had already ended; nothing was stopped.'
        : `The run did not stop: ${e.message}`,
    )
  }
  state.ctx.refreshSoon()
}

/**
 * The Overview's Stop, which has no run page around it. True when the run is
 * no longer going on (stopped now, or already over); false when cancelled or
 * the stop failed, so the caller can give the button back.
 */
export async function stopFromElsewhere(stamp) {
  if (
    !confirm(
      'Stop this run? Its workers are killed and the sweep cleans up after it.',
    )
  )
    return false
  try {
    const { sweep } = await post(`runs/${stamp}/stop`)
    alert(`Run stopped.\n\nSweep: ${sweep || 'nothing left behind'}`)
    return true
  } catch (e) {
    alert(
      e.status === 409
        ? 'This run had already ended; nothing was stopped.'
        : `The run did not stop: ${e.message}`,
    )
    return e.status === 409
  }
}

async function rerunFailed() {
  const button = document.getElementById('rerun')
  button.disabled = true
  button.textContent = 'Starting…'
  try {
    // while another run goes on, the rerun waits in the queue
    const body = await post(`runs/${state.run}/rerun-failed`, {
      device: pickedDevice(),
      queue: true,
    })
    location.hash = body.run ? 'live' : 'launch'
  } catch (e) {
    alert(`The rerun did not start: ${e.message}`)
    render()
  }
}

/**
 * A new run of tests of this run, whatever they ended with: the keys given
 * (one test), else all of them. Queued while another run goes on.
 */
async function rerun(button, keys) {
  const label = button.textContent
  button.disabled = true
  button.textContent = 'Starting…'
  try {
    const body = await post(`runs/${state.run}/rerun`, {
      keys,
      device: pickedDevice(),
      queue: true,
    })
    location.hash = body.run ? 'live' : 'launch'
  } catch (e) {
    alert(`The run did not start: ${e.message}`)
    button.disabled = false
    button.textContent = label
  }
}

/** #live with no run going on, and none shown live since the page opened */
function noLiveRun(current) {
  const waiting = current?.queued ?? 0
  return `<div class="page-head"><h1>Run tests</h1>${runTabs('live', current)}</div>
    <section class="card empty-live">
      <p>No run is going on now.</p>
      <p class="muted">${waiting ? `${waiting} run${waiting === 1 ? '' : 's'} in the queue: the next one starts in a moment, and shows here.` : 'A run started from the dashboard, a terminal or Claude shows here while it goes on.'}</p>
      <p><a class="button primary" href="#launch">Set up a run</a>${current?.run ? ` <a class="button" href="#run=${esc(current.run)}">The newest run</a>` : ''}</p>
    </section>`
}
