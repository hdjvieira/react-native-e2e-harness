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
