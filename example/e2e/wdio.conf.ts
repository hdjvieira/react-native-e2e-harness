import { createWdioConfig } from 'react-native-e2e-harness'
import harness from './e2e.config.ts'

export const config = createWdioConfig(harness)
