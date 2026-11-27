import { $, expect } from '@wdio/globals'
import {
  chain,
  collectIds,
  deepLink,
  devLink,
  hideKeyboard,
  byId,
  restartApp,
  scrollTo,
  tap,
  text,
  waitFor,
  waitGone,
} from 'react-native-e2e-harness'

describe('Home', () => {
  beforeEach(() => restartApp())

  it('starts fresh: the counter at 0', async () => {
    expect(await text('counter-value')).toBe('0')
  })

  it('counts taps', async () => {
    await tap('counter-button')
    await tap('counter-button')
    expect(await text('counter-value')).toBe('2')
  })

  it('greets by the name typed', async () => {
    await $(byId('name-input')).setValue('Ada')
    await hideKeyboard()
    expect(await text('greeting')).toBe('Hello, Ada')
  })

  it('shows the readout a test turns on', async () => {
    await deepLink(devLink('showStats=on')!)
    expect(await text('stats-readout')).toBe('count=0')
  })
})

describe('Details, chained', () => {
  const flow = chain()
  const atHome = {
    check: async () => !!(await $(byId('home-screen')).isExisting()),
    arrive: () => restartApp(),
  }
  const atDetails = {
    check: async () => !!(await $(byId('details-screen')).isExisting()),
    arrive: async () => {
      await restartApp()
      await tap('open-details-button')
      await waitFor('details-screen')
    },
  }

  flow('opens the details', atHome, async () => {
    await tap('open-details-button')
    await waitFor('details-screen')
  })

  flow('goes back home', atDetails, async () => {
    await tap('back-button')
    await waitGone('details-screen')
    await waitFor('home-screen')
  })
})

describe('A long list', () => {
  beforeEach(async () => {
    await restartApp()
    await tap('open-details-button')
    await tap('open-list-button')
    await waitFor('list-screen')
  })

  it('scrolls to a row far below, clear of the header', async () => {
    const row = await scrollTo('row-35', 'list-screen', {
      below: 'list-header',
      slow: true,
    })
    expect(await row.getText()).toBe('Row 35')
  })

  it('reads every row in one pass', async () => {
    const ids = await collectIds('list-end')
    for (let row = 0; row < 40; row++) expect(ids.has(`row-${row}`)).toBe(true)
  })
})
