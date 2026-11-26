import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { config } from './config.js'

// Settings and secrets for a run live in the app's `.env.e2e` (git-ignored),
// loaded by defineConfig. The committed `.env.e2e.example` lists every key
// and is the manual: what each one is for, whether it is required, and where
// to get it. A comment line `# [required]` or `# [optional]` applies to the
// keys below it; keys start out optional.

export type EnvKey = { key: string; required: boolean }

/** the keys the example file declares, and whether each is required */
export function declaredKeys(): EnvKey[] {
  const { example } = config().env
  if (!existsSync(example)) return []
  const keys: EnvKey[] = []
  let required = false
  for (const line of readFileSync(example, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('#')) {
      if (/^#\s*\[required\]/i.test(line)) required = true
      else if (/^#\s*\[optional\]/i.test(line)) required = false
      continue
    }
    const match = /^([A-Z0-9_]+)=/.exec(line)
    if (match) keys.push({ key: match[1], required })
  }
  return keys
}

/** declared keys that are missing or empty, for the preflight */
export function missingKeys() {
  const missing = declaredKeys().filter(({ key }) => !process.env[key])
  return {
    required: missing.filter(k => k.required).map(k => k.key),
    optional: missing.filter(k => !k.required).map(k => k.key),
  }
}

/** a setting that must be there: throws, naming the file, when it isn't */
export function envValue(key: string) {
  const value = process.env[key]
  if (!value) {
    throw new Error(`${key} is not set in ${basename(config().env.file)}`)
  }
  return value
}

/** a setting that may be missing */
export const optionalEnv = (key: string) => process.env[key] || undefined
