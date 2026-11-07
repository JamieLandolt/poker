import { cert, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldPath, FieldValue, getFirestore } from 'firebase-admin/firestore'
import { holeCards, publicView, type Table } from '../src/engine/table.ts'
import type { Store } from './handler.ts'

export const LEDGER_KEEP_MS = 30 * 24 * 60 * 60 * 1000

function app() {
  if (getApps().length) return getApps()[0]
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set')
  const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')
  return initializeApp({ credential: cert(JSON.parse(json)) })
}

export async function verifyToken(header: string | undefined): Promise<string | null> {
  const m = /^Bearer (.+)$/.exec(header ?? '')
  if (!m) return null
  try {
    return (await getAuth(app()).verifyIdToken(m[1])).uid
  } catch {
    return null
  }
}

export const firestoreStore: Store = {
  async run(code, fn) {
    const db = getFirestore(app())
    const tableRef = db.doc(`tables/${code}`)
    const secretRef = db.doc(`tables/${code}/secret/state`)
    // One presence doc per table (a map of uid -> last ping) so each request costs two reads, not one per player.
    const presenceRef = db.doc(`tables/${code}/meta/presence`)
    return db.runTransaction(async (tx) => {
      const [secret, presence] = await Promise.all([tx.get(secretRef), tx.get(presenceRef)])
      const table: Table | null = secret.exists ? (JSON.parse(secret.data()!.json as string) as Table) : null
      const pres: Record<string, number> = {}
      for (const [k, v] of Object.entries(presence.data() ?? {})) pres[k] = Number(v) || 0
      const prevHandId = table?.hand?.handId ?? 0
      const { table: next, result } = fn({ table, presence: pres })
      if (next) {
        const now = Date.now()
        if (next.ledger.length) {
          // Permanent record: one doc per hand holding every change in it, kept for a month, readable by the host through the API only.
          tx.set(db.doc(`tables/${code}/ledger/h${String(next.handCount).padStart(8, '0')}`), { at: now, e: { [`v${String(next.version).padStart(9, '0')}`]: { at: now, lines: next.ledger } } }, { merge: true })
          for (const host of new Set([next.creatorUid, next.ownerUid])) tx.set(db.doc(`hosts/${host}/tables/${code}`), { code, at: now })
          next.ledger = []
        }
        tx.set(secretRef, { json: JSON.stringify(next) })
        tx.set(tableRef, { ...JSON.parse(JSON.stringify(publicView(next, now))), updatedAt: FieldValue.serverTimestamp() })
        if (next.hand && next.hand.handId !== prevHandId) {
          for (const p of next.hand.players) {
            const h = holeCards(next, p.uid)
            if (h) tx.set(db.doc(`tables/${code}/hands/${p.uid}`), h)
          }
        }
      }
      return result
    })
  },
  async loadTable(code) {
    const snap = await getFirestore(app()).doc(`tables/${code}/secret/state`).get()
    return snap.exists ? (JSON.parse(snap.data()!.json as string) as Table) : null
  },
  async ledger(code, since) {
    const db = getFirestore(app())
    const snap = await db.collection(`tables/${code}/ledger`).orderBy(FieldPath.documentId()).get()
    const out: { at: number; lines: string[] }[] = []
    const stale: FirebaseFirestore.DocumentReference[] = []
    snap.forEach((d) => {
      const data = d.data()
      const at = Number(data.at)
      if (at < since) { stale.push(d.ref); return }
      // Older tables have one doc per change; newer ones group the changes of a hand in one doc.
      if (data.lines) out.push({ at, lines: data.lines as string[] })
      else for (const k of Object.keys(data.e ?? {}).sort()) out.push(data.e[k] as { at: number; lines: string[] })
    })
    await Promise.all(stale.map((r) => r.delete())) // past the retention window
    return out
  },
  async hostTables(uid, since) {
    const db = getFirestore(app())
    const [idx, owned, played] = await Promise.all([
      db.collection(`hosts/${uid}/tables`).get(),
      db.collection('tables').where('ownerUid', '==', uid).get(),
      db.collection('tables').where('playerUids', 'array-contains', uid).get(),
    ])
    const byCode = new Map<string, { at: number; host: boolean }>()
    const put = (code: string, at: number, host: boolean) => {
      const prev = byCode.get(code)
      byCode.set(code, { at: Math.max(prev?.at ?? 0, at), host: host || !!prev?.host })
    }
    idx.forEach((d) => put(d.id, Number(d.data().at), true))
    // Tables from before the index existed are found through their current owner.
    owned.forEach((d) => put(d.id, d.data().updatedAt?.toMillis?.() ?? 0, true))
    played.forEach((d) => put(d.id, d.data().updatedAt?.toMillis?.() ?? 0, false))
    return [...byCode].map(([code, v]) => ({ code, ...v })).filter((x) => x.at >= since).sort((a, b) => b.at - a.at)
  },
  async ping(code, uid, now) {
    // A blind write (no read): only uids that hold a seat are ever used from this map.
    if (!/^[A-Z0-9]{4,8}$/.test(code)) return
    await getFirestore(app()).doc(`tables/${code}/meta/presence`).set({ [uid]: now }, { merge: true })
  },
}
