import { describe, expect, it } from 'vitest'
import { handle, type Loaded, type Store } from './handler.ts'
import type { Table } from '../src/engine/table.ts'

function memoryStore(): Store & { tables: Map<string, string>; pres: Map<string, Record<string, number>> } {
  const tables = new Map<string, string>()
  const pres = new Map<string, Record<string, number>>()
  return {
    tables, pres,
    async run(code, fn) {
      const raw = tables.get(code)
      const l: Loaded = { table: raw ? (JSON.parse(raw) as Table) : null, presence: pres.get(code) ?? {} }
      const { table, result } = fn(l)
      if (table) tables.set(code, JSON.stringify(table))
      return result
    },
    async ping(code, uid, now) { pres.set(code, { ...(pres.get(code) ?? {}), [uid]: now }) },
  }
}

describe('handler', () => {
  it('creates, joins, plays and rejects bad requests', async () => {
    const store = memoryStore()
    let now = 1_000_000
    const deps = { store, now: () => now }
    const created = await handle('a', { type: 'create' }, { ...deps, newCode: () => 'ABCDE' })
    expect(created).toEqual({ ok: true, code: 'ABCDE' })
    expect((await handle('a', { type: 'create' }, { ...deps, newCode: () => 'ABCDE' })).ok).toBe(false) // code already taken
    expect((await handle('a', { type: 'sit', code: 'ABCDE', name: 'Ann' }, deps)).ok).toBe(true)
    expect((await handle('b', { type: 'sit', code: 'ABCDE', name: 'Bob' }, deps)).ok).toBe(true)
    expect((await handle('b', { type: 'sit', code: 'ABCDE', name: 'Bob' }, deps)).ok).toBe(false) // already seated
    expect((await handle('a', { type: 'sit', code: 'nope', name: 'x' }, deps)).error).toBe('Bad table code')
    expect((await handle('a', { type: 'tick', code: 'ZZZZZ' }, deps)).error).toBe('Table not found')
    now += 3000
    await handle('a', { type: 'tick', code: 'ABCDE' }, deps)
    now += 3000
    await handle('a', { type: 'tick', code: 'ABCDE' }, deps)
    const t = JSON.parse(store.tables.get('ABCDE')!) as Table
    expect(t.phase).toBe('betting')
    // a spectator cannot act
    expect((await handle('zed', { type: 'act', code: 'ABCDE', handId: 1, seq: 0, kind: 'fold' }, deps)).ok).toBe(false)
    // the actor can fold
    const actor = t.hand!.players[t.hand!.toAct].uid
    const r = await handle(actor, { type: 'act', code: 'ABCDE', handId: 1, seq: 0, kind: 'fold' }, deps)
    expect(r.ok).toBe(true)
    // a stale repeat changes nothing and says so
    const stale = await handle(actor, { type: 'act', code: 'ABCDE', handId: 1, seq: 0, kind: 'fold' }, deps)
    expect(stale).toEqual({ ok: false, error: 'That move is no longer valid' })
    // cleared inputs (null) are rejected, not silently replaced by defaults
    expect((await handle('a', { type: 'settings', code: 'ABCDE', settings: { smallBlind: null, bigBlind: null, startStack: null } }, deps)).ok).toBe(false)
    expect((await handle('a', { type: 'sit', code: 'ABCDE', name: 'Zed', seat: null }, deps)).error).not.toBe('Table is full')
    expect((await handle(actor, { type: 'act', code: 'ABCDE', handId: 1, seq: 1, kind: 'bogus' }, deps)).ok).toBe(false)
  })
})
