import { useEffect, useMemo, useRef, useState } from 'react'
import { MAX_SEATS, GRACE_MS, type PublicSeat, type PublicTable } from './engine/table.ts'
import type { Card } from './engine/cards.ts'
import { api, type Live } from './net.ts'
import { Chips, PlayingCard, Slot } from './Cards.tsx'
import { hue, money } from './hue.ts'

const DEAL_STEP = 110

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
  logOpen: boolean
  tableTheme: string
  chipStyle: string
}

export default function TableView({ code, uid, live, mySeat, onPickSeat, logOpen, tableTheme, chipStyle }: Props) {
  const pub = live.pub as PublicTable
  const { ref, w, h } = useSize()
  const now = useNow(250)
  const serverNow = now + live.offset
  const [busy, setBusy] = useState(false)
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
  const rx = w * (small ? 0.4 : 0.42), ry = h * (small ? 0.38 : 0.34)
  // Seats have fixed places around the table, so you sit exactly where you clicked "Sit".
  const pos = (seat: number) => {
    const th = (Math.PI / 180) * (90 + seat * (360 / MAX_SEATS))
    return { x: cx + rx * Math.cos(th), y: cy + ry * Math.sin(th) }
  }
  const deck = { x: cx - (small ? 0.2 : 0.2) * w, y: cy - 0.02 * h }
  const cw = small ? 30 : 40
  const heroCw = small ? 44 : 56
  const boardCw = small ? 38 : 52
  const sw = small ? 96 : 128

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
    if (mySeat < 0) return
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
  }, [pub.version, pub.phase, pub.deadline, pub.nextHandAt, pub.toAct, pub.eligible, mySeat, code, live.offset, pub.seats])

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
  const holeOk = live.hole && live.hole.handId === pub.handId ? live.hole.cards : null
  const boardY = cy + 0.02 * h
  const potSpot = { x: cx, y: boardY - boardCw * 0.7 - 22 }

  // ----- board card animation parameters -----
  const group = (i: number) => (i < 3 ? 0 : i - 2)
  const boardFly = (i: number) => {
    if (i < gate.base || i < gate.batch) return null
    const delay = (group(i) - group(gate.batch)) * 900 + (i < 3 ? (i - gate.batch) * 160 : 0)
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
    <div className="flex flex-col gap-3">
      <div ref={ref} data-table={tableTheme} data-chips={chipStyle} className="relative w-full select-none mt-14" style={{ aspectRatio: small ? '3 / 4.1' : '16 / 9.5', maxHeight: '76vh' }}>
        <div className="rail" />
        <div className="felt" />

        {/* centre: pot, deck, board */}
        <div className="absolute text-center" style={{ left: potSpot.x, top: potSpot.y, transform: 'translate(-50%, -50%)' }}>
          <div className="text-[11px] uppercase tracking-widest text-white/50">Pot</div>
          <div className="num text-xl font-extrabold text-amber-200">{pub.pot.toLocaleString()}</div>
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
        {pub.phase === 'waiting' && (
          <div className="absolute glass px-3 py-1.5 text-sm text-white/80" style={{ left: cx, top: boardY + boardCw * 0.7 + 26, transform: 'translate(-50%, -50%)' }}>
            {pub.seats.filter(Boolean).length < 2 ? 'Waiting for another player…' : 'Dealing soon…'}
          </div>
        )}

        {/* seats */}
        {Array.from({ length: MAX_SEATS }, (_, i) => {
          const p = pos(i)
          const s = seatsView[i]
          if (!s) {
            if (mySeat >= 0) return null
            return (
              <button key={i} className="seat glass !w-auto px-3 py-2 text-xs text-white/70 hover:text-white hover:border-white/40" style={{ left: p.x, top: p.y }} onClick={() => onPickSeat(i)}>
                + Sit
              </button>
            )
          }
          const isMe = s.uid === uid
          const betSpot = { x: p.x + (cx - p.x) * 0.5, y: p.y + (cy - p.y) * 0.5 }
          const dealIdx = order.indexOf(s.seat)
          const face = (c: number): Card | null => (isMe ? holeOk?.[c] ?? null : s.cards?.[c] ?? null)
          const showCards = s.inHand && !(pub.phase === 'handOver' && s.folded)
          const cardW = isMe ? heroCw : cw
          const fly = (c: number) => {
            if (!animating || dealIdx < 0) return null
            const delay = (c * nDeal + dealIdx) * DEAL_STEP
            return { dx: deck.x - p.x, dy: deck.y - p.y, rot: -40 + c * 25, delay, flipAt: isMe ? dealTotal + 150 : undefined }
          }
          const isTurn = pub.toAct === s.seat && pub.phase === 'betting'
          const dur = pub.settings.turnSecs
          const remaining = pub.deadline ? Math.max(0, pub.deadline - serverNow) : 0
          const cls = ['seat', s.status === 'sitOut' && 'afk', isTurn && 'turn', s.folded && s.inHand && 'folded', winners.has(s.seat) && 'won', isMe && 'me'].filter(Boolean).join(' ')
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
                <div className="plate" key={isTurn ? `t-${pub.handId}-${pub.seq}` : 'p'} style={{ position: 'relative', zIndex: 2, marginTop: showCards ? 0 : 26 }}>
                  <div className="avatar" style={{ background: `hsl(${hue(s.uid)} 60% 42%)` }}>
                    {s.name.slice(0, 1).toUpperCase()}
                    {isTurn && (
                      <svg className="ring" viewBox="0 0 40 40" key={`${pub.handId}-${pub.seq}`}>
                        <circle className="bg" cx="20" cy="20" r="18" pathLength={100} />
                        <circle className="fg" cx="20" cy="20" r="18" pathLength={100} style={{ ['--dur' as string]: `${dur}s`, ['--delay' as string]: `-${Math.max(0, dur * 1000 - remaining) / 1000}s` }} />
                      </svg>
                    )}
                  </div>
                  <div className="flex items-center justify-center gap-1 text-[13px] font-semibold leading-tight">
                    <span className="truncate max-w-[84px]">{s.name}</span>
                    {s.leaving && <span className="pill">leaving</span>}
                    {s.status === 'sitOut' && <span className="pill !bg-white/20 font-bold">AFK</span>}
                  </div>
                  <div className="num text-[12px] text-amber-200 font-bold">{s.status === 'busted' ? 'busted' : s.stack.toLocaleString()}</div>
                  <div className="h-4 text-[11px] text-white/60 truncate">
                    {isTurn ? (isMe ? 'your move' : 'thinking…') : s.status === 'sitOut' ? `missed ${s.afkMissed ?? 0} hand${s.afkMissed === 1 ? '' : 's'}` : pub.phase === 'betting' ? s.lastAction : ''}
                    {winners.has(s.seat) && pub.result && <span className="text-emerald-300 font-bold"> +{won(s.seat).toLocaleString()}</span>}
                  </div>
                  <div className="absolute -top-2 -right-2 flex flex-col gap-0.5">
                    {pub.button === s.seat && pub.phase !== 'waiting' && <span className="badge b-d" title="Dealer">D</span>}
                    {pub.sbSeat === s.seat && pub.phase !== 'waiting' && <span className="badge b-sb" title="Small blind">SB</span>}
                    {pub.bbSeat === s.seat && pub.phase !== 'waiting' && <span className="badge b-bb" title="Big blind">BB</span>}
                  </div>
                </div>
              </div>
              {s.bet > 0 && pub.phase === 'betting' && (
                <div className="absolute" style={{ left: betSpot.x, top: betSpot.y, transform: 'translate(-50%, -50%)' }} key={`bet-${pub.handId}-${s.seat}-${s.bet}`}>
                  <Chips amount={s.bet} fly={{ dx: p.x - betSpot.x, dy: p.y - betSpot.y, delay: animating && pub.street === 'preflop' ? dealTotal : 0 }} />
                </div>
              )}
              {winners.has(s.seat) && pub.phase === 'handOver' && (
                <div className="absolute" style={{ left: p.x, top: p.y - 10, transform: 'translate(-50%, -50%)', zIndex: 5 }} key={`win-${pub.handId}-${s.seat}`}>
                  <Chips amount={won(s.seat)} fly={{ dx: cx - p.x, dy: cy - p.y, delay: 200 }} />
                  <div className="float-win num text-emerald-300 font-extrabold text-lg text-center">+{won(s.seat).toLocaleString()}</div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* actions */}
      <div className="min-h-[88px]">
        {myPub && myTurn && pub.legal ? (
          <ActionBar key={`${pub.handId}-${pub.seq}`} pub={pub} myStack={myPub.stack} busy={busy} onAct={act} />
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
            {myPub ? (pub.phase === 'betting' ? (myPub.inHand ? (myPub.folded ? 'You folded. Waiting for the hand to finish.' : 'Waiting for your turn…') : 'You will be dealt in next hand.') : '') : 'Pick a seat to play.'}
            {myNet > 0 && <div className="text-emerald-300 font-bold">You won {myNet.toLocaleString()}</div>}
          </div>
        )}
        {msg && <div className="text-center text-xs text-red-300 mt-1">{msg}</div>}
      </div>

      {logOpen && (
        <div className="glass p-3 text-xs font-mono text-white/70 max-h-40 overflow-y-auto" aria-live="polite">
          {pub.log.length ? pub.log.map((l, i) => <div key={i}>{l}</div>) : 'No hands yet.'}
        </div>
      )}
    </div>
  )
}

function ActionBar({ pub, myStack, busy, onAct }: { pub: PublicTable; myStack: number; busy: boolean; onAct: (k: string, r?: number) => void }) {
  const lg = pub.legal!
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
  const setClamped = (v: number) => setAmount(String(Math.min(lg.maxRaiseTo, Math.max(lg.minRaiseTo, Math.round(v)))))
  const potRaise = (f: number) => setClamped(pub.currentBet + f * (pub.pot + lg.callAmount))
  const btn = 'rounded-xl px-4 py-3 font-bold text-sm sm:text-base transition active:scale-95 disabled:opacity-40'
  const preset = 'rounded-lg bg-white/10 hover:bg-white/20 px-3 py-1.5 text-xs font-semibold'
  const slider = Math.min(lg.maxRaiseTo, Math.max(lg.minRaiseTo, isInt ? parsed : lg.minRaiseTo))
  return (
    <div className="space-y-2">
      <div className="flex gap-2 justify-center flex-wrap">
        <button className={`${btn} ${lg.canCheck ? 'bg-sky-600' : 'bg-rose-600'}`} disabled={busy} onClick={() => onAct(lg.canCheck ? 'check' : 'fold')}>{lg.canCheck ? 'Check' : 'Fold'}</button>
        {lg.canCheck
          ? null
          : <button className={`${btn} bg-sky-600`} disabled={busy} onClick={() => onAct('call')}>Call {lg.callAmount.toLocaleString()}{lg.callAmount >= myStack ? ' (all-in)' : ''}</button>}
        {lg.canRaise
          ? <button className={`${btn} ${raising ? 'bg-amber-300' : 'bg-amber-500'} text-black`} disabled={busy} onClick={() => setRaising((v) => !v)}>{raising ? 'Cancel' : verb}</button>
          : lg.canAllIn && !lg.canCheck && lg.callAmount < myStack ? <button className={`${btn} bg-violet-600`} disabled={busy} onClick={() => onAct('allin')}>All-in</button> : null}
      </div>
      {lg.canCheck && <div className="text-center text-xs text-white/40">Fold is only offered when there is a bet to call.</div>}
      {raising && lg.canRaise && (
        <div className="glass p-3 space-y-2 max-w-md mx-auto">
          <div className="flex flex-wrap gap-1.5 justify-center">
            {([['¼ pot', 0.25], ['½ pot', 0.5], ['¾ pot', 0.75], ['Pot', 1]] as const).map(([l, f]) => (
              <button key={l} className={preset} onClick={() => potRaise(f)}>{l}</button>
            ))}
            <button className={`${preset} !bg-violet-600/70`} onClick={() => setAmount(String(lg.maxRaiseTo))}>All-in</button>
          </div>
          {lg.minRaiseTo < lg.maxRaiseTo && (
            <input type="range" className="w-full accent-amber-400" min={lg.minRaiseTo} max={lg.maxRaiseTo} value={slider} onChange={(e) => setAmount(e.target.value)} aria-label={`${verb} amount`} />
          )}
          <div className="flex items-center gap-2 justify-center">
            <input type="number" inputMode="numeric" className="w-32 rounded-lg bg-black/40 border border-white/20 px-3 py-2 num text-center font-bold" value={amount} min={lg.minRaiseTo} max={lg.maxRaiseTo}
              onChange={(e) => setAmount(e.target.value)} aria-label={`${verb} amount`} />
            <button className={`${btn} bg-gradient-to-r from-emerald-400 to-yellow-300 text-black`} disabled={busy || !valid} onClick={() => onAct(allIn ? 'allin' : 'raise', parsed)}>
              {allIn ? 'All-in' : `${verb} to`} {valid ? parsed.toLocaleString() : ''}
            </button>
          </div>
          <div className={`text-center text-[11px] ${tooSmall || tooBig || !isInt ? 'text-rose-300' : 'text-white/40'}`}>
            {!isInt ? 'Enter a whole number.' : tooSmall ? `Minimum ${verb.toLowerCase()} is to ${lg.minRaiseTo.toLocaleString()}.` : tooBig ? `You only have ${lg.maxRaiseTo.toLocaleString()} to put in.` : `Min ${lg.minRaiseTo.toLocaleString()} · Max ${lg.maxRaiseTo.toLocaleString()} (all-in)`}
          </div>
        </div>
      )}
    </div>
  )
}
