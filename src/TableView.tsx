import { useEffect, useMemo, useRef, useState } from 'react'
import { MAX_SEATS, GRACE_MS, type PublicSeat, type PublicTable } from './engine/table.ts'
import type { Card } from './engine/cards.ts'
import { api, type Live } from './net.ts'
import { Chips, PlayingCard, Slot } from './Cards.tsx'
import PotDisplay from './PotDisplay.tsx'
import { hue, money } from './hue.ts'

const DEAL_STEP = 110

/** A queued action for when it becomes your turn. */
export interface Premove {
  handId: number
  street: string
  kind: 'checkfold' | 'checkcall' | 'raise'
  raiseTo?: number
  /** The bet in front of you when you queued it; a raise afterwards cancels call/check/raise premoves. */
  facedBet: number
}

function useNow(ms: number) {
  const [n, setN] = useState(() => Date.now())
  useEffect(() => { const id = setInterval(() => setN(Date.now()), ms); return () => clearInterval(id) }, [ms])
  return n
}

function useSize() {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 520 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  return { ref, ...size }
}

interface Props {
  code: string
  uid: string
  live: Live
  mySeat: number
  onPickSeat: (seat: number) => void
  tableTheme: string
  deckStyle: string
  fourColour: boolean
  /** Static display (past table): no seats to pick, no actions. */
  readOnly?: boolean
}

export default function TableView({ code, uid, live, mySeat, onPickSeat, tableTheme, deckStyle, fourColour, readOnly }: Props) {
  const pub = live.pub as PublicTable
  const { ref, w, h } = useSize()
  const now = useNow(250)
  const serverNow = now + live.offset
  const [busy, setBusy] = useState(false)
  const [pre, setPre] = useState<Premove | null>(null)
  const fired = useRef('')
  const [msg, setMsg] = useState('')

  // ----- animation gate: animate a hand only if we saw it start while the page was open -----
  const [gate, setGate] = useState<{ id: number | null; anim: number; base: number; batch: number; len: number }>({ id: null, anim: -1, base: 0, batch: 0, len: 0 })
  if (gate.id !== pub.handId || gate.len !== pub.board.length) {
    const newHand = gate.id !== pub.handId
    const seenLive = gate.id !== null && newHand && pub.phase === 'betting'
    setGate({
      id: pub.handId,
      anim: seenLive ? pub.handId : gate.anim,
      base: newHand ? (seenLive ? 0 : pub.board.length) : gate.base,
      batch: newHand ? 0 : gate.len,
      len: pub.board.length,
    })
  }
  // When a betting round closes, the matched chips stay put for a beat, then slide into the pot.
  const [snap, setSnap] = useState(pub)
  const [sweep, setSweep] = useState<{ id: string; items: { seat: number; amount: number; fresh: boolean }[] } | null>(null)
  if (snap.handId !== pub.handId || snap.seq !== pub.seq) {
    if (snap.handId === pub.handId && snap.phase === 'betting' && (pub.street !== snap.street || pub.phase !== 'betting')) {
      const items = snap.seats.flatMap((x) => {
        if (!x || !x.inHand) return []
        const foldedNow = pub.seats[x.seat]?.folded ?? x.folded
        const amount = foldedNow || x.allIn ? x.bet : Math.max(x.bet, snap.currentBet)
        return amount > 0 ? [{ seat: x.seat, amount, fresh: x.bet < amount }] : []
      })
      setSweep({ id: `${pub.handId}-${pub.seq}`, items })
    }
    setSnap(pub)
  }
  const sweepId = sweep?.id
  useEffect(() => {
    if (!sweepId) return
    const id = setTimeout(() => setSweep(null), 1500)
    return () => clearTimeout(id)
  }, [sweepId])
  // The deal plays once: after it has finished the cards are plain elements and can never replay.
  const [settled, setSettled] = useState(-1)
  const nSeated = pub.seats.filter((x) => x?.inHand).length
  useEffect(() => {
    if (gate.anim !== pub.handId) return
    const id = setTimeout(() => setSettled(pub.handId), 2 * nSeated * DEAL_STEP + 2200)
    return () => clearTimeout(id)
  }, [gate.anim, pub.handId, nSeated])
  const animating = gate.anim === pub.handId && settled !== pub.handId

  // ----- geometry -----
  const small = w < 560
  const cx = w / 2, cy = h / 2
  const rx = Math.min(w * 0.42, (w - (small ? 96 : 128)) / 2 - 4), ry = h * (small ? 0.36 : 0.34)
  // Seats have fixed places around the table, so you sit exactly where you clicked "Sit".
  const pos = (seat: number) => {
    const th = (Math.PI / 180) * (90 + seat * (360 / MAX_SEATS))
    return { x: cx + rx * Math.cos(th), y: cy + ry * Math.sin(th) }
  }
  const deck = { x: cx - (small ? 0.2 : 0.2) * w, y: cy - 0.02 * h }
  const cw = small ? 26 : 40
  const heroCw = small ? 40 : 56
  const boardCw = small ? 32 : 52
  const sw = small ? 80 : 128

  // ----- dealing order -----
  const inHand = pub.seats.filter((s): s is PublicSeat => !!s && s.inHand)
  const order = inHand
    .map((s) => s.seat)
    .sort((a, b) => ((a - pub.button - 1 + MAX_SEATS) % MAX_SEATS) - ((b - pub.button - 1 + MAX_SEATS) % MAX_SEATS))
  const nDeal = order.length
  const dealTotal = 2 * nDeal * DEAL_STEP + 500

  // ----- client side tick / ping loops -----
  const lastFire = useRef(0)
  useEffect(() => {
    if (mySeat < 0 || pub.paused) return
    const myRank = pub.seats.slice(0, mySeat).filter(Boolean).length
    let due: number | null = null
    if (pub.phase === 'betting' && pub.deadline) {
      const rank = pub.toAct === mySeat ? 0 : 1 + ((mySeat - pub.toAct + MAX_SEATS) % MAX_SEATS)
      due = pub.deadline + GRACE_MS + 150 + rank * 1500
    } else if (pub.phase === 'handOver' && pub.nextHandAt) due = pub.nextHandAt + 150 + myRank * 900
    else if (pub.phase === 'waiting' && pub.eligible >= 2) due = (pub.nextHandAt ?? Date.now() + live.offset) + 400 + myRank * 700
    if (due === null) return
    const wait = Math.max(Math.max(0, due - (Date.now() + live.offset)), lastFire.current + 2500 - Date.now())
    const id = setTimeout(() => { lastFire.current = Date.now(); void api('tick', { code }) }, wait)
    return () => clearTimeout(id)
  }, [pub.version, pub.paused, pub.phase, pub.deadline, pub.nextHandAt, pub.toAct, pub.eligible, mySeat, code, live.offset, pub.seats])

  useEffect(() => {
    if (mySeat < 0) return
    const beat = () => { void api('ping', { code }); void api('tick', { code }) }
    beat()
    const id = setInterval(beat, 30_000)
    const vis = () => { if (document.visibilityState === 'visible') beat() }
    document.addEventListener('visibilitychange', vis)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', vis) }
  }, [mySeat >= 0, code]) // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (type: string, payload: Record<string, unknown> = {}) => {
    setBusy(true)
    setMsg('')
    const r = await api(type, { code, ...payload })
    if (!r.ok && r.error) { setMsg(r.error); setTimeout(() => setMsg(''), 2500) }
    setBusy(false)
  }
  const act = (kind: string, raiseTo?: number) => send('act', { handId: pub.handId, seq: pub.seq, kind, raiseTo })

  const myPub = mySeat >= 0 ? pub.seats[mySeat] : null
  const myTurn = !!myPub && pub.toAct === mySeat && pub.phase === 'betting'
  // A queued move disappears when the hand moves on, or when someone raises after you queued a call/check/raise.
  const activePre = pre && pre.handId === pub.handId && pre.street === pub.street && (pre.kind === 'checkfold' || pre.facedBet === pub.currentBet) ? pre : null
  useEffect(() => {
    if (!myTurn || !activePre || !pub.legal) return
    const key = `${pub.handId}:${pub.seq}`
    if (fired.current === key) return
    fired.current = key
    const lg = pub.legal
    let kind = ''
    let raiseTo: number | undefined
    if (activePre.kind === 'checkfold') kind = lg.canCheck ? 'check' : 'fold'
    else if (activePre.kind === 'checkcall') kind = lg.canCheck ? 'check' : 'call'
    else if (lg.canRaise && activePre.raiseTo !== undefined && activePre.raiseTo >= lg.minRaiseTo && activePre.raiseTo <= lg.maxRaiseTo) {
      kind = activePre.raiseTo >= lg.maxRaiseTo ? 'allin' : 'raise'
      raiseTo = activePre.raiseTo
    }
    setPre(null)
    if (kind) void send('act', { handId: pub.handId, seq: pub.seq, kind, raiseTo })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myTurn, pub.seq, pub.handId])
  const holeOk = live.hole && live.hole.handId === pub.handId ? live.hole.cards : null
  const boardY = cy + 0.02 * h
  const potSpot = { x: cx, y: boardY - boardCw * 0.7 - 22 }

  // ----- board card animation parameters -----
  const group = (i: number) => (i < 3 ? 0 : i - 2)
  const boardFly = (i: number) => {
    if (i < gate.base || i < gate.batch) return null
    const delay = (group(i) - group(gate.batch)) * 900 + (i < 3 ? (i - gate.batch) * 160 : 0) + 700
    const bx = cx + (i - 2) * (boardCw + 8)
    return { dx: deck.x - bx, dy: deck.y - boardY, rot: -12, delay, flipAt: delay + 380 }
  }

  const refund = pub.result?.refund ?? null
  // What a seat actually won: payouts minus any uncalled-bet refund (that is just their own chips coming back).
  const won = (seat: number) => (pub.result?.payouts[seat] ?? 0) - (refund && refund.seat === seat ? refund.amount : 0)
  const winners = pub.phase === 'handOver' && pub.result ? new Set(pub.result.pots.flatMap((p) => p.winners).filter((sx) => won(sx) > 0)) : new Set<number>()
  const myNet = pub.phase === 'handOver' && pub.result && mySeat >= 0 ? Math.max(0, won(mySeat)) : 0

  const seatsView = useMemo(() => pub.seats, [pub.seats])

  return (
    <div className="flex flex-col gap-2 h-full min-h-0">
      <div ref={ref} data-table={tableTheme} data-deck={deckStyle} data-faces={fourColour ? 'four' : 'classic'} className="relative w-full flex-1 min-h-0 select-none mt-14">
        <div className="rail" />
        <div className="felt" />

        {/* centre: pot, deck, board */}
        <div className="absolute" style={{ left: potSpot.x, top: potSpot.y, transform: 'translate(-50%, -50%)' }}>
          <PotDisplay amount={pub.pot} />
        </div>
        <div className="absolute" style={{ left: deck.x, top: deck.y, transform: 'translate(-50%, -50%)' }}>
          {[2, 1, 0].map((i) => <div key={i} className="absolute" style={{ left: -boardCw / 2 + i * 1.5, top: -boardCw * 0.7 - i * 1.5 }}><PlayingCard faceUp={false} width={boardCw} /></div>)}
          <div style={{ width: boardCw, height: boardCw * 1.4 }} />
        </div>
        <div className="absolute flex gap-2" style={{ left: cx, top: boardY, transform: 'translate(-50%, -50%)' }}>
          {[0, 1, 2, 3, 4].map((i) =>
            pub.board[i]
              ? <PlayingCard key={`${pub.handId}-${i}`} card={pub.board[i]} faceUp fly={boardFly(i)} width={boardCw} />
              : <Slot key={`s${i}`} width={boardCw} />,
          )}
        </div>

        {/* result banner */}
        {pub.phase === 'handOver' && pub.result && (
          <div className="absolute glass px-3 py-1.5 text-center text-xs" style={{ left: cx, top: potSpot.y - 46, transform: 'translate(-50%, -50%)', maxWidth: '70%' }}>
            {pub.result.pots.map((p, i) => (
              <div key={i}>
                <b className="text-amber-200">{p.winners.map((s) => pub.seats[s]?.name ?? 'Player').join(' & ')}</b> won {p.amount.toLocaleString()}
                {pub.result!.showdown && p.winners[0] !== undefined && pub.result!.hands[p.winners[0]] ? ` · ${pub.result!.hands[p.winners[0]]}` : ''}
              </div>
            ))}
          </div>
        )}
        {pub.paused && (
          <div className="absolute glass px-4 py-2 text-sm font-bold tracking-wide" style={{ left: cx, top: potSpot.y - 46, transform: 'translate(-50%, -50%)', zIndex: 8 }}>⏸ Paused</div>
        )}
        {pub.phase === 'waiting' && !pub.paused && (
          <div className="absolute glass px-3 py-1.5 text-sm text-white/80" style={{ left: cx, top: boardY + boardCw * 0.7 + 26, transform: 'translate(-50%, -50%)' }}>
            {pub.seats.filter(Boolean).length < 2 ? 'Waiting for another player…' : 'Dealing soon…'}
          </div>
        )}

        {/* seats */}
        {Array.from({ length: MAX_SEATS }, (_, i) => {
          const p = pos(i)
          const s = seatsView[i]
          if (!s) {
            if (mySeat >= 0 || readOnly) return null
            return (
              <button key={i} className="seat glass !w-auto px-3 py-2 text-xs text-white/70 hover:text-white hover:border-white/40" style={{ left: p.x, top: p.y }} onClick={() => onPickSeat(i)}>
                + Sit
              </button>
            )
          }
          const isMe = s.uid === uid
          const dealIdx = order.indexOf(s.seat)
          const face = (c: number): Card | null => (isMe ? holeOk?.[c] ?? null : s.cards?.[c] ?? null)
          const showCards = s.inHand && (!(pub.phase === 'handOver' && s.folded) || !!s.cards)
          const cardW = isMe ? heroCw : cw
          // Bottom-half seats have their cards between the plate and the table centre; keep the bet clear of them.
          const betSpot = { x: p.x + (cx - p.x) * 0.5, y: p.y + (cy - p.y) * 0.5 - (p.y > cy ? cardW * 1.5 : 0) }
          const fly = (c: number) => {
            if (!animating || dealIdx < 0) return null
            const delay = (c * nDeal + dealIdx) * DEAL_STEP
            return { dx: deck.x - p.x, dy: deck.y - p.y, rot: -40 + c * 25, delay, flipAt: isMe ? dealTotal + 150 : undefined }
          }
          const isTurn = pub.toAct === s.seat && pub.phase === 'betting'
          const dur = pub.settings.turnSecs
          const clock = pub.paused && pub.pausedAt ? pub.pausedAt : serverNow
          const remaining = pub.deadline ? Math.max(0, pub.deadline - clock) : 0
          const cls = ['seat', pub.paused && 'paused', s.status === 'sitOut' && 'afk', isTurn && 'turn', s.folded && s.inHand && 'folded', winners.has(s.seat) && 'won', isMe && 'me'].filter(Boolean).join(' ')
          return (
            <div key={i}>
              <div className={cls} style={{ left: p.x, top: p.y, ['--sw' as string]: `${sw}px`, ['--dur' as string]: `${dur}s`, ['--delay' as string]: `-${Math.max(0, dur * 1000 - remaining) / 1000}s` }}>
                {showCards && (
                  <div className="flex justify-center gap-1 mb-1.5" style={{ marginTop: -cardW * 0.6, marginBottom: 30, position: 'relative', zIndex: 3 }}>
                    {[0, 1].map((c) => {
                      const card = face(c)
                      const up = !!card
                      return <PlayingCard key={`${pub.handId}-${s.seat}-${c}`} card={card} faceUp={up} fly={fly(c)} dim={s.folded} width={cardW} />
                    })}
                  </div>
                )}
                <div className="plate" key={isTurn ? `t-${pub.handId}-${pub.seq}-${pub.paused}` : 'p'} style={{ position: 'relative', zIndex: 2, marginTop: showCards ? 0 : 26 }}>
                  <div className="avatar" style={{ background: `hsl(${hue(s.uid)} 60% 42%)` }}>
                    {s.name.slice(0, 1).toUpperCase()}
                    {isTurn && (
                      <svg className="ring" viewBox="0 0 40 40" key={`${pub.handId}-${pub.seq}-${pub.paused}`}>
                        <circle className="bg" cx="20" cy="20" r="18" pathLength={100} />
                        <circle className="fg" cx="20" cy="20" r="18" pathLength={100} style={{ ['--dur' as string]: `${dur}s`, ['--delay' as string]: `-${Math.max(0, dur * 1000 - remaining) / 1000}s` }} />
                      </svg>
                    )}
                  </div>
                  <div className="flex items-center justify-center gap-1 text-[11px] sm:text-[13px] font-semibold leading-tight">
                    <span className="truncate max-w-[60px] sm:max-w-[84px]" title={s.name}>{s.name}</span>
                    {s.leaving && <span className="pill">leaving</span>}
                  </div>
                  <div className="num text-[11px] sm:text-[12px] text-amber-200 font-bold">{s.status === 'busted' ? 'busted' : s.stack.toLocaleString()}</div>
                  {winners.has(s.seat) && pub.result && (
                    <div className="text-[11px] text-emerald-300 font-bold num">+{won(s.seat).toLocaleString()}</div>
                  )}
                  <div className="absolute -top-2 -right-2 flex flex-col gap-0.5">
                    {s.status === 'sitOut' && <span className="badge b-afk">AFK</span>}
                    {pub.button === s.seat && pub.phase !== 'waiting' && <span className="badge b-d" title="Dealer">D</span>}
                    {pub.sbSeat === s.seat && pub.phase !== 'waiting' && <span className="badge b-sb" title="Small blind">SB</span>}
                    {pub.bbSeat === s.seat && pub.phase !== 'waiting' && <span className="badge b-bb" title="Big blind">BB</span>}
                  </div>
                </div>
              </div>
              {s.bet > 0 && pub.phase === 'betting' && (
                <div className="absolute" style={{ left: betSpot.x, top: betSpot.y, transform: 'translate(-50%, -50%)' }} key={`bet-${pub.handId}-${s.seat}-${s.bet}`}>
                  <Chips amount={s.bet} bigBlind={pub.settings.bigBlind} fly={{ dx: p.x - betSpot.x, dy: p.y - betSpot.y, delay: animating && pub.street === 'preflop' ? dealTotal : 0 }} />
                </div>
              )}
              {sweep && sweep.items.filter((it) => it.seat === s.seat).map((it) => (
                <div key={`sw-${sweep.id}`} className="absolute" style={{ left: betSpot.x, top: betSpot.y, transform: 'translate(-50%, -50%)', zIndex: 4 }}>
                  <div className="chip-sweep" style={{ ['--dx' as string]: `${potSpot.x - betSpot.x}px`, ['--dy' as string]: `${potSpot.y - betSpot.y}px` }}>
                    <Chips amount={it.amount} bigBlind={pub.settings.bigBlind} fly={it.fresh ? { dx: p.x - betSpot.x, dy: p.y - betSpot.y, delay: 0 } : undefined} />
                  </div>
                </div>
              ))}
              {s.bet === 0 && pub.phase === 'betting' && s.lastAction === 'checks' && (
                <div className="absolute" style={{ left: betSpot.x, top: betSpot.y, transform: 'translate(-50%, -50%)' }} key={`chk-${pub.handId}-${pub.street}-${s.seat}`}>
                  <span className="check-pill">CHECK</span>
                </div>
              )}
              {winners.has(s.seat) && pub.phase === 'handOver' && (
                <div className="absolute" style={{ left: p.x, top: p.y - 10, transform: 'translate(-50%, -50%)', zIndex: 5 }} key={`win-${pub.handId}-${s.seat}`}>
                  <Chips amount={won(s.seat)} bigBlind={pub.settings.bigBlind} fly={{ dx: cx - p.x, dy: cy - p.y, delay: 200 }} />
                  <div className="float-win num text-emerald-300 font-extrabold text-lg text-center">+{won(s.seat).toLocaleString()}</div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* actions */}
      {!readOnly && <div className="flex-none min-h-[72px]">
        {myPub && pub.phase === 'handOver' && myPub.inHand && !myPub.cards && holeOk && (
          <div className="text-center mb-1">
            <button className="rounded-xl px-5 py-2 font-semibold bg-white/10 hover:bg-white/15" disabled={busy} onClick={() => send('show')}>Show cards</button>
          </div>
        )}
        {myPub && myTurn && pub.legal ? (
          <ActionBar key={`${pub.handId}-${pub.seq}`} pub={pub} lg={pub.legal} myStack={myPub.stack} busy={busy} onAct={act} />
        ) : myPub && pub.phase === 'betting' && myPub.inHand && !myPub.folded && !myPub.allIn && myPub.stack > 0 ? (
          <ActionBar key={`pre-${pub.handId}-${pub.street}-${pub.currentBet}`} pub={pub} myStack={myPub.stack} myBet={myPub.bet} busy={false} premove={activePre}
            onAct={(kind, raiseTo) => setPre(activePre && activePre.kind === kind && activePre.raiseTo === raiseTo ? null : { handId: pub.handId, street: pub.street, kind: kind as Premove['kind'], raiseTo, facedBet: pub.currentBet })} />
        ) : myPub && myPub.stack === 0 && !(myPub.inHand && !myPub.folded && pub.phase === 'betting') ? (
          <div className="text-center space-y-2">
            <div className="text-white/80">{myPub.status === 'busted' ? "You're out of chips." : ''}</div>
            <button className="rounded-xl px-6 py-3 font-bold bg-gradient-to-b from-emerald-400 to-yellow-300 text-black pulse" disabled={busy} onClick={() => send('rebuy')}>
              Rebuy {money(pub.settings.buyInCents)}{pub.settings.buyInCents ? ' · ' : ''}{pub.settings.startStack.toLocaleString()} chips
            </button>
          </div>
        ) : myPub?.status === 'sitOut' ? (
          <div className="text-center space-y-1">
            <div className="text-white/70 text-sm">You're AFK. Your seat is held until you come back.</div>
            <button className="rounded-xl px-6 py-3 font-bold bg-gradient-to-r from-emerald-400 to-yellow-300 text-black" onClick={() => send('sitOut', { out: false })}>I'm back</button>
          </div>
        ) : (
          <div className="text-center text-sm text-white/60 pt-4">
            {myPub ? '' : 'Pick a seat to play.'}
            {myNet > 0 && <div className="text-emerald-300 font-bold">You won {myNet.toLocaleString()}</div>}
          </div>
        )}
        {msg && <div className="text-center text-xs text-red-300 mt-1">{msg}</div>}
      </div>}

    </div>
  )
}

function ActionBar({ pub, lg: realLg, myStack, myBet = 0, busy, premove, onAct }: {
  pub: PublicTable
  /** The server's legal actions on your turn; absent while queuing a premove. */
  lg?: NonNullable<PublicTable['legal']>
  myStack: number
  myBet?: number
  busy: boolean
  premove?: Premove | null
  onAct: (k: string, r?: number) => void
}) {
  const pre = realLg === undefined
  // Not your turn: work out the same limits locally from public info.
  const owed = Math.max(0, pub.currentBet - myBet)
  const localMax = myBet + myStack
  const lg = realLg ?? {
    canCheck: owed === 0,
    callAmount: Math.min(owed, myStack),
    canRaise: myStack > owed,
    minRaiseTo: Math.min(pub.currentBet + pub.minRaise, localMax),
    maxRaiseTo: localMax,
    canAllIn: myStack > 0,
  }
  const [raising, setRaising] = useState(false)
  const [amount, setAmount] = useState(String(lg.minRaiseTo))
  const verb = pub.currentBet === 0 ? 'Bet' : 'Raise'
  const parsed = Number(amount)
  const isInt = amount.trim() !== '' && Number.isInteger(parsed)
  const allIn = isInt && parsed >= lg.maxRaiseTo
  // Poker rule: a raise must be at least the size of the last raise (or the big blind). Only an all-in may be smaller.
  const tooSmall = isInt && parsed < lg.minRaiseTo
  const tooBig = isInt && parsed > lg.maxRaiseTo
  const valid = isInt && !tooSmall && !tooBig
  const bb = Math.max(1, pub.settings.bigBlind)
  const setClamped = (v: number) => setAmount(String(Math.min(lg.maxRaiseTo, Math.max(lg.minRaiseTo, Math.round(v)))))
  // Presets land on whole big blinds (nobody wants to bet one extra chip); min and max stay exact.
  const potRaise = (f: number) => setClamped(Math.round((pub.currentBet + f * (pub.pot + lg.callAmount)) / bb) * bb)
  // The slider moves in big blinds and snaps to all-in when it gets within one step of the end.
  const onSlide = (v: number) => setAmount(String(lg.maxRaiseTo - v < bb ? lg.maxRaiseTo : v))
  const btn = 'rounded-xl px-4 py-3 font-bold text-sm sm:text-base transition-[scale,opacity,filter] duration-150 ease-out enabled:active:scale-[0.96] disabled:opacity-40'
  const preset = 'rounded-lg bg-white/10 hover:bg-white/20 px-3 py-1.5 text-xs font-semibold'
  const slider = Math.min(lg.maxRaiseTo, Math.max(lg.minRaiseTo, isInt ? parsed : lg.minRaiseTo))
  // Queued moves look greyed out; the one you picked lights up.
  const grey = (on: boolean) => (on ? 'bg-white/25 text-white ring-2 ring-white' : 'bg-white/10 text-white/70 hover:bg-white/15')
  const callLabel = lg.canCheck ? 'Check' : `Call ${lg.callAmount.toLocaleString()}${lg.callAmount >= myStack ? ' (all-in)' : ''}`
  const raiseSelected = premove?.kind === 'raise'
  const confirmRaise = () => {
    onAct(allIn ? 'allin' : 'raise', parsed)
    if (pre) setRaising(false)
  }
  return (
    <div className="relative space-y-2">
      <div className="flex gap-2 justify-center flex-wrap">
        {pre ? (
          <>
            <button className={`${btn} ${grey(premove?.kind === 'checkfold')}`} onClick={() => onAct('checkfold')}>Check/Fold</button>
            <button className={`${btn} ${grey(premove?.kind === 'checkcall')}`} onClick={() => onAct('checkcall')}>{callLabel}</button>
            {lg.canRaise && (
              <button className={`${btn} ${grey(raiseSelected || raising)}`} onClick={() => setRaising((v) => !v)}>
                {raiseSelected ? `${verb} to ${premove?.raiseTo?.toLocaleString()}` : verb}
              </button>
            )}
          </>
        ) : (
          <>
            <button className={`${btn} bg-rose-600`} disabled={busy} onClick={() => onAct('fold')}>Fold</button>
            {lg.canCheck
              ? <button className={`${btn} bg-sky-600`} disabled={busy} onClick={() => onAct('check')}>Check</button>
              : <button className={`${btn} bg-sky-600`} disabled={busy} onClick={() => onAct('call')}>{callLabel}</button>}
            {lg.canRaise
              ? <button className={`${btn} ${raising ? 'bg-amber-300' : 'bg-amber-500'} text-black`} disabled={busy} onClick={() => setRaising((v) => !v)}>{raising ? 'Cancel' : verb}</button>
              : lg.canAllIn && !lg.canCheck && lg.callAmount < myStack ? <button className={`${btn} bg-violet-600`} disabled={busy} onClick={() => onAct('allin')}>All-in</button> : null}
          </>
        )}
      </div>
      {raising && lg.canRaise && (
        <div className="glass p-3 space-y-2 absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-[min(92vw,28rem)] z-20" style={{ background: 'rgba(16,20,32,.97)' }}>
          <div className="flex flex-wrap gap-1.5 justify-center">
            {([['¼ pot', 0.25], ['½ pot', 0.5], ['¾ pot', 0.75], ['Pot', 1]] as const).map(([l, f]) => (
              <button key={l} className={preset} onClick={() => potRaise(f)}>{l}</button>
            ))}
            <button className={`${preset} !bg-violet-600/70`} onClick={() => setAmount(String(lg.maxRaiseTo))}>All-in</button>
          </div>
          {lg.minRaiseTo < lg.maxRaiseTo && (
            <input type="range" className="w-full accent-amber-400" min={lg.minRaiseTo} max={lg.maxRaiseTo} step={bb} value={slider} onChange={(e) => onSlide(Number(e.target.value))} aria-label={`${verb} amount`} />
          )}
          <div className="flex items-center gap-2 justify-center">
            <input type="number" inputMode="numeric" className="w-32 rounded-lg bg-black/40 border border-white/20 px-3 py-2 num text-center font-bold" value={amount} min={lg.minRaiseTo} max={lg.maxRaiseTo} step={bb}
              onChange={(e) => setAmount(e.target.value)} aria-label={`${verb} amount`} />
            <button className={`${btn} bg-amber-500 text-black`} disabled={busy || !valid} onClick={confirmRaise}>
              {allIn ? 'All-in' : `${verb} to`} {valid ? parsed.toLocaleString() : ''}
            </button>
          </div>
          {(!isInt || tooSmall || tooBig) && (
            <div className="text-center text-[11px] text-rose-300">
              {!isInt ? 'Enter a whole number.' : tooSmall ? `Minimum is ${lg.minRaiseTo.toLocaleString()}.` : `Maximum is ${lg.maxRaiseTo.toLocaleString()}.`}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
