import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Reading } from '../types'

const PLUGIN = 'confidence-meter'
const TOOL = `mcp__${PLUGIN}__report_confidence`

const current = atom({ plugin: 'confidence-meter', key: 'current' } as const, null)
const history = atom({ plugin: 'confidence-meter', key: 'history' } as const, [] as readonly number[])

const GUIDANCE = `# Confidence reporting
A meter beside the user's prompt shows how confident you are in what you are currently doing. Keep it honest and current by calling the \`${TOOL}\` tool:
- when you start a multi-step task or plan, and at each new step or phase;
- whenever your confidence changes noticeably (a test fails, an assumption turns out wrong, you find the root cause, you verify something works);
- before you finish a turn that did real work.
Score 0-100 means how likely you think the current approach and its result are correct. Calibrate: 90+ only when verified (tests pass, behaviour observed); 60-80 for a reasonable but unverified approach; below 50 when guessing, blocked or working from unconfirmed assumptions. Never inflate it. Keep \`reason\` to one short sentence. The call is cheap; don't mention it in your replies. Skip it for trivial one-line answers.`

function colorOf(score: number): string {
  if (score >= 75) return 'green'
  if (score >= 50) return 'yellow'
  return 'red'
}

function bar(score: number, width: number): string {
  const filled = Math.round((score / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function trend(hist: readonly number[]): string {
  if (hist.length < 2) return ''
  const d = (hist[hist.length - 1] ?? 0) - (hist[hist.length - 2] ?? 0)
  if (d >= 5) return '↑'
  if (d <= -5) return '↓'
  return '→'
}

function statusText(r: Reading | null, hist: readonly number[]): string | undefined {
  if (r === null) return undefined
  const stale = r.isStale ? ' (last turn)' : ''
  return `Confidence ${r.score}% ${trend(hist)}${stale} — ${r.reason}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'report_confidence',
      isDeferred: false,
      description:
        "Report your current confidence (0-100) in the step you are working on, shown to the user as a meter beside the prompt. Call it at each step of a multi-step plan and whenever your confidence changes. Returns immediately; it does nothing else.",
      inputSchema: {
        type: 'object',
        properties: {
          score: { type: 'integer', minimum: 0, maximum: 100, description: 'Calibrated confidence, 0-100.' },
          step: { type: 'string', description: 'A few words naming the current step.' },
          reason: { type: 'string', description: 'One short sentence: why this number.' },
        },
        required: ['score', 'reason'],
      },
    })
    const r = await read($, current)
    $.ui.status(statusText(r, await read($, history)))
    return next(e)
  })

  // Tell the model to use the meter.
  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    return { sections: [...out.sections, { id: `${PLUGIN}:guidance`, text: GUIDANCE, scope: 'session' as const }] }
  })

  // Answering at tool.call serves the tool without a permission prompt.
  on('tool.call', { tool: 'mcp__confidence-meter__report_confidence' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const raw = Number(input.score)
    if (!Number.isFinite(raw)) return { deny: 'score must be a number from 0 to 100' }
    const score = Math.max(0, Math.min(100, Math.round(raw)))
    const reason = String(input.reason ?? '').slice(0, 120)
    const step = String(input.step ?? '').slice(0, 60)
    const reading: Reading = { score, reason, step, isStale: false }
    await update($, current, () => reading)
    const hist = await update($, history, prev => [...prev, score].slice(-20))
    $.ui.status(statusText(reading, hist))
    if (score < 40) $.ui.toast(`Claude's confidence dropped to ${score}%: ${reason}`)
    return { result: `Recorded ${score}%.` }
  }).catch(() => ({ result: 'Recorded.' }))

  // A new prompt makes the old reading stale until Claude reports again.
  on('prompt.submit', async ($, e, next) => {
    const r = await read($, current)
    if (r !== null && !r.isStale) {
      const s = { ...r, isStale: true }
      await update($, current, () => s)
      $.ui.status(statusText(s, await read($, history)))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'BesidePrompt' }, async ($, e, next) => {
    const r = await read($, current)
    if (r === null || e.props.maxColumns < 6) return next(e)
    const hist = await read($, history)
    const { Text } = $.ui.resolve(e)
    const label = `${r.score}%${trend(hist)}`
    const width = e.props.maxColumns >= label.length + 12 ? 10 : 0
    return (
      <Text color={colorOf(r.score)} dimColor={r.isStale}>
        {width > 0 ? `${bar(r.score, width)} ` : ''}
        {label}
      </Text>
    )
  })

  // VS Code and the phone apps have no slot beside the prompt: draw a row above it instead.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'terminal' || e.surface === 'desktop') return next(e)
    const r = await read($, current)
    if (r === null) return next(e)
    const hist = await read($, history)
    const { Text } = $.ui.resolve(e)
    const stale = r.isStale ? ' (last turn)' : ''
    return (
      <Text color={colorOf(r.score)} dimColor={r.isStale}>
        {`Confidence ${bar(r.score, 10)} ${r.score}%${trend(hist)}${stale}${r.reason ? ` — ${r.reason}` : ''}`}
      </Text>
    )
  })
}
