import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, it } from 'node:test'
import { render, writeFor } from './ai.js'

const app = mkdtempSync(join(tmpdir(), 'harness-ai-'))
after(() => rmSync(app, { recursive: true, force: true }))

it("keeps the Claude Code plugin's skill in step with the one source", () => {
  const plugin = readFileSync(
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
    'utf8',
  ).replace(/\r\n/g, '\n')
  assert.equal(
    plugin,
    render('claude'),
    'plugin/skills/e2e/SKILL.md is out of date: yarn workspace react-native-e2e-harness sync-skill',
  )
})

it('writes its own section of AGENTS.md, again and again, and nothing else', () => {
  const path = join(app, 'AGENTS.md')
  writeFileSync(path, '# My app\n\nOur own rules.\n')
  writeFor('agents', app)
  writeFor('agents', app)
  const text = readFileSync(path, 'utf8')
  assert.ok(text.startsWith('# My app\n\nOur own rules.\n'))
  assert.equal(text.match(/react-native-e2e-harness:start/g)?.length, 1)
  assert.match(text, /## End-to-end tests/)
})

it('gives each tool its file', () => {
  assert.equal(writeFor('cursor', app), '.cursor/rules/e2e.mdc')
  assert.equal(
    writeFor('copilot', app, '__e2eTests__'),
    '.github/instructions/e2e.instructions.md',
  )
  assert.match(
    readFileSync(join(app, '.github/instructions/e2e.instructions.md'), 'utf8'),
    /^---\napplyTo: '__e2eTests__\/\*\*'/,
  )
})
