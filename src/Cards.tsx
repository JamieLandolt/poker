import type { CSSProperties } from 'react'
import { rankLabel, SUIT_GLYPH, type Card } from './engine/cards.ts'

export interface Fly {
  /** px offset from the deck to this card's resting spot */
  dx: number
  dy: number
  rot?: number
  /** animation delay in ms */
  delay: number
  /** extra delay before the flip starts, in ms; undefined = no flip animation */
  flipAt?: number
}

/**
 * A playing card. Face-up/down is shown by rotating the inner element; `fly` animates it in from the deck
 * and (optionally) flips it. Give it a `key` containing the hand id so it only animates for new hands.
 */
export function PlayingCard({ card, faceUp, fly, dim, width }: { card?: Card | null; faceUp: boolean; fly?: Fly | null; dim?: boolean; width?: number }) {
  const style: Record<string, string | number> = {}
  if (width) style['--cw'] = `${width}px`
  if (fly) {
    style['--dx'] = `${fly.dx}px`
    style['--dy'] = `${fly.dy}px`
    style['--rot'] = `${fly.rot ?? 0}deg`
    style['--d'] = `${fly.delay}ms`
    if (fly.flipAt !== undefined) style['--fd'] = `${fly.flipAt}ms`
  }
  const red = card && (card.suit === 'd' || card.suit === 'h')
  return (
    <div className={`pc${dim ? ' dim' : ''}`} style={style as CSSProperties}>
      <div className={fly ? 'pc-fly' : 'w-full h-full'}>
        <div className={`pc-inner${faceUp ? '' : ' down'}${fly && fly.flipAt !== undefined && faceUp ? ' flip' : ''}`}>
          <div className={`pc-front${red ? ' red' : ''}${card ? ` s-${card.suit}` : ''}`}>
            {card && <><span>{rankLabel(card.rank)}</span><span className="s">{SUIT_GLYPH[card.suit]}</span></>}
          </div>
          <div className="pc-back" />
        </div>
      </div>
    </div>
  )
}

export function Slot({ width }: { width: number }) {
  return <div className="pc" style={{ '--cw': `${width}px` } as CSSProperties}><div className="pc-empty" /></div>
}

/** Chip colour by bet size in big blinds, so it means the same thing at every stake. */
const TIERS: [number, string][] = [[50, '#26262e'], [20, '#7c3aed'], [5, '#16a34a'], [2, '#2563eb'], [1, '#dc2626']]
function chipColor(amount: number, bigBlind: number): string {
  const bbs = amount / Math.max(1, bigBlind)
  return (TIERS.find(([v]) => bbs >= v) ?? [0, '#e5e7eb'])[1]
}

export function Chips({ amount, bigBlind, fly }: { amount: number; bigBlind: number; fly?: { dx: number; dy: number; delay: number } }) {
  if (amount <= 0) return null
  const style = fly ? ({ '--dx': `${fly.dx}px`, '--dy': `${fly.dy}px`, '--d': `${fly.delay}ms` } as CSSProperties) : undefined
  return (
    <div className={`inline-flex items-center gap-1.5 ${fly ? 'chip-fly' : ''}`} style={style}>
      <span className="chip" style={{ ['--c' as string]: chipColor(amount, bigBlind) }} />
      <span className="num text-[11px] font-bold text-amber-200">{amount.toLocaleString()}</span>
    </div>
  )
}
