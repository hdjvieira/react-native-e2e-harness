import AsyncStorage from '@react-native-async-storage/async-storage'
import { useEffect, useState } from 'react'
import {
  Button,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { e2e } from './e2e-switches'

// A small app with what an e2e harness has to get through: an onboarding
// screen on first launch, a home screen with state, a second screen, a text
// field, and a debug readout turned on from a test.

const ONBOARDED = 'onboarded'

export default function App() {
  const [onboarded, setOnboarded] = useState<boolean>()
  const [screen, setScreen] = useState<'home' | 'details'>('home')
  const [count, setCount] = useState(0)
  const [name, setName] = useState('')
  const showStats = e2e?.useFlag('showStats') ?? false

  useEffect(() => {
    AsyncStorage.getItem(ONBOARDED).then(value => setOnboarded(value === '1'))
  }, [])

  if (onboarded === undefined) return <View testID="app-root" />

  return (
    <SafeAreaView testID="app-root" style={styles.root}>
      {!onboarded ? (
        <View testID="onboarding-screen" style={styles.screen}>
          <Text style={styles.title}>Welcome</Text>
          <Button
            testID="onboarding-continue-button"
            title="Continue"
            onPress={() => {
              AsyncStorage.setItem(ONBOARDED, '1')
              setOnboarded(true)
            }}
          />
        </View>
      ) : screen === 'home' ? (
        <View testID="home-screen" style={styles.screen}>
          <Text style={styles.title}>Home</Text>
          <Text testID="counter-value" style={styles.value}>
            {count}
          </Text>
          <Button
            testID="counter-button"
            title="Add one"
            onPress={() => setCount(c => c + 1)}
          />
          <TextInput
            testID="name-input"
            style={styles.input}
            placeholder="Your name"
            value={name}
            onChangeText={setName}
          />
          <Text testID="greeting">{name ? `Hello, ${name}` : ''}</Text>
          <Button
            testID="open-details-button"
            title="Details"
            onPress={() => setScreen('details')}
          />
          {showStats && <Text testID="stats-readout">{`count=${count}`}</Text>}
        </View>
      ) : (
        <View testID="details-screen" style={styles.screen}>
          <Text style={styles.title}>Details</Text>
          <Button
            testID="back-button"
            title="Back"
            onPress={() => setScreen('home')}
          />
        </View>
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  screen: { flex: 1, padding: 24, gap: 16, justifyContent: 'center' },
  title: { fontSize: 28, fontWeight: '600' },
  value: { fontSize: 40 },
  input: { borderWidth: 1, borderColor: '#888', padding: 8 },
})
