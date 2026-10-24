import { cert, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { holeCards, publicView, type Table } from '../src/engine/table.ts'
import type { Store } from './handler.ts'

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
  async ping(code, uid, now) {
    const db = getFirestore(app())
    // Only seated players of an existing table may write presence (no orphan docs).
    const pub = await db.doc(`tables/${code}`).get()
    const seats = (pub.data()?.seats ?? []) as ({ uid: string } | null)[]
    if (!pub.exists || !seats.some((x) => x?.uid === uid)) return
    await db.doc(`tables/${code}/presence/${uid}`).set({ t: now })
  },
}
