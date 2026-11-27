/// <reference types="mocha" preserve="true" />
/// <reference types="@wdio/globals/types" preserve="true" />
// react-native-e2e-harness: the config and the helpers a spec uses.
// Host-side device plumbing is in `react-native-e2e-harness/device`.

export {
  appId,
  config,
  defineConfig,
  loadConfig,
  platform,
  type AppInfo,
  type HarnessConfig,
  type Platform,
  type PreflightContext,
  type ResolvedConfig,
} from './config.js'
export { createWdioConfig } from './wdio.js'
export { chain, type Start } from './chain.js'
export { needsPerson } from './needs-person.js'
export { registerCleanup } from './cleanup.js'
export { measure, record as recordTiming } from './timing.js'
export { envValue, optionalEnv } from './env.js'
export { tagsIn, type PlannedTest } from './plan.js'
export * from './ui.js'
export {
  freshInstall,
  markFresh,
  restartApp,
  tapFirstMatching,
} from './restart.js'

// WebdriverIO's own, so a spec imports from this package alone (a strict
// node_modules, pnpm's, keeps the app from reaching the harness's dependencies)
export { $, $$, browser, driver, expect } from '@wdio/globals'
