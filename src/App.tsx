import { useEffect, useRef, useState } from 'react'
import { legalActions, type GameState, type Player, type Settings } from './engine/game.ts'
import { CardView, Chips } from './ui.tsx'
import { useGame } from './hooks.ts'

function Seat({ p, state }: { p: Player; state: GameState }) {
  const over = state.phase === 'handOver'
  const reveal = over && state.result?.showdown && !p.folded
  const isButton = state.button === p.id
  const won = over ? state.result?.payouts[p.id] ?? 0 : 0
  const net = won - p.total
  const cls = ['seat px-2 py-1.5 text-center min-w-[7rem]']
  if (state.toAct === p.id) cls.push('turn')
  if (p.folded) cls.push('folded')
  if (over && net > 0) cls.push('winner')
  return (
    <div className={cls.join(' ')}>
      <div className="flex items-center justify-center gap-1 text-sm font-semibold">
        {isButton && state.phase !== 'idle' && <span className="rounded-full bg-white text-black text-[10px] px-1.5 font-bold" title="Dealer button">D</span>}
        {p.name}
      </div>
      <div className="text-xs text-amber-300"><Chips n={p.stack} /></div>
      <div className="flex justify-center gap-1 my-1">
        {p.hole.length === 2
          ? p.hole.map((c, i) => <CardView key={i} card={c} hidden={!p.human && !reveal} dim={p.folded} />)
          : [0, 1].map((i) => <CardView key={i} />)}
      </div>
      <div className="text-[11px] h-4 text-white/70 truncate">
        {over && reveal && state.result?.hands[p.id]}
        {over && net > 0 && <span className="text-green-400 font-bold"> +{net}</span>}
        {!over && p.lastAction}
      </div>
      {p.bet > 0 && !over && <div className="text-[11px] text-amber-200">bet <Chips n={p.bet} /></div>}
    </div>
  )
}

function ActionBar({ state, act }: { state: GameState; act: (k: 'fold' | 'check' | 'call' | 'raise' | 'allin', r?: number) => void }) {
  const lg = legalActions(state, 0)
  const mine = state.toAct === 0 && state.phase === 'betting'
  const me = state.players[0]
  // The parent keys this component on (hand, seq), so the box resets for every decision.
  const [amount, setAmount] = useState(() => String(lg.minRaiseTo || ''))
  const pot = state.players.reduce((a, p) => a + p.total, 0)

  const clamp = (v: number) => Math.min(lg.maxRaiseTo, Math.max(lg.minRaiseTo, Number.isFinite(v) ? Math.round(v) : lg.minRaiseTo))
  const value = clamp(Number(amount))
  const preset = (frac: number) => setAmount(String(clamp(state.currentBet + frac * (pot + lg.callAmount))))

  const btn = 'rounded-lg px-4 py-2.5 font-semibold text-sm sm:text-base transition active:scale-95'
  return (
    <div className="w-full max-w-2xl mx-auto space-y-2">
      <div className="flex gap-2 justify-center flex-wrap">
        <button className={`${btn} bg-red-700`} disabled={!mine} onClick={() => act('fold')}>Fold</button>
        {lg.canCheck
          ? <button className={`${btn} bg-sky-700`} disabled={!mine} onClick={() => act('check')}>Check</button>
          : <button className={`${btn} bg-sky-700`} disabled={!mine} onClick={() => act('call')}>
              Call{mine ? ` ${lg.callAmount}` : ''}{mine && lg.callAmount >= me.stack ? ' (all-in)' : ''}
            </button>}
        <button className={`${btn} bg-amber-600`} disabled={!mine || !lg.canRaise} onClick={() => act(value >= lg.maxRaiseTo ? 'allin' : 'raise', value)}>
          {state.currentBet === 0 ? 'Bet' : 'Raise to'} {lg.canRaise ? value : ''}
        </button>
        <button className={`${btn} bg-purple-700`} disabled={!mine || !lg.canAllIn} onClick={() => act('allin')}>All-in</button>
      </div>
      {mine && lg.canRaise && lg.minRaiseTo < lg.maxRaiseTo && (
        <div className="flex items-center gap-2 justify-center flex-wrap text-xs">
          <button className="rounded bg-white/10 px-2 py-1" onClick={() => preset(0.5)}>½ pot</button>
          <button className="rounded bg-white/10 px-2 py-1" onClick={() => preset(0.75)}>¾ pot</button>
          <button className="rounded bg-white/10 px-2 py-1" onClick={() => preset(1)}>pot</button>
          <input type="range" className="w-40 accent-amber-500" min={lg.minRaiseTo} max={lg.maxRaiseTo} value={value} onChange={(e) => setAmount(e.target.value)} aria-label="Raise amount" />
          <input type="number" inputMode="numeric" className="w-24 rounded bg-black/40 border border-white/20 px-2 py-1" min={lg.minRaiseTo} max={lg.maxRaiseTo} value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={() => setAmount(String(value))} aria-label="Raise amount" />
        </div>
      )}
    </div>
  )
}

function SettingsPanel({ settings, onApply, onClose }: { settings: Settings; onApply: (s: Settings) => void; onClose: () => void }) {
  const [bots, setBots] = useState(settings.bots)
  const [bb, setBb] = useState(settings.bigBlind)
  const [stack, setStack] = useState(settings.startStack)
  const valid = bb >= 2 && stack >= bb * 20
  const field = 'w-full rounded bg-black/40 border border-white/20 px-2 py-1.5'
  return (
    <div className="fixed inset-0 z-20 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-neutral-900 rounded-2xl p-5 w-full max-w-sm space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold">New game</h2>
        <label className="block text-sm">Opponents
          <select className={field} value={bots} onChange={(e) => setBots(Number(e.target.value))}>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="block text-sm">Big blind (small blind is half)
          <input className={field} type="number" min={2} step={2} value={bb} onChange={(e) => setBb(Math.max(0, Math.floor(Number(e.target.value))))} />
        </label>
        <label className="block text-sm">Starting chips (at least 20 big blinds)
          <input className={field} type="number" min={bb * 20} step={100} value={stack} onChange={(e) => setStack(Math.max(0, Math.floor(Number(e.target.value))))} />
        </label>
        <div className="flex gap-2 justify-end">
          <button className="rounded-lg px-4 py-2 bg-white/10" onClick={onClose}>Cancel</button>
          <button className="rounded-lg px-4 py-2 bg-amber-600 font-semibold" disabled={!valid}
            onClick={() => { onApply({ bots, bigBlind: bb, smallBlind: Math.max(1, Math.floor(bb / 2)), startStack: stack }); onClose() }}>
            Start
          </button>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const { state, deal, act, rebuy, newGame } = useGame()
  const [showSettings, setShowSettings] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }) }, [state.log.length])

  const pot = state.players.reduce((a, p) => a + p.total, 0)
  const me = state.players[0]
  const over = state.phase === 'handOver'
  const bots = state.players.slice(1)
  const myWin = over ? (state.result?.payouts[0] ?? 0) - me.total : 0
  const busted = state.phase !== 'betting' && me.stack === 0

  return (
    <div className="min-h-full flex flex-col p-2 sm:p-4 gap-2 max-w-4xl mx-auto">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight">♠ Poker</h1>
        <div className="flex items-center gap-3 text-xs text-white/70">
          <span>Hand {state.handId} · Blinds {state.settings.smallBlind}/{state.settings.bigBlind}</span>
          <button className="rounded bg-white/10 px-2 py-1" onClick={() => setShowSettings(true)}>New game</button>
        </div>
      </header>

      <div className="felt rounded-[2rem] sm:rounded-[3rem] flex-1 flex flex-col items-center justify-between gap-3 p-3 sm:p-6 min-h-[28rem]">
        <div className="flex flex-wrap justify-center gap-2">{bots.map((p) => <Seat key={p.id} p={p} state={state} />)}</div>

        <div className="flex flex-col items-center gap-2">
          <div className="text-sm font-semibold text-amber-200">Pot <Chips n={over ? 0 : pot} /></div>
          <div className="flex gap-1.5">
            {[0, 1, 2, 3, 4].map((i) => <CardView key={i} card={state.board[i]} deal />)}
          </div>
          {over && state.result && (
            <div className="text-center text-sm bg-black/60 rounded-xl px-3 py-2 max-w-sm">
              {state.result.pots.map((a, i) => (
                <div key={i}>
                  {a.winners.map((id) => state.players[id].name).join(' & ')} won {a.amount}
                  {state.result!.showdown ? ` with ${state.result!.hands[a.winners[0]]}` : ''}
                </div>
              ))}
              {myWin !== 0 && <div className={myWin > 0 ? 'text-green-400 font-bold' : 'text-red-300'}>You {myWin > 0 ? 'won' : 'lost'} {Math.abs(myWin)} this hand</div>}
            </div>
          )}
          {state.phase === 'idle' && <div className="text-white/80">Ready when you are.</div>}
        </div>

        <Seat p={me} state={state} />
      </div>

      <div className="min-h-[5.5rem]">
        {state.phase === 'betting'
          ? <ActionBar key={`${state.handId}:${state.seq}`} state={state} act={act} />
          : busted
            ? <div className="text-center space-y-2"><div>You're out of chips.</div><button className="rounded-lg px-5 py-2.5 bg-amber-600 font-semibold" onClick={rebuy}>Rebuy {state.settings.startStack.toLocaleString()}</button></div>
            : <div className="text-center"><button className="rounded-lg px-6 py-3 bg-amber-600 font-bold text-lg active:scale-95" onClick={deal} autoFocus>{state.phase === 'idle' ? 'Deal' : 'Next hand'}</button></div>}
      </div>

      <div ref={logRef} className="h-24 overflow-y-auto rounded-lg bg-black/40 p-2 text-xs text-white/70 font-mono" aria-live="polite">
        {state.log.map((l, i) => <div key={i}>{l}</div>)}
      </div>
      <footer className="text-center text-[11px] text-white/40">Play money only. Rebuys: {state.rebuys}</footer>

      {showSettings && <SettingsPanel settings={state.settings} onApply={newGame} onClose={() => setShowSettings(false)} />}
    </div>
  )
}
