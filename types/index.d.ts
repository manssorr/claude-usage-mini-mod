export type Limit = { kind: string; percentUsed: number; resetsAt?: number }

export type Snapshot = {
  now: number
  limits: Limit[]
  ctxTokens?: number
  ctxWindow: number
  ctxPercent?: number
  // Last response's prompt size and cache hit, with when this mod saw it arrive.
  cache?: { signature: string; promptTokens: number; hitPercent: number; at?: number }
}

// A prompt the guard held back because the cache was cold and the context large.
export type Pending = {
  text: string
  // Tokens the send would write to the cache again.
  tokens: number
  // 'idle' shows the choices. 'compacting' while the mod compacts.
  // 'manual' after the person took the /compact prompt into the box to edit it.
  // 'running' after the person sent that /compact line, while it compacts.
  phase: 'idle' | 'compacting' | 'manual' | 'running'
}

declare module 'claude-code' {
  interface PluginState {
    'usage-mini': { snapshot: Snapshot | null; pending: Pending | null }
  }
}
