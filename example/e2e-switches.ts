import AsyncStorage from '@react-native-async-storage/async-storage'

// The dev-only link the harness talks to: e2eexample://e2e?...
// Debug builds only: a release build never loads the harness.
export const e2e = __DEV__
  ? (
      require('react-native-e2e-harness/in-app') as typeof import('react-native-e2e-harness/in-app')
    ).createE2ESwitches({
      url: 'e2eexample://e2e',
      storage: AsyncStorage,
      flags: { showStats: { default: false, keepOnReload: true } },
    })
  : undefined
