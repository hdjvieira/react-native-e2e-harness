import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { render } from './ai.js'

// For this repo: writes the Claude Code plugin's skill from ai/e2e.md
// (yarn workspace react-native-e2e-harness sync-skill)
writeFileSync(
  join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    'plugin',
    'skills',
    'e2e',
    'SKILL.md',
  ),
  render('claude'),
)
console.log('plugin/skills/e2e/SKILL.md written')
