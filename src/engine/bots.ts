import type { Card, Rng } from './cards.ts'
import { Category, evaluate } from './evaluate.ts'
import { legalActions, type ActKind, type GameState } from './game.ts'

export interface Decision {
  kind: ActKind
  raiseTo?: number
}

/** Chen-formula style preflop strength, scaled to roughly 0..1. */
export function preflopStrength(hole: readonly Card[]): number {
  const [a, b] = hole[0].rank >= hole[1].rank ? [hole[0], hole[1]] : [hole[1], hole[0]]
  const pts = (r: number) => (r === 14 ? 10 : r === 13 ? 8 : r === 12 ? 7 : r === 11 ? 6 : r / 2)
  let s = pts(a.rank)
  if (a.rank === b.rank) s = Math.max(5, s * 2)
  if (a.suit === b.suit) s += 2
  const gap = a.rank - b.rank - 1
  if (a.rank !== b.rank) {
    s -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5
    if (gap <= 1 && a.rank < 12) s += 1
  }
  return Math.min(1, Math.max(0, (s + 1) / 21))
}

export function postflopStrength(hole: readonly Card[], board: readonly Card[]): number {
  const sc = evaluate([...hole, ...board])
  const holeRanks = hole.map((c) => c.rank)
  const boardMax = Math.max(...board.map((c) => c.rank))
  let s: number
  switch (sc.category) {
    case Category.HighCard: s = 0.12 + Math.max(...holeRanks) / 120; break
    case Category.Pair: {
      const used = holeRanks.includes(sc.ranks[0] as never)
      s = !used ? 0.22 : sc.ranks[0] >= boardMax ? 0.58 : 0.42
      break
    }
    case Category.TwoPair: s = 0.74; break
    case Category.Trips: s = 0.8; break
    case Category.Straight: s = 0.88; break
    case Category.Flush: s = 0.9; break
    case Category.FullHouse: s = 0.96; break
    default: s = 0.99
  }
  // Flush draw bonus (not on the river).
  if (board.length < 5 && sc.category < Category.Flush) {
    const suits = new Map<string, number>()
    for (const c of [...hole, ...board]) suits.set(c.suit, (suits.get(c.suit) ?? 0) + 1)
    if ([...suits.values()].some((n) => n === 4)) s += 0.14
  }
  return Math.min(1, s)
}

/** Choose an action. Only looks at the seat's own hole cards and the public state. */
export function decide(state: GameState, seat: number, rng: Rng): Decision {
  const p = state.players[seat]
  const lg = legalActions(state, seat)
  const pot = state.players.reduce((a, x) => a + x.total, 0)
  const raw = state.board.length === 0 ? preflopStrength(p.hole) : postflopStrength(p.hole, state.board)
  const strength = Math.min(1, Math.max(0, raw + (rng() - 0.5) * 0.16))
  const { loose, aggro } = p.persona

  const sized = (frac: number): Decision => {
    if (!lg.canRaise) return lg.canCheck ? { kind: 'check' } : { kind: 'call' }
    const target = Math.round(state.currentBet + Math.max(state.minRaise, frac * pot * (0.8 + rng() * 0.4)))
    const raiseTo = Math.min(lg.maxRaiseTo, Math.max(lg.minRaiseTo, target))
    return raiseTo >= lg.maxRaiseTo ? { kind: 'allin' } : { kind: 'raise', raiseTo }
  }

  if (lg.canCheck) {
    if (strength > 0.62 / aggro && rng() < 0.75) return sized(0.4 + strength * 0.5)
    if (rng() < 0.05 * aggro * loose) return sized(0.5)
    return { kind: 'check' }
  }
  const toCall = lg.callAmount
  const odds = toCall / (pot + toCall)
  if (strength > 0.82 && rng() < 0.55 * aggro) return sized(0.7 + strength * 0.5)
  // Tight players need more than the pot odds say; loose ones less.
  if (strength > odds + 0.12 / loose) {
    // Don't call off a huge share of the stack with a marginal hand.
    if (toCall >= p.stack && strength < 0.55) return { kind: 'fold' }
    return { kind: 'call' }
  }
  if (rng() < 0.04 * aggro && lg.canRaise) return sized(0.8)
  return { kind: 'fold' }
}
