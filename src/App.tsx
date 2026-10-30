import { useCallback, useEffect, useRef, useState } from 'react'
import TableView from './TableView.tsx'
import { api, configured, ensureUser, subscribeTable, type Live } from './net.ts'
import { hue, money } from './hue.ts'

const NAME_KEY = 'poker:name'
const LOG_KEY = 'poker:log'
const THEME_KEY = 'poker:table'
const DECK_KEY = 'poker:deck'
const FACES_KEY = 'poker:faces'
const DECKS: [string, string][] = [['indigo', 'Indigo'], ['crimson', 'Crimson'], ['emerald', 'Emerald'], ['gold', 'Gold'], ['midnight', 'Midnight']]
const TABLE_THEMES: [string, string, string][] = [
  // [id, label, preview = felt colours inside, rail colours as the ring]
  ['classic', 'Lime green', 'radial-gradient(circle at 40% 35%,#6b8f1f,#213808 90%) padding-box, linear-gradient(145deg,#2b2f3d,#12141c) border-box'],
  ['midnight', 'Midnight blue', 'radial-gradient(circle at 40% 35%,#0b3347,#04121c 90%) padding-box, linear-gradient(120deg,#22d3ee,#5eead4 45%,#facc15) border-box'],
  ['crimson', 'Crimson velvet', 'radial-gradient(circle at 40% 35%,#9a2233,#3a0911 90%) padding-box, linear-gradient(145deg,#6b3d1d,#2c1608 60%,#170b04) border-box'],
  ['noir', 'Noir & gold', 'radial-gradient(circle at 40% 35%,#2c2c33,#0a0a0d 90%) padding-box, linear-gradient(145deg,#f5d37a,#b8892b 55%,#6e4f12) border-box'],
  ['neon', 'Neon', 'radial-gradient(circle at 40% 35%,#6fc63a,#14501c 90%) padding-box, linear-gradient(120deg,#6ee7b7,#a3e635 50%,#fde047) border-box'],
  ['violet', 'Violet', 'radial-gradient(circle at 40% 35%,#5d2b8f,#1f0b38 90%) padding-box, linear-gradient(145deg,#3a3550,#17141f) border-box'],
]
const lsGet = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* ignore */ } }

function useHashCode() {
  const read = () => location.hash.replace('#', '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5)
  const [code, setCode] = useState(read)
  useEffect(() => {
    const f = () => setCode(read())
    window.addEventListener('hashchange', f)
    return () => window.removeEventListener('hashchange', f)
  }, [])
  return code
}

export default function App() {
  const code = useHashCode()
  const [uid, setUid] = useState<string | null>(null)
  const [authErr, setAuthErr] = useState('')
  useEffect(() => {
    if (!configured) return
    ensureUser().then(setUid).catch(() => setAuthErr('Could not sign in. Check your connection and refresh.'))
  }, [])

  if (!configured) return <Shell><div className="glass p-6 max-w-md mx-auto text-center">Firebase is not configured yet. Add the VITE_FIREBASE_* values to <code>.env.local</code>.</div></Shell>
  if (authErr) return <Shell><div className="glass p-6 max-w-md mx-auto text-center">{authErr}</div></Shell>
  if (!uid) return <Shell><div className="text-center text-white/60 pt-24">Connecting…</div></Shell>
  return <Shell>{code.length === 5 ? <TableScreen key={code} code={code} uid={uid} /> : <div className="h-full overflow-y-auto"><Landing /><div className="max-w-md mx-auto mt-4 pb-6"><PastTables /></div></div>}</Shell>
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-[100dvh] max-w-7xl mx-auto px-3 sm:px-5 py-2 flex flex-col overflow-hidden">
      <header className="flex items-center justify-between mb-1 flex-none">
        <a href="#" className="text-xl font-extrabold tracking-tight">♠ <span className="bg-gradient-to-r from-emerald-300 to-yellow-300 bg-clip-text text-transparent">Poker</span></a>
      </header>
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
    </div>
  )
}

const BLINDS = [[10, 20], [25, 50], [50, 100], [100, 200]]
const toCents = (dollars: string) => Math.max(0, Math.round(Number(dollars) * 100) || 0)

function Landing() {
  const [blind, setBlind] = useState(0)
  const [price, setPrice] = useState('5')
  const [chips, setChips] = useState('2000')
  const [joinCode, setJoinCode] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const field = 'w-full rounded-xl bg-black/40 border border-white/15 px-3 py-2.5 outline-none focus:border-emerald-400'
  const create = async () => {
    setBusy(true); setErr('')
    const [sb, bb] = BLINDS[blind]
    const r = await api('create', { settings: { smallBlind: sb, bigBlind: bb, startStack: Math.floor(Number(chips)) || 0, buyInCents: toCents(price) } })
    setBusy(false)
    if (r.ok && r.code) location.hash = r.code
    else setErr(r.error ?? 'Could not create a table')
  }
  return (
    <div className="max-w-md mx-auto mt-10 space-y-4">
      <div className="text-center space-y-1">
        <h1 className="text-3xl font-extrabold">Play poker with friends</h1>
        <p className="text-white/60">Texas Hold'em, play money. Make a table, share the link, deal.</p>
      </div>
      <div className="glass p-5 space-y-3">
        <h2 className="font-bold">Create a table</h2>
        <label className="block text-sm text-white/70">Blinds
          <select className={field} value={blind} onChange={(e) => setBlind(Number(e.target.value))}>
            {BLINDS.map(([s, b], i) => <option key={i} value={i}>{s} / {b}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm text-white/70">Buy-in price ($)
            <input className={field} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0 = don't track" />
          </label>
          <label className="block text-sm text-white/70">Chips per buy-in
            <input className={field} inputMode="numeric" value={chips} onChange={(e) => setChips(e.target.value)} />
          </label>
        </div>
        <button className="w-full rounded-xl px-4 py-3 font-bold bg-gradient-to-b from-emerald-400 to-yellow-300 text-black disabled:opacity-50" disabled={busy} onClick={create}>Create table</button>
      </div>
      <div className="glass p-5 space-y-3">
        <h2 className="font-bold">Join with a code</h2>
        <div className="flex gap-2">
          <input className={`${field} uppercase tracking-widest text-center`} placeholder="ABCDE" maxLength={5} value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
          <button className="rounded-xl px-5 font-bold bg-white/10 disabled:opacity-40" disabled={joinCode.length !== 5} onClick={() => { location.hash = joinCode }}>Join</button>
        </div>
      </div>
      {err && <div className="text-center text-red-300 text-sm">{err}</div>}
    </div>
  )
}

const KEEP = /^--- Hand|\b(bets|raises to|calls|win|wins)\b/

/** Minimal log: bets, calls and wins only. This hand and the last one; scroll up to read the previous hand. */
function HandLog({ handId, lines }: { handId: number; lines: string[] }) {
  const [hist, setHist] = useState<Record<number, string[]>>({})
  const box = useRef<HTMLElement>(null)
  const kept = lines.filter((l) => KEEP.test(l))
  if (kept.length > (hist[handId]?.length ?? 0)) setHist({ ...hist, [handId]: kept })
  const ids = Object.keys(hist).map(Number).sort((a, b) => a - b).slice(-2)
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }) }, [hist])
  return (
    <aside ref={box} className="glass p-3 text-xs font-mono text-white/70 max-h-64 overflow-y-auto overscroll-contain" aria-live="polite">
      <div className="text-[11px] font-sans font-bold text-white/50 mb-1.5">Hand log</div>
      {ids.length ? ids.map((id) => hist[id].map((l, i) => <div key={`${id}-${i}`} className={i === 0 ? 'mt-1.5 text-white/40' : ''}>{l}</div>)) : 'No hands yet.'}
    </aside>
  )
}

function TableScreen({ code, uid }: { code: string; uid: string }) {
  const [live, setLive] = useState<Live>({ status: 'loading', pub: null, hole: null, offset: 0, fromCache: false })
  const [showJoin, setShowJoin] = useState(false)
  const [wantSeat, setWantSeat] = useState<number | undefined>(undefined)
  const [logOpen, setLogOpen] = useState(() => lsGet(LOG_KEY) === '1')
  const [board, setBoard] = useState(false)
  const [settings, setSettings] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [copied, setCopied] = useState(false)
  const [menu, setMenu] = useState(false)
  const [codeCopied, setCodeCopied] = useState(false)
  const [tableTheme, setTableTheme] = useState(() => { const v = lsGet(THEME_KEY); return TABLE_THEMES.some((t) => t[0] === v) ? (v as string) : 'classic' })
  const [deckStyle, setDeckStyle] = useState(() => { const v = lsGet(DECK_KEY); return DECKS.some((d) => d[0] === v) ? (v as string) : 'indigo' })
  const [fourColour, setFourColour] = useState(() => lsGet(FACES_KEY) === '1')
  const [themes, setThemes] = useState(false)

  useEffect(() => subscribeTable(code, uid, (p) => setLive((l) => ({ ...l, ...p }))), [code, uid])

  const pub = live.pub
  const mySeat = pub ? pub.seats.findIndex((s) => s?.uid === uid) : -1
  const isOwner = pub?.ownerUid === uid
  // Once you were seated and no longer are (left, removed, seat freed), go back to the lobby.
  const wasSeated = useRef(false)
  useEffect(() => {
    if (!pub) return
    if (mySeat >= 0) wasSeated.current = true
    else if (wasSeated.current) location.hash = ''
  }, [pub, mySeat])
  const toggleLog = () => setLogOpen((v) => { lsSet(LOG_KEY, v ? '0' : '1'); return !v })
  const link = `${location.origin}/#${code}`
  const copy = useCallback(async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* ignore */ }
  }, [link])

  const afk = mySeat >= 0 && pub?.seats[mySeat]?.status === 'sitOut'
  const toggleAfk = () => void api('sitOut', { code, out: !afk }).then((r) => { if (!r.ok) alert(r.error) })
  const togglePause = () => void api('pause', { code, on: !pub?.paused })
  const doLeave = () => { if (confirm('Leave the table? Your chips are cashed out.')) void api('leave', { code }).then(() => { location.hash = '' }) }
  const copyCode = async () => {
    try { await navigator.clipboard.writeText(code); setCodeCopied(true); setTimeout(() => setCodeCopied(false), 1500) } catch { /* ignore */ }
  }

  if (live.status === 'missing') return (
    <div className="glass p-6 max-w-sm mx-auto text-center space-y-3 mt-10">
      <div className="font-bold text-lg">Table not found</div>
      <div className="text-white/60 text-sm">Check the link, or start a new table.</div>
      <a href="#" className="inline-block rounded-xl px-5 py-2.5 bg-gradient-to-r from-emerald-400 to-yellow-300 text-black font-bold">Create a table</a>
    </div>
  )
  if (live.status === 'error') return <div className="glass p-6 max-w-sm mx-auto text-center mt-10">Lost connection. Retrying…</div>
  if (!pub) return <div className="text-center text-white/60 pt-24">Loading table…</div>

  const joined = mySeat >= 0
  const isHost = pub.ownerUid === uid || pub.creatorUid === uid
    const chip = 'rounded-lg bg-white/10 hover:bg-white/15 px-3 py-1.5 text-xs font-semibold'
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="relative flex-none mb-1">
      <div className="flex items-center gap-1.5 sm:gap-2 text-xs">
        <button className="glass px-2.5 sm:px-3 py-1.5 font-mono tracking-widest hover:border-white/40" title="Click to copy the table code" onClick={copyCode}>{codeCopied ? 'Copied ✓' : code}</button>
        <button className={chip} onClick={() => setThemes((v) => !v)} aria-label="Look">🎨<span className="hidden sm:inline"> Look</span></button>
        <span className="hidden sm:contents">
          <button className={chip} onClick={copy}>{copied ? 'Link copied ✓' : 'Copy invite link'}</button>
          {joined && <button className={chip} onClick={toggleAfk}>{afk ? "I'm back" : 'Go AFK'}</button>}
          {joined && <button className={`${chip} !text-red-300`} onClick={doLeave}>Leave</button>}
          {isHost && <button className={chip} onClick={() => setShowHistory(true)}>History</button>}
          {isOwner && <button className={chip} onClick={() => setSettings(true)}>⚙ Settings</button>}
          {isOwner && <button className={chip} onClick={togglePause}>{pub.paused ? '▶ Resume' : '⏸ Pause'}</button>}
        </span>
        <span className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <span className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold num whitespace-nowrap">Blinds: {pub.settings.smallBlind}/{pub.settings.bigBlind}</span>
          <button className={chip} onClick={() => setBoard((v) => !v)} aria-label="Leaderboard">🏆<span className="hidden sm:inline"> Leaderboard</span></button>
          <button className={chip} onClick={toggleLog} aria-label="Log">📜<span className="hidden sm:inline"> {logOpen ? 'Hide log' : 'Show log'}</span></button>
          <button className={`${chip} sm:!hidden`} onClick={() => setMenu((v) => !v)} aria-label="Menu">⋯</button>
        </span>
      </div>
      {menu && (
        <div className="glass absolute right-0 top-full mt-2 z-40 p-2 flex flex-col gap-1.5 w-56 sm:hidden" style={{ background: 'rgba(16,20,32,.97)' }}>
          <button className={chip} onClick={() => { void copy(); setMenu(false) }}>{copied ? 'Link copied ✓' : 'Copy invite link'}</button>
          {joined && <button className={chip} onClick={() => { toggleAfk(); setMenu(false) }}>{afk ? "I'm back" : 'Go AFK'}</button>}
          {isHost && <button className={chip} onClick={() => { setShowHistory(true); setMenu(false) }}>History</button>}
          {isOwner && <button className={chip} onClick={() => { setSettings(true); setMenu(false) }}>⚙ Settings</button>}
          {isOwner && <button className={chip} onClick={() => { togglePause(); setMenu(false) }}>{pub.paused ? '▶ Resume timers' : '⏸ Pause timers'}</button>}
          {joined && <button className={`${chip} !text-red-300`} onClick={() => { setMenu(false); doLeave() }}>Leave table</button>}
        </div>
      )}

      {themes && (
        <div className="glass absolute left-0 right-0 lg:right-[21.5rem] top-full mt-2 z-40 px-3 py-2 flex items-center gap-3 flex-wrap text-xs" style={{ background: 'rgba(16,20,32,.97)' }}>
          {TABLE_THEMES.map(([id, label, bg]) => (
            <button key={id} title={label} aria-label={label} className={`swatch ${tableTheme === id ? 'on' : ''}`} style={{ background: bg }}
              onClick={() => { setTableTheme(id); lsSet(THEME_KEY, id) }} />
          ))}
          {DECKS.map(([id, label]) => (
            <button key={id} title={label} aria-label={`${label} deck`}
              className={`rounded-xl px-2.5 py-2 flex flex-col items-center gap-1.5 font-semibold ${deckStyle === id ? 'bg-white/20 ring-2 ring-white' : 'bg-white/10 hover:bg-white/15'}`}
              onClick={() => { setDeckStyle(id); lsSet(DECK_KEY, id) }}>
              <span data-deck={id} className="block" style={{ width: 28, height: 40 }}>
                <span className="pc-back block" style={{ position: 'static', width: '100%', height: '100%', transform: 'none', borderRadius: 5 }} />
              </span>
              <span>{label}</span>
            </button>
          ))}
          <button className={`rounded-lg px-3 py-1.5 font-semibold ${fourColour ? 'bg-white text-black' : 'bg-white/10'}`}
            onClick={() => { setFourColour((v) => { lsSet(FACES_KEY, v ? '0' : '1'); return !v }) }}>
            Accessible suit colours
          </button>
        </div>
      )}
      </div>
      <div className="flex-1 min-h-0 lg:flex lg:gap-4">
        <div className="flex-1 min-w-0 h-full min-h-0">
          <TableView code={code} uid={uid} live={live} mySeat={mySeat} tableTheme={tableTheme} deckStyle={deckStyle} fourColour={fourColour} onPickSeat={(s) => { setWantSeat(s); setShowJoin(true) }} />
        </div>
        {(board || logOpen) && (
          <div className="fixed inset-x-3 top-28 z-30 max-h-[45dvh] overflow-y-auto overscroll-contain space-y-3 lg:static lg:inset-auto lg:z-auto lg:w-80 lg:shrink-0 lg:mt-12 lg:max-h-full">
            {board && <Leaderboard pub={pub} uid={uid} isOwner={isOwner} code={code} onClose={() => setBoard(false)} />}
            {logOpen && (
              <HandLog handId={pub.handId} lines={pub.log} />
            )}
          </div>
        )}
      </div>

      {!joined && (
        <div className="flex flex-wrap justify-center gap-2 py-2 flex-none">
          <button className="rounded-xl px-6 py-3 font-bold bg-gradient-to-b from-emerald-400 to-yellow-300 text-black" onClick={() => { setWantSeat(undefined); setShowJoin(true) }}>Join this table</button>
          {isHost && <button className="rounded-xl px-5 py-3 font-semibold bg-white/10 hover:bg-white/15" onClick={() => setShowHistory(true)}>History</button>}
          <button className="rounded-xl px-5 py-3 font-semibold bg-white/10 hover:bg-white/15" onClick={() => { location.hash = '' }}>Back to lobby</button>
        </div>
      )}

      {!joined && showJoin && <JoinCard code={code} seat={wantSeat} full={pub.seats.every(Boolean)} onClose={() => setShowJoin(false)} />}
      {showHistory && <HistoryCard code={code} onClose={() => setShowHistory(false)} />}
      {settings && <SettingsCard code={code} pub={pub} onClose={() => setSettings(false)} />}
    </div>
  )
}

type HistoryData = { final: import('./engine/table.ts').PublicTable | null; entries: { at: number; lines: string[] }[]; leaderboard: import('./engine/table.ts').PublicTable['leaderboard']; settings: import('./engine/table.ts').PublicTable['settings'] }

/** Host-only record of everything that happened at the table, kept for a month. */
function HistoryCard({ code, onClose }: { code: string; onClose: () => void }) {
  const [data, setData] = useState<HistoryData | null>(null)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let live = true
    void api('history', { code }).then((r) => {
      if (!live) return
      if (r.ok) setData((r as unknown as { history: HistoryData }).history)
      else setErr(r.error ?? 'Could not load the history')
    })
    return () => { live = false }
  }, [code])
  const stamp = (at: number) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const paid = (data?.settings.buyInCents ?? 0) > 0
  const text = data ? [
    `Table ${code}`,
    ...data.leaderboard.map((r) => `${r.name}: ${r.buyIns} buy-in${r.buyIns === 1 ? '' : 's'}, ${r.seated ? `${r.stack} chips on table` : `left with ${r.cashedOut}`}, net ${r.net}${paid ? `, ${money(r.netCents, true) || '$0'}` : ''}`),
    '',
    ...data.entries.flatMap((e) => e.lines.map((l) => `${stamp(e.at)}  ${l}`)),
  ].join('\n') : ''
  const copy = async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* ignore */ } }
  const sign = (n: number) => (n > 0 ? '+' : '')
  return (
    <div className="fixed inset-0 z-30 bg-black/70 backdrop-blur-sm grid place-items-center p-4" onClick={onClose}>
      <div className="glass p-4 w-full max-w-2xl max-h-[88dvh] flex flex-col" style={{ background: 'rgba(16,20,32,.97)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-bold">History · {code}</h2>
          <div className="flex gap-2">
            {data && <button className="rounded-lg px-3 py-1 text-sm bg-white/10" onClick={copy}>{copied ? 'Copied' : 'Copy all'}</button>}
            <button className="text-white/60 px-1" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>
        {err && <div className="text-red-300 text-sm">{err}</div>}
        {!data && !err && <div className="text-white/60 text-sm">Loading…</div>}
        {data && (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain space-y-3">
            <div className="text-xs">
              <div className="flex gap-2 text-[10px] uppercase tracking-wide text-white/40 pb-1">
                <span className="flex-1">Player</span><span className="w-16 text-right">Chips</span><span className="w-16 text-right">Net</span>{paid && <span className="w-16 text-right">Profit</span>}
              </div>
              {data.leaderboard.map((r) => (
                <div key={r.uid} className="flex gap-2 py-1 border-t border-white/5 items-baseline">
                  <span className="flex-1 min-w-0 truncate">{r.name} <span className="text-white/40">{r.buyIns}×{paid ? ` ${money(r.paidCents)}` : ''}</span></span>
                  <span className="w-16 text-right num">{r.seated ? r.stack.toLocaleString() : `left ${r.cashedOut.toLocaleString()}`}</span>
                  <span className={`w-16 text-right num ${r.net > 0 ? 'text-emerald-300' : r.net < 0 ? 'text-rose-300' : ''}`}>{sign(r.net)}{r.net.toLocaleString()}</span>
                  {paid && <span className={`w-16 text-right num ${r.netCents > 0 ? 'text-emerald-300' : r.netCents < 0 ? 'text-rose-300' : ''}`}>{money(r.netCents, true) || '$0'}</span>}
                </div>
              ))}
            </div>
            <div className="font-mono text-[11px] text-white/70 space-y-px">
              {data.entries.flatMap((e, i) => e.lines.map((l, j) => (
                <div key={`${i}-${j}`} className="flex gap-2"><span className="text-white/30 shrink-0 w-24">{j === 0 ? stamp(e.at) : ''}</span><span>{l}</span></div>
              )))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function PastTables() {
  const [tables, setTables] = useState<{ code: string; at: number }[]>([])
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void api('myTables').then((r) => { if (live && r.ok) setTables((r as unknown as { tables: { code: string; at: number }[] }).tables ?? []) })
    return () => { live = false }
  }, [])
  if (!tables.length) return null
  return (
    <>
    <div className="glass p-5 space-y-2">
      <h2 className="font-bold">Your past tables</h2>
      {tables.map((x) => (
        <button key={x.code} onClick={() => setOpen(x.code)} className="w-full flex justify-between rounded-xl px-3 py-2 bg-white/5 hover:bg-white/10">
          <span className="font-mono font-bold tracking-widest">{x.code}</span>
          <span className="text-white/50 text-sm">{new Date(x.at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
        </button>
      ))}
    </div>
    {open && <PastTable code={open} onClose={() => setOpen(null)} />}
    </>
  )
}

/** A finished table: history and final standings only. There is no way to join from here. */
function PastTable({ code, onClose }: { code: string; onClose: () => void }) {
  const [view, setView] = useState<'menu' | 'history' | 'final'>('menu')
  const [final, setFinal] = useState<{ pub: import('./engine/table.ts').PublicTable | null } | null>(null)
  const openFinal = () => {
    setView('final')
    void api('history', { code }).then((r) => setFinal({ pub: r.ok ? (r as unknown as { history: HistoryData }).history.final : null }))
  }
  if (view === 'history') return <HistoryCard code={code} onClose={onClose} />
  if (view === 'final') {
    return (
      <div className="fixed inset-0 z-30 bg-black/80 backdrop-blur-sm flex flex-col p-4" onClick={onClose}>
        <div className="flex items-center justify-between mb-2" onClick={(e) => e.stopPropagation()}>
          <h2 className="text-lg font-bold">Final standings · {code}</h2>
          <button className="text-white/60 px-2" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="flex-1 min-h-0" onClick={(e) => e.stopPropagation()}>
          {!final && <div className="text-white/60 text-sm">Loading…</div>}
          {final && !final.pub && <div className="text-white/60 text-sm">No final screen was saved for this table.</div>}
          {final?.pub && (
            <TableView code={code} uid="" live={{ status: 'ready', pub: final.pub, hole: null, offset: 0, fromCache: false }} mySeat={-1} readOnly
              tableTheme={lsGet(THEME_KEY) ?? 'classic'} deckStyle={lsGet(DECK_KEY) ?? 'indigo'} fourColour={lsGet(FACES_KEY) === '1'} onPickSeat={() => {}} />
          )}
        </div>
      </div>
    )
  }
  return (
    <Modal onClose={onClose}>
      <h2 className="text-lg font-bold mb-3 font-mono tracking-widest">{code}</h2>
      <div className="grid gap-2">
        <button className="rounded-xl px-4 py-3 font-semibold bg-white/10 hover:bg-white/15" onClick={() => setView('history')}>History</button>
        <button className="rounded-xl px-4 py-3 font-semibold bg-white/10 hover:bg-white/15" onClick={openFinal}>Final standings</button>
        <button className="rounded-xl px-4 py-2 text-white/60" onClick={onClose}>Close</button>
      </div>
    </Modal>
  )
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-30 bg-black/70 backdrop-blur-sm grid place-items-center p-4" onClick={onClose}>
      <div className="glass p-5 w-full max-w-md max-h-[85vh] overflow-y-auto overscroll-contain" style={{ background: 'rgba(16,20,32,.96)' }} onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  )
}

function JoinCard({ code, seat, full, onClose }: { code: string; seat?: number; full: boolean; onClose: () => void }) {
  const [name, setName] = useState(() => lsGet(NAME_KEY) ?? '')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const go = async () => {
    const n = name.trim()
    if (!n) return setErr('Pick a nickname first')
    lsSet(NAME_KEY, n)
    setBusy(true)
    const r = await api('sit', { code, name: n, seat })
    setBusy(false)
    if (r.ok) onClose(); else setErr(r.error ?? 'Could not join')
  }
  return (
    <Modal onClose={onClose}>
      <h2 className="text-lg font-bold mb-1">Join table {code}</h2>
      <p className="text-sm text-white/60 mb-3">{full ? 'The table is full right now.' : 'Choose a nickname. Everyone at the table will see it.'}</p>
      <input autoFocus className="w-full rounded-xl bg-black/40 border border-white/15 px-3 py-2.5 outline-none focus:border-emerald-400" placeholder="Nickname" maxLength={16} value={name}
        onChange={(e) => { setName(e.target.value); setErr('') }} onKeyDown={(e) => { if (e.key === 'Enter') void go() }} />
      {err && <div className="text-red-300 text-sm mt-2">{err}</div>}
      <div className="flex gap-2 justify-end mt-4">
        <button className="rounded-xl px-4 py-2 bg-white/10" onClick={onClose}>Just watch</button>
        <button className="rounded-xl px-5 py-2 font-bold bg-gradient-to-r from-emerald-400 to-yellow-300 text-black disabled:opacity-50" disabled={busy || full} onClick={go}>Take a seat</button>
      </div>
    </Modal>
  )
}

function Leaderboard({ pub, uid, isOwner, code, onClose }: { pub: import('./engine/table.ts').PublicTable; uid: string; isOwner: boolean; code: string; onClose: () => void }) {
  const paid = (pub.settings.buyInCents ?? 0) > 0
  const sign = (n: number) => (n > 0 ? '+' : '')
  const tone = (n: number) => (n > 0 ? 'text-emerald-300' : n < 0 ? 'text-rose-300' : 'text-white/60')
  return (
    <aside className="glass p-4 max-h-[60vh] overflow-y-auto overscroll-contain">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-bold">🏆 Leaderboard</h2>
        <button className="text-white/60 px-1" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="flex justify-end gap-2.5 pr-0.5 text-[10px] uppercase tracking-wide text-white/40 num">
        <span className="w-12 text-right">Total</span><span className="w-12 text-right">Net chips</span><span className="w-12 text-right">Profit</span>
        {isOwner && <span className="w-5" />}
      </div>
      <div className="divide-y divide-white/5">
        {pub.leaderboard.map((r, i) => (
          <div key={r.uid} className={`flex items-center gap-2.5 py-2.5 ${r.seated ? '' : 'opacity-50'}`}>
            <span className="w-4 text-center text-xs text-white/40 num">{i + 1}</span>
            <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: `hsl(${hue(r.uid)} 60% 50%)` }} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold text-sm" title={r.name}>{r.name}{r.uid === uid ? ' (you)' : ''}</div>
              <div className="text-[11px] text-white/50 truncate">
                {r.buyIns} buy-in{r.buyIns === 1 ? '' : 's'}{paid ? ` · ${money(r.paidCents)}` : ''}{!r.seated ? ' · left' : ''}
              </div>
            </div>
            <div className="flex shrink-0 text-right num text-xs gap-2.5">
              <span className="w-12 font-bold text-sm">{r.stack.toLocaleString()}</span>
              <span className={`w-12 font-semibold ${tone(r.net)}`}>{sign(r.net)}{r.net.toLocaleString()}</span>
              <span className={`w-12 font-semibold ${paid ? tone(r.netCents) : 'text-white/30'}`}>{paid ? money(r.netCents, true) || '$0' : '–'}</span>
            </div>
            {isOwner && r.seated && r.uid !== uid && (
              <button className="text-white/40 hover:text-red-300 px-1 shrink-0" title={`Remove ${r.name}`} aria-label={`Remove ${r.name}`}
                onClick={() => { if (confirm(`Remove ${r.name}?`)) void api('kick', { code, target: r.uid }) }}>✕</button>
            )}
          </div>
        ))}
      </div>
      {!pub.leaderboard.length && <div className="text-white/50 text-sm">No players yet.</div>}
    </aside>
  )
}

function SettingsCard({ code, pub, onClose }: { code: string; pub: import('./engine/table.ts').PublicTable; onClose: () => void }) {
  const [bb, setBb] = useState(pub.pendingSettings?.bigBlind ?? pub.settings.bigBlind)
  const [stack, setStack] = useState(pub.pendingSettings?.startStack ?? pub.settings.startStack)
  const [price, setPrice] = useState(String((pub.pendingSettings?.buyInCents ?? pub.settings.buyInCents ?? 0) / 100))
  const [err, setErr] = useState('')
  const priceOk = Number.isFinite(Number(price)) && price.trim() !== ''
  const save = async () => {
    if (!Number.isFinite(bb) || !Number.isFinite(stack) || !priceOk) return setErr('Enter valid numbers')
    const r = await api('settings', { code, settings: { smallBlind: Math.max(1, Math.floor(bb / 2)), bigBlind: bb, startStack: stack, buyInCents: toCents(price) } })
    if (r.ok) onClose(); else setErr(r.error ?? 'Invalid settings')
  }
  const f = 'w-full rounded-xl bg-black/40 border border-white/15 px-3 py-2'
  return (
    <Modal onClose={onClose}>
      <h2 className="text-lg font-bold mb-2">Table settings</h2>
      <p className="text-xs text-white/50 mb-3">Changes apply from the next hand. New buy-ins use the new stack size.</p>
      <label className="block text-sm mb-2">Big blind<input className={f} type="number" min={2} step={2} value={bb} onChange={(e) => setBb(Math.floor(Number(e.target.value)))} /></label>
      <label className="block text-sm mb-2">Buy-in price ($, 0 = don't track money)<input className={f} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
      <label className="block text-sm mb-2">Chips per buy-in (at least 20 big blinds)<input className={f} type="number" min={bb * 20} step={100} value={stack} onChange={(e) => setStack(Math.floor(Number(e.target.value)))} /></label>
      {err && <div className="text-red-300 text-sm">{err}</div>}
      <div className="flex gap-2 justify-end mt-3"><button className="rounded-xl px-4 py-2 bg-white/10" onClick={onClose}>Cancel</button><button className="rounded-xl px-5 py-2 font-bold bg-gradient-to-r from-emerald-400 to-yellow-300 text-black" onClick={save}>Save</button></div>
    </Modal>
  )
}

