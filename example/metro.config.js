const path = require('path')
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')

// The harness is a workspace next door: Metro watches it, and resolves what
// its in-app module imports (react, react-native) from this app's own
// node_modules.
const harness = path.resolve(__dirname, '../packages/harness')

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  watchFolders: [harness],
  resolver: {
    nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
  },
})
