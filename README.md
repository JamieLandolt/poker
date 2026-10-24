# Poker

No-limit Texas Hold'em against 1–5 computer players. Play money, no sign-up, runs entirely in the browser.

**Live at [poker.jland.me](https://poker.jland.me)**

## Playing

- **Deal** starts a hand. Use **Fold / Check / Call / Raise / All-in**; the slider and pot buttons set the raise.
- Busted? **Rebuy**. Busted bots rejoin automatically.
- **New game** changes the number of opponents, blinds and starting chips (saved in your browser).

## Development

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server |
| `npm test` | Engine tests (hand evaluation, side pots, betting rules, random-play invariants) |
| `npm run build` | Typecheck and production build |
| `npm run lint` | oxlint |

`src/engine` is pure TypeScript with no React: `evaluate.ts` (hand ranking), `pots.ts` (side pots), `game.ts` (betting state machine reducer), `bots.ts` (computer players). The reducer takes the shuffled deck as input, so it is deterministic and testable. Actions carry the hand id and sequence number, so stale clicks or timers are ignored.

Rules notes: the button moves to the next player with chips (no dead button); heads-up the button is the small blind; a short all-in does not reopen raising for players who already acted; uncalled bets are refunded; odd chips go to the first winner left of the button.
