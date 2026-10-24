import { useCallback, useEffect, useReducer } from 'react'
import { decide } from './engine/bots.ts'
import { newDeck, secureRng, shuffle } from './engine/cards.ts'
import { createGame, DEFAULT_SETTINGS, reduce, type ActKind, type Settings } from './engine/game.ts'

const KEY = 'poker:settings:v1'

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    const ok = (n: unknown, lo: number, hi: number) => Number.isInteger(n) && (n as number) >= lo && (n as number) <= hi
    if (raw && ok(raw.bots, 1, 5) && ok(raw.smallBlind, 1, 10000) && ok(raw.bigBlind, 2, 20000) && raw.bigBlind >= raw.smallBlind && ok(raw.startStack, 20, 10_000_000)) {
      return raw as Settings
    }
  } catch { /* storage unavailable or corrupt */ }
  return DEFAULT_SETTINGS
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* ignore */ }
}

export function useGame() {
  const [state, dispatch] = useReducer(reduce, undefined, () => createGame(loadSettings()))

  // One bot action per (hand, seq). The timer is cleared whenever either changes or the component unmounts.
  const { phase, toAct, handId, seq } = state
  useEffect(() => {
    if (phase !== 'betting' || toAct < 0 || state.players[toAct].human) return
    const humanOut = state.players[0].folded
    const t = window.setTimeout(() => {
      const d = decide(state, toAct, secureRng)
      dispatch({ type: 'act', handId, seq, seat: toAct, kind: d.kind, raiseTo: d.raiseTo })
    }, humanOut ? 300 : 600 + Math.random() * 600)
    return () => window.clearTimeout(t)
    // `state` is intentionally read at effect creation; handId/seq change on every applied action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, toAct, handId, seq])

  const deal = useCallback(() => dispatch({ type: 'startHand', deck: shuffle(newDeck(), secureRng) }), [])
  const act = useCallback(
    (kind: ActKind, raiseTo?: number) => dispatch({ type: 'act', handId, seq, seat: 0, kind, raiseTo }),
    [handId, seq],
  )
  const rebuy = useCallback(() => dispatch({ type: 'rebuy' }), [])
  const newGame = useCallback((s: Settings) => { saveSettings(s); dispatch({ type: 'newGame', settings: s }) }, [])
  return { state, deal, act, rebuy, newGame }
}
