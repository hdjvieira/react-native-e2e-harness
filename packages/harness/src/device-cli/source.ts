// Reading a UiAutomator2 page source (Android's UI tree as XML) without a
// client library, and the two things in it that get in the way of every
// command: React Native's dev overlays and Android's permission dialogs.

export type Bounds = { x: number; y: number; w: number; h: number }

export type UiNode = {
  cls: string
  /** the resource-id; the app's own lose their `<package>:id/` prefix */
  testID: string
  text: string
  desc: string
  clickable: boolean
  bounds: Bounds | null
}

/** anything that can read the tree and tap: an Appium session or adb */
export type Driver = {
  source(): Promise<string>
  tap(x: number, y: number): Promise<unknown>
  click(testID: string): Promise<unknown>
}

// A value holding a double quote is written single-quoted
// (text='Make sure "Metro" runs'), so both quote styles must parse: matching
// only "..." shifts every attribute after it, the resource-id included, and
// the node silently drops out of every lookup.
function parseAttrs(raw: string) {
  const attrs: Record<string, string> = {}
  for (const a of raw.matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[a[1]] = (a[2] ?? a[3])
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
      .replace(/&amp;/g, '&')
  }
  return attrs
}

/**
 * Every element in the dump, with or without a resource-id (React Native's
 * LogBox toasts have none, and must be found before a tap lands in one).
 * `appPackage` is stripped from the app's own ids.
 */
export function parseAllNodes(xml: string, appPackage?: string): UiNode[] {
  const prefix = appPackage ? `${appPackage}:id/` : undefined
  const nodes: UiNode[] = []
  for (const m of xml.matchAll(/<([\w.$]+)\b([^>]*?)\/?>/g)) {
    const attrs = parseAttrs(m[2])
    const b = attrs.bounds?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    const id = attrs['resource-id'] || ''
    nodes.push({
      cls: m[1],
      testID: prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id,
      text: attrs.text || '',
      desc: attrs['content-desc'] || '',
      clickable: attrs.clickable === 'true',
      bounds: b
        ? { x: +b[1], y: +b[2], w: +b[3] - +b[1], h: +b[4] - +b[2] }
        : null,
    })
  }
  return nodes
}

/** the elements that have a resource-id */
export const parseSource = (xml: string, appPackage?: string) =>
  parseAllNodes(xml, appPackage).filter(n => n.testID)

/** whether `inner` lies inside `outer`, give or take `slack` pixels */
export const within = (inner: Bounds | null, outer: Bounds, slack = 0) =>
  !!inner &&
  inner.x >= outer.x &&
  inner.y >= outer.y - slack &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h + slack

// React Native dev builds drop LogBox notifications ("2 Warnings", "Possible
// Unhandled Promise Rejection"...) over the bottom of the screen. They have
// no testID and a tap meant for the app lands inside one. The open LogBox
// inspector ("Log 3 of 15") counts too: it covers the whole screen.
const LOGBOX_TEXT =
  /^(\s*\d+\s+(warning|error)s?\s*|warning:.*|error:.*|possible unhandled promise rejection.*|log \d+ of \d+)$/i
// Newer toasts show the count and the message as separate texts, which no
// text pattern can tell from app copy; the container's label joins them as
// "12, ...". App elements can read the same way (a button with a counter
// badge, "1, Following"), but a toast has no testID, so a node with one is
// the app's.
const LOGBOX_TOAST_DESC = /^\d+, \S/

export function findDevOverlays(all: UiNode[]) {
  const boxes = all.filter(
    n =>
      n.bounds &&
      n.bounds.h > 0 &&
      (LOGBOX_TEXT.test(n.text.trim()) ||
        (!n.testID && LOGBOX_TOAST_DESC.test(n.desc))),
  )
  const dismissers = all.filter(
    n => n.bounds && n.bounds.h > 0 && /^(dismiss|close)$/i.test(n.desc.trim()),
  )
  return { boxes, dismissers }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** dismisses every dev overlay, or throws rather than guess a tap */
export async function dismissDevOverlays(s: Driver, appPackage?: string) {
  let tapped = false
  let confirmed = false
  for (let round = 0; round < 16; round++) {
    const all = parseAllNodes(await s.source(), appPackage)
    const { boxes, dismissers } = findDevOverlays(all)
    if (!boxes.length) {
      // a tapped toast opens the inspector only after a beat: after any tap,
      // confirm the screen stays clear
      if (!tapped || confirmed) return
      confirmed = true
      await sleep(1500)
      continue
    }
    tapped = true
    confirmed = false
    const label = boxes
      .map(b => JSON.stringify((b.text || b.desc).trim().slice(0, 40)))
      .join(', ')
    console.log(`  dev overlay detected (${label}) - dismissing`)
    // prefer an explicit dismiss control (the open inspector has one). A
    // toast's own dismiss button is an unlabelled clickable child at its
    // right end; a tap anywhere else on the toast opens the inspector
    const box = boxes[0].bounds!
    const toastX = all
      .filter(
        n => n.clickable && within(n.bounds, box, 5) && n.bounds!.w < box.w / 3,
      )
      .sort((a, b) => b.bounds!.x - a.bounds!.x)[0]
    const target = (dismissers[0] ?? toastX ?? boxes[0]).bounds!
    const x = target === box ? box.x + box.w - 40 : target.x + target.w / 2
    await s.tap(x, target.y + Math.floor(target.h / 2))
    await sleep(1200)
  }
  const left = findDevOverlays(
    parseAllNodes(await s.source(), appPackage),
  ).boxes
  if (left.length) {
    throw new Error(
      `a React Native dev overlay is covering the screen and would not dismiss: ${left.map(b => (b.text || b.desc).trim().slice(0, 60)).join(' | ')}`,
    )
  }
}

// Android runtime-permission dialogs are a system window of their own (ids
// carry the permissioncontroller package)
export const PERMISSION_ALLOW =
  /permissioncontroller:id\/permission_allow(_foreground_only)?_button$/

/** accepts every permission dialog showing, a few deep (one can chain into the next) */
export async function acceptPermissionDialogs(s: Driver, rounds = 4) {
  let accepted = 0
  for (let i = 0; i < rounds; i++) {
    const allow = parseSource(await s.source()).find(n =>
      PERMISSION_ALLOW.test(n.testID),
    )
    if (!allow) break
    await s.click(allow.testID).catch(() => {})
    accepted++
    await sleep(1500)
  }
  return accepted
}
