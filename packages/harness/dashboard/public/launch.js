// Run tests (#launch): 1. a device, 2. what to run (a preset, or tests
// picked from the tree), and a summary with the Run button. One run at a
// time: while a run goes on, the button puts the new one in the server's
// queue, which starts it when the runs before it have ended. The run going on
// is the other tab of Run tests (#live, run.js).

import {
  api,
  clock,
  duration,
  esc,
  icon,
  load,
  oldServer,
  plain,
  platformName,
  post,
  runTabs,
  save,
  strip,
  stripLegend,
  tagChip,
  tagTitle,
} from './util.js'

const SELECTED = 'e2e-selected'
const DEVICE = 'e2e-device'
const MODE = 'e2e-mode'
const TAGS = 'e2e-tags'
const SPEC = 'e2e-spec'

const view = {
  data: undefined, // /api/tests: { tests, perTest, setup, overhead }
  devices: [],
  devicesAt: 0,
  device: undefined,
  /** full | tags | spec | failed | pick */
  mode: load(MODE, 'full'),
  presetTags: new Set(load(TAGS, [])),
  spec: load(SPEC, ''),
  selected: new Set(load(SELECTED, [])),
  closed: new Set(), // specs folded away in the tree
  query: '',
  tags: new Set(), // the tree's filter: tags every shown test must have
  onlyFailed: false,
  loadedAt: 0,
  starting: false,
  /** emulators and simulators not running, which the page can start */
  startable: [],
  /** by id: when a start was asked, while it boots */
  booting: new Map(),
  /** the live run's device, to mark it busy */
  liveDevice: undefined,
  liveRun: undefined,
  /** /api/queue: runs waiting their turn */
  queue: [],
  queueKey: '',
  /** the last run added to the queue from here, for a moment's note */
  justQueued: undefined,
  ctx: undefined,
}

/** what the run page's Rerun failed uses: the device last picked here */
export const pickedDevice = () => view.device ?? load(DEVICE, undefined)

export function show(ctx, route) {
  view.ctx = ctx
  if (route.mode) view.mode = route.mode
  if (view.data) render()
  else ctx.main.innerHTML = '<p class="muted center">Reading the specs…</p>'
  // a fresh look at the specs and devices when the page opens
  if (Date.now() - view.loadedAt > 15000) view.loadedAt = 0
}

export const onLive = ctx => ctx.refreshSoon()

export async function refresh(ctx, still) {
  try {
    if (!view.loadedAt) {
      const [data, devs] = await Promise.all([api('tests'), api('devices')])
      if (!still()) return 0
      view.data = data
      takeDevices(devs)
      view.loadedAt = Date.now()
      // forget picks whose tests are gone
      const known = new Set(data.tests.map(t => t.key))
      for (const key of view.selected)
        if (!known.has(key)) view.selected.delete(key)
      // and tags no test carries any more: no chip would be left to untick
      // them, and By tag would pick nothing for good
      const tags = new Set(data.tests.flatMap(t => t.tags))
      for (const tag of view.presetTags)
        if (!tags.has(tag)) view.presetTags.delete(tag)
      save(TAGS, [...view.presetTags])
      if (!view.data.tests.some(t => t.spec === view.spec))
        view.spec = view.data.tests[0]?.spec ?? ''
      await Promise.all([liveDevice(ctx), readQueue()])
      if (!still()) return 0
      render()
      return 3000
    }
    // between: only whether a run is going on, and the queue, change what
    // this page allows and shows
    const before = `${view.liveRun}|${view.liveDevice}|${view.queueKey}`
    await Promise.all([liveDevice(ctx), readQueue()])
    if (!still()) return 0
    if (
      `${view.liveRun}|${view.liveDevice}|${view.queueKey}` !== before &&
      !ctx.busy()
    ) {
      render()
    }
    return 3000
  } catch (e) {
    if (!still()) return 0
    ctx.main.innerHTML = oldServer(e)
    return 5000
  }
}

function takeDevices(devs) {
  view.devices = devs.devices
  view.startable = devs.startable ?? []
  view.devicesAt = devs.now ?? Date.now()
  // a start asked for is done once the device is up, or given up on
  for (const [id, at] of view.booting) {
    const up = !view.startable.some(s => s.id === id)
    if (up || Date.now() - at > BOOT_WAIT) view.booting.delete(id)
  }
  const remembered = load(DEVICE, undefined)
  const usable = view.devices.filter(d => d.usable !== false)
  view.device =
    view.devices.find(d => d.id === view.device)?.id ??
    view.devices.find(d => d.id === remembered)?.id ??
    usable.find(d => d.id === devs.preferred)?.id ??
    usable[0]?.id ??
    view.devices[0]?.id
}

// how long a started emulator or simulator gets to boot before the page
// stops waiting for it
const BOOT_WAIT = 180000

/** how each device is reached: the card's state line, and its hover */
const CONNECTION = {
  cable: ['Cable', 'Connected by USB cable'],
  wifi: [
    'Wi-Fi',
    'Connected over Wi-Fi (Android wireless debugging): runs work, a little slower than on a cable',
  ],
  emulator: ['Emulator', 'An Android emulator on this machine'],
  simulator: ['Simulator', 'An iOS simulator on this machine'],
}

/** the queue, from the server (an older server has none) */
async function readQueue() {
  try {
    view.queue = (await api('queue')).items ?? []
  } catch {
    view.queue = []
  }
  view.queueKey = JSON.stringify(view.queue)
}

async function liveDevice(ctx) {
  const current = ctx.shell.current ?? (await api('current'))
  if (!current.live) {
    view.liveRun = view.liveDevice = undefined
    return
  }
  if (view.liveRun === current.run && view.liveDevice) return
  view.liveRun = current.run
  try {
    view.liveDevice = (await api(`runs/${current.run}`)).device
  } catch {
    view.liveDevice = undefined
  }
}

// --- what a preset runs ------------------------------------------------------------

const specsOf = tests => [...new Set(tests.map(t => t.spec))]

/**
 * The target tags a run on the picked device leaves out, as the runner does:
 * the other platform's, and the other kind of device's (plan.ts)
 */
function leftOutTags() {
  const device = view.devices?.find(d => d.id === view.device)
  if (!device) return []
  const kind =
    device.connection === 'emulator' || device.connection === 'simulator'
      ? 'virtual'
      : 'device'
  return view.data?.leaves?.[device.platform]?.[kind] ?? []
}

/** the first of these tags the test carries */
const leftOutBy = (t, tags) => tags.find(tag => t.tags.includes(tag))

/** what the preset picks, less what the picked device's run leaves out */
function chosen() {
  const tags = leftOutTags()
  return presetTests().filter(t => !leftOutBy(t, tags))
}

/** the preset's tests, whatever the device */
function presetTests() {
  const tests = view.data.tests
  switch (view.mode) {
    case 'tags':
      return view.presetTags.size
        ? tests.filter(t =>
            [...view.presetTags].every(tag => t.tags.includes(tag)),
          )
        : []
    case 'spec':
      return tests.filter(t => t.spec === view.spec)
    case 'failed':
      return tests.filter(t => t.last?.status === 'failed')
    case 'pick':
      return tests.filter(t => view.selected.has(t.key))
    default:
      return tests
  }
}

function describeChoice(picked) {
  switch (view.mode) {
    case 'tags':
      return view.presetTags.size
        ? `tagged ${[...view.presetTags].join(' + ')}`
        : 'no tag picked yet'
    case 'spec':
      return `the spec ${view.spec}`
    case 'failed':
      return 'those that failed last time'
    case 'pick':
      return `picked by hand from ${specsOf(picked).length} spec file${specsOf(picked).length === 1 ? '' : 's'}`
    default:
      return 'the full suite'
  }
}

/** typical seconds for these tests, as the run's ETA reckons them */
function estimateOf(tests) {
  if (!tests.length) return 0
  const describes = new Set(tests.map(t => t.describe)).size
  return (
    tests.reduce((sum, t) => sum + t.estimate + (view.data.perTest ?? 0), 0) +
    describes * view.data.setup +
    view.data.overhead
  )
}

// --- drawing ---------------------------------------------------------------------------

function render() {
  const ctx = view.ctx
  if (!view.data || !location.hash.match(/^#(launch|tests)/)) return
  const tests = view.data.tests
  const picked = chosen()
  const failedLast = tests.filter(t => t.last?.status === 'failed')
  const allTags = [...new Set(tests.flatMap(t => t.tags))].sort()
  const specs = specsOf(tests)

  const preset = (mode, title, sub, hint) =>
    `<button class="preset ${view.mode === mode ? 'on' : ''}" data-mode="${mode}" title="${esc(hint)}">
      <span class="preset-title">${title}</span><span class="preset-sub">${sub}</span>
    </button>`

  const detail =
    view.mode === 'tags'
      ? `<div class="preset-detail">
          <div class="muted small">Tests that have every tag picked:</div>
          <div class="chips">${allTags.map(tag => `<button class="chip ${view.presetTags.has(tag) ? 'on' : ''}" data-preset-tag="${esc(tag)}" title="${esc(tagTitle(tag))}">${esc(tag)}</button>`).join('')}</div>
          ${pickedList(picked)}
        </div>`
      : view.mode === 'spec'
        ? `<div class="preset-detail">
            <div class="spec-search">
              <input id="spec-q" class="search" type="search" placeholder="Search spec files" value="${esc(view.specQuery ?? '')}" title="Type part of a spec's path or name; pick it from the list">
              <div class="spec-list" role="listbox" title="Spec files, with how many tests each holds">
                ${
                  specs
                    .filter(s =>
                      s
                        .toLowerCase()
                        .includes((view.specQuery ?? '').toLowerCase()),
                    )
                    .map(
                      s => `<button class="spec-option ${s === view.spec ? 'on' : ''}" data-spec="${esc(s)}" role="option" aria-selected="${s === view.spec}" title="${esc(s)}">
                        <span class="mono">${esc(s.replace(/^specs\//, ''))}</span>
                        <span class="count">${tests.filter(t => t.spec === s).length} tests</span>
                      </button>`,
                    )
                    .join('') ||
                  '<p class="muted small" style="padding:8px 12px">No spec file matches.</p>'
                }
              </div>
            </div>
            ${pickedList(picked)}
          </div>`
        : view.mode === 'failed'
          ? `<div class="preset-detail">${failedLast.length ? pickedList(picked) : '<p class="muted">Nothing failed in its last run.</p>'}</div>`
          : view.mode === 'pick'
            ? tree()
            : `<div class="preset-detail muted small">Every device test in the specs (the config's <code>exclude</code> leaves some out). Tests tagged for the other platform (<code>#android</code> on an iPhone) are left out by the run itself.</div>`

  ctx.main.innerHTML = `
    <div class="page-head"><h1>Run tests</h1>${runTabs('launch', ctx.shell.current)}</div>
    <div class="launch">
      <div class="launch-main">
        <section class="card">
          <div class="card-head">
            <h2>1. Device</h2>
            <span class="muted small" title="When the device list was read">updated ${clock(view.devicesAt)}</span>
            <button class="ghost small" id="refresh-devices" title="Ask adb (and devicectl on a Mac) again">Refresh</button>
          </div>
          ${deviceCards()}
          ${startButtons()}
          <p class="muted small" title="Several devices would run one after another, each its own run: not built yet">One device per run. Running on several devices one after another is not built yet.</p>
        </section>
        <section class="card">
          <h2>2. What to run</h2>
          <div class="presets">
            ${preset('full', 'Full suite', `${specs.length} specs · ${tests.length} tests`, 'Every device test, spec by spec')}
            ${preset('tags', 'By tag', view.presetTags.size ? [...view.presetTags].map(esc).join(' + ') : 'pick tags', 'The tests that carry every tag you pick')}
            ${preset('spec', 'One spec file', esc(view.spec.replace(/^specs\//, '') || 'pick one'), 'Every test in one spec file')}
            ${preset('failed', 'Failed last time', `${failedLast.length} test${failedLast.length === 1 ? '' : 's'}`, 'The tests whose newest result is a failure')}
            ${preset('pick', 'Pick tests', `${view.selected.size} ticked`, 'Tick tests, describes or whole specs in the tree')}
          </div>
          ${detail}
        </section>
      </div>
      ${summary(picked)}
    </div>`

  for (const box of ctx.main.querySelectorAll('input[data-partial]'))
    box.indeterminate = true
  bind()
}

/** reads the devices every few seconds while something boots */
let watching = false
async function watchBoot() {
  if (watching) return
  watching = true
  try {
    while (view.booting.size) {
      await new Promise(resolve => setTimeout(resolve, 5000))
      try {
        takeDevices(await api('devices?fresh=1'))
      } catch {
        // the next round asks again
      }
      if (!view.ctx.busy?.()) render()
    }
  } finally {
    watching = false
  }
}

function deviceCards() {
  if (!view.devices.length) {
    return '<p class="muted">No device connected: plug in a phone with USB debugging on, or start an emulator or simulator below, then Refresh.</p>'
  }
  return `<div class="device-cards">${view.devices
    .map(d => {
      const busy = d.id === view.liveDevice
      const [how, howTitle] = CONNECTION[d.connection] ?? ['Connected', '']
      const usable = d.usable !== false
      const state = busy
        ? '<span class="now-state running">Running a run</span>'
        : usable
          ? `<span class="now-state up" title="${esc(howTitle)}">${esc(how)}</span>`
          : `<span class="now-state blocked" title="${esc(d.why ?? '')}">${esc(how)} only: can't run</span>`
      const title = busy
        ? 'A run is going on on this device: a new run waits until it ends'
        : usable
          ? 'Run on this device'
          : d.why
      return `<button class="device-card ${d.id === view.device ? 'on' : ''} ${usable ? '' : 'unusable'}" data-device="${esc(d.id)}" ${usable ? '' : 'disabled'} title="${esc(title ?? '')}">
        <span class="device-name">${esc(d.model ?? d.label)}</span>
        <span class="muted small">${esc(platformName(d.platform))} · <code>${esc(d.id)}</code></span>
        ${state}
        ${usable ? '' : `<span class="small device-why">${esc(d.why ?? '')}</span>`}
      </button>`
    })
    .join('')}</div>`
}

/** the emulators and simulators that aren't running, each with Start */
function startButtons() {
  if (!view.startable.length) return ''
  return `<div class="startable">
    <span class="muted small" title="Emulators (Android Virtual Devices) on this machine, and iPhone simulators the app is installed on">Not running:</span>
    ${view.startable
      .map(s => {
        const booting = view.booting.has(s.id)
        const kind = s.platform === 'ios' ? 'simulator' : 'emulator'
        return `<button class="small" data-start="${esc(s.id)}" data-platform="${esc(s.platform)}" ${booting ? 'disabled' : ''} title="${esc(booting ? 'Booting: it appears above once it is up (a minute or two)' : `Start this ${kind}: it appears above once it has booted`)}">${booting ? 'Starting' : 'Start'} ${esc(s.name)} <span class="muted">${kind}</span></button>`
      })
      .join('')}
  </div>`
}

function pickedList(picked) {
  if (!picked.length) return ''
  const shown = picked.slice(0, 12)
  return `<ul class="picked-list" title="The tests this choice runs; the mark is each test's newest result (hover it)">${shown
    .map(
      t =>
        `<li>${icon(t.last ? (t.last.flaky ? 'flaky' : t.last.status) : 'never', 'Its newest result: ')} ${esc(plain(t.title))} <span class="muted small">${esc(plain(t.describe))}</span></li>`,
    )
    .join(
      '',
    )}${picked.length > shown.length ? `<li class="muted">and ${picked.length - shown.length} more</li>` : ''}</ul>`
}

/** the run going on and the queue behind it, under the Run button */
function queueList(live) {
  if (!live && !view.queue.length) return ''
  const known = view.devices
  const name = item =>
    item.model ??
    known.find(d => d.id === item.device)?.model ??
    item.device ??
    'the default device'
  const rows = view.queue
    .map(
      (
        item,
        i,
      ) => `<li class="${item.error ? 'q-error' : ''} ${view.justQueued === item.id ? 'q-new' : ''}">
        <span class="q-pos">${i + 1}</span>
        <span class="q-what">
          <b>${item.tests} test${item.tests === 1 ? '' : 's'}</b> <span class="muted">${esc(item.label)}</span>
          <span class="muted small">on ${esc(name(item))}</span>
          ${item.error ? `<span class="q-why" title="It could not start, so the queue waits on it: retry once fixed, or remove it">${esc(item.error)}</span>` : ''}
        </span>
        ${item.error ? `<button class="ghost small" data-q-retry="${esc(item.id)}" title="Try to start it again">Retry</button>` : ''}
        <button class="ghost small" data-q-remove="${esc(item.id)}" title="Take it out of the queue">Remove</button>
      </li>`,
    )
    .join('')
  return `<div class="queue">
    <h3 title="Runs start one at a time, in this order, each when the one before it has ended">Queue</h3>
    ${view.liveRun ? `<p class="small q-live"><span class="spinner" aria-hidden="true"></span> <a href="#live">The run going on</a></p>` : ''}
    ${rows ? `<ol>${rows}</ol>` : '<p class="muted small">Nothing waiting.</p>'}
  </div>`
}

function summary(picked) {
  const device = view.devices.find(d => d.id === view.device)
  const live = !!view.ctx.shell.current?.live || !!view.liveRun
  const reason = !view.devices.length
    ? 'No device connected'
    : !device
      ? 'Pick a device'
      : device.usable === false
        ? `${device.model ?? device.id}: ${device.why}`
        : !picked.length
          ? 'Nothing picked to run'
          : view.starting
            ? 'Starting…'
            : ''
  const est = estimateOf(picked)
  const tags = leftOutTags()
  const preset = presetTests()
  const leftOut = preset.length - picked.length
  // the tags that actually left a test out, for the line that says so
  const tag = [
    ...new Set(preset.map(t => leftOutBy(t, tags)).filter(Boolean)),
  ].join(', ')
  return `<aside class="card summary-panel">
    <h2>Summary</h2>
    <dl>
      <dt>Device</dt>
      <dd>${device ? `${esc(device.model ?? device.label)} <span class="muted small">${esc(platformName(device.platform))}</span>` : '<span class="muted">none</span>'}</dd>
      <dt>Tests</dt>
      <dd><b>${picked.length}</b> <span class="muted small">${esc(describeChoice(picked))}${picked.length ? ` · ${specsOf(picked).length} spec file${specsOf(picked).length === 1 ? '' : 's'}` : ''}</span></dd>
      ${leftOut ? `<dt></dt><dd class="muted small" title="${esc(tag.split(', ').map(tagTitle).join('\n'))}">${leftOut} more tagged <code>${esc(tag)}</code> left out on this device</dd>` : ''}
      <dt title="Typical time from past runs: each test's median duration plus its beforeEach/afterEach, each describe's setup, and the preflight and sweeps. A test never run counts as the median of all tests.">Estimated time <span class="hint">?</span></dt>
      <dd title="Typical time from past runs plus setup: a guess, not a promise">${picked.length ? `~${duration(est)}` : '–'}</dd>
    </dl>
    <span class="run-wrap" title="${esc(reason || (live ? 'One run at a time: this one waits in the queue and starts by itself when the runs before it have ended' : 'Start the run and open its page'))}">
      <button class="primary big" id="run" ${reason ? 'disabled' : ''}>${view.starting ? 'Starting…' : `${live ? 'Queue' : 'Run'} ${picked.length || ''} test${picked.length === 1 ? '' : 's'}`}</button>
    </span>
    ${reason && !view.starting ? `<p class="muted small">${esc(reason)}.</p>` : ''}
    ${live && !reason ? '<p class="muted small">A run is going on: this one waits in the queue.</p>' : ''}
    ${queueList(live)}
  </aside>`
}

// --- the tree (Pick tests) ----------------------------------------------------------

function shown(test) {
  if (view.onlyFailed && test.last?.status !== 'failed') return false
  for (const tag of view.tags) if (!test.tags.includes(tag)) return false
  if (!view.query) return true
  const q = view.query.toLowerCase()
  return `${test.spec} ${test.describe} ${test.title}`.toLowerCase().includes(q)
}

function tree() {
  const tests = view.data.tests
  const visible = tests.filter(shown)
  const allTags = [...new Set(tests.flatMap(t => t.tags))].sort()
  const failedLast = tests.filter(t => t.last?.status === 'failed')

  // spec -> describe -> tests
  const specs = []
  for (const test of visible) {
    let spec = specs.find(s => s.spec === test.spec)
    if (!spec) specs.push((spec = { spec: test.spec, describes: [] }))
    let group = spec.describes.find(g => g.describe === test.describe)
    if (!group)
      spec.describes.push((group = { describe: test.describe, tests: [] }))
    group.tests.push(test)
  }

  // only what the picked device can run is tickable: a spec's or describe's
  // box ticks its runnable tests, and is off when it has none
  const tags = leftOutTags()
  const runnable = list => list.filter(t => !leftOutBy(t, tags)).map(t => t.key)
  const check = keys => {
    if (!keys.length) return 'disabled'
    const n = keys.filter(k => view.selected.has(k)).length
    return n === 0 ? '' : n === keys.length ? 'checked' : 'data-partial="1"'
  }

  return `<div class="tree">
    <div class="tree-tools">
      <input id="q" class="search" type="search" placeholder="Search specs and tests" value="${esc(view.query)}">
      <div class="chips">
        <span class="muted small" title="Show only the tests with every tag switched on">Show:</span>
        ${allTags.map(tag => `<button class="chip ${view.tags.has(tag) ? 'on' : ''}" data-tag="${esc(tag)}" title="${esc(tagTitle(tag))}">${esc(tag)}</button>`).join('')}
        <button class="chip ${view.onlyFailed ? 'on' : ''}" id="only-failed" title="Only the tests whose newest result is a failure">failed last time (${failedLast.length})</button>
      </div>
      <div class="toolbar-row">
        <button id="pick-failed" class="small" ${failedLast.length ? '' : 'disabled'} title="Tick every test that failed last time">Tick the failed ones</button>
        <button id="clear" class="small" ${view.selected.size ? '' : 'disabled'} title="Untick everything">Clear</button>
        <span class="muted small">${view.selected.size} ticked</span>
      </div>
      ${stripLegend()}
      <div class="legend"><span class="muted">Last time: taken in its newest run; <b>~</b> marks an estimate from past runs, not a measured time.</span></div>
    </div>
    <div class="tree-head" aria-hidden="true">
      <span title="Tick to run">✓</span>
      <span title="Its newest result: ✓ passed (amber: on retry), ✗ failed, – skipped, · never run">Last result</span>
      <span>Test</span>
      <span title="The tags in its titles: hover one for its meaning">Tags</span>
      <span title="Its last runs, one square each, oldest left">Last runs</span>
      <span title="How long it took last time (~: an estimate)">Last time</span>
    </div>
    ${
      specs
        .map(spec => {
          const all = spec.describes.flatMap(g => g.tests)
          const keys = runnable(all)
          const closed = view.closed.has(spec.spec)
          const failed = spec.describes
            .flatMap(g => g.tests)
            .filter(t => t.last?.status === 'failed').length
          return `<div class="spec">
            <div class="spec-row">
              <input type="checkbox" data-keys="${esc(keys.join('\n'))}" ${check(keys)} title="Tick every test in this spec">
              <button class="fold" data-fold="${esc(spec.spec)}" title="${closed ? 'Unfold' : 'Fold'}">${closed ? '▸' : '▾'}</button>
              <span class="mono">${esc(spec.spec)}</span>
              <span class="muted">${all.length} test${all.length === 1 ? '' : 's'}${failed ? ` · <span style="color:var(--fail)">${failed} failed last time</span>` : ''}</span>
            </div>
            ${
              closed
                ? ''
                : spec.describes
                    .map(
                      g => `<div class="describe">
                <div class="describe-row">
                  <input type="checkbox" data-keys="${esc(runnable(g.tests).join('\n'))}" ${check(runnable(g.tests))} title="Tick every test in this describe">
                  <span>${esc(plain(g.describe))}</span>
                </div>
                ${g.tests.map(testRow).join('')}
              </div>`,
                    )
                    .join('')
            }
          </div>`
        })
        .join('') || '<p class="muted">No test matches.</p>'
    }
  </div>`
}

function testRow(t) {
  const last = t.last
  const status = last ? (last.flaky ? 'flaky' : last.status) : 'never'
  const tag = leftOutBy(t, leftOutTags())
  const leftOut = !!tag
  return `<label class="test-pick ${leftOut ? 'left-out' : ''}" ${leftOut ? `title="${esc(`Tagged ${tag}: a run on this device leaves it out, ticked or not`)}"` : ''}>
    <input type="checkbox" data-keys="${esc(t.key)}" ${leftOut ? 'disabled' : view.selected.has(t.key) ? 'checked' : ''}>
    ${icon(status)}
    <span class="pick-title" title="${esc(last ? `Newest result: run ${last.run}` : 'Never run')}">${esc(plain(t.title))}${last?.reviewed ? '<span class="tag" title="Its last failure was marked as looked at">reviewed</span>' : ''}
      ${last?.status === 'failed' && last.error ? `<span class="pick-error" title="${esc(last.error)}">${esc(last.error)}</span>` : ''}
    </span>
    <span class="pick-tags">${t.tags.map(tagChip).join('')}</span>
    ${strip(t.recent, duration)}
    <span class="time ${last ? '' : 'est'}" title="${esc(last ? 'How long it took in its newest run' : '~: an estimate from past runs (the median of all tests when it never ran), not a measured time')}">${last ? duration(last.seconds) : `~${duration(t.estimate)}`}</span>
  </label>`
}

// --- events ------------------------------------------------------------------------------

function bind() {
  const main = view.ctx.main
  const rerender = () => render()

  main.querySelector('#refresh-devices')?.addEventListener('click', async e => {
    e.target.disabled = true
    e.target.textContent = 'Reading…'
    try {
      takeDevices(await api('devices?fresh=1'))
    } catch (err) {
      alert(`Could not read the devices: ${err.message}`)
    }
    rerender()
  })
  for (const b of main.querySelectorAll('[data-start]')) {
    b.addEventListener('click', async () => {
      const id = b.dataset.start
      try {
        await post('devices/start', { id, platform: b.dataset.platform })
      } catch (err) {
        alert(`It did not start: ${err.message}`)
        return
      }
      view.booting.set(id, Date.now())
      rerender()
      watchBoot()
    })
  }
  for (const card of main.querySelectorAll('[data-device]')) {
    card.addEventListener('click', () => {
      view.device = card.dataset.device
      save(DEVICE, view.device)
      rerender()
    })
  }
  for (const b of main.querySelectorAll('[data-mode]')) {
    b.addEventListener('click', () => {
      view.mode = b.dataset.mode
      save(MODE, view.mode)
      rerender()
    })
  }
  for (const chip of main.querySelectorAll('[data-preset-tag]')) {
    chip.addEventListener('click', () => {
      const tag = chip.dataset.presetTag
      view.presetTags.has(tag)
        ? view.presetTags.delete(tag)
        : view.presetTags.add(tag)
      save(TAGS, [...view.presetTags])
      rerender()
    })
  }
  // One spec file: type to narrow the list, click a row to pick it
  const specQ = main.querySelector('#spec-q')
  specQ?.addEventListener('input', () => {
    view.specQuery = specQ.value
    const at = specQ.selectionStart
    rerender()
    const again = main.querySelector('#spec-q')
    again.focus()
    again.setSelectionRange(at, at)
  })
  for (const option of main.querySelectorAll('[data-spec]')) {
    option.addEventListener('click', () => {
      view.spec = option.dataset.spec
      save(SPEC, view.spec)
      rerender()
    })
  }

  const q = main.querySelector('#q')
  q?.addEventListener('input', () => {
    view.query = q.value
    const at = q.selectionStart
    rerender()
    const again = main.querySelector('#q')
    again.focus()
    again.setSelectionRange(at, at)
  })
  for (const chip of main.querySelectorAll('[data-tag]')) {
    chip.addEventListener('click', () => {
      const tag = chip.dataset.tag
      view.tags.has(tag) ? view.tags.delete(tag) : view.tags.add(tag)
      rerender()
    })
  }
  main.querySelector('#only-failed')?.addEventListener('click', () => {
    view.onlyFailed = !view.onlyFailed
    rerender()
  })
  main.querySelector('#pick-failed')?.addEventListener('click', () => {
    const tags = leftOutTags()
    for (const t of view.data.tests)
      if (t.last?.status === 'failed' && !leftOutBy(t, tags))
        view.selected.add(t.key)
    save(SELECTED, [...view.selected])
    rerender()
  })
  main.querySelector('#clear')?.addEventListener('click', () => {
    view.selected.clear()
    save(SELECTED, [])
    rerender()
  })
  for (const fold of main.querySelectorAll('[data-fold]')) {
    fold.addEventListener('click', event => {
      event.preventDefault()
      const spec = fold.dataset.fold
      view.closed.has(spec) ? view.closed.delete(spec) : view.closed.add(spec)
      rerender()
    })
  }
  for (const box of main.querySelectorAll('input[data-keys]')) {
    box.addEventListener('change', () => {
      const keys = box.dataset.keys.split('\n')
      for (const key of keys)
        box.checked ? view.selected.add(key) : view.selected.delete(key)
      save(SELECTED, [...view.selected])
      rerender()
    })
  }
  main.querySelector('#run')?.addEventListener('click', start)
  for (const button of main.querySelectorAll(
    '[data-q-remove], [data-q-retry]',
  )) {
    button.addEventListener('click', async () => {
      const remove = button.dataset.qRemove
      const id = remove ?? button.dataset.qRetry
      button.disabled = true
      try {
        view.queue =
          (await post(`queue/${id}/${remove ? 'remove' : 'retry'}`)).items ?? []
        view.queueKey = JSON.stringify(view.queue)
      } catch (e) {
        alert(`The queue did not change: ${e.message}`)
      }
      view.ctx.refreshSoon()
      render()
    })
  }
}

async function start() {
  // in the specs' own order, which is the order a run takes them in
  const keys = chosen().map(t => t.key)
  view.starting = true
  render()
  const picked = chosen()
  const live = !!view.ctx.shell.current?.live || !!view.liveRun
  try {
    // while a run goes on, the server keeps this one in its queue
    const body = await post('runs', {
      keys,
      device: view.device,
      queue: live,
      label: describeChoice(picked),
    })
    view.starting = false
    if (body.run) {
      view.loadedAt = 0 // its results change the history
      location.hash = 'live'
      return
    }
    view.justQueued = body.queued
    await readQueue()
    view.ctx.refreshSoon()
    render()
  } catch (e) {
    alert(`The run did not start: ${e.message}`)
    view.starting = false
    render()
  }
}
