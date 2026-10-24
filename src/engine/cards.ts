export type Suit = 'c' | 'd' | 'h' | 's'
/** 2..14, where 14 is the ace. */
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14
export interface Card {
  rank: Rank
  suit: Suit
}

export type Rng = () => number

export const SUITS: Suit[] = ['c', 'd', 'h', 's']
export const RANKS: Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]

export function newDeck(): Card[] {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })))
}

/** Uniform float in [0, 1) from the browser's CSPRNG (falls back to Math.random). */
export const secureRng: Rng = () => {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const a = new Uint32Array(1)
    crypto.getRandomValues(a)
    return a[0] / 2 ** 32
  }
  return Math.random()
}

/** Fisher-Yates. Returns a new array. */
export function shuffle<T>(items: readonly T[], rng: Rng = secureRng): T[] {
  const a = items.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const RANK_CHAR: Record<number, string> = { 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }
export const rankLabel = (r: Rank) => RANK_CHAR[r] ?? String(r)
export const SUIT_GLYPH: Record<Suit, string> = { c: '♣', d: '♦', h: '♥', s: '♠' }

/** "As", "Td" ... for tests. */
export function parseCards(s: string): Card[] {
  return s
    .trim()
    .split(/\s+/)
    .map((t) => {
      const r = t[0].toUpperCase()
      const rank = (Object.entries(RANK_CHAR).find(([, c]) => c === r)?.[0] ?? r) as unknown
      return { rank: Number(rank) as Rank, suit: t[1].toLowerCase() as Suit }
    })
}
