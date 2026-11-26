import { useSyncExternalStore } from 'react'
import { DevSettings, Keyboard, Linking, LogBox } from 'react-native'
import {
  type FlagSpec,
  type FlagValue,
  isSwitchLink,
  parseLink,
} from './in-app-core.js'

// The app's side of the harness, for debug builds only: switches a test sends
// as a deep link (`myapp://e2e?logbox=off&reload=123`).
//
//   // in the app, at start-up
//   if (__DEV__) {
//     const { createE2ESwitches } = require('react-native-e2e-harness/in-app')
//     createE2ESwitches({ url: 'myapp://e2e', storage: AsyncStorage })
//   }
//
// Built in:
// - `reload=<id>`: reloads the JS, the fast way back to a fresh app between
//   tests (a cold start costs several times as long). The id makes each
//   request once-only: after the reload, the link the app was opened with can
//   come back as the initial URL, and must not reload it again. Needs
//   `storage`.
// - `logbox=off`: LogBox toasts sit over the bottom of the screen, outside the
//   view tree a test can read, yet take the taps meant for what is under them.
//   Off until the app is killed: a reload keeps it off.
// - `keyboard=dismiss`: closes the keyboard, which a test on an iPhone has no
//   other reliable way to do.
//
// The app's own:
// - `flags`: values the app reads where they apply (a readout to show, a view
//   to keep out of the accessibility tree), set by `<name>=on|off|<value>`.
// - `actions`: things to do once the app is up (move the map, open a screen
//   at a given state), called with the parameter's value.

/** where the switches keep what must survive a reload, e.g. AsyncStorage */
export type E2EStorage = {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

type Widen<V> = V extends boolean ? boolean : string
export type FlagValues<F extends Record<string, FlagSpec>> = {
  [K in keyof F]: Widen<F[K]['default']>
}

export type E2ESwitchesOptions<F extends Record<string, FlagSpec>> = {
  /** the link the switches answer, e.g. `myapp://e2e` */
  url: string
  /** needed for `reload` and for anything kept across one */
  storage?: E2EStorage
  flags?: F
  actions?: Record<
    string,
    (value: string, link: string) => void | Promise<void>
  >
}

const LAST_RELOAD_KEY = 'e2e-harness.lastReload'
const RELOADING_KEY = 'e2e-harness.reloading'
/** how long a reload's settings wait for the app to start over */
const RELOAD_WINDOW = 30000

type Global = { __e2eHarnessSwitches?: { remove(): void } }

export function createE2ESwitches<F extends Record<string, FlagSpec>>(
  options: E2ESwitchesOptions<F>,
) {
  const specs = (options.flags ?? {}) as F
  const actions = options.actions ?? {}
  const flags = Object.fromEntries(
    Object.entries(specs).map(([name, spec]) => [name, spec.default]),
  ) as FlagValues<F>
  const listeners = new Set<() => void>()

  function set<K extends keyof F>(name: K, value: FlagValues<F>[K]) {
    if (flags[name] === value) return
    flags[name] = value
    listeners.forEach(listener => listener())
  }

  /** called whenever a flag changes; returns the unsubscribe */
  function onChange(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  /** a flag's value in a component, re-rendering when a link changes it */
  function useFlag<K extends keyof F>(name: K): FlagValues<F>[K] {
    return useSyncExternalStore(onChange, () => flags[name])
  }

  function setAll(values: Record<string, FlagValue>) {
    for (const [name, value] of Object.entries(values)) {
      if (name in specs) set(name as keyof F, value as FlagValues<F>[keyof F])
    }
  }

  async function apply(link: string | null) {
    if (!isSwitchLink(link, options.url)) return
    const parsed = parseLink(link!, specs, Object.keys(actions))
    if (parsed.logboxOff) LogBox.ignoreAllLogs()
    setAll(parsed.flags)
    if (parsed.dismissKeyboard) Keyboard.dismiss()
    for (const [name, value] of parsed.actions) {
      try {
        await actions[name](value, link!)
      } catch (e) {
        console.warn(`e2e switch ${name}: ${(e as Error).message}`)
      }
    }

    if (!parsed.reload) return
    const { storage } = options
    if (!storage) {
      console.warn('e2e switches: reload needs `storage` (e.g. AsyncStorage)')
      return
    }
    if (parsed.reload === (await storage.getItem(LAST_RELOAD_KEY))) return
    await storage.setItem(LAST_RELOAD_KEY, parsed.reload)
    // handed to the app as it starts over, for this reload only: a developer
    // opening the app normally later still sees LogBox
    const kept = Object.fromEntries(
      Object.entries(flags).filter(([name]) => specs[name].keepOnReload),
    )
    await storage.setItem(
      RELOADING_KEY,
      JSON.stringify({
        at: Date.now(),
        logboxOff: parsed.logboxOff,
        flags: kept,
      }),
    )
    DevSettings.reload('e2e')
  }

  // started over by a reload: keep what the links asked for
  options.storage?.getItem(RELOADING_KEY).then(value => {
    if (!value) return
    options.storage!.removeItem(RELOADING_KEY)
    const {
      at,
      logboxOff,
      flags: kept,
    } = JSON.parse(value) as {
      at: number
      logboxOff: boolean
      flags: Record<string, FlagValue>
    }
    if (Date.now() - at >= RELOAD_WINDOW) return
    if (logboxOff) LogBox.ignoreAllLogs()
    setAll(kept)
  })

  // a Fast Refresh that runs this again must not answer every link twice
  const global = globalThis as Global
  global.__e2eHarnessSwitches?.remove()
  global.__e2eHarnessSwitches = Linking.addEventListener('url', ({ url }) => {
    apply(url)
  })
  Linking.getInitialURL().then(apply)

  return { flags, set, onChange, useFlag }
}

export type { FlagSpec, FlagValue }
