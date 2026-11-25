import { expect, test } from 'claude-code/testing'

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
  const log = { status: [] as (string | undefined)[], toast: [] as string[], tools: [] as any[] }
  on('tool.register', (_: any, e: any) => { log.tools.push(e); return { value: e } })
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

test('no band before any report', async ($, on) => {
  engine(on)
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  const ui = await $.ui.mount(BAND('terminal'))
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('a report draws the band on every surface, with trend', async ($, on) => {
  const log = engine(on)
  const r1 = await $.tool.call({ tool: TOOL, score: 60, reason: 'plan drafted', step: 'plan' } as any)
  const r2 = await $.tool.call({ tool: TOOL, score: 82, reason: 'tests pass' } as any)
  expect(JSON.stringify(r1)).toContain('Recorded 60%')
  expect(JSON.stringify(r2)).toContain('Recorded 82%')
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
