// The few React and React Native APIs the in-app switches use, typed here so
// the package builds without installing React Native. The app's own copies
// are what run.

declare module 'react' {
  export function useSyncExternalStore<T>(
    subscribe: (onChange: () => void) => () => void,
    getSnapshot: () => T,
  ): T
}

declare module 'react-native' {
  export const DevSettings: { reload(reason?: string): void }
  export const Keyboard: { dismiss(): void }
  export const LogBox: { ignoreAllLogs(value?: boolean): void }
  export const Linking: {
    getInitialURL(): Promise<string | null>
    addEventListener(
      type: 'url',
      handler: (event: { url: string }) => void,
    ): { remove(): void }
  }
}
