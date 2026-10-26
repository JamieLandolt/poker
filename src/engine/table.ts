import type { Card } from './cards.ts'
import { applyAction, cardText, dealHand, foldOut, legalActions, type HandState, type Legal } from './game.ts'

// ---------- types ----------

export const MAX_SEATS = 9
export const GRACE_MS = 1000
export const AWAY_SIT_OUT_MS = 45_000
export const AWAY_LEAVE_MS = 120_000
export const NEXT_HAND_MS = 6000
export const NEXT_HAND_FOLD_MS = 3500
export const BUSTED_MAX_MS = 5 * 60_000

export interface TableSettings {
  smallBlind: number
  bigBlind: number
  /** Chips handed out per buy-in. */
  startStack: number
  /** Price of one buy-in in cents (0 = money not tracked). Independent of the chip count. */
  buyInCents: number
  turnSecs: number
}
export const DEFAULT_TABLE_SETTINGS: TableSettings = { smallBlind: 10, bigBlind: 20, startStack: 2000, buyInCents: 0, turnSecs: 40 }

export type SeatStatus = 'active' | 'sitOut' | 'busted'

export interface SeatInfo {
  uid: string
  name: string
  stack: number
  status: SeatStatus
  /** Consecutive turn timeouts. */
  timeouts: number
  /** Wants to go once the current hand is over (all-in when they left). */
  leaving: boolean
  lastSeen: number
  /** Hands dealt since the player went away (shown to the table; the seat is held until they return or the host removes them). */
  afkHands: number
  /** When the seat became busted or sat out; used to free abandoned seats. */
  idleSince: number | null
}

export interface PlayerRecord {
  uid: string
  name: string
  /** Chips bought in across all buy-ins. */
  invested: number
  buyIns: number
  /** Money paid across all buy-ins, in cents. */
  paidCents: number
  /** Chips taken off the table when leaving. */
  cashedOut: number
  handsWon: number
  biggestPot: number
  seat: number | null
}

export interface Table {
  code: string
  ownerUid: string
  /** Who created the table; keeps access to the history after leaving. */
  creatorUid: string
  /** Ledger lines waiting to be written by the store (it stamps the time and clears this). */
  ledger: string[]
  /** How many lines of the current hand's log are already in the ledger. */
  ledgerHandLen: number
  /** Players who chose to show their cards after the hand. */
  shown: string[]
  settings: TableSettings
  /** Applied at the start of the next hand. */
  pendingSettings: TableSettings | null
  seats: (SeatInfo | null)[]
  /** Seat index of the dealer button; -1 before the first hand. */
  button: number
  handCount: number
  phase: 'waiting' | 'betting' | 'handOver'
  /** Full engine state, hole cards and deck included. SERVER ONLY. */
  hand: HandState | null
  nextHandAt: number | null
  deadline: number | null
  /** uid of the player the current deadline belongs to. */
  actorUid: string | null
  /** Host pause: all clocks (turn timer, next hand, away detection) stand still. */
  paused: boolean
  pausedAt: number | null
  records: Record<string, PlayerRecord>
  version: number
}

export class TableError extends Error {}
const fail = (m: string): never => { throw new TableError(m) }

// ---------- helpers ----------

export function cleanName(raw: unknown): string {
  // eslint-disable-next-line no-control-regex
  const s = String(raw ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16)
  return s
}

function uniqueName(t: Table, uid: string, name: string): string {
  const taken = new Set(Object.values(t.records).filter((r) => r.uid !== uid).map((r) => r.name.toLowerCase()))
  if (!taken.has(name.toLowerCase())) return name
  for (let i = 2; i < 100; i++) {
    const cand = `${name.slice(0, 12)} (${i})`
    if (!taken.has(cand.toLowerCase())) return cand
  }
  return name
}

export function seatOf(t: Table, uid: string): number {
  return t.seats.findIndex((s) => s?.uid === uid)
}

/** Index in the current hand's participant list for a uid, or -1. */
function handIdx(t: Table, uid: string): number {
  return t.hand ? t.hand.players.findIndex((p) => p.uid === uid) : -1
}

/** True when the uid still has a claim in the running hand (not folded). */
function contesting(t: Table, uid: string): boolean {
  if (t.phase !== 'betting' || !t.hand) return false
  const i = handIdx(t, uid)
  return i >= 0 && !t.hand.players[i].folded
}

/** Fill in fields that older stored tables do not have yet. Safe to call on every load. */
export function migrate(t: Table): Table {
  t.settings.buyInCents ??= 0
  // existing tables pick up the longer default turn clock
  t.settings.turnSecs = Math.max(t.settings.turnSecs ?? 0, DEFAULT_TABLE_SETTINGS.turnSecs)
  if (t.pendingSettings) t.pendingSettings.turnSecs = Math.max(t.pendingSettings.turnSecs ?? 0, DEFAULT_TABLE_SETTINGS.turnSecs)
  if (t.pendingSettings) t.pendingSettings.buyInCents ??= 0
  t.actorUid ??= null
  t.paused ??= false
  t.pausedAt ??= null
  t.creatorUid ??= t.ownerUid
  t.ledger ??= []
  t.ledgerHandLen ??= 0
  t.shown ??= []
  for (const s of t.seats) {
    if (!s) continue
    s.afkHands ??= 0
    s.idleSince ??= null
    s.timeouts ??= 0
    s.leaving ??= false
  }
  for (const r of Object.values(t.records)) r.paidCents ??= 0
  if (t.hand) for (const p of t.hand.players) p.actedAtBet ??= -1
  return t
}

export function createTable(code: string, ownerUid: string, settings: TableSettings, now: number): Table {
  validateSettings(settings)
  void now
  const t: Table = {
    code, ownerUid, creatorUid: ownerUid, ledger: [], ledgerHandLen: 0, shown: [], settings, pendingSettings: null, seats: Array(MAX_SEATS).fill(null), button: -1,
    handCount: 0, phase: 'waiting', hand: null, nextHandAt: null, deadline: null, actorUid: null, paused: false, pausedAt: null, records: {}, version: 0,
  }
  note(t, `Table ${code} created, blinds ${n(settings.smallBlind)}/${n(settings.bigBlind)}, ${n(settings.startStack)} chips per buy-in${settings.buyInCents ? ` at $${(settings.buyInCents / 100).toFixed(2)}` : ''}`)
  return t
}

export function validateSettings(s: TableSettings) {
  const ok = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi
  if (!ok(s.bigBlind, 2, 100_000) || !ok(s.smallBlind, 1, s.bigBlind) || !ok(s.startStack, s.bigBlind * 20, 100_000_000) || !ok(s.buyInCents ?? 0, 0, 10_000_000) || !ok(s.turnSecs, 5, 120)) {
    fail('Invalid table settings')
  }
}

// ---------- seating ----------

export function sit(t: Table, uid: string, rawName: unknown, wanted: number | undefined, now: number): void {
  const name = cleanName(rawName)
  if (!name) fail('Pick a nickname')
  if (seatOf(t, uid) >= 0) fail('You are already seated')
  // Someone who just left a running hand cannot re-sit until it is over (their old stack is still in it).
  if (t.phase === 'betting' && handIdx(t, uid) >= 0) fail('Wait for the current hand to finish')
  let seat = wanted
  if (seat === undefined || seat === null) seat = t.seats.findIndex((s) => s === null)
  if (!Number.isInteger(seat) || seat < 0 || seat >= MAX_SEATS) fail('Table is full')
  if (t.seats[seat as number]) fail('That seat is taken')
  const rec = t.records[uid]
  const finalName = uniqueName(t, uid, name)
  const stack = t.settings.startStack
  t.records[uid] = {
    uid, name: finalName, invested: (rec?.invested ?? 0) + stack, buyIns: (rec?.buyIns ?? 0) + 1,
    paidCents: (rec?.paidCents ?? 0) + (t.settings.buyInCents ?? 0), cashedOut: rec?.cashedOut ?? 0, handsWon: rec?.handsWon ?? 0, biggestPot: rec?.biggestPot ?? 0, seat: seat as number,
  }
  t.seats[seat as number] = { uid, name: finalName, stack, status: 'active', timeouts: 0, leaving: false, lastSeen: now, afkHands: 0, idleSince: null }
  note(t, `${finalName} sits at seat ${(seat as number) + 1}, buys in ${n(stack)}${cash(t)} (buy-in ${t.records[uid].buyIns})`)
  prune(t)
  touch(t)
}

/** Keep the records map bounded: drop the oldest players who are gone. */
function prune(t: Table) {
  const gone = Object.values(t.records).filter((r) => r.seat === null)
  if (Object.keys(t.records).length <= 30) return
  for (const r of gone.slice(0, Object.keys(t.records).length - 30)) delete t.records[r.uid]
}

function touch(t: Table) { t.version++ }

const n = (x: number) => x.toLocaleString('en-US')
const cash = (t: Table) => ((t.settings.buyInCents ?? 0) > 0 ? ` $${((t.settings.buyInCents ?? 0) / 100).toFixed(2)}` : '')
/** Minimal permanent record of what happened at the table. */
function note(t: Table, line: string) { t.ledger.push(line) }
const stacksLine = (t: Table) => `Stacks: ${t.seats.filter((x): x is SeatInfo => !!x).map((x) => `${x.name} ${n(x.stack)}`).join(', ')}`

function cashOutAndFree(t: Table, seat: number) {
  const s = t.seats[seat]
  if (!s) return
  const rec = t.records[s.uid]
  if (rec) { rec.cashedOut += s.stack; rec.seat = null }
  note(t, `${s.name} leaves with ${n(s.stack)} chips`)
  t.seats[seat] = null
  // The table never ends up without an owner while someone is still sitting at it.
  if (s.uid === t.ownerUid) {
    const next = t.seats.find((x) => x && !x.leaving) ?? t.seats.find(Boolean)
    if (next) { t.ownerUid = next.uid; note(t, `${next.name} is now the host`) }
  }
}

export function leave(t: Table, uid: string, now: number): void {
  const seat = seatOf(t, uid)
  if (seat < 0) return
  const s = t.seats[seat]!
  const hi = handIdx(t, uid)
  if (t.phase === 'betting' && t.hand && hi >= 0) {
    const hp = t.hand.players[hi]
    if (hp.allIn && !hp.folded) {
      // Committed chips keep playing; the seat is released after the payout.
      s.leaving = true
      touch(t)
      return
    }
    if (!hp.folded) {
      t.hand = foldOut(t.hand, hi)
      // The hand's stack for this player is what is left behind them.
      s.stack = t.hand.players[hi].stack
      afterHandChange(t, now)
    }
  }
  cashOutAndFree(t, seat)
  touch(t)
}

export function kick(t: Table, byUid: string, targetUid: string, now: number): void {
  if (byUid !== t.ownerUid) fail('Only the table owner can remove players')
  if (byUid === targetUid) fail('Use Leave instead')
  const ks = t.seats[seatOf(t, targetUid)]
  if (ks) note(t, `Host removes ${ks.name}`)
  leave(t, targetUid, now)
  // A kicked player who was all-in keeps playing out the hand, then goes.
}

export function rebuy(t: Table, uid: string): void {
  const seat = seatOf(t, uid)
  if (seat < 0) fail('Sit down first')
  const s = t.seats[seat]!
  if (s.stack > 0) fail('You still have chips')
  if (contesting(t, uid)) fail('Wait for the hand to finish')
  const rec = t.records[uid]
  s.stack = t.settings.startStack
  s.status = 'active'
  s.timeouts = 0
  s.afkHands = 0
  s.idleSince = null
  s.leaving = false
  rec.invested += t.settings.startStack
  rec.paidCents = (rec.paidCents ?? 0) + (t.settings.buyInCents ?? 0)
  rec.buyIns += 1
  note(t, `${s.name} rebuys ${n(t.settings.startStack)}${cash(t)} (buy-in ${rec.buyIns})`)
  touch(t)
}

export function setSitOut(t: Table, uid: string, out: boolean, now: number): void {
  const seat = seatOf(t, uid)
  if (seat < 0) fail('Sit down first')
  const s = t.seats[seat]!
  if (s.status === 'busted') fail('Rebuy first')
  if (out && s.status !== 'sitOut') note(t, `${s.name} goes AFK`)
  if (!out && s.status === 'sitOut') note(t, `${s.name} is back`)
  if (out) {
    s.status = 'sitOut'
    s.idleSince = now
    s.afkHands = 0
    // Sitting out mid-hand folds you unless you are all-in.
    const hi = handIdx(t, uid)
    if (t.phase === 'betting' && t.hand && hi >= 0 && !t.hand.players[hi].folded && !t.hand.players[hi].allIn) {
      t.hand = foldOut(t.hand, hi)
      afterHandChange(t, now)
    }
  } else {
    s.status = 'active'
    s.timeouts = 0
    s.afkHands = 0
    s.idleSince = null
  }
  touch(t)
}

/** Host-only: freeze or unfreeze every clock. Resuming pushes deadlines out by the time spent paused. */
export function setPaused(t: Table, uid: string, on: boolean, now: number): void {
  if (uid !== t.ownerUid) fail('Only the table owner can pause')
  if (on === t.paused) return
  if (on) {
    t.paused = true
    t.pausedAt = now
    note(t, 'Host paused the game')  } else {
    const d = Math.max(0, now - (t.pausedAt ?? now))
    if (t.deadline !== null) t.deadline += d
    if (t.nextHandAt !== null) t.nextHandAt += d
    for (const s of t.seats) {
      if (!s) continue
      s.lastSeen += d
      if (s.idleSince !== null) s.idleSince += d
    }
    t.paused = false
    t.pausedAt = null
    note(t, 'Host resumed the game')  }
  touch(t)
}

export function setSettings(t: Table, uid: string, s: TableSettings): void {
  if (uid !== t.ownerUid) fail('Only the table owner can change settings')
  validateSettings(s)
  t.pendingSettings = s
  note(t, `Host sets blinds ${n(s.smallBlind)}/${n(s.bigBlind)}, ${n(s.startStack)} chips per buy-in${s.buyInCents ? ` at $${(s.buyInCents / 100).toFixed(2)}` : ''} (from next hand)`)
  touch(t)
}

export function rename(t: Table, uid: string, rawName: unknown): void {
  const name = cleanName(rawName)
  if (!name) fail('Pick a nickname')
  const rec = t.records[uid]
  if (!rec) fail('Sit down first')
  const finalName = uniqueName(t, uid, name)
  if (finalName !== rec.name) note(t, `${rec.name} is now called ${finalName}`)
  rec.name = finalName
  const seat = seatOf(t, uid)
  if (seat >= 0) t.seats[seat]!.name = finalName
  touch(t)
}

// ---------- playing ----------

/** After a hand, a player may turn their cards face up for everyone. */
export function showHand(t: Table, uid: string): void {
  const hi = handIdx(t, uid)
  if (t.phase !== 'handOver' || !t.hand || hi < 0) fail('Nothing to show')
  if (t.shown.includes(uid)) return
  t.shown.push(uid)
  const hp = t.hand!.players[hi]
  const [a, b] = hp.hole
  note(t, `${hp.name} shows ${cardText(a)} ${cardText(b)}`)
  touch(t)
}


export function act(t: Table, uid: string, a: { handId: number; seq: number; kind: 'fold' | 'check' | 'call' | 'raise' | 'allin'; raiseTo?: number }, now: number): boolean {
  if (t.phase !== 'betting' || !t.hand) return false
  const hi = handIdx(t, uid)
  if (hi < 0) fail('You are not in this hand')
  const next = applyAction(t.hand, { ...a, seat: hi })
  if (next === t.hand) return false // stale or illegal: ignored
  t.hand = next
  const s = t.seats[seatOf(t, uid)]
  if (s) { s.timeouts = 0; s.lastSeen = now }
  afterHandChange(t, now, true)
  return true
}

/** Sync seats from the hand, detect the end of the hand, re-arm the turn clock. */
function afterHandChange(t: Table, now: number, rearm = false) {
  const h = t.hand!
  for (const l of h.log.slice(t.ledgerHandLen)) note(t, l)
  t.ledgerHandLen = h.log.length
  // keep stacks in sync for seats still holding their place
  for (const p of h.players) {
    const si = seatOf(t, p.uid)
    if (si >= 0) t.seats[si]!.stack = p.stack
  }
  if (h.phase === 'handOver' && t.phase !== 'handOver') onHandOver(t, now)
  else if (h.phase === 'betting') {
    const actor = h.toAct >= 0 ? h.players[h.toAct].uid : null
    // A new clock starts after someone acts or when a different player becomes the actor;
    // other players leaving or going AFK must not hand the actor extra time.
    if (rearm || actor !== t.actorUid || t.deadline === null) {
      t.deadline = actor ? now + t.settings.turnSecs * 1000 : null
      t.actorUid = actor
    }
  }
  touch(t)
}

function onHandOver(t: Table, now: number) {
  const h = t.hand!
  t.phase = 'handOver'
  t.deadline = null
  t.nextHandAt = now + (h.result?.showdown ? NEXT_HAND_MS : NEXT_HAND_FOLD_MS)
  for (const p of h.players) {
    const won = h.result?.payouts[p.id] ?? 0
    const rec = t.records[p.uid]
    if (rec) {
      const potWon = h.result!.pots.some((a) => a.winners.includes(p.id))
      if (potWon) rec.handsWon++
      for (const a of h.result!.pots) if (a.winners.includes(p.id)) rec.biggestPot = Math.max(rec.biggestPot, a.amount)
    }
    const si = seatOf(t, p.uid)
    if (si < 0) {
      // Left mid-hand: whatever they are still owed (an uncalled bet coming back) goes straight to their cash-out.
      if (rec && won > 0) rec.cashedOut += won
      continue
    }
    const s = t.seats[si]!
    s.stack = p.stack
    if (s.leaving) continue // freed when the next hand starts, so the result screen stays accurate
    if (s.stack === 0) { s.status = 'busted'; s.idleSince = now; note(t, `${s.name} is out of chips`) }
  }
  note(t, stacksLine(t))
}

/** Seats that will be dealt into the next hand, in seat order. */
function eligibleSeats(t: Table): number[] {
  const out: number[] = []
  t.seats.forEach((s, i) => { if (s && s.status === 'active' && s.stack > 0 && !s.leaving) out.push(i) })
  return out
}

function releaseLeavers(t: Table) {
  for (let i = 0; i < MAX_SEATS; i++) if (t.seats[i]?.leaving) cashOutAndFree(t, i)
}

function startNextHand(t: Table, deck: Card[], now: number): boolean {
  releaseLeavers(t)
  const seats = eligibleSeats(t)
  if (seats.length < 2) {
    t.phase = 'waiting'
    t.hand = null
    t.nextHandAt = null
    t.deadline = null
    return false
  }
  if (t.pendingSettings) { t.settings = t.pendingSettings; t.pendingSettings = null }
  // Button: next eligible seat clockwise after the previous button seat (no dead button).
  const btn = seats.find((i) => i > t.button) ?? seats[0]
  const buttonIdx = seats.indexOf(btn)
  for (let i = 0; i < MAX_SEATS; i++) {
    const s2 = t.seats[i]
    if (s2 && s2.status === 'sitOut') {
      s2.afkHands++
    }
  }
  note(t, stacksLine(t))
  t.handCount++
  t.button = btn
  t.hand = dealHand({
    players: seats.map((i) => ({ uid: t.seats[i]!.uid, seat: i, name: t.seats[i]!.name, stack: t.seats[i]!.stack })),
    button: buttonIdx,
    blinds: { smallBlind: t.settings.smallBlind, bigBlind: t.settings.bigBlind },
    deck,
    handId: t.handCount,
  })
  t.phase = 'betting'
  t.nextHandAt = null
  t.actorUid = null
  for (const s of seats) t.seats[s]!.stack = t.hand.players.find((p) => p.seat === s)!.stack
  t.ledgerHandLen = 0
  t.shown = []
  afterHandChange(t, now, true)
  return true
}

/**
 * Advance anything that is due: stale players, turn timeouts, the next hand.
 * `deckFn` is only called when a hand actually starts. Idempotent: returns false if nothing changed.
 */
export function tick(t: Table, now: number, deckFn: () => Card[]): boolean {
  if (t.paused) return false
  const before = t.version
  // 1. absent players
  for (let i = 0; i < MAX_SEATS; i++) {
    const s = t.seats[i]
    if (!s) continue
    const away = now - s.lastSeen
    // A disconnected active player is moved to AFK (keeps the seat for a few hands in case they come back).
    if (away > AWAY_SIT_OUT_MS && s.status === 'active') setSitOut(t, s.uid, true, now)
    if (s.status === 'busted' && s.idleSince !== null && now - s.idleSince > BUSTED_MAX_MS && !contesting(t, s.uid)) leave(t, s.uid, now)
  }
  // 2. turn timeout
  if (t.phase === 'betting' && t.hand && t.deadline !== null && now > t.deadline + GRACE_MS) {
    const h = t.hand
    const idx = h.toAct
    if (idx >= 0) {
      const lg = legalActions(h, idx)
      const next = applyAction(h, { handId: h.handId, seq: h.seq, seat: idx, kind: lg.canCheck ? 'check' : 'fold' })
      if (next !== h) {
        t.hand = next
        const s = t.seats[seatOf(t, h.players[idx].uid)]
        if (s) {
          s.timeouts++
          if (s.timeouts >= 2 && s.status === 'active') { s.status = 'sitOut'; s.idleSince = now; note(t, `${s.name} goes AFK`) }
        }
        afterHandChange(t, now, true)
      }
    }
  }
  // 3. next hand
  if (t.phase === 'waiting') {
    if (eligibleSeats(t).length >= 2) {
      // short pause so a second player who just sat down sees the table before cards fly
      if (t.nextHandAt === null) { t.nextHandAt = now + 2500; touch(t) }
      else if (now >= t.nextHandAt) startNextHand(t, deckFn(), now)
    } else if (t.nextHandAt !== null) { t.nextHandAt = null; touch(t) }
  } else if (t.phase === 'handOver' && t.nextHandAt !== null && now >= t.nextHandAt) {
    if (eligibleSeats(t).length >= 2) startNextHand(t, deckFn(), now)
    else { releaseLeavers(t); t.phase = 'waiting'; t.nextHandAt = null; t.hand = null; touch(t) }
  }
  return t.version !== before
}

// ---------- views ----------

export interface PublicSeat {
  seat: number
  uid: string
  name: string
  stack: number
  status: SeatStatus
  leaving: boolean
  /** Hands an away player has missed so far; null when not away. */
  afkMissed: number | null
  inHand: boolean
  folded: boolean
  allIn: boolean
  bet: number
  lastAction: string
  /** Revealed hole cards (showdown only). */
  cards: Card[] | null
  away: boolean
}

export interface PublicTable {
  code: string
  ownerUid: string
  creatorUid: string
  settings: TableSettings
  pendingSettings: TableSettings | null
  phase: Table['phase']
  handId: number
  seq: number
  street: string
  board: Card[]
  pot: number
  currentBet: number
  minRaise: number
  button: number
  sbSeat: number
  bbSeat: number
  /** Posted blind amounts for display. */
  sbAmount: number
  bbAmount: number
  toAct: number
  legal: Legal | null
  deadline: number | null
  nextHandAt: number | null
  paused: boolean
  pausedAt: number | null
  seats: (PublicSeat | null)[]
  /** Seats that can currently be dealt a hand (used so clients know when to nudge the table). */
  eligible: number
  result: null | { showdown: boolean; pots: { amount: number; winners: number[] }[]; payouts: Record<number, number>; hands: Record<number, string>; refund: { seat: number; amount: number } | null }
  leaderboard: { uid: string; name: string; buyIns: number; invested: number; cashedOut: number; stack: number; net: number; paidCents: number; netCents: number; handsWon: number; biggestPot: number; seated: boolean }[]
  log: string[]
  now: number
  version: number
}

/** Allow-list copy: only fields listed here ever reach clients. Hole cards appear only at a showdown. */
export function publicView(t: Table, now: number): PublicTable {
  const h = t.hand
  const seatForUid = (uid: string) => seatOf(t, uid)
  const reveal = !!(h && t.phase === 'handOver' && h.result?.showdown)
  const seats: (PublicSeat | null)[] = t.seats.map((s, i) => {
    if (!s) return null
    const hi = handIdx(t, s.uid)
    const hp = h && hi >= 0 ? h.players[hi] : null
    return {
      seat: i, uid: s.uid, name: s.name, stack: s.stack, status: s.status, leaving: s.leaving,
      afkMissed: s.status === 'sitOut' ? (s.afkHands ?? 0) : null,
      inHand: !!hp, folded: !!hp?.folded, allIn: !!hp?.allIn,
      bet: hp && t.phase === 'betting' ? hp.bet : 0,
      lastAction: hp ? hp.lastAction : '',
      cards: hp && ((reveal && !hp.folded) || (t.phase === 'handOver' && t.shown.includes(s.uid))) ? hp.hole : null,
      away: false,
    }
  })
  const toActUid = h && t.phase === 'betting' && h.toAct >= 0 ? h.players[h.toAct].uid : null
  const toAct = toActUid ? seatForUid(toActUid) : -1
  const seatOfIdx = (i: number) => (h && i >= 0 && h.players[i] ? h.players[h.players[i].id].seat : -1)
  const res = h?.result
  const mapIdsToSeat = (ids: number[]) => ids.map((id) => h!.players[id].seat)
  const board = h ? h.board : []
  const leaderboard = Object.values(t.records).map((r) => {
    const s = r.seat !== null ? t.seats[r.seat] : null
    const hi = s && h && t.phase === 'betting' ? handIdx(t, s.uid) : -1
    // chips already pushed into the pot this hand are still the player's
    const stack = (s?.stack ?? 0) + (hi >= 0 ? h!.players[hi].total : 0)
    const paid = r.paidCents ?? 0
    // Chips are worth what the player paid per chip on average, so changing the table's rate later never rewrites history.
    const perChip = r.invested > 0 ? paid / r.invested : 0
    return { uid: r.uid, name: r.name, buyIns: r.buyIns, invested: r.invested, cashedOut: r.cashedOut, stack, net: stack + r.cashedOut - r.invested, paidCents: paid, netCents: Math.round((stack + r.cashedOut) * perChip) - paid, handsWon: r.handsWon, biggestPot: r.biggestPot, seated: !!s }
  }).sort((a, b) => b.net - a.net)
  return {
    code: t.code, ownerUid: t.ownerUid, creatorUid: t.creatorUid, settings: t.settings, pendingSettings: t.pendingSettings,
    phase: t.phase, handId: h?.handId ?? 0, seq: h?.seq ?? 0, street: h?.street ?? 'preflop', board,
    pot: h && t.phase === 'betting' ? h.players.reduce((a, p) => a + p.total, 0) : 0,
    currentBet: h?.currentBet ?? 0, minRaise: h?.minRaise ?? 0,
    button: t.button,
    sbSeat: h ? seatOfIdx(h.sb) : -1, bbSeat: h ? seatOfIdx(h.bb) : -1,
    sbAmount: h ? Math.min(t.settings.smallBlind, h.blinds.smallBlind) : 0, bbAmount: h ? h.blinds.bigBlind : 0,
    toAct, legal: h && toAct >= 0 ? legalActions(h, h.toAct) : null,
    deadline: t.deadline, nextHandAt: t.nextHandAt, paused: t.paused, pausedAt: t.pausedAt, seats,
    result: res && h ? {
      showdown: res.showdown,
      pots: res.pots.map((p) => ({ amount: p.amount, winners: mapIdsToSeat(p.winners) })),
      payouts: Object.fromEntries(Object.entries(res.payouts).map(([id, v]) => [h.players[Number(id)].seat, v])),
      hands: Object.fromEntries(Object.entries(res.hands).map(([id, v]) => [h.players[Number(id)].seat, v])),
      refund: res.refund ? { seat: h.players[res.refund.id].seat, amount: res.refund.amount } : null,
    } : null,
    eligible: eligibleSeats(t).length,
    leaderboard, log: h ? h.log.slice(-15) : [], now, version: t.version,
  }
}

/** Private view: just this player's own hole cards. */
export function holeCards(t: Table, uid: string): { handId: number; cards: Card[] } | null {
  const i = handIdx(t, uid)
  if (!t.hand || i < 0) return null
  return { handId: t.hand.handId, cards: t.hand.players[i].hole }
}

/** Chip invariant: stacks + chips committed to a running hand + cashed out == invested. */
export function chipCheck(t: Table): { held: number; invested: number } {
  const stacks = t.seats.reduce((a, s) => a + (s?.stack ?? 0), 0)
  const inPot = t.phase === 'betting' && t.hand ? t.hand.players.reduce((a, p) => a + p.total, 0) : 0
  // seats hold post-blind stacks during betting, so add the committed chips; folded leavers' chips stay in the pot.
  const cashed = Object.values(t.records).reduce((a, r) => a + r.cashedOut, 0)
  const invested = Object.values(t.records).reduce((a, r) => a + r.invested, 0)
  return { held: stacks + inPot + cashed, invested }
}
