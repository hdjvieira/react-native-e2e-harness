// Run history (#history): every run folder in out/, newest first, one row
// each: what it ran against and how it ended. A row opens the run's page.

import { byPlatform, platformFilter, PLATFORM } from './overview.js'
import {
  api,
  deviceName,
  duration,
  esc,
  load,
  oldServer,
  pill,
  platformName,
  resultBar,
  save,
  when,
} from './util.js'

const view = { data: undefined, key: undefined }

// the live run ended (it joins the list) or a new one started (it leaves it)
export const onLive = ctx => {
  view.key = undefined
  ctx.refreshSoon()
}

export function show(ctx) {
  view.key = undefined
  ctx.main.innerHTML = `
    <div class="page-head">
      <h1>Run history</h1>
      <div id="h-filter"></div>
    </div>
    <p class="muted page-note">Every past run kept in <code>out/</code>, newest first (the run going on is under <a href="#live">Run tests</a> until it ends). Old reports are pruned by the runner once their code is in master and nothing in them is still failing. Click a row for its page.</p>
    <section class="card" id="h-table"><p class="muted center">Reading the runs…</p></section>`
  if (view.data) draw(ctx)
}

export async function refresh(ctx, still) {
  try {
    // the device names come with it: /api/devices asks adb every time
    const data = await api('history')
    if (!still()) return 0
    view.data = data
    draw(ctx)
    return data.runs.some(r => r.status === 'running') ? 3000 : 10000
  } catch (e) {
    if (!still()) return 0
    const el = ctx.main.querySelector('#h-table')
    if (el) el.innerHTML = oldServer(e)
    view.key = undefined
    return 5000
  }
}

/** force: the user asked for it, so a pointer still down doesn't hold it */
function draw(ctx, force = false) {
  const platform = load(PLATFORM, 'all')
  const filter = ctx.main.querySelector('#h-filter')
  const table = ctx.main.querySelector('#h-table')
  if (!filter || !table || (!force && ctx.busy())) return
  // past runs only: the run going on is Run tests' live tab
  const live = ctx.shell.current?.live ? ctx.shell.current.run : undefined
  const { known } = view.data
  const all = view.data.runs.filter(r => r.run !== live)
  const key = JSON.stringify({ runs: all, platform, known })
  if (key === view.key) return
  view.key = key
  filter.innerHTML = platformFilter(platform)
  for (const b of filter.querySelectorAll('[data-platform]')) {
    b.addEventListener('click', () => {
      save(PLATFORM, b.dataset.platform)
      view.key = undefined
      // the click is still going out (ctx.busy() says so): draw anyway
      draw(ctx, true)
    })
  }
  const runs = byPlatform(all, platform)
  if (!runs.length) {
    table.innerHTML = `<p class="muted center">No ${platform === 'all' ? '' : `${esc(platformName(platform))} `}runs in out/ yet.</p>`
    return
  }
  table.innerHTML = `<div class="table-wrap"><table class="table runs-table">
    <thead><tr>
      <th title="When the run started (hover for the exact time)">When</th>
      <th title="The release the code belongs to: a version means that commit shipped in it; '>x (in master, unreleased)' means merged after release x; '>x (unreleased)' means not in master yet (a feature branch)">Release</th>
      <th title="The git branch and commit the run's code came from">Branch @ commit</th>
      <th title="The device it ran on, and its platform">Device / platform</th>
      <th title="How the run ended">Result</th>
      <th title="Its tests: passed (green), failed (red), skipped (grey); passed/total">Passed / failed / skipped</th>
      <th class="num" title="Wall-clock time of the whole run: preflight, sweeps and tests">Duration</th>
      <th class="num" title="Tests in the run (planned, or with a result for older runs)">Tests</th>
    </tr></thead>
    <tbody>${runs.map(row).join('')}</tbody>
  </table></div>`
  for (const tr of table.querySelectorAll('tr[data-run]')) {
    tr.addEventListener('click', e => {
      if (e.target.closest('a')) return
      ctx.go(`run=${tr.dataset.run}`)
    })
  }
}

function row(r) {
  const code =
    r.branch || r.commit
      ? `<code title="${esc(`${r.branch ?? '?'} @ ${r.commit ?? '?'}${r.approximate ? ' (approximate: HEAD at the run start, written after the fact)' : ''}`)}">${esc(r.branch ?? '?')} @ ${esc(r.commit ?? '?')}${r.approximate ? ' ≈' : ''}</code>${r.dirty ? ' <span class="tag warn" title="The checkout had uncommitted changes: a debug build runs whatever Metro serves">uncommitted changes</span>' : ''}`
      : '<span class="muted" title="No run.json: run before it was written">–</span>'
  const counts = `<span class="counts"><span title="passed" style="color:var(--pass)">${r.passed}</span> / <span title="failed" style="color:var(--fail)">${r.failed}</span> / <span title="skipped" class="muted">${r.skipped}</span></span>`
  return `<tr data-run="${esc(r.run)}" class="clickable" title="Open run ${esc(r.run)}">
    <td class="c-when"><a href="#run=${esc(r.run)}">${when(r.started)}</a></td>
    <td class="c-release">${r.release ? `<span title="${esc(r.release)}">${esc(r.release)}</span>` : '<span class="muted" title="No run.json: run before it was written">–</span>'}</td>
    <td class="c-code">${code}</td>
    <td class="c-device">${esc(deviceName(r.device, view.data.known ?? {}))}<div class="muted small">${r.device ? `<code>${esc(r.device)}</code> · ` : ''}<span title="${r.platformGuessed ? 'Not in run.json: read off the device serial' : 'From run.json'}">${esc(platformName(r.platform))}${r.platformGuessed ? '?' : ''}</span></div></td>
    <td class="c-result">${pill(r.status)}${r.error ? `<div class="muted small clip" title="${esc(r.error)}">${esc(r.error)}</div>` : ''}${r.hookFailures ? `<div class="muted small" title="Before/after hooks that failed: they end no test of their own">${r.hookFailures} hook${r.hookFailures > 1 ? 's' : ''} failed</div>` : ''}</td>
    <td class="c-bar">${resultBar(r, { label: false })} ${counts}${r.flaky ? ` <span class="tag flaky" title="Tests that failed once and passed on their retry">${r.flaky} on retry</span>` : ''}</td>
    <td class="num c-dur">${duration(r.seconds)}</td>
    <td class="num c-total">${r.total}</td>
  </tr>`
}
