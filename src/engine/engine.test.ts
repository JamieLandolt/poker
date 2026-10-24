import { describe, expect, it } from 'vitest'
import { newDeck, parseCards, shuffle, type Card, type Rng } from './cards.ts'
import { compareScores, evaluate, Category } from './evaluate.ts'
import { buildPots, splitPot } from './pots.ts'
import { createGame, DEFAULT_SETTINGS, legalActions, reduce, totalChips, type ActKind, type GameState } from './game.ts'
import { decide } from './bots.ts'

function seeded(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const cat = (s: string) => evaluate(parseCards(s)).category
const cmp = (a: string, b: string) => compareScores(evaluate(parseCards(a)), evaluate(parseCards(b)))

// Reference: best of all 5-card combinations using the 5-card path of the evaluator.
function brute(cards: Card[]) {
  let best = evaluate(cards.slice(0, 5))
  const n = cards.length
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++)
    for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
      const sc = evaluate([cards[a], cards[b], cards[c], cards[d], cards[e]])
      if (compareScores(sc, best) > 0) best = sc
    }
  return best
}

describe('evaluate', () => {
  it('ranks each category', () => {
    expect(cat('As Kd 9c 5h 3d')).toBe(Category.HighCard)
    expect(cat('As Ad 9c 5h 3d')).toBe(Category.Pair)
    expect(cat('As Ad 9c 9h 3d')).toBe(Category.TwoPair)
    expect(cat('As Ad Ac 9h 3d')).toBe(Category.Trips)
    expect(cat('5s 6d 7c 8h 9d')).toBe(Category.Straight)
    expect(cat('As Kd Qc Jh Td')).toBe(Category.Straight)
    expect(cat('As 8s 9s 5s 3s')).toBe(Category.Flush)
    expect(cat('As Ad Ac 9h 9d')).toBe(Category.FullHouse)
    expect(cat('As Ad Ac Ah 9d')).toBe(Category.Quads)
    expect(cat('5s 6s 7s 8s 9s')).toBe(Category.StraightFlush)
  })
  it('treats the wheel as the lowest straight', () => {
    expect(cat('As 2d 3c 4h 5d')).toBe(Category.Straight)
    expect(cmp('As 2d 3c 4h 5d', '2s 3d 4c 5h 6d')).toBeLessThan(0)
    expect(cat('As 2s 3s 4s 5s')).toBe(Category.StraightFlush)
    expect(cat('Qs Kd Ac 2h 3d')).toBe(Category.HighCard) // no wrap-around
  })
  it('handles 7 cards', () => {
    expect(cat('As Ks Qs Js 9s Th 2d')).toBe(Category.Flush) // straight present but not straight flush
    expect(cat('As Ks Qs Js Ts 2h 2d')).toBe(Category.StraightFlush)
    expect(cat('Ac Ad Ah Kc Kd Kh 2s')).toBe(Category.FullHouse)
    expect(evaluate(parseCards('Ac Ad Ah Kc Kd Kh 2s')).ranks).toEqual([14, 13])
    // three pairs: best two pair, best kicker is the unused pair's rank
    expect(evaluate(parseCards('Ac Ad Kh Kd Qc Qd 2s')).ranks).toEqual([14, 13, 12])
    expect(cat('2c 2d 2h 2s Ac Ad Ah')).toBe(Category.Quads)
    expect(evaluate(parseCards('2c 2d 2h 2s Ac Ad Ah')).ranks).toEqual([2, 14])
    // flush uses top five suited cards
    expect(evaluate(parseCards('2s 4s 6s 8s Ts Qs Ah')).ranks).toEqual([12, 10, 8, 6, 4])
  })
  it('breaks ties by kickers and detects exact ties', () => {
    expect(cmp('As Ad Kc 5h 3d', 'Ac Ah Qc 5s 3h')).toBeGreaterThan(0)
    expect(cmp('As Kd Qc Jh 9d 2c 3c', 'Ac Kh Qd Jd 9h 4s 5s')).toBe(0)
  })
  it('matches a brute-force oracle on random 7-card hands', () => {
    const rng = seeded(42)
    for (let i = 0; i < 4000; i++) {
      const cards = shuffle(newDeck(), rng).slice(0, 7)
      expect(compareScores(evaluate(cards), brute(cards))).toBe(0)
    }
  })
})

describe('pots', () => {
  it('refunds an uncalled bet', () => {
    const r = buildPots([{ id: 0, total: 100, folded: false }, { id: 1, total: 40, folded: false }])
    expect(r.refund).toEqual({ id: 0, amount: 60 })
    expect(r.pots).toEqual([{ amount: 80, eligible: [0, 1] }])
  })
  it('builds side pots and keeps folded chips', () => {
    const r = buildPots([
      { id: 0, total: 50, folded: false },
      { id: 1, total: 100, folded: false },
      { id: 2, total: 100, folded: false },
      { id: 3, total: 30, folded: true },
    ])
    expect(r.refund).toBeNull()
    expect(r.pots).toEqual([
      { amount: 50 * 3 + 30, eligible: [0, 1, 2] },
      { amount: 100, eligible: [1, 2] },
    ])
  })
  it('conserves chips against a naive oracle', () => {
    const rng = seeded(7)
    for (let i = 0; i < 500; i++) {
      const players = Array.from({ length: 2 + Math.floor(rng() * 5) }, (_, id) => ({
        id, total: 1 + Math.floor(rng() * 20) * 10, folded: rng() < 0.3,
      }))
      if (players.every((p) => p.folded)) players[0].folded = false
      const r = buildPots(players)
      const sum = r.pots.reduce((a, p) => a + p.amount, 0) + (r.refund?.amount ?? 0)
      expect(sum).toBe(players.reduce((a, p) => a + p.total, 0))
      for (const p of r.pots) for (const id of p.eligible) expect(players[id].folded).toBe(false)
    }
  })
  it('splits odd chips one at a time in order', () => {
    expect([...splitPot(101, [3, 1])]).toEqual([[3, 51], [1, 50]])
    expect([...splitPot(5, [2, 0, 1])]).toEqual([[2, 2], [0, 2], [1, 1]])
  })
})

function rigged(top: string): Card[] {
  // deck is dealt with pop(), so the LAST cards are dealt first
  const wanted = parseCards(top)
  const rest = newDeck().filter((c) => !wanted.some((w) => w.rank === c.rank && w.suit === c.suit))
  return [...rest, ...wanted.reverse()]
}
const act = (s: GameState, kind: ActKind, raiseTo?: number) =>
  reduce(s, { type: 'act', handId: s.handId, seq: s.seq, seat: s.toAct, kind, raiseTo })

describe('game', () => {
  it('heads-up: button is small blind and acts first preflop, big blind first after', () => {
    let s = createGame({ ...DEFAULT_SETTINGS, bots: 1 })
    s = reduce(s, { type: 'startHand', deck: newDeck() })
    expect(s.players[s.button].bet).toBe(10)
    expect(s.toAct).toBe(s.button)
    s = act(s, 'call')
    expect(s.street).toBe('preflop') // big blind still has the option
    s = act(s, 'check')
    expect(s.street).toBe('flop')
    expect(s.toAct).not.toBe(s.button)
  })
  it('folding to the big blind ends the hand without showdown', () => {
    let s = createGame({ ...DEFAULT_SETTINGS, bots: 2 })
    s = reduce(s, { type: 'startHand', deck: newDeck() })
    const before = totalChips(s)
    s = act(s, 'fold'); s = act(s, 'fold')
    expect(s.phase).toBe('handOver')
    expect(s.result!.showdown).toBe(false)
    expect(totalChips(s)).toBe(before)
  })
  it('ignores stale or wrong-seat actions', () => {
    let s = createGame()
    s = reduce(s, { type: 'startHand', deck: newDeck() })
    expect(reduce(s, { type: 'act', handId: s.handId, seq: s.seq + 1, seat: s.toAct, kind: 'fold' })).toBe(s)
    expect(reduce(s, { type: 'act', handId: s.handId, seq: s.seq, seat: (s.toAct + 1) % 5, kind: 'fold' })).toBe(s)
  })
  it('a short all-in does not reopen raising for a player who already acted', () => {
    let s = createGame({ ...DEFAULT_SETTINGS, bots: 2 })
    s.players[1].stack = 70 // small blind: 10 posted, shoves to 70
    s = reduce(s, { type: 'startHand', deck: newDeck() })
    expect(s.toAct).toBe(0)
    s = act(s, 'raise', 60)
    expect(s.minRaise).toBe(40)
    expect(s.toAct).toBe(1)
    s = act(s, 'allin') // 70: only 10 over the bet, a short raise
    expect(s.currentBet).toBe(70)
    expect(s.minRaise).toBe(40)
    s = act(s, 'call') // big blind calls 70
    expect(s.toAct).toBe(0)
    const l = legalActions(s, 0)
    expect(l.canRaise).toBe(false)
    expect(l.callAmount).toBe(10)
    expect(act(s, 'raise', 200)).toBe(s)
    // but the big blind, who has not yet acted since the raise, could have raised
  })
  it('a full all-in raise reopens action', () => {
    let s = createGame({ ...DEFAULT_SETTINGS, bots: 2 })
    s.players[1].stack = 160 // shoves to 160: a 100 raise over 60
    s = reduce(s, { type: 'startHand', deck: newDeck() })
    s = act(s, 'raise', 60)
    s = act(s, 'allin')
    expect(s.minRaise).toBe(100)
    s = act(s, 'fold') // big blind
    expect(legalActions(s, 0).canRaise).toBe(false) // only one other player, all-in
    expect(legalActions(s, 0).callAmount).toBe(100)
  })
  it('all-in call on a short stack runs the board out and conserves chips', () => {
    let s = createGame({ ...DEFAULT_SETTINGS, bots: 1 })
    s.players[1].stack = 300
    s = reduce(s, { type: 'startHand', deck: newDeck() })
    const before = totalChips(s)
    s = act(s, 'allin'); s = act(s, 'call')
    expect(s.phase).toBe('handOver')
    expect(s.board).toHaveLength(5)
    expect(totalChips(s)).toBe(before)
  })
  it('awards the pot to the best hand', () => {
    let s = createGame({ ...DEFAULT_SETTINGS, bots: 1 })
    // deal order: first card to left of button. Compute rigged deck after seeing who is where.
    const probe = reduce(s, { type: 'startHand', deck: newDeck() })
    const btn = probe.button
    const other = 1 - btn
    // dealing alternates starting with `other`: other, btn, other, btn
    const deck = rigged(`As Kd Ah Kc 2c 7d 9h Js 3s`) // other: As Ah ; btn: Kd Kc ; board 2c 7d 9h Js 3s
    s = reduce(s, { type: 'startHand', deck })
    s = act(s, 'allin'); s = act(s, 'call')
    expect(s.result!.payouts[other]).toBeGreaterThan(0)
    expect(s.result!.payouts[btn] ?? 0).toBe(0)
    expect(s.result!.hands[other]).toBe('Pair')
  })
})

describe('property: random play', () => {
  function playHand(s: GameState, rng: Rng, mode: 'random' | 'bots' | 'shove'): GameState {
    s = reduce(s, { type: 'startHand', deck: shuffle(newDeck(), rng) })
    const start = totalChips(s)
    let guard = 0
    while (s.phase === 'betting') {
      if (++guard > 200) throw new Error('hand did not terminate')
      const seat = s.toAct
      expect(seat).toBeGreaterThanOrEqual(0)
      const lg = legalActions(s, seat)
      let next: GameState
      if (mode === 'bots') {
        const d = decide(s, seat, rng)
        next = reduce(s, { type: 'act', handId: s.handId, seq: s.seq, seat, kind: d.kind, raiseTo: d.raiseTo })
        if (next === s) throw new Error(`bot made illegal action ${JSON.stringify(d)}`)
      } else {
        const r = rng()
        let kind: ActKind = lg.canCheck ? 'check' : 'call'
        let raiseTo: number | undefined
        if (mode === 'shove' && r < 0.5 && lg.canAllIn) kind = 'allin'
        else if (r < 0.15) kind = lg.canCheck ? 'check' : 'fold'
        else if (r < 0.4 && lg.canRaise) {
          kind = 'raise'
          raiseTo = lg.minRaiseTo + Math.floor(rng() * (lg.maxRaiseTo - lg.minRaiseTo + 1))
        }
        next = reduce(s, { type: 'act', handId: s.handId, seq: s.seq, seat, kind, raiseTo })
        if (next === s) throw new Error(`illegal ${kind} ${raiseTo} ${JSON.stringify(lg)}`)
      }
      s = next
      expect(totalChips(s)).toBe(start)
      for (const p of s.players) expect(p.stack).toBeGreaterThanOrEqual(0)
    }
    expect(totalChips(s)).toBe(start)
    expect(s.board.length === 0 || s.board.length === 5 || s.result!.showdown === false || s.board.length === 5).toBe(true)
    if (s.result!.showdown) expect(s.board).toHaveLength(5)
    expect(Object.values(s.result!.payouts).reduce((a, b) => a + b, 0)).toBe(
      s.players.reduce((a, p) => a + p.total, 0),
    )
    return s
  }
  for (const mode of ['random', 'bots', 'shove'] as const) {
    for (const bots of [1, 2, 4]) {
      it(`${mode} play with ${bots} bots`, () => {
        const rng = seeded(1000 + bots)
        let s = createGame({ ...DEFAULT_SETTINGS, bots })
        for (let i = 0; i < 400; i++) {
          if (s.players[0].stack === 0) s = reduce(s, { type: 'rebuy' })
          s = playHand(s, rng, mode)
        }
      })
    }
  }
})
