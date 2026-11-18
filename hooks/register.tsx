import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Limit, Pending, Snapshot } from '../types'

const snapshot = atom({ plugin: 'usage-mini', key: 'snapshot' } as const, null)
const pending = atom({ plugin: 'usage-mini', key: 'pending' } as const, null)

const MINUTE = 60_000
// This account's Claude Code requests write 1-hour cache entries (ephemeral_1h).
const CACHE_TTL_MS = 60 * MINUTE

// The guard holds a prompt back only when a cold send would re-cache at least this many tokens.
const GUARD_MIN_TOKENS = 50_000

// The /compact instructions the guard suggests: keep what the held prompt needs.
const compactPrompt = (next: string): string =>
  'Summarize this conversation for the next request below. ' +
  'Keep every decision, file path, command, error and open task that the request needs. ' +
  'Drop detail that it does not need.\n\n' +
  `Next request:\n"""\n${next.slice(0, 4000)}\n"""`

// The cache's age is only known when this mod saw the response arrive.
// It keeps that time per session in $.store, so a reopened session still knows it.
type SavedCache = { signature: string; at: number }
const cacheKey = (sessionId: string) => `cache:${sessionId}`

const isCold = (s: Snapshot): boolean =>
  s.cache?.at !== undefined && s.now - s.cache.at >= CACHE_TTL_MS

// 63k, 301k, 1.2M
const tok = (n: number): string =>
  n >= 999_500 ? `${parseFloat((n / 1e6).toFixed(1))}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

// Two largest units: 42m, 2h48m, 6d22h
const left = (ms: number): string => {
  const m = Math.max(0, Math.ceil(ms / MINUTE))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return d > 0 ? `${d}d${h}h` : h > 0 ? `${h}h${m % 60}m` : `${m}m`
}

const tone = (pct: number) => (pct >= 90 ? 'error' : pct >= 70 ? 'warning' : 'success')

// Ten-cell bar: ▰▰▰▱▱▱▱▱▱▱
const bar = (pct: number): string => {
  const on = Math.round(Math.min(100, Math.max(0, pct)) / 10)
  return '▰'.repeat(on) + '▱'.repeat(10 - on)
}

async function refresh($: EngineInterface, isStart: boolean) {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const now = await $.clock.now()
  const api = usage.context.breakdown?.apiUsage ?? null
  const sessionId = await $.session.id()
  const saved = isStart ? ((await $.store.get(cacheKey(sessionId)).catch(() => null)) as SavedCache | null) : null
  const before = isStart ? null : await read($, snapshot)
  let toSave: SavedCache | undefined

  await update($, snapshot, prev => {
    let cache: Snapshot['cache']
    if (api) {
      const promptTokens = api.input_tokens + api.cache_read_input_tokens + api.cache_creation_input_tokens
      const signature = [api.input_tokens, api.output_tokens, api.cache_read_input_tokens, api.cache_creation_input_tokens].join('/')
      // The same response keeps its time. At load, the stored time is used when it is for this same response.
      const at =
        prev?.cache?.signature === signature
          ? prev.cache.at
          : isStart
            ? saved?.signature === signature
              ? saved.at
              : undefined
            : now
      if (at !== undefined && !isStart) toSave = { signature, at }
      cache = {
        signature,
        promptTokens,
        hitPercent: promptTokens > 0 ? Math.round((api.cache_read_input_tokens / promptTokens) * 100) : 0,
        at,
      }
    }
    const limits: Limit[] = usage.rateLimits.map(l => ({
      kind: l.kind,
      percentUsed: l.percentUsed,
      resetsAt: l.resetsAt ? Date.parse(l.resetsAt) : undefined,
    }))
    return {
      now,
      limits,
      ctxTokens: usage.context.tokens,
      ctxWindow: usage.context.window,
      ctxPercent: usage.context.percent,
      cache,
    }
  })

  if (toSave) await $.store.set(cacheKey(sessionId), toSave).catch(() => undefined)

  // A context that drops to under half its size was compacted. This catches a compaction
  // that the session.compact hook did not see.
  const ctx = usage.context.tokens
  if (before?.ctxTokens !== undefined && ctx !== undefined && ctx < before.ctxTokens / 2) await afterCompaction($)
}

// A compaction replaces the context. The old cache entry no longer applies, and the next send
// writes only the short summary, so the guard holds nothing until a new reply sets the time again.
async function afterCompaction($: EngineInterface) {
  await update($, snapshot, s => (s?.cache ? { ...s, cache: { ...s.cache, at: undefined } } : s))
  await $.store.delete(cacheKey(await $.session.id())).catch(() => undefined)
  // The session.compact hook and the context-drop check can both arrive here for one compaction.
  // Only the call that clears a 'manual' or 'running' hold sends it, so the prompt goes out once.
  let claimed: Pending | null = null
  await update($, pending, p => (p?.phase === 'manual' || p?.phase === 'running' ? ((claimed = p), null) : p))
  if (claimed) await $.prompt.submit({ text: (claimed as Pending).text, asUser: true })
}

// Sends the held prompt as the person's own words, and clears the hold.
async function sendHeld($: EngineInterface, text: string) {
  await update($, pending, () => null)
  // The guard put the held text back in the box. Clear it, but keep a draft the person changed.
  const box = await $.prompt.read().catch(() => undefined)
  if (box?.text?.trim() === text.trim()) await $.prompt.fill({ text: '' }).catch(() => undefined)
  await $.prompt.submit({ text, asUser: true })
}

// True only while this module's own compaction call runs. A reload starts it at false,
// so a 'compacting' phase left from an earlier module is seen as stale.
let compacting = false

// Puts the /compact line in the box. The person presses Enter, and the session.compact
// hook sends the held prompt after the compaction.
async function manualCompact($: EngineInterface, p: Pending) {
  await update($, pending, () => ({ ...p, phase: 'manual' as const }))
  await $.prompt.fill({ text: `/compact ${compactPrompt(p.text)}` }).catch(() => undefined)
}

// The desktop app and other SDK hosts cannot compact from a plugin call yet.
// After the first refusal, Compact & send goes straight to the /compact line.
let directCompact = true
const isHeadlessRefusal = (reason: string) => /headless|inside a turn/i.test(reason)

async function compactAndSend($: EngineInterface, p: Pending) {
  if (!directCompact) return manualCompact($, p)
  await update($, pending, () => ({ ...p, phase: 'compacting' as const }))
  let skip: string | undefined
  let failure: string | undefined
  compacting = true
  try {
    skip = (await $.session.compact({ instructions: compactPrompt(p.text) })).skip
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    compacting = false
  }
  // The person pressed Cancel while it ran: keep the compaction, send nothing.
  if ((await read($, pending)) === null) return
  // The call failed: the person's own /compact still works, so offer that line.
  if (failure !== undefined) {
    if (isHeadlessRefusal(failure)) directCompact = false
    $.ui.toast('Press Enter to compact. Your prompt sends after.')
    return manualCompact($, p)
  }
  if (skip !== undefined) {
    $.ui.toast(`Compaction skipped: ${skip}`)
    await update($, pending, () => ({ ...p, phase: 'idle' as const }))
    return
  }
  await sendHeld($, p.text)
}

// Decides if the guard holds this composer prompt. Returns the drop reason, or undefined to send it.
async function holdReason($: EngineInterface, e: { text: string; attachments?: readonly unknown[] }): Promise<string | undefined> {
  const held = await read($, pending)
  // A turn that starts while the compaction runs stops it. Nothing goes out until it ends.
  if (held?.phase === 'compacting' && !compacting) await update($, pending, () => ({ ...held, phase: 'idle' as const }))
  // A prompt with attachments goes through: dropping it would lose the images.
  else if (held?.phase === 'compacting' && !e.attachments?.length) {
    await $.prompt.fill({ text: e.text }).catch(() => undefined)
    return 'Held: compaction is running. Your prompt is back in the box.'
  }
  // The same text sent again while held means "send anyway".
  if (held && held.text === e.text) {
    await update($, pending, () => null)
    return undefined
  }

  const stored = await read($, snapshot)
  // The ticker updates 'now' once a minute. The guard uses the time of the send itself.
  const s = stored && { ...stored, now: await $.clock.now() }
  const tokens = s?.cache?.promptTokens ?? 0
  // A plugin's resend cannot carry pasted images, so a prompt with attachments is never held.
  if (!s || !isCold(s) || tokens < GUARD_MIN_TOKENS || e.attachments?.length) return undefined

  await update($, pending, () => ({ text: e.text, tokens, phase: 'idle' as const }))
  await $.prompt.fill({ text: e.text }).catch(() => undefined)
  return `Held: cache cold (${tok(tokens)}). Pick an option above the prompt.`
}

const LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: '$' }

// Ring fills. These hex values read on both light and dark backgrounds.
const HEX = { success: '#3fb950', warning: '#d29922', error: '#f85149', warm: '#58a6ff', cold: '#8b949e' } as const

// A 16px donut: a grey track and a coloured arc from 12 o'clock, clockwise.
const ring = (pct: number, color: string): string => {
  const r = 6
  const c = 2 * Math.PI * r
  const fill = (Math.min(100, Math.max(0, pct)) / 100) * c
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">` +
    `<circle cx="8" cy="8" r="${r}" fill="none" stroke="#8b949e" stroke-opacity="0.3" stroke-width="2.5"/>` +
    `<circle cx="8" cy="8" r="${r}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" ` +
    `stroke-dasharray="${fill.toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 8 8)"/>` +
    `</svg>`
  )
}

export const register: Register = on => {
  let ticker: Timer | undefined

  on('session.start', async ($, e, next) => {
    await refresh($, true)
    ticker?.cancel()
    ticker = $.clock.every(MINUTE, async () => {
      const now = await $.clock.now()
      await update($, snapshot, s => (s ? { ...s, now } : s))
    })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await refresh($, false)
    return next(e)
  })

  // The guard: a large prompt send onto a cold cache is held back, and the band offers to compact first.
  // An error in the guard lets the prompt through: a broken guard must never eat a prompt.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind !== 'composer' || e.command) return next(e)
    const drop = await holdReason($, e).catch(() => undefined)
    return drop === undefined ? next(e) : { drop }
  })

  // The person sent the suggested /compact line: the band stops asking for it.
  // The send itself waits for the compaction signal below, not for this command to return.
  on('command.run', { command: 'compact' }, async ($, e, next) => {
    await update($, pending, p => (p?.phase === 'manual' ? { ...p, phase: 'running' as const } : p)).catch(() => undefined)
    return next(e)
  })

  // After the person runs the suggested /compact, the held prompt goes out by itself.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.trigger !== 'precompute' && result.skip === undefined) void afterCompaction($).catch(() => undefined)
    return result
  })

  on('session.end', async ($, e, next) => {
    await update($, pending, () => null)
    if (e.reason === 'clear') await update($, snapshot, () => null)
    else {
      ticker?.cancel()
      ticker = undefined
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (e.props.hasSurvey || s === null) return next(e)

    const held = await read($, pending)
    if (held) {
      // A 'compacting' phase with no call in flight is stale (a reload or a failed call).
      const phase = held.phase === 'compacting' && !compacting ? 'idle' : held.phase
      const { Box, Text, Button } = $.ui.resolve(e)
      const preview = held.text.length > 60 ? `${held.text.slice(0, 60)}…` : held.text
      const message =
        phase === 'compacting' || phase === 'running'
          ? 'Compacting with your next prompt in mind… it sends by itself when done.'
          : phase === 'manual'
            ? 'Edit the /compact prompt in the box and send it. Your held prompt goes out after the compaction.'
            : `Cache is cold. Sending now writes ${tok(held.tokens)} tokens to the cache again. Held: "${preview}"`
      return (
        <Box flexDirection="column" gap="xs" paddingX="sm">
          <Text color={phase === 'idle' ? 'warning' : undefined} weight="semibold">{`⚠ ${message}`}</Text>
          <Box flexDirection="row" alignItems="center" gap="sm">
            {phase === 'idle'
              ? [
                  <Button key="compact" variant="primary" onPress={() => void compactAndSend($, held)}>
                    Compact & send
                  </Button>,
                  <Button
                    key="edit"
                    onPress={() => void manualCompact($, held)}
                  >
                    Edit compact prompt
                  </Button>,
                  <Button key="send" onPress={() => void sendHeld($, held.text)}>
                    Send anyway
                  </Button>,
                ]
              : null}
            <Button
              key="cancel"
              role="dismiss"
              onPress={async () => {
                await update($, pending, () => null)
                await $.prompt.fill({ text: held.text }).catch(() => undefined)
              }}
            >
              {phase === 'compacting' || phase === 'running' ? "Don't send after" : 'Cancel'}
            </Button>
          </Box>
        </Box>
      )
    }

    if (e.surface === 'desktop' || e.surface === 'mobile') {
      const { Box, Text, Svg } = $.ui.resolve(e)

      // One metric: a small ring, a bold label, the value and a dim detail.
      const item = (key: string, ring: string, alt: string, label: string, value: string, detail?: string) => (
        <Box key={key} flexDirection="row" alignItems="center" gap="xs">
          <Svg source={ring} alt={alt} width={14} height={14} />
          <Text size="footnote" weight="semibold">{label}</Text>
          <Text size="footnote" tabular>{value}</Text>
          {detail ? <Text size="footnote" dimColor>{detail}</Text> : null}
        </Box>
      )

      const limits = s.limits.filter(l => LABEL[l.kind])
      const row1 =
        limits.length === 0
          ? [<Text key="none" size="footnote" dimColor>Limits: waiting for a reply</Text>]
          : limits.map(l =>
              item(
                l.kind,
                ring(l.percentUsed, HEX[tone(l.percentUsed)]),
                `${LABEL[l.kind]} limit ${Math.round(l.percentUsed)}% used`,
                LABEL[l.kind] ?? l.kind,
                `${Math.round(l.percentUsed)}%`,
                l.resetsAt ? `resets in ${left(l.resetsAt - s.now)}` : undefined,
              ),
            )

      const ctxPct = s.ctxPercent ?? 0
      const row2 = [
        item(
          'ctx',
          ring(ctxPct, HEX[tone(ctxPct)]),
          `Context ${ctxPct}% full`,
          'Context',
          s.ctxTokens === undefined ? '–' : `${ctxPct}%`,
          s.ctxTokens === undefined ? undefined : `${tok(s.ctxTokens)} / ${tok(s.ctxWindow)}`,
        ),
      ]
      if (!s.cache || s.cache.at === undefined) {
        row2.push(item('cache', ring(0, HEX.cold), 'Cache unknown', 'Cache', '–', 'waiting for a reply'))
      } else {
        const msLeft = Math.max(0, CACHE_TTL_MS - (s.now - s.cache.at))
        const isWarm = msLeft > 0
        const warmth = (msLeft / CACHE_TTL_MS) * 100
        row2.push(
          item(
            'cache',
            ring(warmth, isWarm ? HEX.warm : HEX.cold),
            isWarm ? `Cache warm, ${left(msLeft)} left` : 'Cache cold',
            'Cache',
            isWarm ? `${left(msLeft)} left` : 'cold',
            `${s.cache.hitPercent}% hit · next ${isWarm ? 'reuses' : 're-caches'} ${tok(s.cache.promptTokens)}`,
          ),
        )
      }

      return (
        <Box flexDirection="column" gap="xs" paddingX="sm">
          <Box flexDirection="row" alignItems="center" gap="lg">{row1}</Box>
          <Box flexDirection="row" alignItems="center" gap="lg">{row2}</Box>
        </Box>
      )
    }

    const { Box, Text } = $.ui.resolve(e)
    const dot = (key: string) => <Text key={key} dimColor>{'  ·  '}</Text>

    // Line 1: rate-limit windows.
    const limits = s.limits.filter(l => LABEL[l.kind])
    const line1 =
      limits.length === 0
        ? [<Text key="none" dimColor>limits: waiting for a reply</Text>]
        : limits.flatMap((l, i) => {
            const parts = [
              <Text key={`${l.kind}-l`} dimColor>{`${LABEL[l.kind]} `}</Text>,
              <Text key={`${l.kind}-b`} color={tone(l.percentUsed)}>{`${bar(l.percentUsed)} ${Math.round(l.percentUsed)}%`}</Text>,
              <Text key={`${l.kind}-r`} dimColor>{l.resetsAt ? ` ↻${left(l.resetsAt - s.now)}` : ''}</Text>,
            ]
            return i === 0 ? parts : [dot(`${l.kind}-s`), ...parts]
          })

    // Line 2: context fill and prompt cache.
    const ctxPct = s.ctxPercent ?? 0
    const line2 = [
      <Text key="ctx-l" dimColor>ctx </Text>,
      <Text key="ctx-v" color={s.ctxTokens === undefined ? undefined : tone(ctxPct)}>
        {s.ctxTokens === undefined ? '–' : `${tok(s.ctxTokens)}/${tok(s.ctxWindow)} ${ctxPct}%`}
      </Text>,
      dot('sep'),
      <Text key="cache-l" dimColor>cache </Text>,
    ]

    if (!s.cache || s.cache.at === undefined) {
      line2.push(<Text key="cache-w" dimColor>– waiting for a reply</Text>)
    } else {
      const msLeft = CACHE_TTL_MS - (s.now - s.cache.at)
      const isWarm = msLeft > 0
      line2.push(
        <Text key="cache-s" color={isWarm ? 'success' : 'error'}>{isWarm ? `● warm ${left(msLeft)}` : '● cold'}</Text>,
        <Text key="cache-d" dimColor>
          {` · hit ${s.cache.hitPercent}% · next ${isWarm ? 'reuses' : 're-caches'} ${tok(s.cache.promptTokens)}`}
        </Text>,
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">{line1}</Box>
        <Box flexDirection="row">{line2}</Box>
      </Box>
    )
  })
}
