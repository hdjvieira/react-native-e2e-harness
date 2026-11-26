import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  forPlatform,
  globToRegex,
  grepFor,
  plan,
  planArgsFrom,
  platformGrep,
  type PlannedTest,
  tagsIn,
  targetTagConflict,
} from './plan.js'

const test = (spec: string, describe: string, title: string): PlannedTest => ({
  key: `${describe} > ${title}`,
  spec,
  describe,
  title,
  tags: tagsIn(`${describe} ${title}`),
})

describe('globToRegex', () => {
  it('crosses folders with ** and stays in one with *', () => {
    const specs = globToRegex('specs/**/*.e2e.ts')
    assert.ok(specs.test('specs/login.e2e.ts'))
    assert.ok(specs.test('specs/account/deep/login.e2e.ts'))
    assert.ok(!specs.test('specs/login.ts'))
    const one = globToRegex('specs/*.e2e.ts')
    assert.ok(one.test('specs/login.e2e.ts'))
    assert.ok(!one.test('specs/account/login.e2e.ts'))
    assert.ok(globToRegex('specs/api/**').test('specs/api/a/b.e2e.ts'))
  })
})

describe('planArgsFrom', () => {
  it('reads --spec, grep and invert, inline or not', () => {
    assert.deepEqual(
      planArgsFrom([
        '--spec',
        'a.ts,b.ts',
        '--mochaOpts.grep=#slow',
        '--mochaOpts.invert',
      ]),
      { specs: ['a.ts', 'b.ts'], grep: '#slow', invert: true },
    )
  })
})

describe('plan', () => {
  const tests = [
    test('specs/b.e2e.ts', 'B', 'one'),
    test('specs/a.e2e.ts', 'A', 'two #slow'),
    test('specs/a.e2e.ts', 'A', 'three'),
  ]
  it('runs files sorted, tests in file order', () => {
    assert.deepEqual(
      plan(tests, { specs: [] }).map(t => t.key),
      ['A > two #slow', 'A > three', 'B > one'],
    )
  })
  it('keeps --spec order and applies an inverted grep', () => {
    assert.deepEqual(
      plan(tests, {
        specs: ['specs/b.e2e.ts', 'specs/a.e2e.ts'],
        grep: '#slow',
        invert: true,
      }).map(t => t.key),
      ['B > one', 'A > three'],
    )
  })
  it('greps exactly the tests grepFor names', () => {
    const grep = grepFor([tests[2]])
    assert.deepEqual(
      plan(tests, { specs: [], grep }).map(t => t.key),
      ['A > three'],
    )
  })
})

describe('target tags', () => {
  it('refuses tags that could run nowhere', () => {
    assert.match(
      targetTagConflict(['#android', '#ios'])!,
      /more than one platform/,
    )
    assert.match(
      targetTagConflict(['#on-ios-simulator-only', '#on-ios-device-only'])!,
      /more than one kind/,
    )
    assert.match(
      targetTagConflict(['#android', '#on-ios-device-only'])!,
      /never runs on/,
    )
    assert.equal(
      targetTagConflict(['#on-ios-simulator-only', '#on-android-device-only']),
      undefined,
    )
  })

  it('leaves out the other platform and the other kind of device', () => {
    const tests = [
      test('s', 'D', 'plain'),
      test('s', 'D', 'droid #android'),
      test('s', 'D', 'sim #on-ios-simulator-only'),
      test('s', 'D', 'phone #on-ios-device-only'),
    ]
    assert.deepEqual(
      forPlatform(tests, 'ios', 'virtual').map(t => t.title),
      ['plain', 'sim #on-ios-simulator-only'],
    )
    assert.deepEqual(
      forPlatform(tests, 'android', 'device').map(t => t.title),
      [
        'plain',
        'droid #android',
        'sim #on-ios-simulator-only',
        'phone #on-ios-device-only',
      ],
    )
  })

  it('folds the left-out tags into the run grep', () => {
    const titles = ['D plain', 'D droid #android', 'D slow #slow']
    const keep = (g: { grep?: string; invert?: boolean }) =>
      titles.filter(t => new RegExp(g.grep ?? '').test(t) !== !!g.invert)
    assert.deepEqual(keep(platformGrep({}, 'ios')), ['D plain', 'D slow #slow'])
    assert.deepEqual(keep(platformGrep({ grep: '#slow' }, 'ios')), [
      'D slow #slow',
    ])
    assert.deepEqual(
      keep(platformGrep({ grep: '#slow', invert: true }, 'ios')),
      ['D plain'],
    )
    // a whole tag only: #android-ish is not #android
    assert.deepEqual(keep(platformGrep({}, 'ios')).length, 2)
    assert.ok(
      new RegExp(platformGrep({}, 'ios').grep!).test('D x #android-ish'),
    )
  })
})
