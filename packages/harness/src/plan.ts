import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { config, type Platform } from './config.js'

// Which tests exist and which a run will run: Mocha's own dry run over the
// specs (it registers every describe and it, including those built in loops,
// and runs no hook or test). About half a second per spec file.

export type PlannedTest = {
  /** as the run records it: `<describe> > <test>` */
  key: string
  /** the spec file, relative to the e2e folder, with forward slashes */
  spec: string
  describe: string
  title: string
  /** #-words in the describe and test titles */
  tags: string[]
}

type DryRun = {
  tests: { title: string; fullTitle: string; file: string }[]
}

/** every device test in the specs, minus the config's `exclude` */
export function discoverTests(): PlannedTest[] {
  const { dir, specs, exclude } = config()
  const mocha = createRequire(join(dir, 'package.json')).resolve(
    'mocha/bin/mocha.js',
  )
  const out = execFileSync(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      mocha,
      '--dry-run',
      '--reporter',
      'json',
      specs,
    ],
    { cwd: dir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  const json = JSON.parse(out.slice(out.indexOf('{'))) as DryRun
  const excluded = exclude.map(globToRegex)
  const tests = json.tests
    .map(test => {
      const spec = relative(dir, test.file).replace(/\\/g, '/')
      // fullTitle is the describes and the test joined by spaces
      const describe = test.fullTitle
        .slice(0, test.fullTitle.length - test.title.length)
        .trim()
      return {
        key: `${describe} > ${test.title}`,
        spec,
        describe,
        title: test.title,
        tags: tagsIn(test.fullTitle),
      }
    })
    .filter(test => !excluded.some(pattern => pattern.test(test.spec)))
  // a test whose target tags contradict each other could run nowhere: it
  // would quietly never run
  const problems = tests.flatMap(test => {
    const why = targetTagConflict(test.tags)
    return why ? [`- ${test.spec}: ${test.key}\n  ${why}`] : []
  })
  if (problems.length) {
    throw new TargetTagError(
      `tags to fix before anything runs:\n${problems.join('\n')}`,
    )
  }
  return tests
}

export type PlanArgs = {
  specs: string[]
  grep?: string
  invert?: boolean
}

/** what `wdio run` was asked for: its --spec and --mochaOpts.grep/invert */
export function planArgsFrom(argv: string[]): PlanArgs {
  const args: PlanArgs = { specs: [] }
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s)
    const next = () => inline ?? argv[++i]
    if (flag === '--spec') args.specs.push(...next().split(','))
    else if (flag === '--mochaOpts.grep') args.grep = next()
    else if (flag === '--mochaOpts.invert')
      args.invert = inline === undefined || inline !== 'false'
  }
  return args
}

/** the tests a run with these arguments runs, in the order it runs them */
export function plan(tests: PlannedTest[], { grep, invert, specs }: PlanArgs) {
  const wanted = specs.map(normalise)
  const pattern = grep ? new RegExp(grep) : undefined
  const kept = tests.filter(test => {
    if (wanted.length && !wanted.some(spec => matchesSpec(test.spec, spec)))
      return false
    if (!pattern) return true
    // Mocha greps the full title: the describes and the test, by spaces
    const matches = pattern.test(`${test.describe} ${test.title}`)
    return invert ? !matches : matches
  })
  return inRunOrder(kept, wanted)
}

/**
 * The tests by spec file in the order WDIO runs the files: each --spec in
 * the order given, a glob's files sorted, a file only the first time; with
 * no --spec, the config's glob, sorted. Inside a file, Mocha's own order.
 */
function inRunOrder(tests: PlannedTest[], wanted: string[]) {
  const files = [...new Set(tests.map(test => test.spec))]
  const order = wanted.length
    ? [
        ...new Set(
          wanted.flatMap(spec =>
            files.filter(file => matchesSpec(file, spec)).sort(),
          ),
        ),
      ]
    : files.sort()
  return order.flatMap(file => tests.filter(test => test.spec === file))
}

const normalise = (spec: string) =>
  spec.replace(/\\/g, '/').replace(/^\.\//, '')

/** a spec path or a glob (`specs/photos/*.e2e.ts`) */
const matchesSpec = (spec: string, wanted: string) =>
  wanted.includes('*') ? globToRegex(wanted).test(spec) : spec === wanted

/** `**` crosses folders, `*` stays inside one */
export function globToRegex(glob: string) {
  const source = normalise(glob)
    .split(/(\*\*\/?|\*)/)
    .map(part =>
      part === '**/'
        ? '(?:.*/)?'
        : part === '**'
          ? '.*'
          : part === '*'
            ? '[^/]*'
            : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('')
  return new RegExp(`^${source}$`)
}

/** a grep that runs exactly these tests (Mocha matches the full title) */
export function grepFor(tests: Pick<PlannedTest, 'describe' | 'title'>[]) {
  return tests
    .map(test =>
      `${test.describe} ${test.title}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .map(title => `^${title}$`)
    .join('|')
}

// ---- tags -----------------------------------------------------------------
//
// Tags are #-words in the describe and test titles (`#dev-only`). Any tag
// can be grepped for; the target tags below also decide where a test runs.

/** the #-tags in a title */
export const tagsIn = (title: string) => [
  ...new Set(title.match(/#[\w-]+/g) ?? []),
]

// ---- where a test can run: its target tags --------------------------------
//
// A test with none of these runs everywhere. A test or describe carries one
// only when it truly needs that target: the other platform's tools (adb,
// Android's Back) or, on one platform, one kind of device.
//
// | tag                         | a run on…                                   |
// | #android                    | iOS leaves it out                           |
// | #ios                        | Android leaves it out                       |
// | #on-android-emulator-only   | an Android phone leaves it out; iOS runs it |
// | #on-android-device-only     | an Android emulator leaves it out; iOS too  |
// | #on-ios-simulator-only      | an iPhone leaves it out; Android runs it    |
// | #on-ios-device-only         | an iOS simulator leaves it out; Android too |
//
// A device tag limits its own platform only: `#on-ios-simulator-only` alone
// still runs on Android; `#ios #on-ios-simulator-only` runs on the iOS
// simulator alone. Refused, as they could run nowhere or mean nothing (the
// describes' tags count with the test's): both platform tags; two device
// tags of one platform; a platform tag with the other platform's device tag.

/** a phone in hand, or a simulator / emulator */
export type DeviceKind = 'device' | 'virtual'

const TARGET_TAGS: Record<string, { platform: Platform; kind?: DeviceKind }> = {
  '#android': { platform: 'android' },
  '#ios': { platform: 'ios' },
  '#on-android-emulator-only': { platform: 'android', kind: 'virtual' },
  '#on-android-device-only': { platform: 'android', kind: 'device' },
  '#on-ios-simulator-only': { platform: 'ios', kind: 'virtual' },
  '#on-ios-device-only': { platform: 'ios', kind: 'device' },
}

/** a platform or device tag: it decides where a test runs */
export const isTargetTag = (tag: string) => tag in TARGET_TAGS

export class TargetTagError extends Error {}

/** why these tags can't go together, if they can't */
export function targetTagConflict(tags: string[]): string | undefined {
  const targets = tags.filter(isTargetTag)
  const platformTags = targets.filter(tag => !TARGET_TAGS[tag].kind)
  if (platformTags.length > 1)
    return `${platformTags.join(' + ')}: more than one platform`
  const only = platformTags.length
    ? TARGET_TAGS[platformTags[0]].platform
    : undefined
  for (const platform of ['android', 'ios'] as const) {
    const kinds = targets.filter(
      tag => TARGET_TAGS[tag].kind && TARGET_TAGS[tag].platform === platform,
    )
    if (kinds.length > 1)
      return `${kinds.join(' + ')}: more than one kind of ${platform === 'ios' ? 'iOS' : 'Android'} device`
    if (kinds.length && only && only !== platform)
      return `${platformTags[0]} + ${kinds[0]}: the device tag is for the platform the test never runs on`
  }
  return undefined
}

/**
 * The tags that keep a test off this platform and, once the preflight has
 * picked the device, off this kind of device. None with E2E_ALL_PLATFORMS=1
 * (to try a tagged test anyway).
 */
export function leftOutTags(platform: Platform, kind?: DeviceKind) {
  if (process.env.E2E_ALL_PLATFORMS === '1') return []
  return Object.entries(TARGET_TAGS)
    .filter(([, target]) =>
      target.kind
        ? target.platform === platform &&
          kind !== undefined &&
          target.kind !== kind
        : target.platform !== platform,
    )
    .map(([tag]) => tag)
}

/** the tests a run on this platform (and kind of device, once known) keeps */
export function forPlatform(
  tests: PlannedTest[],
  platform: Platform,
  kind?: DeviceKind,
) {
  const out = leftOutTags(platform, kind)
  return tests.filter(test => !test.tags.some(tag => out.includes(tag)))
}

/**
 * Mocha's grep for a run on this platform and kind of device: the run's own
 * grep (and invert), minus every test tagged for another target. One regex,
 * as Mocha takes one: a lookahead keeps the run's grep, a negative one drops
 * the tags (whole tags only).
 */
export function platformGrep(
  { grep, invert }: { grep?: string | RegExp; invert?: boolean },
  platform: Platform,
  kind?: DeviceKind,
): { grep?: string; invert?: boolean } {
  const out = leftOutTags(platform, kind)
  const source = grep instanceof RegExp ? grep.source : grep
  if (!out.length) return { grep: source, invert }
  const drop = `(?!.*(?:${out.join('|')})(?![\\w-]))`
  if (!source) return { grep: `^${drop}`, invert: false }
  return invert
    ? { grep: `^(?!.*(?:${source}))${drop}`, invert: false }
    : { grep: `^${drop}(?=.*(?:${source}))`, invert: false }
}
