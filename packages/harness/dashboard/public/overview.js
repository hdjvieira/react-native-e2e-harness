// The Overview (#overview): how the app is doing. The run going on (stages,
// progress, ETA), four figures across recent runs, every device with its
// latest run, and a chart of the recent runs. The platform filter is shared
// with Run history.

import {
  counts,
  elapsedOf,
  etaSub,
  etaValue,
  pipeline,
  progress,
  runStatus,
  stopFromElsewhere,
} from './run.js'
import {
  api,
  deviceName,
  duration,
  esc,
  exact,
  load,
  oldServer,
  pill,
  platformName,
  resultBar,
  save,
  when,
} from './util.js'

export const PLATFORM = 'e2e-platform'

const view = {
  history: undefined,
  devices: undefined, // /api/devices
  devicesAt: 0,
  live: undefined, // the live run's payload
  liveKey: undefined,
  restKey: undefined,
  platform: 'all', // read again on every show: Run history may have changed it
}

/** the platform filter, the same on Overview and Run history */
export function platformFilter(current) {
  const options = [
    ['all', 'All', 'Runs on every platform'],
    ['android', 'Android', 'Android runs only (emulator or phone)'],
    ['ios', 'iOS', 'iOS runs only (simulator or iPhone)'],
  ]
  return `<div class="seg" role="group" aria-label="Platform">${options
    .map(
      ([value, label, title]) =>
        `<button data-platform="${value}" class="${current === value ? 'on' : ''}" title="${esc(title)}">${label}</button>`,
    )
    .join('')}</div>`
}

export const byPlatform = (runs, platform) =>
  platform === 'all' ? runs : runs.filter(r => r.platform === platform)

export function show(ctx) {
  view.liveKey = view.restKey = undefined
  view.platform = load(PLATFORM, 'all')
  ctx.main.innerHTML = `
    <div class="page-head">
      <h1>How is the app doing?</h1>
      <div id="ov-filter"></div>
    </div>
    <div id="ov-live"></div>
    <div id="ov-rest"><p class="muted center">Reading the runs…</p></div>`
  drawFilter(ctx)
  if (view.history) draw(ctx)
}

function drawFilter(ctx) {
  const el = ctx.main.querySelector('#ov-filter')
  if (!el) return
  el.innerHTML = platformFilter(view.platform)
  for (const b of el.querySelectorAll('[data-platform]')) {
    b.addEventListener('click', () => {
      view.platform = b.dataset.platform
      save(PLATFORM, view.platform)
      drawFilter(ctx)
      view.restKey = undefined
      // the click is still going out (ctx.busy() says so): draw anyway
      draw(ctx, true)
    })
  }
}

export const onLive = ctx => ctx.refreshSoon()

export async function refresh(ctx, still) {
  try {
    const current = ctx.shell.current ?? (await api('current'))
    const wants = [api('history')]
    if (!view.devices || Date.now() - view.devicesAt > 15000) {
      wants.push(
        api('devices').then(d => {
          view.devices = d
          view.devicesAt = Date.now()
        }),
      )
    }
    const liveP = current.live
      ? api(`runs/${current.run}`).catch(() => undefined)
      : Promise.resolve(undefined)
    const [history] = await Promise.all(wants)
    const live = await liveP
    if (!still()) return 0
    view.history = history
    view.live =
      live?.running || (live && !live.ended && !live.lost) ? live : undefined
    draw(ctx)
    return view.live ? 2000 : 10000
  } catch (e) {
    if (!still()) return 0
    const rest = ctx.main.querySelector('#ov-rest')
    if (rest) rest.innerHTML = oldServer(e)
    view.restKey = undefined
    return 5000
  }
}

/** force: the user asked for it, so a pointer still down doesn't hold it */
function draw(ctx, force = false) {
  if (!force && ctx.busy()) return
  const liveEl = ctx.main.querySelector('#ov-live')
  const restEl = ctx.main.querySelector('#ov-rest')
  if (!liveEl || !restEl || !view.history) return
  const liveKey = JSON.stringify(
    view.live ? { ...view.live, now: 0, eta: !!view.live.eta } : null,
  )
  if (liveKey !== view.liveKey) {
    view.liveKey = liveKey
    liveEl.innerHTML = view.live ? liveCard(view.live) : ''
    liveEl.querySelector('#ov-stop')?.addEventListener('click', async e => {
      const button = e.currentTarget
      button.disabled = true
      // cancelled, or the stop failed: the card may not be drawn again for a
      // while (one long test), so the button must work again now
      if (!(await stopFromElsewhere(view.live.run))) button.disabled = false
      ctx.refreshSoon()
    })
  } else if (view.live) {
    const set = (sel, html) => {
      const el = liveEl.querySelector(sel)
      if (el && el.innerHTML !== html) el.innerHTML = html
    }
    set('[data-eta]', etaValue(view.live))
    set('[data-eta-sub]', etaSub(view.live))
    set('[data-elapsed]', duration(elapsedOf(view.live)))
  }
  const restKey = JSON.stringify({
    runs: view.history.runs,
    kpis: view.history.kpis,
    devices: view.devices,
    platform: view.platform,
    live: view.live?.device,
  })
  if (restKey === view.restKey) return
  view.restKey = restKey
  restEl.innerHTML = rest()
  for (const el of restEl.querySelectorAll('[data-run]')) {
    el.addEventListener('click', () => ctx.go(`run=${el.dataset.run}`))
  }
}

function liveCard(d) {
  const [statusClass, statusText] = runStatus(d)
  const c = counts(d)
  const specs = [...new Set(d.tests.map(t => t.spec).filter(Boolean))]
  const what =
    specs.length === 1
      ? `${d.tests.length} test${d.tests.length === 1 ? '' : 's'} of <code>${esc(specs[0])}</code>`
      : `${d.tests.length} tests from ${specs.length} spec files`
  const known = view.devices?.known ?? {}
  const connected = view.devices?.devices ?? []
  return `<section class="card live-card">
    <div class="live-head">
      <span class="live-dot" title="A run is going on now"></span>
      <h2>Running now</h2>
      ${pill(statusClass, statusText)}
      <span class="muted">on <b title="${esc(d.device ?? '')}">${esc(deviceName(d.device, known, connected))}</b> · ${what}</span>
      <div class="run-actions">
        <a class="button" href="#live" title="The live run under Run tests: every test, failures with screenshots">Open</a>
        ${d.summary ? `<a class="button" href="/files/${esc(d.run)}/summary.md" target="_blank" title="The run's summary.md">Summary</a>` : ''}
        ${d.running ? '<button class="danger" id="ov-stop" title="Kills this run\'s launcher and its workers, then runs the clean-up sweep">Stop</button>' : ''}
      </div>
    </div>
    ${pipeline(d)}
    ${progress(d, c)}
    <div class="live-figures">
      <span title="Passed so far"><b style="color:var(--pass)">${c.passed}</b> passed</span>
      <span title="Failed so far (after their retry)"><b style="color:var(--fail)">${c.failed}</b> failed</span>
      <span title="Skipped: the test decided it doesn't apply here"><b>${c.skipped}</b> skipped</span>
      <span title="Still to run, including the one running now"><b>${c.queued + c.running}</b> to go</span>
      <span class="spacer"></span>
      <span title="Since the run started">elapsed <b data-elapsed>${duration(elapsedOf(d))}</b></span>
      <span title="Time left: each remaining test's usual time plus setups and the end sweep, scaled by how this run is going against past ones">ETA <b data-eta>${etaValue(d)}</b> <span class="muted" data-eta-sub>${etaSub(d)}</span></span>
    </div>
  </section>`
}

function rest() {
  const h = view.history
  const platform = view.platform
  const runs = byPlatform(h.runs, platform)
  const k = h.kpis[platform] ?? h.kpis.all
  const pName = platform === 'all' ? 'all platforms' : platformName(platform)
  const rate = k.passRate.executed
    ? Math.round((k.passRate.passed / k.passRate.executed) * 1000) / 10
    : undefined
  const kpi = (label, value, sub, title, tone = '') =>
    `<div class="kpi ${tone}" title="${esc(title)}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`
  const kpis = `<section class="kpis">
    ${kpi(
      'Pass rate',
      rate === undefined ? '–' : `${rate}%`,
      `newest result of each test, last ${k.passRate.runs} runs`,
      `Each test that passed or failed in the last ${k.passRate.runs} runs (${pName}) counts once, by its newest result: ${k.passRate.passed} passed of ${k.passRate.executed}. Skips are left out; a test that passed on its retry counts as passed. The run going on and runs whose preflight failed don't count; a stopped or lost run counts for the tests it finished. The card's top edge is green at 95% or more, amber from 80%, red below.`,
      rate === undefined
        ? ''
        : rate >= 95
          ? 'good'
          : rate >= 80
            ? 'warn'
            : 'bad',
    )}
    ${kpi(
      'Tests executed',
      k.newest.executed,
      `in the newest run on each device (${k.newest.runs.length})`,
      `Tests that passed or failed (not skipped) in the newest finished run on each device: ${k.newest.runs.join(', ') || 'none'}`,
    )}
    ${kpi(
      'Failures',
      k.newest.failed,
      k.newest.hookFailures
        ? `${k.newest.hookFailures} in before/after hooks`
        : 'none in before/after hooks',
      `Tests that failed in the newest finished run on each device (${k.newest.runs.join(', ') || 'none'}). A failed before/after hook ends no test of its own and is counted beside them. The card's top edge is red when any test or hook failed, green when tests ran with none.`,
      k.newest.failed || k.newest.hookFailures
        ? 'bad'
        : k.newest.executed
          ? 'good'
          : '',
    )}
    ${kpi(
      'Average run duration',
      duration(k.duration.average),
      `over the last ${k.duration.runs} finished runs`,
      `The wall-clock time of the runs that passed or failed among the last ${h.window} (${pName}): preflight, sweeps and every test. Stopped, lost and preflight-failed runs are left out.`,
    )}
  </section>`

  return `${kpis}
    <section class="card">
      <h2 title="Every device a run has used, and those connected now">Devices</h2>
      ${devicesTable(runs)}
    </section>
    <section class="card">
      <div class="card-head"><h2 title="Each bar is one run: its tests stacked by result">Recent runs</h2>
        <div class="legend"><span><i class="sw p-pass"></i>passed</span><span><i class="sw p-fail"></i>failed</span><span><i class="sw p-skip"></i>skipped</span><span class="muted">oldest left → newest right · click a bar for its run</span></div>
      </div>
      ${chart(runs.slice(0, 40).reverse())}
    </section>`
}

function devicesTable(runs) {
  const known = view.devices?.known ?? {}
  const connected = view.devices?.devices ?? []
  const devices = new Map()
  // newest first: the first run seen per device is its latest
  for (const r of runs) {
    if (!r.device) continue
    if (!devices.has(r.device))
      devices.set(r.device, { id: r.device, platform: r.platform, latest: r })
  }
  for (const d of connected) {
    if (view.platform !== 'all' && d.platform !== view.platform) continue
    if (!devices.has(d.id))
      devices.set(d.id, { id: d.id, platform: d.platform })
  }
  if (!devices.size)
    return '<p class="muted">No device yet: connect a phone or start an emulator, then run tests.</p>'
  const liveDevice = view.live?.device
  const rows = [...devices.values()].map(d => {
    const seen = connected.find(c => c.id === d.id)
    const now =
      liveDevice === d.id
        ? '<span class="now-state running" title="A run is going on on it now">running</span>'
        : seen?.usable === false
          ? `<span class="now-state blocked" title="${esc(seen.why ?? '')}">Wi-Fi only</span>`
          : seen
            ? '<span class="now-state up" title="Connected now (adb, an iPhone on a cable, or a booted simulator): a run can use it">connected</span>'
            : '<span class="now-state" title="Not connected now: plug it in, or start the emulator or simulator (Run tests), to run on it">not connected</span>'
    const r = d.latest
    return `<tr ${r ? `data-run="${esc(r.run)}" class="clickable" title="Open its latest run"` : ''}>
      <td class="lead"><b>${esc(deviceName(d.id, known, connected))}</b><div class="muted small"><code>${esc(d.id)}</code> · ${esc(platformName(d.platform))}</div></td>
      <td data-label="Now">${now}</td>
      <td data-label="Latest run">${r ? pill(r.status) : '<span class="muted" title="No run on it yet">–</span>'}</td>
      <td class="wide">${r ? resultBar(r) : ''}</td>
      <td class="num" data-label="Failures" title=""Tests that failed in its latest run${r?.hookFailures ? `, plus ${r.hookFailures} failed hook(s)` : ''}">${r ? (r.failed ? `<b style="color:var(--fail)">${r.failed}</b>` : '0') : ''}</td>
      <td class="num" data-label="Duration" title="How long its latest run took">${r ? duration(r.seconds) : ''}</td>
      <td data-label="When">${r ? when(r.started) : ''}</td>
    </tr>`
  })
  return `<div class="table-wrap"><table class="table stack">
    <thead><tr>
      <th title="The device's model (when it was ever seen connected), its serial and platform">Device</th>
      <th title="Whether it is connected or running a run now">Now</th>
      <th title="How its latest run ended">Latest run</th>
      <th title="Its latest run's tests: passed (green), failed (red), skipped (grey); passed/total">Result</th>
      <th class="num" title="Tests that failed in its latest run">Failures</th>
      <th class="num" title="How long its latest run took">Duration</th>
      <th title="When its latest run started (hover for the exact time)">When</th>
    </tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table></div>`
}

/** stacked bars, one per run, with a y axis in tests */
function chart(runs) {
  if (!runs.length) return '<p class="muted">No runs yet.</p>'
  const known = view.devices?.known ?? {}
  const max = Math.max(1, ...runs.map(r => r.passed + r.failed + r.skipped))
  // a round top for the axis: 5, 10, 20, 50…
  const step =
    [1, 2, 5, 10, 20, 25, 50, 100, 200].find(s => max / s <= 5) ?? 500
  const top = Math.ceil(max / step) * step
  const ticks = []
  for (let v = 0; v <= top; v += step) ticks.push(v)
  const pct = n => (n / top) * 100
  const bars = runs
    .map(r => {
      const n = r.passed + r.failed + r.skipped
      const title = `${exact(r.started)}\n${deviceName(r.device, known)} (${platformName(r.platform)})\n${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped${r.hookFailures ? `, ${r.hookFailures} failed hook(s)` : ''}\n${duration(r.seconds)} · ${r.status === 'preflight' ? 'preflight failed: no test ran' : r.status}`
      return `<button class="bar ${r.status}" data-run="${esc(r.run)}" title="${esc(title)}" aria-label="${esc(title)}">
        ${
          n
            ? `<i class="p-skip" style="height:${pct(r.skipped)}%"></i><i class="p-fail" style="height:${pct(r.failed)}%"></i><i class="p-pass" style="height:${pct(r.passed)}%"></i>`
            : '<i class="none"></i>'
        }
      </button>`
    })
    .join('')
  return `<div class="chart">
    <div class="axis" aria-hidden="true">${ticks
      .map(v => `<span style="bottom:${pct(v)}%">${v}</span>`)
      .join('')}</div>
    <div class="plot">
      ${ticks.map(v => `<i class="grid" style="bottom:${pct(v)}%"></i>`).join('')}
      <div class="bars">${bars}</div>
    </div>
    <div class="axis-label" title="The y axis counts tests">tests</div>
  </div>`
}
