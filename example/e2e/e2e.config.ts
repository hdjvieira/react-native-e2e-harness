import { defineConfig } from 'react-native-e2e-harness'

// The harness's own example: what an app's e2e config looks like
export default defineConfig({
  dir: import.meta.dirname,
  android: { package: 'com.e2eexample' },
  ios: { bundleId: 'org.reactjs.native.example.E2EExample' },
  home: {
    ready: 'home-screen',
    // first launch: the onboarding screen, tapped through
    through: ['onboarding-continue-button'],
  },
  devLink: { url: 'e2eexample://e2e' },
  dashboard: { title: 'Example' },
})
