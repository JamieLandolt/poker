import { rankLabel, SUIT_GLYPH, type Card } from './engine/cards.ts'

export function CardView({ card, hidden, dim, deal }: { card?: Card; hidden?: boolean; dim?: boolean; deal?: boolean }) {
  if (!card) return <div className="card empty" />
  if (hidden) return <div className="card back" aria-label="Hidden card" />
  const red = card.suit === 'd' || card.suit === 'h'
  return (
    <div className={`card${red ? ' red' : ''}${dim ? ' dim' : ''}${deal ? ' deal' : ''}`} aria-label={`${rankLabel(card.rank)} of ${card.suit}`}>
      <span>{rankLabel(card.rank)}</span>
      <span className="suit">{SUIT_GLYPH[card.suit]}</span>
    </div>
  )
}

export function Chips({ n }: { n: number }) {
  return <span className="tabular-nums">{n.toLocaleString()}</span>
}
