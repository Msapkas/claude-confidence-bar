export type Reading = {
  /** 0-100, Claude's own estimate (one decimal in fast mode), or 110 for good vibes: purple and glowing. */
  score: number
  /** Short note on what drives the number; may be empty in slow mode. */
  reason: string
  /** True once a new prompt starts and this reading hasn't been refreshed. */
  isStale: boolean
}

/** slow: one report a turn, minimal tokens. fast: frequent decimal reports plus a live thought line. */
export type Mode = 'slow' | 'fast'

declare module 'claude-code' {
  interface PluginState {
    'confidence-meter': {
      current: Reading | null
      history: readonly number[]
      mode: Mode
      /** Latest line of Claude's live thinking or text, refreshed every 3 s in fast mode. */
      thought: string
      /** Flips every 0.8 s while the vibes bar glows. */
      glow: boolean
    }
  }
}
