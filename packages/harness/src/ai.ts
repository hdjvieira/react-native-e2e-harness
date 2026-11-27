import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { PACKAGE_DIR } from './config.js'

// The e2e runbook for AI coding assistants, from one source (ai/e2e.md in
// this package) into the place each tool reads it:
//
//   claude    .claude/skills/e2e/SKILL.md   a Claude Code skill (or the plugin)
//   agents    AGENTS.md                     Codex, Cursor, Copilot's agent, Gemini CLI…
//   cursor    .cursor/rules/e2e.mdc         Cursor's rules
//   copilot   .github/instructions/e2e.instructions.md   GitHub Copilot
//
// Writing again replaces what an earlier write put there, nothing else: in
// AGENTS.md, a marked section; elsewhere, a file of its own.

export const TOOLS = ['claude', 'agents', 'cursor', 'copilot'] as const
export type Tool = (typeof TOOLS)[number]

const source = (name: string) =>
  readFileSync(join(PACKAGE_DIR, 'ai', name), 'utf8').trim()

/** the runbook and when to use it */
export const runbook = () => ({
  body: source('e2e.md'),
  description: source('e2e.description.txt'),
})

const START =
  '<!-- react-native-e2e-harness:start (written by `e2e-harness ai`) -->'
const END = '<!-- react-native-e2e-harness:end -->'

/** where a tool's copy goes, relative to the app's root */
export const target: Record<Tool, string> = {
  claude: '.claude/skills/e2e/SKILL.md',
  agents: 'AGENTS.md',
  cursor: '.cursor/rules/e2e.mdc',
  copilot: '.github/instructions/e2e.instructions.md',
}

/** the text a tool's file holds (for AGENTS.md: the section) */
export function render(tool: Tool, e2eFolder = 'e2e') {
  const { body, description } = runbook()
  switch (tool) {
    case 'claude':
      return `---\nname: e2e\ndescription: ${description}\n---\n\n${body}\n`
    case 'cursor':
      return `---\ndescription: ${description}\nalwaysApply: false\n---\n\n${body}\n`
    case 'copilot':
      return `---\napplyTo: '${e2eFolder}/**'\n---\n\n${body}\n`
    case 'agents':
      return `${START}\n\n## End-to-end tests\n\n${description}\n\n${body.replace(/^# .*\n+/, '').replace(/^(#+) /gm, '$1# ')}\n\n${END}\n`
  }
}

/** writes a tool's copy into the app; returns the path written */
export function writeFor(tool: Tool, appDir: string, e2eFolder?: string) {
  const path = join(appDir, target[tool])
  const text = render(tool, e2eFolder)
  mkdirSync(dirname(path), { recursive: true })
  if (tool === 'agents' && existsSync(path)) {
    const current = readFileSync(path, 'utf8')
    const from = current.indexOf(START)
    const to = current.indexOf(END)
    const next =
      from >= 0 && to > from
        ? current.slice(0, from) +
          text.trimEnd() +
          current.slice(to + END.length)
        : `${current.trimEnd()}\n\n${text}`
    writeFileSync(path, next.endsWith('\n') ? next : `${next}\n`)
  } else {
    writeFileSync(path, text)
  }
  return relative(appDir, path).replace(/\\/g, '/')
}
