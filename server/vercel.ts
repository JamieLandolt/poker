import type { VercelRequest, VercelResponse } from '@vercel/node'
import { firestoreStore, verifyToken } from './firestore.ts'
import { handle, type Request } from './handler.ts'


export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' })
  const uid = await verifyToken(req.headers.authorization)
  if (!uid) return res.status(401).json({ ok: false, error: 'Not signed in' })
  let body: unknown
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  } catch {
    return res.status(400).json({ ok: false, error: 'Bad request' })
  }
  if (!body || typeof body !== 'object' || JSON.stringify(body).length > 2000) return res.status(400).json({ ok: false, error: 'Bad request' })
  const out = await handle(uid, body as Request, { store: firestoreStore, now: () => Date.now() })
  res.status(200).json(out)
}
