import { useCallback, useEffect, useState } from 'react'
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
  ['classic', 'Lime green', 'radial-gradient(circle at 40% 35%,#86b02a,#2f4d0d 90%) padding-box, linear-gradient(145deg,#2b2f3d,#12141c) border-box'],
  ['midnight', 'Midnight blue', 'radial-gradient(circle at 40% 35%,#21468f,#0a1838 90%) padding-box, linear-gradient(145deg,#b9c4dd,#4a5878 55%,#232b40) border-box'],
  ['crimson', 'Crimson velvet', 'radial-gradient(circle at 40% 35%,#9a2233,#3a0911 90%) padding-box, linear-gradient(145deg,#6b3d1d,#2c1608 60%,#170b04) border-box'],
  ['noir', 'Noir & gold', 'radial-gradient(circle at 40% 35%,#2c2c33,#0a0a0d 90%) padding-box, linear-gradient(145deg,#f5d37a,#b8892b 55%,#6e4f12) border-box'],
  ['neon', 'Neon', 'radial-gradient(circle at 40% 35%,#0b3347,#04121c 90%) padding-box, linear-gradient(120deg,#22d3ee,#5eead4 45%,#facc15) border-box'],
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
  return <Shell>{code.length === 5 ? <TableScreen key={code} code={code} uid={uid} /> : <Landing />}</Shell>
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-full max-w-7xl mx-auto px-3 sm:px-5 py-3">
      <header className="flex items-center justify-between mb-2">
        <a href="#" className="text-xl font-extrabold tracking-tight">♠ <span className="bg-gradient-to-r from-emerald-300 to-yellow-300 bg-clip-text text-transparent">Poker</span></a>
      </header>
      {children}
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

function TableScreen({ code, uid }: { code: string; uid: string }) {
  const [live, setLive] = useState<Live>({ status: 'loading', pub: null, hole: null, offset: 0, fromCache: false })
  const [showJoin, setShowJoin] = useState(false)
  const [wantSeat, setWantSeat] = useState<number | undefined>(undefined)
  const [logOpen, setLogOpen] = useState(() => lsGet(LOG_KEY) === '1')
  const [board, setBoard] = useState(false)
  const [settings, setSettings] = useState(false)
  const [copied, setCopied] = useState(false)
  const [codeCopied, setCodeCopied] = useState(false)
  const [tableTheme, setTableTheme] = useState(() => { const v = lsGet(THEME_KEY); return TABLE_THEMES.some((t) => t[0] === v) ? (v as string) : 'classic' })
  const [deckStyle, setDeckStyle] = useState(() => { const v = lsGet(DECK_KEY); return DECKS.some((d) => d[0] === v) ? (v as string) : 'indigo' })
  const [fourColour, setFourColour] = useState(() => lsGet(FACES_KEY) === '1')
  const [themes, setThemes] = useState(false)

  useEffect(() => subscribeTable(code, uid, (p) => setLive((l) => ({ ...l, ...p }))), [code, uid])

  const pub = live.pub
  const mySeat = pub ? pub.seats.findIndex((s) => s?.uid === uid) : -1
  const isOwner = pub?.ownerUid === uid
  const toggleLog = () => setLogOpen((v) => { lsSet(LOG_KEY, v ? '0' : '1'); return !v })
  const link = `${location.origin}/#${code}`
  const copy = useCallback(async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* ignore */ }
  }, [link])

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
  const chip = 'rounded-lg bg-white/10 hover:bg-white/15 px-3 py-1.5 text-xs font-semibold'
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
        <button className="glass px-3 py-1.5 font-mono tracking-widest hover:border-white/40" title="Click to copy the table code" onClick={copyCode}>{codeCopied ? 'Copied ✓' : code}</button>
        <button className={chip} onClick={copy}>{copied ? 'Link copied ✓' : 'Copy invite link'}</button>
        <button className={chip} onClick={() => setThemes((v) => !v)}>🎨 Look</button>
        {joined && <button className={chip} onClick={() => void api('sitOut', { code, out: pub.seats[mySeat]?.status !== 'sitOut' }).then((r) => { if (!r.ok) alert(r.error) })}>{pub.seats[mySeat]?.status === 'sitOut' ? "I'm back" : 'Go AFK'}</button>}
        {joined && <button className={`${chip} !text-red-300`} onClick={() => { if (confirm('Leave the table? Your chips are cashed out.')) void api('leave', { code }) }}>Leave</button>}
        {isOwner && <button className={chip} onClick={() => setSettings(true)}>⚙ Settings</button>}
        <span className="ml-auto flex items-center gap-2">
          <span className="text-white/50">Blinds {pub.settings.smallBlind}/{pub.settings.bigBlind}</span>
          <button className={chip} onClick={() => setBoard((v) => !v)}>🏆 Leaderboard</button>
          <button className={chip} onClick={toggleLog}>{logOpen ? 'Hide log' : 'Show log'}</button>
        </span>
      </div>

      {themes && (
        <div className="glass px-3 py-2 mb-2 flex items-center gap-3 flex-wrap text-xs">
          <span className="text-white/60">Table</span>
          {TABLE_THEMES.map(([id, label, bg]) => (
            <button key={id} title={label} aria-label={label} className={`swatch ${tableTheme === id ? 'on' : ''}`} style={{ background: bg }}
              onClick={() => { setTableTheme(id); lsSet(THEME_KEY, id) }} />
          ))}
          <span className="text-white/50">{TABLE_THEMES.find((t) => t[0] === tableTheme)?.[1]}</span>
          <span className="text-white/60 ml-3">Deck</span>
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
            Four-colour faces
          </button>
        </div>
      )}
      <div className="lg:flex lg:items-start lg:gap-4">
        <div className="flex-1 min-w-0">
          <TableView code={code} uid={uid} live={live} mySeat={mySeat} tableTheme={tableTheme} deckStyle={deckStyle} fourColour={fourColour} onPickSeat={(s) => { setWantSeat(s); setShowJoin(true) }} />
        </div>
        {(board || logOpen) && (
          <div className="lg:w-80 lg:shrink-0 mt-3 lg:mt-14 space-y-3 lg:sticky lg:top-3">
            {board && <Leaderboard pub={pub} uid={uid} isOwner={isOwner} code={code} onClose={() => setBoard(false)} />}
            {logOpen && (
              <aside className="glass p-3 text-xs font-mono text-white/70 max-h-64 overflow-y-auto" aria-live="polite">
                <div className="text-[11px] font-sans font-bold text-white/50 mb-1.5">Hand log</div>
                {pub.log.length ? pub.log.map((l, i) => <div key={i}>{l}</div>) : 'No hands yet.'}
              </aside>
            )}
          </div>
        )}
      </div>

      {!joined && (
        <div className="text-center mt-3">
          <button className="rounded-xl px-6 py-3 font-bold bg-gradient-to-b from-emerald-400 to-yellow-300 text-black" onClick={() => { setWantSeat(undefined); setShowJoin(true) }}>Join this table</button>
        </div>
      )}

      {!joined && showJoin && <JoinCard code={code} seat={wantSeat} full={pub.seats.every(Boolean)} onClose={() => setShowJoin(false)} />}
      {settings && <SettingsCard code={code} pub={pub} onClose={() => setSettings(false)} />}
    </div>
  )
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-30 bg-black/70 backdrop-blur-sm grid place-items-center p-4" onClick={onClose}>
      <div className="glass p-5 w-full max-w-md max-h-[85vh] overflow-y-auto" style={{ background: 'rgba(16,20,32,.96)' }} onClick={(e) => e.stopPropagation()}>{children}</div>
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
  return (
    <aside className="glass p-4 max-h-[60vh] overflow-y-auto">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-bold">🏆 Leaderboard</h2>
        <button className="text-white/60" onClick={onClose}>✕</button>
      </div>
      <div className={`grid ${paid ? 'grid-cols-[1fr_auto_auto_auto_auto]' : 'grid-cols-[1fr_auto_auto_auto]'} gap-x-3 gap-y-1.5 text-sm items-center`}>
        <div className="text-xs text-white/50">Player</div><div className="text-xs text-white/50 text-right">Buy-ins</div><div className="text-xs text-white/50 text-right">Chips</div><div className="text-xs text-white/50 text-right">Net chips</div>{paid && <div className="text-xs text-white/50 text-right">Net $</div>}
        {pub.leaderboard.map((r) => (
          <div key={r.uid} className="contents">
            <div className={`flex items-center gap-2 ${r.seated ? '' : 'opacity-50'}`}>
              <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: `hsl(${hue(r.uid)} 60% 50%)` }} />
              <span className="truncate">{r.name}{r.uid === uid ? ' (you)' : ''}{!r.seated ? ' · left' : ''}</span>
              {isOwner && r.seated && r.uid !== uid && <button className="text-[10px] text-red-300 underline" onClick={() => { if (confirm(`Remove ${r.name}?`)) void api('kick', { code, target: r.uid }) }}>remove</button>}
            </div>
            <div className="text-right num font-bold">{r.buyIns}{paid && <span className="text-white/40 font-normal"> · {money(r.paidCents)}</span>}</div>
            <div className="text-right num">{r.stack.toLocaleString()}</div>
            <div className={`text-right num font-bold ${r.net > 0 ? 'text-emerald-300' : r.net < 0 ? 'text-rose-300' : ''}`}>{r.net > 0 ? '+' : ''}{r.net.toLocaleString()}</div>
            {paid && <div className={`text-right num font-bold ${r.netCents > 0 ? 'text-emerald-300' : r.netCents < 0 ? 'text-rose-300' : ''}`}>{money(r.netCents, true) || '$0'}</div>}
          </div>
        ))}
      </div>
      {!pub.leaderboard.length && <div className="text-white/50 text-sm">No players yet.</div>}
      <p className="text-[11px] text-white/40 mt-3">Net = what you hold now (chips on the table plus chips cashed out) minus what you bought in. Money is valued at this table's price per chip.</p>
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

