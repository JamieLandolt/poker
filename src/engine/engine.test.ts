import { describe, expect, it } from 'vitest'
import { newDeck, parseCards, shuffle, type Card, type Rng } from './cards.ts'
import { compareScores, evaluate, Category } from './evaluate.ts'
import { buildPots, splitPot } from './pots.ts'
import { applyAction, dealHand, foldOut, legalActions, totalChips, type ActKind, type HandState } from './game.ts'

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
  it('pays folded chips to the last live player even if they put nothing in', () => {
    const r = buildPots([
      { id: 0, total: 10, folded: true },
      { id: 1, total: 20, folded: true },
      { id: 2, total: 0, folded: false },
    ])
    expect(r.refund).toEqual({ id: 1, amount: 10 })
    expect(r.pots).toEqual([{ amount: 20, eligible: [2] }])
  })
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
const blinds = { smallBlind: 10, bigBlind: 20 }
function deal(stacks: number[], button = 0, deck: Card[] = newDeck()): HandState {
  return dealHand({
    players: stacks.map((stack, i) => ({ uid: `u${i}`, seat: i, name: `P${i}`, stack })),
    button, blinds, deck, handId: 1,
  })
}
const act = (s: HandState, kind: ActKind, raiseTo?: number) =>
  applyAction(s, { handId: s.handId, seq: s.seq, seat: s.toAct, kind, raiseTo })

describe('game', () => {
  it('heads-up: button is small blind and acts first preflop, big blind first after', () => {
    let s = deal([1000, 1000], 0)
    expect(s.players[0].bet).toBe(10)
    expect(s.toAct).toBe(0)
    s = act(s, 'call')
    expect(s.street).toBe('preflop') // big blind still has the option
    s = act(s, 'check')
    expect(s.street).toBe('flop')
    expect(s.toAct).toBe(1)
  })
  it('three-handed blind and action order', () => {
    const s = deal([1000, 1000, 1000], 0)
    expect([s.sb, s.bb, s.toAct]).toEqual([1, 2, 0])
  })
  it('folding to the big blind ends the hand without showdown', () => {
    let s = deal([1000, 1000, 1000])
    const before = totalChips(s)
    s = act(s, 'fold'); s = act(s, 'fold')
    expect(s.phase).toBe('handOver')
    expect(s.result!.showdown).toBe(false)
    expect(totalChips(s)).toBe(before)
  })
  it('ignores stale or wrong-seat actions', () => {
    const s = deal([1000, 1000, 1000])
    expect(applyAction(s, { handId: s.handId, seq: s.seq + 1, seat: s.toAct, kind: 'fold' })).toBe(s)
    expect(applyAction(s, { handId: s.handId, seq: s.seq, seat: (s.toAct + 1) % 3, kind: 'fold' })).toBe(s)
    expect(applyAction(s, { handId: 99, seq: s.seq, seat: s.toAct, kind: 'fold' })).toBe(s)
  })
  it('a short all-in does not reopen raising for a player who already acted', () => {
    let s = deal([1000, 80, 1000]) // seat 1 is small blind: 10 posted, shoves to 80
    s = act(s, 'raise', 60)
    expect(s.minRaise).toBe(40)
    s = act(s, 'allin') // 80: only 20 over the bet, a short raise
    expect(s.currentBet).toBe(80)
    expect(s.minRaise).toBe(40)
    s = act(s, 'call') // big blind calls 80
    expect(s.toAct).toBe(0)
    const l = legalActions(s, 0)
    expect(l.canRaise).toBe(false)
    expect(l.callAmount).toBe(20)
    expect(act(s, 'raise', 300)).toBe(s)
  })
  it('a full all-in raise reopens action for others', () => {
    let s = deal([1000, 170, 1000])
    s = act(s, 'raise', 60)
    s = act(s, 'allin') // 170, a 110 raise
    expect(s.minRaise).toBe(110)
    s = act(s, 'call') // big blind
    expect(legalActions(s, 0).canRaise).toBe(true)
    expect(legalActions(s, 0).minRaiseTo).toBe(280)
  })
  it('all-in call runs the board out and conserves chips', () => {
    let s = deal([1000, 300])
    const before = totalChips(s)
    s = act(s, 'allin'); s = act(s, 'call')
    expect(s.phase).toBe('handOver')
    expect(s.board).toHaveLength(5)
    expect(totalChips(s)).toBe(before)
  })
  it('awards the pot to the best hand', () => {
    // button 0 (heads-up): dealing starts with seat 1, then seat 0, twice
    const s0 = deal([1000, 1000], 0, rigged('As Kd Ah Kc 2c 7d 9h Js 3s'))
    let s = act(s0, 'allin'); s = act(s, 'call')
    expect(s.result!.payouts[1]).toBeGreaterThan(0)
    expect(s.result!.payouts[0] ?? 0).toBe(0)
    expect(s.result!.hands[1]).toBe('Pair')
  })
  describe('foldOut', () => {
    it('folds a player who is not acting and keeps the actor', () => {
      let s = deal([1000, 1000, 1000, 1000], 0) // sb1 bb2, utg=3
      expect(s.toAct).toBe(3)
      s = foldOut(s, 1)
      expect(s.players[1].folded).toBe(true)
      expect(s.toAct).toBe(3)
      expect(s.phase).toBe('betting')
    })
    it('folds the actor and moves on', () => {
      let s = deal([1000, 1000, 1000, 1000], 0)
      s = foldOut(s, 3)
      expect(s.toAct).toBe(0)
    })
    it('ends the hand when one player is left', () => {
      let s = deal([1000, 1000])
      s = foldOut(s, 1)
      expect(s.phase).toBe('handOver')
      expect(s.result!.payouts[0]).toBe(20) // pays 10, big blind refunded 10
    })
    it('completes the round when the remaining players already matched', () => {
      let s = deal([1000, 1000, 1000], 0) // actor 0
      s = act(s, 'call')
      s = act(s, 'call') // small blind completes; big blind has the option
      expect(s.toAct).toBe(2)
      s = foldOut(s, 1) // small blind leaves: only 0 and 2 left, 2 still has option
      expect(s.phase).toBe('betting')
      expect(s.toAct).toBe(2)
      s = act(s, 'check')
      expect(s.street).toBe('flop')
    })
    it('never folds an all-in player', () => {
      let s = deal([1000, 100, 1000])
      s = act(s, 'call')
      s = act(s, 'allin')
      const same = foldOut(s, 1)
      expect(same).toBe(s)
    })
  })
})

describe('property: random play', () => {
  function playHand(rng: Rng, n: number, mode: 'random' | 'shove'): void {
    const stacks = Array.from({ length: n }, () => 20 + Math.floor(rng() * 40) * 50)
    let s = deal(stacks, Math.floor(rng() * n), shuffle(newDeck(), rng))
    const start = totalChips(s)
    let guard = 0
    while (s.phase === 'betting') {
      if (++guard > 300) throw new Error('hand did not terminate')
      const seat = s.toAct
      expect(seat).toBeGreaterThanOrEqual(0)
      const lg = legalActions(s, seat)
      const r = rng()
      let kind: ActKind = lg.canCheck ? 'check' : 'call'
      let raiseTo: number | undefined
      if (r < 0.04) { // someone leaves mid-hand
        const idx = Math.floor(rng() * n)
        const before = s
        s = foldOut(s, idx)
        if (s !== before) expect(totalChips(s)).toBe(start)
        continue
      }
      if (mode === 'shove' && r < 0.5 && lg.canAllIn) kind = 'allin'
      else if (r < 0.2) kind = lg.canCheck ? 'check' : 'fold'
      else if (r < 0.45 && lg.canRaise) {
        kind = 'raise'
        raiseTo = lg.minRaiseTo + Math.floor(rng() * (lg.maxRaiseTo - lg.minRaiseTo + 1))
      }
      const next = applyAction(s, { handId: s.handId, seq: s.seq, seat, kind, raiseTo })
      if (next === s) throw new Error(`illegal ${kind} ${raiseTo} ${JSON.stringify(lg)}`)
      s = next
      expect(totalChips(s)).toBe(start)
      for (const p of s.players) expect(p.stack).toBeGreaterThanOrEqual(0)
    }
    expect(totalChips(s)).toBe(start)
    if (s.result!.showdown) expect(s.board).toHaveLength(5)
    expect(Object.values(s.result!.payouts).reduce((a, b) => a + b, 0)).toBe(s.players.reduce((a, p) => a + p.total, 0))
  }
  for (const mode of ['random', 'shove'] as const) {
    for (const n of [2, 3, 6, 9]) {
      it(`${mode} play with ${n} players`, () => {
        const rng = seeded(500 + n)
        for (let i = 0; i < 400; i++) playHand(rng, n, mode)
      })
    }
  }
})
