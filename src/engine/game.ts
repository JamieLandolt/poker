import { type Card } from './cards.ts'
import { CATEGORY_NAME, compareScores, evaluate, type HandScore } from './evaluate.ts'
import { buildPots, splitPot } from './pots.ts'

export type Street = 'preflop' | 'flop' | 'turn' | 'river'
export type Phase = 'idle' | 'betting' | 'handOver'
export type ActKind = 'fold' | 'check' | 'call' | 'raise' | 'allin'

export interface Player {
  /** Index within this hand's participant list. */
  id: number
  uid: string
  seat: number
  name: string
  stack: number
  hole: Card[]
  /** Chips put in on the current street. */
  bet: number
  /** Chips put in this hand. */
  total: number
  folded: boolean
  allIn: boolean
  /** Has acted since the bet last changed. */
  acted: boolean
  /** Value of currentBet when this player last acted this street; -1 if they have not acted yet. */
  actedAtBet: number
  lastAction: string
}

export interface PotAward {
  amount: number
  winners: number[]
  eligible: number[]
}

export interface HandResult {
  showdown: boolean
  pots: PotAward[]
  payouts: Record<number, number>
  /** Hand name per revealed player id. */
  hands: Record<number, string>
  refund: { id: number; amount: number } | null
}

export interface Blinds {
  smallBlind: number
  bigBlind: number
}

export interface HandState {
  blinds: Blinds
  players: Player[]
  phase: 'betting' | 'handOver'
  street: Street
  handId: number
  /** Number of actions applied this hand; used to reject stale actions. */
  seq: number
  /** Indexes into `players`. */
  button: number
  sb: number
  bb: number
  toAct: number
  deck: Card[]
  board: Card[]
  currentBet: number
  /** Size of the last full raise (at least the big blind). */
  minRaise: number
  result: HandResult | null
  log: string[]
}

export type GameState = HandState
export interface DealInput {
  players: { uid: string; seat: number; name: string; stack: number }[]
  /** Index into `players` of the dealer button. */
  button: number
  blinds: Blinds
  deck: Card[]
  handId: number
}

// ---------- helpers ----------

const live = (p: Player) => !p.folded
const able = (p: Player) => !p.folded && !p.allIn

/** Seat after `from` (wrapping) satisfying `pred`, or -1. Never returns `from` itself unless it is the only match. */
function nextSeat(players: Player[], from: number, pred: (p: Player) => boolean): number {
  const n = players.length
  for (let i = 1; i <= n; i++) {
    const s = (from + i) % n
    if (pred(players[s])) return s
  }
  return -1
}

export interface Legal {
  canCheck: boolean
  /** Chips needed to call, capped at the stack. */
  callAmount: number
  canRaise: boolean
  /** Smallest legal raise-to total for this street (all-in if the stack is shorter). */
  minRaiseTo: number
  /** Raise-to total when going all-in. */
  maxRaiseTo: number
  canAllIn: boolean
}

export function legalActions(state: GameState, seat: number): Legal {
  const p = state.players[seat]
  const none: Legal = { canCheck: false, callAmount: 0, canRaise: false, minRaiseTo: 0, maxRaiseTo: 0, canAllIn: false }
  if (!p || state.phase !== 'betting' || state.toAct !== seat || !able(p)) return none
  const owed = state.currentBet - p.bet
  const callAmount = Math.min(owed, p.stack)
  const othersCanAct = state.players.some((o) => o.id !== p.id && able(o))
  const reopened = p.actedAtBet < 0 || state.currentBet - p.actedAtBet >= state.minRaise
  const canRaise = p.stack > owed && othersCanAct && reopened
  const maxRaiseTo = p.bet + p.stack
  const minRaiseTo = Math.min(state.currentBet + state.minRaise, maxRaiseTo)
  return {
    canCheck: owed <= 0,
    callAmount,
    canRaise,
    minRaiseTo,
    maxRaiseTo,
    canAllIn: p.stack > 0 && (p.stack <= owed || canRaise),
  }
}

function pushLog(state: GameState, line: string): string[] {
  return [...state.log.slice(-14), line]
}

function put(p: Player, amount: number): Player {
  const a = Math.min(amount, p.stack)
  const stack = p.stack - a
  return { ...p, stack, bet: p.bet + a, total: p.total + a, allIn: stack === 0 }
}

// ---------- hand lifecycle ----------

/** Deal a new hand to 2+ participants. Blinds are posted, the first actor is set. */
export function dealHand(input: DealInput): HandState {
  const { blinds, deck, handId } = input
  if (input.players.length < 2 || deck.length !== 52) throw new Error('need 2+ players and a full deck')
  let players: Player[] = input.players.map((p, id) => ({
    id, uid: p.uid, seat: p.seat, name: p.name, stack: p.stack,
    hole: [], bet: 0, total: 0, folded: false, allIn: false, acted: false, actedAtBet: -1, lastAction: '',
  }))
  const n = players.length
  const button = input.button
  const headsUp = n === 2
  const sb = headsUp ? button : (button + 1) % n
  const bb = (sb + 1) % n

  const d = deck.slice()
  // Deal one card at a time starting left of the button.
  for (let round = 0; round < 2; round++) {
    for (let i = 1; i <= n; i++) {
      const s = (button + i) % n
      players[s] = { ...players[s], hole: [...players[s].hole, d.pop()!] }
    }
  }
  players[sb] = put(players[sb], blinds.smallBlind)
  players[bb] = put(players[bb], blinds.bigBlind)
  const log = [
    `--- Hand ${handId} --- ${players[button].name} has the button`,
    `${players[sb].name} posts ${players[sb].bet}, ${players[bb].name} posts ${players[bb].bet}`,
  ]
  const base: HandState = {
    blinds, players, phase: 'betting', street: 'preflop', handId, seq: 0, button, sb, bb,
    toAct: -1, deck: d, board: [], currentBet: blinds.bigBlind, minRaise: blinds.bigBlind, result: null, log,
  }
  // First to act: left of the big blind (heads-up this is the button/small blind).
  return advance(base, bb)
}

/** Apply a player's action. Returns the same object when the action is stale or illegal. */
export function applyAction(state: HandState, a: { handId: number; seq: number; seat: number; kind: ActKind; raiseTo?: number }): HandState {
  if (state.phase !== 'betting' || a.handId !== state.handId || a.seq !== state.seq || a.seat !== state.toAct) return state
  return applyAct(state, a.seat, a.kind, a.raiseTo)
}

/**
 * Fold a player out of turn (they left, were kicked or timed out while not acting).
 * Already all-in players are never folded: their chips are committed.
 */
export function foldOut(state: HandState, idx: number): HandState {
  const p = state.players[idx]
  if (state.phase !== 'betting' || !p || p.folded || p.allIn) return state
  if (idx === state.toAct) return applyAct(state, idx, 'fold')
  const players = state.players.map((x, i) => (i === idx ? { ...x, folded: true, lastAction: 'left' } : x))
  const next: HandState = { ...state, players, seq: state.seq + 1, log: pushLog(state, `${p.name} folds`) }
  if (players.filter(live).length === 1 || roundComplete(next)) return advance(next, state.toAct)
  return next
}

function applyAct(state: GameState, seat: number, kind: ActKind, raiseTo?: number): GameState {
  const legal = legalActions(state, seat)
  const p = state.players[seat]
  const owed = state.currentBet - p.bet
  let np = p
  let currentBet = state.currentBet
  let minRaise = state.minRaise
  let text: string

  if (kind === 'fold') {
    np = { ...p, folded: true }
    text = 'folds'
  } else if (kind === 'check') {
    if (!legal.canCheck) return state
    text = 'checks'
  } else if (kind === 'call') {
    if (owed <= 0) return state
    np = put(p, owed)
    text = np.allIn ? `calls ${np.bet - p.bet} (all-in)` : `calls ${np.bet - p.bet}`
  } else {
    // raise / allin
    let target: number
    if (kind === 'allin') {
      if (!legal.canAllIn) return state
      target = p.bet + p.stack
    } else {
      if (!legal.canRaise || raiseTo === undefined || !Number.isInteger(raiseTo)) return state
      if (raiseTo > legal.maxRaiseTo || raiseTo < legal.minRaiseTo) return state
      target = raiseTo
    }
    if (target <= state.currentBet) {
      // All-in for no more than the current bet is just a call.
      np = put(p, p.stack)
      text = `calls ${np.bet - p.bet} (all-in)`
    } else {
      np = put(p, target - p.bet)
      const size = np.bet - state.currentBet
      if (size >= state.minRaise) minRaise = size
      const verb = state.currentBet === 0 ? 'bets' : 'raises to'
      text = np.allIn ? `${verb} ${np.bet} (all-in)` : `${verb} ${np.bet}`
      currentBet = np.bet
    }
  }

  np = { ...np, acted: true, actedAtBet: currentBet, lastAction: text }
  const players = state.players.map((x, i) => {
    if (i === seat) return np
    // A higher bet means everyone still in must respond again.
    return currentBet > state.currentBet && able(x) ? { ...x, acted: false } : x
  })
  const next: GameState = {
    ...state,
    players,
    currentBet,
    minRaise,
    seq: state.seq + 1,
    log: pushLog(state, `${p.name} ${text}`),
  }
  return advance(next, seat)
}

/** True when nobody else needs to act this street. */
function roundComplete(state: GameState): boolean {
  const ab = state.players.filter(able)
  if (ab.length === 0) return true
  if (ab.length === 1) return ab[0].bet >= state.currentBet
  return ab.every((p) => p.acted && p.bet === state.currentBet)
}

/** Move the hand forward after an action (or after the blinds): next actor, next street, or the end. */
function advance(state: GameState, from: number): GameState {
  let s = state
  for (;;) {
    if (s.players.filter(live).length === 1) return finishHand(s, false)
    if (!roundComplete(s)) {
      const nextTo = nextSeat(s.players, from, (p) => able(p) && !(p.acted && p.bet === s.currentBet))
      return { ...s, toAct: nextTo }
    }
    if (s.street === 'river') return finishHand(s, true)
    s = dealStreet(s)
    from = s.button // post-flop the first live player left of the button acts first
  }
}

function dealStreet(state: GameState): GameState {
  const deck = state.deck.slice()
  const street: Street = state.street === 'preflop' ? 'flop' : state.street === 'flop' ? 'turn' : 'river'
  const n = street === 'flop' ? 3 : 1
  const dealt = Array.from({ length: n }, () => deck.pop()!)
  const board = [...state.board, ...dealt]
  const players = state.players.map((p) => ({ ...p, bet: 0, acted: false, actedAtBet: -1, lastAction: p.folded || p.allIn ? p.lastAction : '' }))
  return {
    ...state,
    players,
    deck,
    board,
    street,
    currentBet: 0,
    minRaise: state.blinds.bigBlind,
    log: pushLog(state, `${street.toUpperCase()}: ${board.map(cardText).join(' ')}`),
  }
}

const cardText = (c: Card) => `${'..23456789TJQKA'[c.rank]}${c.suit}`

function finishHand(state: GameState, showdown: boolean): GameState {
  const { refund, pots } = buildPots(state.players.map((p) => ({ id: p.id, total: p.total, folded: p.folded })))
  const n = state.players.length
  // Seat order starting left of the button, used for odd chips.
  const order = Array.from({ length: n }, (_, i) => (state.button + 1 + i) % n)

  const scores = new Map<number, HandScore>()
  const hands: Record<number, string> = {}
  if (showdown) {
    for (const p of state.players.filter(live)) {
      const sc = evaluate([...p.hole, ...state.board])
      scores.set(p.id, sc)
      hands[p.id] = CATEGORY_NAME[sc.category]
    }
  }

  const payouts: Record<number, number> = {}
  const awards: PotAward[] = []
  for (const pot of pots) {
    let winners = pot.eligible
    if (showdown && winners.length > 1) {
      let best: HandScore | null = null
      let list: number[] = []
      for (const id of winners) {
        const sc = scores.get(id)!
        const c = best ? compareScores(sc, best) : 1
        if (c > 0) { best = sc; list = [id] } else if (c === 0) list.push(id)
      }
      winners = list
    }
    winners = order.filter((id) => winners.includes(id))
    for (const [id, amt] of splitPot(pot.amount, winners)) payouts[id] = (payouts[id] ?? 0) + amt
    awards.push({ amount: pot.amount, winners, eligible: pot.eligible })
  }
  if (refund) payouts[refund.id] = (payouts[refund.id] ?? 0) + refund.amount

  const players = state.players.map((p) => ({ ...p, stack: p.stack + (payouts[p.id] ?? 0) }))
  const names = (ids: number[]) => ids.map((id) => state.players[id].name).join(' & ')
  const log = [...state.log]
  for (const a of awards) {
    const how = showdown ? ` with ${hands[a.winners[0]]}` : ''
    log.push(`${names(a.winners)} win${a.winners.length === 1 ? 's' : ''} ${a.amount}${how}`)
  }
  return {
    ...state,
    players,
    phase: 'handOver',
    toAct: -1,
    seq: state.seq + 1,
    log: log.slice(-15),
    result: { showdown, pots: awards, payouts, hands, refund },
  }
}

/** Total chips in stacks plus chips currently committed to the hand. For conservation checks. */
export function totalChips(state: GameState): number {
  const inHand = state.phase === 'handOver' ? 0 : state.players.reduce((a, p) => a + p.total, 0)
  return state.players.reduce((a, p) => a + p.stack, 0) + inHand
}
