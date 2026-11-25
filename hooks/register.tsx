import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { Mode, Reading } from '../types'

const PLUGIN = 'confidence-meter'
const TOOL = `mcp__${PLUGIN}__report_confidence`
const THOUGHT_MS = 3000
const GLOW_MS = 800
const VIBE_SCORE = 110
const REASON_MAX = 50

const current = atom({ plugin: 'confidence-meter', key: 'current' } as const, null)
const history = atom({ plugin: 'confidence-meter', key: 'history' } as const, [] as readonly number[])
const modeAtom = atom({ plugin: 'confidence-meter', key: 'mode' } as const, 'slow' as Mode)
const glowAtom = atom({ plugin: 'confidence-meter', key: 'glow' } as const, false)
const thoughtAtom = atom({ plugin: 'confidence-meter', key: 'thought' } as const, '')

// This text rides along with every request, so each mode keeps it as short as it can.
// Slow: one bare integer a turn. Fast: roughly five times the calls, decimals and a reason.
const GUIDANCE: Record<Mode, string> = {
  slow: `# Confidence
Once, before ending a turn that did real work, call \`${TOOL}\` with an honest integer score and a `reason`: a summary of where you stand, 6 words or fewer, under 50 characters. If the user is excited, enthusiastic or sharing a new idea and you share that energy, also pass `vibe: true`. Don't mention it.`,
  fast: `# Confidence (live)
Call \`${TOOL}\` often: when starting work, after each thinking step, finding or tool result that moves your view, and before ending. Use one-decimal scores (e.g. 72.5) so small shifts show. `reason`: a summary of your current state, 6 words or fewer, under 50 characters, no full sentences. If the user is excited, enthusiastic or sharing a new idea and you share that energy, also pass `vibe: true`. Calibrate: 90+ verified, 60-80 plausible but unchecked, <50 guessing or blocked. Never inflate. Don't mention it.`,
}

const MODE_LINE: Record<Mode, string> = {
  slow: 'Confidence bar: slow mode (one report per turn, minimal tokens).',
  fast: 'Confidence bar: fast mode (live thoughts every 3 s, frequent decimal scores, about 5x the tokens of slow).',
}

function colorOf(score: number): string {
  if (score > 100) return 'magenta'
  if (score >= 75) return 'green'
  if (score >= 50) return 'yellow'
  return 'red'
}

const LEVELS = ' ▁▂▃▄▅▆▇█'

/** A vertical bar's cells, top first, filled in eighths: a glyph pair each, or '' where empty. */
function column(score: number, rows: number): string[] {
  const filled = Math.round((score / 100) * rows * 8)
  return Array.from({ length: rows }, (_, i) => {
    const level = Math.max(0, Math.min(8, filled - (rows - 1 - i) * 8))
    return level === 0 ? '' : (LEVELS[level] ?? '█').repeat(2)
  })
}

function trend(hist: readonly number[]): string {
  if (hist.length < 2) return ''
  const d = (hist[hist.length - 1] ?? 0) - (hist[hist.length - 2] ?? 0)
  if (d >= 5) return '↑'
  if (d <= -5) return '↓'
  return '→'
}

/** One line cut to `max` characters at a word boundary, with an ellipsis if anything was lost. */
function fit(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '') + '…'
}

/** The last non-empty line of the streamed text, cut to fit one row. */
function lastLine(buf: string, max = 60): string {
  const lines = buf.split('\n').map(l => l.trim()).filter(Boolean)
  return fit(lines[lines.length - 1] ?? '', max)
}

export const register: Register = on => {
  // Module-local, so a reload starts them over; session.start re-reads the mode.
  let mode: Mode = 'slow'
  let streamed = ''
  let timer: Timer | undefined
  let glowTimer: Timer | undefined

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'report_confidence',
      isDeferred: false,
      description: 'Show your confidence to the user.',
      inputSchema: {
        type: 'object',
        properties: {
          score: { type: 'number', minimum: 0, maximum: 100 },
          reason: { type: 'string' },
          vibe: { type: 'boolean', description: 'True when the user and you are in an excited, enthusiastic mood.' },
        },
        required: ['score'],
      },
    })
    await $.command.register({ name: 'confidence-fast', description: 'Confidence bar: live thoughts and frequent decimal scores (more tokens).' })
    await $.command.register({ name: 'confidence-slow', description: 'Confidence bar: one report per turn (fewest tokens).' })
    const stored = await $.store.get('mode')
    mode = stored === 'fast' ? 'fast' : 'slow'
    await update($, modeAtom, () => mode)
    // The live thought line: flush what streamed at most every 3 s, only in fast mode.
    timer?.cancel()
    let shown = ''
    timer = $.clock.every(THOUGHT_MS, async () => {
      if (mode !== 'fast') return
      const line = lastLine(streamed)
      if (line === shown) return
      shown = line
      await update($, thoughtAtom, () => line)
    })
    // The vibes glow: while the bar is purple, it pulses between two purples.
    glowTimer?.cancel()
    glowTimer = $.clock.every(GLOW_MS, async () => {
      const r = await read($, current)
      if (r === null || r.score <= 100 || r.isStale) return
      await update($, glowAtom, g => !g)
    })
    // The bar above the prompt is the only display; clear any status line an older version set.
    $.ui.status(undefined)
    return next(e)
  })

  // The mode is kept in the store, so it carries over to later sessions.
  on('command.run', { command: 'confidence-fast' }, async $ => {
    mode = 'fast'
    await $.store.set('mode', 'fast')
    await update($, modeAtom, () => 'fast' as Mode)
    return { text: MODE_LINE.fast, context: [GUIDANCE.fast], isTextDisplayOnly: true as const }
  })
  on('command.run', { command: 'confidence-slow' }, async $ => {
    mode = 'slow'
    streamed = ''
    await $.store.set('mode', 'slow')
    await update($, modeAtom, () => 'slow' as Mode)
    await update($, thoughtAtom, () => '')
    return { text: MODE_LINE.slow, context: [GUIDANCE.slow], isTextDisplayOnly: true as const }
  })

  // Tell the model to use the meter, with the current mode's rules only.
  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    const m = await read($, modeAtom)
    return { sections: [...out.sections, { id: `${PLUGIN}:guidance`, text: GUIDANCE[m], scope: 'session' as const }] }
  })

  // Fast mode watches Claude's thinking and text as they stream; it costs no tokens.
  on('turn.step', async function* ($, e, next) {
    if (mode !== 'fast') return yield* next(e)
    const it = next(e)
    for (;;) {
      const r = await it.next()
      if (r.done) return r.value
      const c = r.value
      if (c.kind === 'thinking' || c.kind === 'text') streamed = (streamed + c.text).slice(-400)
      yield c
    }
  })

  // Answering at tool.call serves the tool without a permission prompt.
  on('tool.call', { tool: 'mcp__confidence-meter__report_confidence' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const raw = Number(input.score)
    if (!Number.isFinite(raw)) return { deny: 'score must be a number from 0 to 100' }
    const m = await read($, modeAtom)
    const clamped = Math.max(0, Math.min(100, raw))
    const score = m === 'fast' ? Math.round(clamped * 10) / 10 : Math.round(clamped)
    const reason = fit(String(input.reason ?? ''), REASON_MAX)
    const vibe = input.vibe === true
    const reading: Reading = { score: vibe ? VIBE_SCORE : score, reason, isStale: false }
    await update($, current, () => reading)
    await update($, history, prev => [...prev, reading.score].slice(-20))
    if (!vibe && score < 40) $.ui.toast(`Claude's confidence dropped to ${score}%${reason ? `: ${reason}` : ''}`)
    return { result: 'ok' }
  }).catch(() => ({ result: 'ok' }))

  // A new prompt makes the old reading stale until Claude reports again.
  on('prompt.submit', async ($, e, next) => {
    const r = await read($, current)
    if (r !== null && !r.isStale) {
      await update($, current, () => ({ ...r, isStale: true }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The band above the prompt: the one slot every app (terminal, desktop, VS Code, mobile) draws.
  // A vertical bar on the left with the number and arrow at its middle, joined by a short
  // rule to a thin rounded box holding the reason and, in fast mode, the live thought.
  // It is always there; only a survey, which the band asks every row to yield to, hides it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const r = await read($, current)
    const m = await read($, modeAtom)
    const thought = m === 'fast' ? await read($, thoughtAtom) : ''
    const hist = r === null ? [] : await read($, history)
    const { Box, Text } = $.ui.resolve(e)

    const score = r?.score ?? 0
    const vibe = score > 100
    const glow = vibe && !(r?.isStale) && (await read($, glowAtom))
    const color = r === null ? undefined : vibe && glow ? 'magentaBright' : colorOf(score)
    const dim = r === null || r.isStale
    // Fixed width, so the box beside it doesn't jump as the number changes.
    const pct = r === null ? '--' : m === 'fast' ? score.toFixed(1) : String(Math.round(score))
    const number = `${pct}%`.padStart(m === 'fast' ? 6 : 5) + (vibe ? '✨' : trend(hist) || ' ')
    const stale = r?.isStale ? '(last turn) ' : ''
    const headline = r === null ? "waiting for Claude's first report" : `${stale}${r.reason || 'Confidence'}`
    const lines = thought ? [headline, `💭 ${thought}`] : [headline]

    // The bar is as tall as the box: its two borders plus a row per line.
    const rows = lines.length + 2
    if (e.props.maxRows < rows) {
      // Too little room for the box: one line, as before.
      return (
        <Text color={color} dimColor={dim} wrap="truncate-end">
          {`${number.trim()} ${headline}${thought ? `  💭 ${thought}` : ''}`}
        </Text>
      )
    }
    return (
      <Box width="100%" flexDirection="row" alignItems="center">
        <Box flexDirection="column">
          {column(score, rows).map(cell =>
            cell ? <Text color={color} dimColor={dim}>{cell}</Text> : <Text dimColor>░░</Text>,
          )}
        </Box>
        <Text color={color} dimColor={dim} bold>{` ${number}`}</Text>
        <Text dimColor>{'─╴'}</Text>
        <Box flexGrow={1} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          {lines.map((l, i) => (
            <Text dimColor={dim || i > 0} wrap="truncate-end">{l}</Text>
          ))}
        </Box>
      </Box>
    )
  })
}
