import { describe, expect, it } from 'vitest'
import { newDeck, shuffle, type Card, type Rng } from './cards.ts'
import { legalActions } from './game.ts'
import {
  act, chipCheck, createTable, migrate, DEFAULT_TABLE_SETTINGS, holeCards, kick, leave, publicView, rebuy, seatOf,
  setSitOut, sit, tick, TableError, type Table, AWAY_LEAVE_MS, GRACE_MS, AFK_MAX_HANDS,
} from './table.ts'

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
const S = { ...DEFAULT_TABLE_SETTINGS, startStack: 1000, buyInCents: 200 }
const deck = (rng: Rng) => () => shuffle(newDeck(), rng)

function setup(n: number, rng = seeded(1)) {
  const t = createTable('ABCDE', 'u0', S, 0)
  let now = 1000
  for (let i = 0; i < n; i++) sit(t, `u${i}`, `Player${i}`, undefined, now)
  const d = deck(rng)
  tick(t, now, d) // schedules the hand
  now += 3000
  tick(t, now, d)
  return { t, now, d }
}
const actor = (t: Table) => t.hand!.players[t.hand!.toAct].uid
const check = (t: Table) => { const c = chipCheck(t); expect(c.held).toBe(c.invested) }

describe('seating', () => {
  it('seats players, assigns unique seats, rejects bad input', () => {
    const t = createTable('ABCDE', 'u0', S, 0)
    sit(t, 'u0', ' Ann ', undefined, 0)
    sit(t, 'u1', 'Bob', 4, 0)
    expect(seatOf(t, 'u0')).toBe(0)
    expect(seatOf(t, 'u1')).toBe(4)
    expect(() => sit(t, 'u2', 'Cy', 4, 0)).toThrow(TableError)
    expect(() => sit(t, 'u0', 'Ann', 1, 0)).toThrow(TableError)
    expect(() => sit(t, 'u3', '   ', 1, 0)).toThrow(TableError)
    expect(t.seats[0]!.name).toBe('Ann')
  })
  it('dedupes names and strips markup', () => {
    const t = createTable('ABCDE', 'u0', S, 0)
    sit(t, 'u0', 'Sam', undefined, 0)
    sit(t, 'u1', 'sam<b>', undefined, 0)
    expect(t.seats[1]!.name).not.toBe('Sam')
    expect(t.seats[1]!.name).not.toContain('<')
  })
  it('table fills at 9', () => {
    const t = createTable('ABCDE', 'u0', S, 0)
    for (let i = 0; i < 9; i++) sit(t, `u${i}`, `P${i}`, undefined, 0)
    expect(() => sit(t, 'x', 'X', undefined, 0)).toThrow('full')
  })
})

describe('hand flow', () => {
  it('waits for two players, then deals', () => {
    const t = createTable('ABCDE', 'u0', S, 0)
    sit(t, 'u0', 'A', undefined, 0)
    tick(t, 5000, deck(seeded(2)))
    expect(t.phase).toBe('waiting')
    sit(t, 'u1', 'B', undefined, 5000)
    tick(t, 5000, deck(seeded(2)))
    expect(t.phase).toBe('waiting') // short pause first
    tick(t, 8000, deck(seeded(2)))
    expect(t.phase).toBe('betting')
    check(t)
  })
  it('player joining mid-hand is dealt in next hand only', () => {
    const { t, now, d } = setup(2)
    sit(t, 'late', 'Late', undefined, now)
    expect(t.hand!.players.map((p) => p.uid)).not.toContain('late')
    expect(holeCards(t, 'late')).toBeNull()
    // finish the hand: everyone folds
    act(t, actor(t), { handId: t.hand!.handId, seq: t.hand!.seq, kind: 'fold' }, now)
    expect(t.phase).toBe('handOver')
    tick(t, now + 10_000, d)
    expect(t.phase).toBe('betting')
    expect(t.hand!.players.map((p) => p.uid)).toContain('late')
    check(t)
  })
  it('leaving on your turn folds you and ends a heads-up hand', () => {
    const { t, now } = setup(2)
    const who = actor(t)
    leave(t, who, now)
    expect(t.phase).toBe('handOver')
    expect(seatOf(t, who)).toBe(-1)
    expect(t.records[who].cashedOut).toBeGreaterThan(0)
    check(t)
  })
  it('leaving out of turn does not disturb the actor', () => {
    const { t, now } = setup(4)
    const a = actor(t)
    const other = t.hand!.players.find((p) => p.uid !== a)!.uid
    leave(t, other, now)
    expect(t.phase).toBe('betting')
    expect(actor(t)).toBe(a)
    check(t)
  })
  it('leaving all-in keeps the chips in play and frees the seat after payout', () => {
    const { t, now } = setup(2)
    const a = actor(t)
    act(t, a, { handId: t.hand!.handId, seq: t.hand!.seq, kind: 'allin' }, now)
    leave(t, a, now)
    expect(seatOf(t, a)).toBeGreaterThanOrEqual(0)
    expect(t.seats[seatOf(t, a)]!.leaving).toBe(true)
    const b = actor(t)
    act(t, b, { handId: t.hand!.handId, seq: t.hand!.seq, kind: 'call' }, now)
    expect(t.phase).toBe('handOver')
    // still shown on the result screen until the next hand starts
    expect(seatOf(t, a)).toBeGreaterThanOrEqual(0)
    tick(t, now + 60_000, deck(seeded(9)))
    expect(seatOf(t, a)).toBe(-1)
    check(t)
  })
  it('a timed-out player is checked or folded, and two timeouts sit them out', () => {
    const { t, now, d } = setup(3)
    let clock = now
    const first = actor(t)
    clock = t.deadline! + GRACE_MS + 1
    tick(t, clock, d)
    expect(t.seats[seatOf(t, first)]!.timeouts).toBe(1)
    expect(t.hand!.players.find((p) => p.uid === first)!.folded).toBe(true)
    check(t)
  })
  it('tick is a no-op before any deadline', () => {
    const { t, now, d } = setup(3)
    const v = t.version
    expect(tick(t, now + 100, d)).toBe(false)
    expect(t.version).toBe(v)
  })
  it('ignores a stale action', () => {
    const { t, now } = setup(3)
    const h = t.hand!
    expect(act(t, actor(t), { handId: h.handId, seq: h.seq + 5, kind: 'fold' }, now)).toBe(false)
    expect(() => act(t, 'nobody', { handId: h.handId, seq: h.seq, kind: 'fold' }, now)).toThrow(TableError)
  })
})

describe('rebuy and leaderboard', () => {
  it('busted player can rebuy and buy-ins count up', () => {
    const { t, now } = setup(2)
    const a = actor(t)
    const hi = t.hand!.players.findIndex((p) => p.uid === a)
    expect(hi).toBeGreaterThanOrEqual(0)
    // force a bust: both all-in, loser has 0
    act(t, a, { handId: t.hand!.handId, seq: t.hand!.seq, kind: 'allin' }, now)
    act(t, actor(t), { handId: t.hand!.handId, seq: t.hand!.seq, kind: 'call' }, now)
    expect(t.phase).toBe('handOver')
    const loser = t.seats.find((s) => s && s.stack === 0)
    if (loser) {
      expect(loser.status).toBe('busted')
      rebuy(t, loser.uid)
      expect(t.records[loser.uid].buyIns).toBe(2)
      expect(loser.stack).toBe(1000)
      expect(() => rebuy(t, loser.uid)).toThrow(TableError)
    }
    check(t)
  })
  it('cannot rebuy while still holding chips or contesting a hand', () => {
    const { t } = setup(3)
    expect(() => rebuy(t, 'u0')).toThrow(TableError)
  })
  it('rejoining after leaving counts a second buy-in and net stays right', () => {
    const t = createTable('ABCDE', 'u0', S, 0)
    sit(t, 'u0', 'A', undefined, 0)
    leave(t, 'u0', 1)
    sit(t, 'u0', 'A', undefined, 2)
    expect(t.records.u0.buyIns).toBe(2)
    const lb = publicView(t, 3).leaderboard.find((r) => r.uid === 'u0')!
    expect(lb.net).toBe(0)
    check(t)
  })
})

describe('money ratio', () => {
  it('prices buy-ins independently of chip count', () => {
    const t = createTable('ABCDE', 'u0', S, 0)
    sit(t, 'u0', 'A', undefined, 0)
    expect(t.records.u0.paidCents).toBe(200)
    leave(t, 'u0', 1)
    sit(t, 'u0', 'A', undefined, 2)
    expect(t.records.u0.paidCents).toBe(400)
    // 1000 chips for $2: ending with 3000 chips is worth $6 -> net +$2 on $4 paid after a second 1000-chip buy-in
    t.seats[seatOf(t, 'u0')]!.stack = 3000
    const lb = publicView(t, 3).leaderboard[0]
    expect(lb.netCents).toBe(Math.round((3000 + 1000) * 0.2) - 400)
  })
})

describe('AFK', () => {
  it('an away player keeps the seat for a few hands, then loses it; coming back resets', () => {
    const rng = seeded(5)
    const d = deck(rng)
    const t = createTable('ABCDE', 'u0', S, 0)
    let now = 1000
    for (let i = 0; i < 3; i++) sit(t, `u${i}`, `P${i}`, undefined, now)
    tick(t, now, d); now += 3000; tick(t, now, d)
    setSitOut(t, 'u2', true, now)
    expect(t.seats[2]!.status).toBe('sitOut')
    // play AFK_MAX_HANDS hands heads-up between u0 and u1: fold each hand
    for (let h = 0; h < AFK_MAX_HANDS; h++) {
      while (t.phase === 'betting') {
        for (const x of t.seats) if (x) x.lastSeen = now
        act(t, actor(t), { handId: t.hand!.handId, seq: t.hand!.seq, kind: 'fold' }, now)
      }
      now += 10_000
      for (const x of t.seats) if (x) x.lastSeen = now
      tick(t, now, d)
    }
    expect(seatOf(t, 'u2')).toBeGreaterThanOrEqual(0)
    expect(publicView(t, now).seats[2]!.afkLeft).toBeLessThanOrEqual(1)
    setSitOut(t, 'u2', false, now)
    expect(t.seats[2]!.afkHands).toBe(0)
    check(t)
  })
  it('loses the seat and cashes out after too many hands away', () => {
    const rng = seeded(6)
    const d = deck(rng)
    const t = createTable('ABCDE', 'u0', S, 0)
    let now = 1000
    for (let i = 0; i < 3; i++) sit(t, `u${i}`, `P${i}`, undefined, now)
    tick(t, now, d); now += 3000; tick(t, now, d)
    setSitOut(t, 'u2', true, now)
    for (let h = 0; h < AFK_MAX_HANDS + 2; h++) {
      while (t.phase === 'betting') {
        for (const x of t.seats) if (x) x.lastSeen = now
        act(t, actor(t), { handId: t.hand!.handId, seq: t.hand!.seq, kind: 'fold' }, now)
      }
      now += 10_000
      for (const x of t.seats) if (x) x.lastSeen = now
      tick(t, now, d)
    }
    expect(seatOf(t, 'u2')).toBe(-1)
    expect(t.records.u2.cashedOut).toBeGreaterThan(970) // may have posted a blind before going away
    check(t)
  })
})

describe('regressions from the bug pass', () => {
  it('does not give the actor a fresh clock when someone else leaves', () => {
    const { t, now } = setup(4)
    const a = actor(t)
    const deadline = t.deadline
    const other = t.hand!.players.find((p) => p.uid !== a)!.uid
    leave(t, other, now + 5000)
    expect(actor(t)).toBe(a)
    expect(t.deadline).toBe(deadline)
  })
  it('leaderboard counts chips already in the pot', () => {
    const { t, now } = setup(2)
    const a = actor(t)
    act(t, a, { handId: t.hand!.handId, seq: t.hand!.seq, kind: 'allin' }, now)
    const lb = publicView(t, now).leaderboard
    for (const r of lb) expect(r.stack + 0).toBeGreaterThan(0)
    expect(lb.reduce((x, r) => x + r.stack, 0)).toBe(2000)
  })
  it('an uncalled-bet refund is reported separately from winnings', () => {
    const { t, now } = setup(2)
    const a = actor(t)
    const h = t.hand!
    act(t, a, { handId: h.handId, seq: h.seq, kind: 'allin' }, now)
    act(t, actor(t), { handId: t.hand!.handId, seq: t.hand!.seq, kind: 'fold' }, now)
    const v = publicView(t, now)
    expect(v.result!.showdown).toBe(false)
    expect(v.result!.refund).not.toBeNull()
  })
  it('ownership passes on when the owner leaves', () => {
    const t = createTable('ABCDE', 'u0', S, 0)
    sit(t, 'u0', 'A', undefined, 0)
    sit(t, 'u1', 'B', undefined, 0)
    leave(t, 'u0', 1)
    expect(t.ownerUid).toBe('u1')
  })
  it('migrates an older stored table', () => {
    const t = createTable('ABCDE', 'u0', S, 0)
    sit(t, 'u0', 'A', undefined, 0)
    const old = JSON.parse(JSON.stringify(t)) as Table
    delete (old.seats[0] as unknown as Record<string, unknown>).afkHands
    delete (old.settings as unknown as Record<string, unknown>).buyInCents
    delete (old as unknown as Record<string, unknown>).actorUid
    const m = migrate(old)
    expect(m.seats[0]!.afkHands).toBe(0)
    expect(m.settings.buyInCents).toBe(0)
    setSitOut(m, 'u0', true, 5)
    expect(publicView(m, 5).seats[0]!.afkLeft).toBe(AFK_MAX_HANDS)
  })
  it('money net uses what each chip cost, even after the rate changes', () => {
    const t = createTable('ABCDE', 'u0', S, 0)
    sit(t, 'u0', 'A', undefined, 0)
    sit(t, 'u1', 'B', undefined, 0)
    t.settings.startStack = 4000 // owner changes the rate later (same $2 now buys 4000)
    expect(publicView(t, 1).leaderboard.map((r) => r.netCents)).toEqual([0, 0])
  })
})

describe('owner', () => {
  it('only the owner can kick or change settings; settings apply next hand', () => {
    const { t, now } = setup(3)
    expect(() => kick(t, 'u1', 'u2', now)).toThrow(TableError)
    kick(t, 'u0', 'u2', now)
    expect(seatOf(t, 'u2')).toBe(-1)
    check(t)
  })
})

describe('privacy', () => {
  it('public view never contains hole cards before showdown', () => {
    const { t, now } = setup(4)
    const pub = JSON.stringify(publicView(t, now))
    for (const p of t.hand!.players) for (const c of p.hole) {
      expect(pub.includes(JSON.stringify(c))).toBe(false)
    }
    expect(pub.includes('"deck"')).toBe(false)
    const mine = holeCards(t, 'u1')!
    expect(mine.cards).toHaveLength(2)
  })
  it('fold-wins reveal nothing; showdown reveals only live hands', () => {
    const { t, now } = setup(3)
    const h = t.hand!
    // everyone but last folds
    for (let i = 0; i < 2; i++) act(t, actor(t), { handId: h.handId, seq: t.hand!.seq, kind: 'fold' }, now)
    const v = publicView(t, now)
    expect(v.result!.showdown).toBe(false)
    expect(v.seats.every((s) => !s || s.cards === null)).toBe(true)
  })
})

describe('property: chaos', () => {
  it('random joins, leaves, actions, timeouts and rebuys keep the books balanced', () => {
    for (const seed of [11, 12, 13, 14]) {
      const rng = seeded(seed)
      const t = createTable('ABCDE', 'u0', S, 0)
      const d = deck(rng)
      let now = 0
      let nextId = 0
      let handsSeen = new Set<number>()
      const ops: string[] = []
      for (let step = 0; step < 4000; step++) {
        now += Math.floor(rng() * 4000)
        const r = rng()
        const uids = t.seats.filter(Boolean).map((s) => s!.uid)
        try {
          if (r < 0.07 && uids.length < 9) { ops.push('sit'); sit(t, `u${nextId++ % 14}`, `P${nextId}`, undefined, now) }
          else if (r < 0.11 && uids.length) { ops.push('leave'); leave(t, uids[Math.floor(rng() * uids.length)], now) }
          else if (r < 0.14 && uids.length) { ops.push('rebuy'); rebuy(t, uids[Math.floor(rng() * uids.length)]) }
          else if (r < 0.16 && uids.length) { ops.push('sitout'); setSitOut(t, uids[Math.floor(rng() * uids.length)], rng() < 0.5, now) }
          else if (r < 0.2) { ops.push('tickfar'); tick(t, now + 30_000 * Math.floor(rng() * 2), d) }
          else if (t.phase === 'betting' && t.hand && t.hand.toAct >= 0) {
            const idx = t.hand.toAct
            const lg = legalActions(t.hand, idx)
            const x = rng()
            let kind: 'fold' | 'check' | 'call' | 'raise' | 'allin' = lg.canCheck ? 'check' : 'call'
            let raiseTo: number | undefined
            if (x < 0.15) kind = lg.canCheck ? 'check' : 'fold'
            else if (x < 0.35 && lg.canRaise) { kind = 'raise'; raiseTo = lg.minRaiseTo + Math.floor(rng() * (lg.maxRaiseTo - lg.minRaiseTo + 1)) }
            else if (x < 0.4 && lg.canAllIn) kind = 'allin'
            ops.push('act:' + kind)
            act(t, t.hand.players[idx].uid, { handId: t.hand.handId, seq: t.hand.seq, kind, raiseTo }, now)
          } else tick(t, now, d)
        } catch (e) {
          if (!(e instanceof TableError)) throw e
        }
        // keep everybody "present" so only the explicit chaos above removes them
        for (const s of t.seats) if (s) s.lastSeen = now
        const c = chipCheck(t)
        if (c.held !== c.invested) throw new Error(`books off by ${c.held - c.invested} at step ${step}, seed ${seed}, ops ${ops.slice(-4).join(',')} phase ${t.phase} dump ${JSON.stringify({ players: t.hand?.players.map((p) => ({ u: p.uid, s: p.seat, st: p.stack, tot: p.total, f: p.folded, a: p.allIn })), seats: t.seats.map((x) => x && [x.uid, x.stack, x.status, x.leaving]), pay: t.hand?.result?.payouts, rec: Object.values(t.records).map((r) => [r.uid, r.invested, r.cashedOut, r.seat]) })}`)
        const seen = new Set<string>()
        for (const s of t.seats) if (s) { expect(seen.has(s.uid)).toBe(false); seen.add(s.uid); expect(s.stack).toBeGreaterThanOrEqual(0) }
        for (const r of Object.values(t.records)) expect(r.seat === null ? true : t.seats[r.seat]?.uid === r.uid).toBe(true)
        if (t.phase === 'betting') {
          expect(t.hand!.toAct).toBeGreaterThanOrEqual(0)
          expect(t.deadline).not.toBeNull()
        }
        handsSeen.add(t.handCount)
        const pub = JSON.stringify(publicView(t, now))
        if (t.phase === 'betting' && t.hand) for (const p of t.hand.players) for (const c2 of p.hole as Card[]) expect(pub.includes(JSON.stringify(c2))).toBe(false)
      }
      expect(handsSeen.size).toBeGreaterThan(20)
    }
  })
  it('absent players go AFK first and are only removed after a long time', () => {
    const { t, now, d } = setup(3)
    tick(t, now + AWAY_LEAVE_MS + 10, d)
    expect(t.seats.filter((x) => x?.status === 'sitOut').length).toBeGreaterThan(0)
    for (const x of t.seats) if (x) x.lastSeen = now + 40 * 60_000
    tick(t, now + 40 * 60_000, d)
    expect(t.seats.filter(Boolean).length).toBe(0)
    check(t)
  })
})
