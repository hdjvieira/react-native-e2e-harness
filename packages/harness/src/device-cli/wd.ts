import { writeFileSync } from 'node:fs'
import { config } from '../config.js'

// A minimal W3C WebDriver client for Appium: one command at a time from a
// CLI, where WebdriverIO's start-up would cost more than the command.

const base = () =>
  process.env.APPIUM_URL ?? `http://127.0.0.1:${config().appium.port}`

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf'
type ElementRef = { [ELEMENT]?: string; ELEMENT?: string }
export const elementId = (v: ElementRef) => (v[ELEMENT] ?? v.ELEMENT)!

export async function isAppiumUp(ms = 1500) {
  try {
    const r = await fetch(`${base()}/status`, {
      signal: AbortSignal.timeout(ms),
    })
    return r.ok
  } catch {
    return false
  }
}

export async function call<T = any>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(base() + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as {
    value?: { error?: string; message?: string }
  }
  if (!res.ok || json?.value?.error) {
    const message = (json?.value?.message ?? '').slice(0, 600)
    throw new Error(
      `${method} ${path} -> ${res.status} ${json?.value?.error ?? ''}: ${message}`.trim(),
    )
  }
  return json.value as T
}

export async function newSession(capabilities: Record<string, unknown>) {
  const v = await call<{ sessionId: string }>('POST', '/session', {
    capabilities: { alwaysMatch: capabilities, firstMatch: [{}] },
  })
  return v.sessionId
}

const touch = (
  id: string,
  x: number,
  y: number,
  steps: Record<string, unknown>[],
) => ({
  type: 'pointer',
  id,
  parameters: { pointerType: 'touch' },
  actions: [
    { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) },
    ...steps,
  ],
})

export const press = [
  { type: 'pointerDown', button: 0 },
  { type: 'pause', duration: 60 },
  { type: 'pointerUp', button: 0 },
]

export class Session {
  readonly p: string
  constructor(readonly id: string) {
    this.p = `/session/${id}`
  }
  quit() {
    return call('DELETE', this.p)
  }
  source() {
    return call<string>('GET', `${this.p}/source`)
  }
  async screenshot(file?: string) {
    const buf = Buffer.from(
      await call<string>('GET', `${this.p}/screenshot`),
      'base64',
    )
    if (file) writeFileSync(file, buf)
    return buf
  }
  /** Android: by resource-id; iOS: by accessibility id */
  async find(testID: string, ios = false) {
    return elementId(
      await call('POST', `${this.p}/element`, {
        using: ios ? 'accessibility id' : 'xpath',
        value: ios ? testID : `//*[@resource-id="${testID}"]`,
      }),
    )
  }
  async findAll(testID: string, ios = false) {
    const all = await call<ElementRef[]>('POST', `${this.p}/elements`, {
      using: ios ? 'accessibility id' : 'xpath',
      value: ios ? testID : `//*[@resource-id="${testID}"]`,
    })
    return all.map(elementId)
  }
  async click(testID: string, ios = false) {
    await call(
      'POST',
      `${this.p}/element/${await this.find(testID, ios)}/click`,
      {},
    )
  }
  async text(testID: string, ios = false) {
    return call<string>(
      'GET',
      `${this.p}/element/${await this.find(testID, ios)}/text`,
    )
  }
  async rect(testID: string, ios = false) {
    return call<{ x: number; y: number; width: number; height: number }>(
      'GET',
      `${this.p}/element/${await this.find(testID, ios)}/rect`,
    )
  }
  async type(testID: string, text: string) {
    const el = await this.find(testID)
    await call('POST', `${this.p}/element/${el}/click`, {})
    await call('POST', `${this.p}/element/${el}/value`, { text })
  }
  hideKeyboard() {
    return call('POST', `${this.p}/appium/device/hide_keyboard`, {}).catch(
      () => {},
    )
  }
  back() {
    return call('POST', `${this.p}/back`, {})
  }
  windowRect() {
    return call<{ width: number; height: number }>(
      'GET',
      `${this.p}/window/rect`,
    )
  }
  actions(actions: unknown[]) {
    return call('POST', `${this.p}/actions`, { actions })
  }
  tap(x: number, y: number) {
    return this.actions([touch('finger1', x, y, press)])
  }
  doubleTap(x: number, y: number) {
    return this.actions([
      touch('finger1', x, y, [
        ...press,
        { type: 'pause', duration: 90 },
        ...press,
      ]),
    ])
  }
  twoFingerTap(x: number, y: number) {
    return this.actions([
      touch('finger1', x - 40, y, press),
      touch('finger2', x + 40, y, press),
    ])
  }
  drag(x: number, y: number, toX: number, toY: number) {
    return this.actions([
      touch('finger1', x, y, [
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 100 },
        {
          type: 'pointerMove',
          duration: 600,
          x: Math.round(toX),
          y: Math.round(toY),
        },
        { type: 'pause', duration: 300 },
        { type: 'pointerUp', button: 0 },
      ]),
    ])
  }
  execute(script: string, args: unknown[] = []) {
    return call('POST', `${this.p}/execute/sync`, { script, args })
  }
}
