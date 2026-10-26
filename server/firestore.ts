import { cert, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
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
    const presenceCol = db.collection(`tables/${code}/presence`)
    return db.runTransaction(async (tx) => {
      const [secret, presence] = await Promise.all([tx.get(secretRef), tx.get(presenceCol)])
      const table: Table | null = secret.exists ? (JSON.parse(secret.data()!.json as string) as Table) : null
      const pres: Record<string, number> = {}
      presence.forEach((d) => { pres[d.id] = Number(d.data().t) || 0 })
      const prevHandId = table?.hand?.handId ?? 0
      const { table: next, result } = fn({ table, presence: pres })
      if (next) {
        const now = Date.now()
        if (next.ledger.length) {
          // Permanent record: one doc per change, kept for a month, readable by the host through the API only.
          tx.set(db.doc(`tables/${code}/ledger/${String(next.version).padStart(9, '0')}`), { at: now, lines: next.ledger })
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
    const snap = await db.collection(`tables/${code}/ledger`).orderBy('at').get()
    const out: { at: number; lines: string[] }[] = []
    const stale: FirebaseFirestore.DocumentReference[] = []
    snap.forEach((d) => {
      const at = Number(d.data().at)
      if (at < since) stale.push(d.ref)
      else out.push({ at, lines: d.data().lines as string[] })
    })
    await Promise.all(stale.map((r) => r.delete())) // past the retention window
    return out
  },
  async hostTables(uid, since) {
    const snap = await getFirestore(app()).collection(`hosts/${uid}/tables`).get()
    return snap.docs.map((d) => ({ code: d.id, at: Number(d.data().at) })).filter((x) => x.at >= since).sort((a, b) => b.at - a.at)
  },
  async ping(code, uid, now) {
    const db = getFirestore(app())
    // Only seated players of an existing table may write presence (no orphan docs).
    const pub = await db.doc(`tables/${code}`).get()
    const seats = (pub.data()?.seats ?? []) as ({ uid: string } | null)[]
    if (!pub.exists || !seats.some((x) => x?.uid === uid)) return
    await db.doc(`tables/${code}/presence/${uid}`).set({ t: now })
  },
}
