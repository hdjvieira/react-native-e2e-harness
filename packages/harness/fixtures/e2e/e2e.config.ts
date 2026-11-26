import { defineConfig } from '../../src/index.js'

export default defineConfig({
  dir: import.meta.dirname,
  android: { package: 'com.example.fixture' },
  ios: { bundleId: 'com.example.fixture' },
  exclude: ['specs/api/**'],
})
