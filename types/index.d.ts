export type Reading = {
  /** 0-100, Claude's own estimate. */
  score: number
  /** Short note on what drives the number. */
  reason: string
  /** What Claude is working on when it reported. */
  step: string
  /** True once a new prompt starts and this reading hasn't been refreshed. */
  isStale: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'confidence-meter': { current: Reading | null; history: readonly number[] }
  }
}
