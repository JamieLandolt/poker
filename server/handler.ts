import { newDeck, secureRng, shuffle, type Card } from '../src/engine/cards.ts'
import {
  act, cleanName, createTable, holeCards, kick, leave, migrate, publicView, rebuy, rename, setPaused, setSettings, setSitOut, sit, tick,
  DEFAULT_TABLE_SETTINGS, TableError, type Table, type TableSettings,
} from '../src/engine/table.ts'

/** What a transaction sees and returns. The Firestore store and the in-memory test store both implement this. */
export interface Loaded {
  table: Table | null
  /** uid -> last ping (ms). */
  presence: Record<string, number>
}
export interface Store {
  /** Run `fn` atomically against one table. `fn` returns the new table (or null for no change) and extra hole-card docs to write. */
  run<T>(code: string, fn: (l: Loaded) => { table: Table | null; result: T }): Promise<T>
  ping(code: string, uid: string, now: number): Promise<void>
}

export interface Request {
  type: string
  code?: string
  [k: string]: unknown
}
export interface Response {
  ok: boolean
  error?: string
  code?: string
  version?: number
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/

export function newCode(rng: () => number = secureRng): string {
  return Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(rng() * CODE_CHARS.length)]).join('')
}

const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : NaN)

function parseSettings(v: unknown): TableSettings {
  const o = (v ?? {}) as Record<string, unknown>
  // Only a missing field falls back to the default; null/NaN from a cleared input is rejected by validation.
  const pick = (k: keyof TableSettings) => int(o[k] === undefined ? DEFAULT_TABLE_SETTINGS[k] : o[k])
  return {
    smallBlind: pick('smallBlind'),
    bigBlind: pick('bigBlind'),
    startStack: pick('startStack'),
    buyInCents: pick('buyInCents'),
    turnSecs: DEFAULT_TABLE_SETTINGS.turnSecs,
  }
}

export interface HandlerDeps {
  store: Store
  now: () => number
  deck?: () => Card[]
  newCode?: () => string
}

/** Core request handler: `uid` is already authenticated by the caller. */
export async function handle(uid: string, req: Request, deps: HandlerDeps): Promise<Response> {
  const now = deps.now()
  const deckFn = deps.deck ?? (() => shuffle(newDeck(), secureRng))
  try {
    if (req.type === 'create') {
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = (deps.newCode ?? newCode)()
        const created = await deps.store.run(code, (l) => {
          if (l.table) return { table: null, result: false }
          const t = createTable(code, uid, parseSettings(req.settings), now)
          return { table: t, result: true }
        })
        if (created) return { ok: true, code }
      }
      return { ok: false, error: 'Could not create a table, try again' }
    }

    const code = String(req.code ?? '').toUpperCase()
    if (!CODE_RE.test(code)) return { ok: false, error: 'Bad table code' }

    if (req.type === 'ping') {
      await deps.store.ping(code, uid, now)
      return { ok: true }
    }

    let version = 0
    const out = await deps.store.run(code, (l) => {
      const t = l.table ? migrate(l.table) : null
      if (!t) return { table: null, result: { ok: false, error: 'Table not found' } as Response }
      const before = t.version
      // merge presence pings into seats, then handle anything that is due
      for (const s of t.seats) if (s && l.presence[s.uid] && l.presence[s.uid] > s.lastSeen) s.lastSeen = Math.min(l.presence[s.uid], now)
      const seat = t.seats.find((s) => s?.uid === uid)
      if (seat) seat.lastSeen = now
      if (req.type !== 'tick') tick(t, now, deckFn)
      switch (req.type) {
        case 'tick': tick(t, now, deckFn); break
        case 'sit': sit(t, uid, req.name, req.seat == null ? undefined : int(req.seat), now); break
        case 'leave': leave(t, uid, now); break
        case 'rebuy': rebuy(t, uid); break
        case 'sitOut': setSitOut(t, uid, !!req.out, now); break
        case 'kick': kick(t, uid, String(req.target ?? ''), now); break
        case 'settings': setSettings(t, uid, parseSettings(req.settings)); break
        case 'rename': rename(t, uid, req.name); break
        case 'pause': setPaused(t, uid, !!req.on, now); break
        case 'act': {
          const kind = String(req.kind)
          if (!['fold', 'check', 'call', 'raise', 'allin'].includes(kind)) throw new TableError('Bad action')
          const applied = act(t, uid, {
            handId: int(req.handId), seq: int(req.seq), kind: kind as 'fold', raiseTo: req.raiseTo === undefined ? undefined : int(req.raiseTo),
          }, now)
          if (!applied) {
            // stale click or illegal raise: persist any due ticks, but tell the player nothing happened
            return { table: t.version !== before ? t : null, result: { ok: false, error: 'That move is no longer valid' } as Response }
          }
          break
        }
        default: throw new TableError('Unknown request')
      }
      version = t.version
      return { table: t.version !== before || req.type === 'sit' ? t : null, result: { ok: true, version } as Response }
    })
    return out
  } catch (e) {
    if (e instanceof TableError) return { ok: false, error: e.message }
    console.error('handler error', e)
    return { ok: false, error: 'Server error' }
  }
}

export { cleanName, holeCards, publicView }
