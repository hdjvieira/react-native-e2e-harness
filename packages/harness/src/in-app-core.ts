// The part of the in-app switches that needs no React Native: reading a
// switch link. Kept apart so it can be tested on Node.

export type FlagValue = boolean | string

export type FlagSpec = {
  /** the value until a link sets it; its type is the flag's type */
  default: FlagValue
  /** keep what a link set across a `reload` (otherwise back to the default) */
  keepOnReload?: boolean
}

export type ParsedLink = {
  /** `logbox=off` */
  logboxOff: boolean
  /** `keyboard=dismiss` */
  dismissKeyboard: boolean
  /** `reload=<id>`: once-only id */
  reload?: string
  /** flags the link sets */
  flags: Record<string, FlagValue>
  /** the app's own actions it asks for, with their values, in link order */
  actions: [name: string, value: string][]
}

/** the link's query as pairs; React Native's URLSearchParams can't be trusted */
export function queryPairs(link: string): [string, string][] {
  const query = link.split('#')[0].split('?')[1] ?? ''
  return query
    .split('&')
    .filter(Boolean)
    .map(pair => {
      const at = pair.indexOf('=')
      const decode = (s: string) => {
        try {
          return decodeURIComponent(s.replace(/\+/g, ' '))
        } catch {
          return s
        }
      }
      return at < 0
        ? [decode(pair), '']
        : [decode(pair.slice(0, at)), decode(pair.slice(at + 1))]
    })
}

/** whether `link` is the switch link `base` (`myapp://e2e`), with or without a query */
export function isSwitchLink(link: string | null | undefined, base: string) {
  if (!link?.startsWith(base)) return false
  const next = link.charAt(base.length)
  return next === '' || next === '?' || next === '/' || next === '#'
}

const ON = new Set(['on', 'true', '1', 'yes'])
const OFF = new Set(['off', 'false', '0', 'no'])

/**
 * What a switch link asks for. A boolean flag takes on/off (true/false,
 * 1/0); a string flag takes any value, `off` clearing it. Unknown names and
 * values a flag can't take are ignored.
 */
export function parseLink(
  link: string,
  flagSpecs: Record<string, FlagSpec>,
  actionNames: string[],
): ParsedLink {
  const parsed: ParsedLink = {
    logboxOff: false,
    dismissKeyboard: false,
    flags: {},
    actions: [],
  }
  for (const [name, value] of queryPairs(link)) {
    if (name === 'logbox') parsed.logboxOff = OFF.has(value)
    else if (name === 'keyboard') parsed.dismissKeyboard = value === 'dismiss'
    else if (name === 'reload') parsed.reload = value || undefined
    else if (name in flagSpecs) {
      const kind = typeof flagSpecs[name].default
      if (kind === 'boolean') {
        if (ON.has(value)) parsed.flags[name] = true
        else if (OFF.has(value)) parsed.flags[name] = false
      } else {
        parsed.flags[name] = value === 'off' ? '' : value
      }
    } else if (actionNames.includes(name)) parsed.actions.push([name, value])
  }
  return parsed
}
