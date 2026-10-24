import type { Card } from './cards.ts'

export const Category = {
  HighCard: 0,
  Pair: 1,
  TwoPair: 2,
  Trips: 3,
  Straight: 4,
  Flush: 5,
  FullHouse: 6,
  Quads: 7,
  StraightFlush: 8,
} as const
export type Category = (typeof Category)[keyof typeof Category]

export const CATEGORY_NAME: Record<Category, string> = [
  'High card',
  'Pair',
  'Two pair',
  'Three of a kind',
  'Straight',
  'Flush',
  'Full house',
  'Four of a kind',
  'Straight flush',
]

export interface HandScore {
  category: Category
  /** Tiebreak ranks, most significant first. */
  ranks: number[]
}

/** Highest top-card of a straight within the given distinct ranks (desc), or 0. The wheel counts as 5-high. */
function straightHigh(ranksDesc: number[]): number {
  const set = new Set(ranksDesc)
  if (set.has(14)) set.add(1)
  for (let hi = 14; hi >= 5; hi--) {
    let ok = true
    for (let k = 0; k < 5; k++) if (!set.has(hi - k)) { ok = false; break }
    if (ok) return hi
  }
  return 0
}

/** Best five-card hand from 5..7 cards. */
export function evaluate(cards: readonly Card[]): HandScore {
  const counts = new Map<number, number>()
  const bySuit = new Map<string, number[]>()
  for (const c of cards) {
    counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1)
    const l = bySuit.get(c.suit) ?? []
    l.push(c.rank)
    bySuit.set(c.suit, l)
  }

  // Flush / straight flush
  let flushRanks: number[] | null = null
  for (const l of bySuit.values()) if (l.length >= 5) flushRanks = l.slice().sort((a, b) => b - a)
  if (flushRanks) {
    const sf = straightHigh(flushRanks)
    if (sf) return { category: Category.StraightFlush, ranks: [sf] }
  }

  // Group by count then rank.
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])
  const [r0, n0] = groups[0]

  if (n0 === 4) {
    const kicker = Math.max(...groups.slice(1).map((g) => g[0]))
    return { category: Category.Quads, ranks: [r0, kicker] }
  }
  if (n0 === 3 && groups.length > 1 && groups[1][1] >= 2) {
    // With two trips the second set supplies the pair.
    return { category: Category.FullHouse, ranks: [r0, groups[1][0]] }
  }
  if (flushRanks) return { category: Category.Flush, ranks: flushRanks.slice(0, 5) }

  const distinct = [...counts.keys()].sort((a, b) => b - a)
  const st = straightHigh(distinct)
  if (st) return { category: Category.Straight, ranks: [st] }

  if (n0 === 3) {
    const kick = groups.slice(1).map((g) => g[0]).slice(0, 2)
    return { category: Category.Trips, ranks: [r0, ...kick] }
  }
  if (n0 === 2) {
    const pairs = groups.filter((g) => g[1] === 2).map((g) => g[0])
    if (pairs.length >= 2) {
      const [p1, p2] = pairs // already descending
      const kicker = Math.max(...distinct.filter((r) => r !== p1 && r !== p2))
      return { category: Category.TwoPair, ranks: [p1, p2, kicker] }
    }
    const kick = distinct.filter((r) => r !== r0).slice(0, 3)
    return { category: Category.Pair, ranks: [r0, ...kick] }
  }
  return { category: Category.HighCard, ranks: distinct.slice(0, 5) }
}

export function compareScores(a: HandScore, b: HandScore): number {
  if (a.category !== b.category) return a.category - b.category
  const n = Math.max(a.ranks.length, b.ranks.length)
  for (let i = 0; i < n; i++) {
    const d = (a.ranks[i] ?? 0) - (b.ranks[i] ?? 0)
    if (d) return d
  }
  return 0
}
