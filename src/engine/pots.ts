export interface Contribution {
  id: number
  /** Total chips put in this hand. */
  total: number
  folded: boolean
}

export interface Pot {
  amount: number
  eligible: number[]
}

export interface PotResult {
  /** Chips returned to the one player whose bet nobody matched. */
  refund: { id: number; amount: number } | null
  pots: Pot[]
}

/** Refund uncalled chips, then split everything into a main pot and side pots. */
export function buildPots(input: readonly Contribution[]): PotResult {
  const players = input.map((p) => ({ ...p }))
  let refund: PotResult['refund'] = null

  const sorted = players.slice().sort((a, b) => b.total - a.total)
  if (sorted.length >= 2 && sorted[0].total > sorted[1].total) {
    const amount = sorted[0].total - sorted[1].total
    sorted[0].total -= amount
    refund = { id: sorted[0].id, amount }
  }

  const levels = [...new Set(players.filter((p) => !p.folded && p.total > 0).map((p) => p.total))].sort((a, b) => a - b)
  const pots: Pot[] = []
  let prev = 0
  for (const level of levels) {
    let amount = 0
    for (const p of players) amount += Math.min(p.total, level) - Math.min(p.total, prev)
    const eligible = players.filter((p) => !p.folded && p.total >= level).map((p) => p.id)
    const last = pots[pots.length - 1]
    if (last && last.eligible.length === eligible.length && last.eligible.every((id, i) => id === eligible[i])) {
      last.amount += amount
    } else {
      pots.push({ amount, eligible })
    }
    prev = level
  }

  // Chips above the highest live level (only possible from folded players) join the last pot.
  let leftover = 0
  for (const p of players) leftover += Math.max(0, p.total - prev)
  if (leftover > 0 && pots.length) pots[pots.length - 1].amount += leftover

  return { refund, pots: pots.filter((p) => p.amount > 0) }
}

/**
 * Split `amount` between `winners` (already ordered starting left of the button).
 * Odd chips go one at a time in that order.
 */
export function splitPot(amount: number, winners: readonly number[]): Map<number, number> {
  const out = new Map<number, number>()
  const base = Math.floor(amount / winners.length)
  let rem = amount - base * winners.length
  for (const id of winners) {
    out.set(id, base + (rem > 0 ? 1 : 0))
    if (rem > 0) rem--
  }
  return out
}
