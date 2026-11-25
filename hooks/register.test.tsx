import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__confidence-meter__report_confidence'
const BAND = (surface: 'terminal' | 'desktop' | 'vscode' | 'mobile', hasSurvey = false) => ({
  plugin: 'confidence-meter',
  surface,
  component: 'AbovePrompt',
  props: {
    hasSurvey, isCollapsed: false, isWorking: true, maxRows: 10, bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 }, view: {},
  },
}) as const

function engine(on: any) {
  const log = { status: [] as (string | undefined)[], toast: [] as string[], tools: [] as any[], store: {} as Record<string, unknown>, clock: mock.clock(on) }
  on('store.get', (_: any, e: any) => ({ value: log.store[e.key] }))
  on('store.set', (_: any, e: any) => { log.store[e.key] = e.value; return { value: undefined } })
  on('tool.register', (_: any, e: any) => { log.tools.push(e); return { value: e } })
  on('command.register', (_: any, e: any) => ({ value: e }))
  on('ui.status', (_: any, e: any) => { log.status.push(e.text); return { value: undefined } })
  on('ui.toast', (_: any, e: any) => { log.toast.push(e.text); return { value: undefined } })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [] }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  return log
}

test('registers the tool at session start', async ($, on) => {
  const log = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(log.tools.map(t => t.name)).toEqual(['report_confidence'])
})

test('adds guidance to the system prompt', async ($, on) => {
  engine(on)
  const out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
  const s = out.sections.find(x => x.id === 'confidence-meter:guidance')
  expect(s?.scope).toBe('session')
  expect(s?.text.includes(TOOL)).toBe(true)
})

test('a placeholder band before any report, on every surface', async ($, on) => {
  engine(on)
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount(BAND(surface))
    const t = await ui.find({ type: 'Text', text: /Confidence/ })
    expect(t?.text).toBe("Confidence ░░░░░░░░░░ --% — waiting for Claude's first report")
    await ui.unmount()
  }
})

test('a report draws the band on every surface, with trend', async ($, on) => {
  const log = engine(on)
  const r1 = await $.tool.call({ tool: TOOL, score: 60, reason: 'plan drafted'} as any)
  const r2 = await $.tool.call({ tool: TOOL, score: 82, reason: 'tests pass' } as any)
  expect(JSON.stringify(r1)).toBe(JSON.stringify(r2))
  expect(JSON.stringify(r2)).toContain('ok')
  expect(log.status).toEqual([])
  expect(log.toast).toEqual([])
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount(BAND(surface))
    const t = await ui.find({ type: 'Text', text: /Confidence/ })
    expect(t?.text).toBe('Confidence ████████░░ 82%↑ — tests pass')
    await ui.unmount()
  }
})

test('low score toasts; score is clamped and rounded', async ($, on) => {
  const log = engine(on)
  await $.tool.call({ tool: TOOL, score: 150, reason: 'x' } as any)

  await $.tool.call({ tool: TOOL, score: 12.6, reason: 'stuck' } as any)

  expect(log.toast).toEqual(["Claude's confidence dropped to 13%: stuck"])
})

test('non-numeric score is denied', async ($, on) => {
  engine(on)
  const r = await $.tool.call({ tool: TOOL, score: 'high', reason: 'x' } as any)
  expect(JSON.stringify(r)).toContain('score must be a number')
})

test('a new prompt marks the reading stale', async ($, on) => {
  const log = engine(on)
  await $.tool.call({ tool: TOOL, score: 55, reason: 'unverified' } as any)
  await $.prompt.submit({ text: 'next' } as any)

  const ui = await $.ui.mount(BAND('desktop'))
  expect((await ui.find({ type: 'Text', text: /Confidence/ }))?.text).toBe('Confidence ██████░░░░ 55% (last turn) — unverified')
  await ui.unmount()
})

test('yields to a survey', async ($, on) => {
  engine(on)
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  await $.tool.call({ tool: TOOL, score: 90, reason: 'ok' } as any)
  const ui = await $.ui.mount(BAND('terminal', true))
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('slow is the default: minimal guidance and integer scores', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
  const text = out.sections.find(x => x.id === 'confidence-meter:guidance')!.text
  expect(text.includes('Once')).toBe(true)
  expect(text.length < 200).toBe(true)
  await $.tool.call({ tool: TOOL, score: 71.6 } as any)
  const ui = await $.ui.mount(BAND('terminal'))
  expect((await ui.find({ type: 'Text', text: /Confidence/ }))?.text).toBe('Confidence ███████░░░ 72%')
  await ui.unmount()
})

test('/confidence-fast switches guidance, keeps decimals, and is remembered', async ($, on) => {
  const log = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const res = await $.command.run({ command: 'confidence-fast', args: '' } as any)
  expect(JSON.stringify(res)).toContain('fast mode')
  const out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
  expect(out.sections.find(x => x.id === 'confidence-meter:guidance')!.text.includes('one-decimal')).toBe(true)
  await $.tool.call({ tool: TOOL, score: 72.46, reason: 'tests green' } as any)
  const ui = await $.ui.mount(BAND('vscode'))
  expect((await ui.find({ type: 'Text', text: /Confidence/ }))?.text).toBe('Confidence ███████░░░ 72.5% — tests green')
  await ui.unmount()
  expect(log.store.mode).toBe('fast')

  await $.command.run({ command: 'confidence-slow', args: '' } as any)
  expect(log.store.mode).toBe('slow')
})

test('fast mode shows the latest streamed thought, refreshed on the 3 s tick', async ($, on) => {
  const log = engine(on)
  on('turn.step', async function* (_: any, e: any) {
    yield { kind: 'thinking', index: 0, text: 'Reading the config.\nThe bug is in the parser' } as any
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' } as any
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'confidence-fast', args: '' } as any)
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'm', messages: [] } as any)) { /* drain */ }

  // Nothing shows until the 3 s tick.
  let ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: /💭/ })).toBe(undefined)
  await ui.unmount()

  await log.clock.advance(3000)
  ui = await $.ui.mount(BAND('terminal'))
  expect((await ui.find({ type: 'Text', text: /💭/ }))?.text).toBe('💭 The bug is in the parser')
  await ui.unmount()
})

test('a mode saved in an earlier session is used at start', async ($, on) => {
  const log = engine(on)
  log.store.mode = 'fast'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
  expect(out.sections.find(x => x.id === 'confidence-meter:guidance')!.text.includes('one-decimal')).toBe(true)
})
