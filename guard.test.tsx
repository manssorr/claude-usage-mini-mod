import { expect, mock, test } from 'claude-code/testing'

const MINUTE = 60_000

// A session whose last response sent 120k prompt tokens, most from the cache.
const usage = {
  startedAt: 0,
  rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: new Date(3 * 3_600_000).toISOString() }],
  context: {
    tokens: 120_000,
    window: 200_000,
    percent: 60,
    breakdown: {
      apiUsage: { input_tokens: 2_000, output_tokens: 500, cache_read_input_tokens: 110_000, cache_creation_input_tokens: 8_000 },
    },
  },
}

const BAND = {
  plugin: 'usage-mini',
  component: 'AbovePrompt',
  requestId: 'above',
  props: {},
} as const

async function setup($: any, on: any, filled: string[] = []) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  // Before the first reply the session has no API usage yet.
  let current: any = { ...usage, context: { ...usage.context, breakdown: undefined } }
  on('session.usage', () => ({ value: current }))
  on('session.id', () => ({ value: 's1' }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
  on('prompt.fill', (_: any, e: any) => (filled.push(e.text), { isFilled: true }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // A response arrives: the mod notes the cache time.
  current = usage
  await $.session.measure({ ...usage, changed: ['context'] })
  return clock
}

const send = ($: any, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

test('a warm cache lets the prompt through', async ($, on) => {
  const entered: string[] = []
  on('prompt.submit', (_: any, e: any) => (entered.push(e.text), { text: e.text }))
  const clock = await setup($, on)
  await clock.advance(30 * MINUTE)
  const r: any = await send($, 'next step')
  expect(r.drop).toBe(undefined)
  expect(entered).toEqual(['next step'])
})

test('a cold cache holds a large send, and Enter again sends it', async ($, on) => {
  const entered: string[] = []
  on('prompt.submit', (_: any, e: any) => (entered.push(e.text), { text: e.text }))
  const clock = await setup($, on)
  await clock.advance(61 * MINUTE)

  const r: any = await send($, 'fix the login bug')
  expect(typeof r.drop).toBe('string')
  expect(entered).toEqual([])

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface } as any)
    expect((await ui.find({ type: 'Text', text: /Cache is cold/ }))?.text).toContain('120k')
    expect(await ui.find({ type: 'Button', text: /Compact & send/ })).toBeTruthy()
    await ui.unmount()
  }

  const again: any = await send($, 'fix the login bug')
  expect(again.drop).toBe(undefined)
  expect(entered).toEqual(['fix the login bug'])
})

test('Compact & send compacts with the held prompt, then sends it', async ($, on) => {
  const entered: string[] = []
  const compacted: string[] = []
  on('prompt.submit', (_: any, e: any) => (entered.push(e.text), { text: e.text }))
  on('session.compact', (_: any, e: any) => (compacted.push(e.instructions ?? ''), { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))
  const clock = await setup($, on)
  await clock.advance(61 * MINUTE)
  await send($, 'fix the login bug')

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  const button: any = await ui.find({ type: 'Button', text: /Compact & send/ })
  await ui.press({ key: button.key })
  await clock.settle()
  await ui.unmount()

  expect(compacted.length).toBe(1)
  expect(compacted[0]).toContain('fix the login bug')
  expect(entered).toEqual(['fix the login bug'])
})

test('a vetoed compaction brings the buttons back and sends nothing', async ($, on) => {
  const entered: string[] = []
  on('prompt.submit', (_: any, e: any) => (entered.push(e.text), { text: e.text }))
  on('session.compact', () => ({ skip: 'vetoed' }))
  const clock = await setup($, on)
  await clock.advance(61 * MINUTE)
  await send($, 'fix the login bug')

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  const button: any = await ui.find({ type: 'Button', text: /Compact & send/ })
  await ui.press({ key: button.key })
  await clock.settle()
  expect(await ui.find({ type: 'Button', text: /Compact & send/ })).toBeTruthy()
  await ui.unmount()
  expect(entered).toEqual([])
})

test('a prompt sent while the compaction runs is held, and does not send twice', async ($, on) => {
  const entered: string[] = []
  let finish: () => void = () => {}
  on('prompt.submit', (_: any, e: any) => (entered.push(e.text), { text: e.text }))
  on('session.compact', () => new Promise(r => (finish = () => r({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))))
  const clock = await setup($, on)
  await clock.advance(61 * MINUTE)
  await send($, 'fix the login bug')

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  const button: any = await ui.find({ type: 'Button', text: /Compact & send/ })
  await ui.press({ key: button.key })
  await clock.settle()
  const during: any = await send($, 'fix the login bug')
  expect(typeof during.drop).toBe('string')
  expect(entered).toEqual([])
  finish()
  await clock.settle()
  await ui.unmount()
  expect(entered).toEqual(['fix the login bug'])
})

test('a compaction call that throws (an SDK host) puts the /compact line in the box', async ($, on) => {
  const entered: string[] = []
  const filled: string[] = []
  on('prompt.submit', (_: any, e: any) => (entered.push(e.text), { text: e.text }))
  on('session.compact', () => {
    throw new Error('$.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt)')
  })
  const clock = await setup($, on, filled)
  await clock.advance(61 * MINUTE)
  await send($, 'fix the login bug')

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  const button: any = await ui.find({ type: 'Button', text: /Compact & send/ })
  await ui.press({ key: button.key })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /Edit the \/compact prompt/ }))).toBeTruthy()
  await ui.unmount()
  const last = filled[filled.length - 1]
  expect(last.startsWith('/compact ')).toBe(true)
  expect(last).toContain('fix the login bug')
  expect(entered).toEqual([])
})

test('after a compaction the next prompt is not held, even when the old reply is old', async ($, on) => {
  const entered: string[] = []
  on('prompt.submit', (_: any, e: any) => (entered.push(e.text), { text: e.text }))
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))
  const clock = await setup($, on)
  await $.session.compact({ instructions: '', messages: [{ role: 'user', text: 'old', toolUses: [] }] } as any)
  await clock.advance(61 * MINUTE)
  const r: any = await send($, 'next step')
  expect(r.drop).toBe(undefined)
  expect(entered).toEqual(['next step'])
})

test('sending the /compact line changes the band from "edit" to "compacting"', async ($, on) => {
  const entered: string[] = []
  const filled: string[] = []
  on('prompt.submit', (_: any, e: any) => (entered.push(e.text), { text: e.text }))
  on('command.run', (_: any, e: any) => ({ text: `ran ${e.command}` }))
  on('session.compact', () => {
    throw new Error('$.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt)')
  })
  const clock = await setup($, on, filled)
  await clock.advance(61 * MINUTE)
  await send($, 'fix the login bug')

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  const button: any = await ui.find({ type: 'Button', text: /Compact & send/ })
  await ui.press({ key: button.key })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /Edit the \/compact prompt/ })).toBeTruthy()

  // The person presses Enter on the /compact line.
  await $.command.run({ command: 'compact', args: 'x' } as any)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /Edit the \/compact prompt/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /Compacting/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /Don't send after/ })).toBeTruthy()
  await ui.unmount()
  expect(entered).toEqual([])
})

test('Send anyway sends the held prompt and clears it from the box, but keeps a changed draft', async ($, on) => {
  const entered: string[] = []
  const filled: string[] = []
  on('prompt.submit', (_: any, e: any) => (entered.push(e.text), { text: e.text }))
  on('prompt.read', () => ({ value: { text: filled[filled.length - 1] ?? '', cursor: 0 } }))
  const clock = await setup($, on, filled)
  await clock.advance(61 * MINUTE)
  await send($, 'fix the login bug')
  expect(filled[filled.length - 1]).toBe('fix the login bug')

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  const button: any = await ui.find({ type: 'Button', text: /Send anyway/ })
  await ui.press({ key: button.key })
  await clock.settle()
  await ui.unmount()
  expect(entered).toEqual(['fix the login bug'])
  expect(filled[filled.length - 1]).toBe('')

  // A draft the person changed stays.
  await clock.advance(61 * MINUTE)
  await send($, 'second prompt')
  filled.push('my new words')
  const ui2 = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  const again: any = await ui2.find({ type: 'Button', text: /Send anyway/ })
  await ui2.press({ key: again.key })
  await clock.settle()
  await ui2.unmount()
  expect(filled[filled.length - 1]).toBe('my new words')
})
