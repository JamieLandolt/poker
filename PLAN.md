# Poker – plan

## Goal
Texas Hold'em site: you vs 3–5 computer players, no-limit, play-money chips. Deployed like Streakly:
GitHub repo (JamieLandolt/poker) -> Vercel project via `npx vercel link/deploy --prod` -> subdomain `poker.jland.me`
(Namecheap DNS, same as streakly.jland.me). No server, no database: everything runs in the browser.
(Real multiplayer needs a websocket server, which Vercel does not host. Out of scope; engine is pure so it can be added later.)

## Stack
Vite + React 19 + TypeScript + Tailwind 4 + Vitest + oxlint (same as Streakly). npm scripts: dev, build, test, lint.

## Architecture
`src/engine/` pure TypeScript, no React, fully unit tested:
- `cards.ts`  card type, deck, Fisher-Yates shuffle using `crypto.getRandomValues` (injectable RNG for tests).
- `evaluate.ts` best 5 of 7 -> comparable score (category + ranks array). Compare function.
- `pots.ts`   build main + side pots from per-player total contributions; award with split and odd chip.
- `game.ts`   state + `reduce(state, action)`: startHand, act(fold/check/call/raise/allin), advance street, showdown.
- `bots.ts`   `decide(state, seat)` -> action. Uses hand strength (preflop chart-ish score, postflop made-hand rank + pot odds) + randomness + a per-bot personality (tight/loose, passive/aggressive).
`src/ui/` React: Table, Seat, Card, ActionBar (fold/check/call/raise slider + presets), Log, Settings (blinds, bot count), HandResult overlay.
`src/hooks/useGame.ts` holds reducer; one effect drives bots with a timeout that is cleaned up.
Persistence: chip stack + settings in localStorage (try/catch). "Rebuy" button when busted.

## Rules to get right (known bug areas)
1. Hand ranking: wheel A-2-3-4-5 is the lowest straight; straight flush vs royal; kickers; full house with two trips; flush with 6-7 suited cards uses top 5; ties compare full tiebreak arrays.
2. Blinds/button: button moves to next *live* player; heads-up the button is the small blind and acts first preflop, big blind acts first postflop. Busted players skipped everywhere.
3. Betting round ends only when every non-folded, non-all-in player has acted AND matched the current bet. Big blind gets the option to raise preflop when everyone just calls.
4. Raises: min raise = size of last full raise (at least big blind). Short all-in (less than a full raise) does NOT reopen action for players who already acted. Call amount is capped at stack (call all-in).
5. If all remaining players are all-in (or only one can still bet), deal the remaining board without more betting, then showdown.
6. Uncalled bet is returned (a bet bigger than any opponent can match is refunded before pots are built).
7. Side pots: folded players' chips stay in pots but they are not eligible. Each pot is awarded to the best hand among eligible players; ties split, odd chips go to the first winner left of the button. Pots with one eligible player go back to them.
8. Win without showdown when everyone else folds: do not reveal cards, take whole pot.
9. All chips are integers; invariant: total chips across stacks + pots is constant (asserted in tests).
10. Game over: human has 0 chips -> rebuy prompt; all bots busted -> "you won" and restart.
11. UI: bot timers cleaned up on unmount/re-render (React strict mode double-invokes effects); buttons disabled when it is not the human's turn; raise input clamped to [min raise, stack]; no double-click double-action (actions go through the reducer, which rejects illegal ones by returning state unchanged).

## Tests (Vitest)
- evaluate: every category, wheel, kicker ties, 7-card cases, split.
- pots: 3-way all-in with different stacks, folded contributor, uncalled bet refund, odd chip.
- game: heads-up blind order, BB option, short all-in not reopening, fold-win, run-out, chip conservation property test (random legal bot play for 2000 hands, asserts invariant and that every hand terminates).
- bots: always return a legal action.

## Steps
1. Scaffold (copy Streakly toolchain), git init.
2. Engine + tests, get green.
3. Bots.
4. UI.
5. Playwright-free manual check in browser pane + build + lint.
6. README, .gitignore, GitHub repo, Vercel deploy, domain.

## Review changes (from an independent reviewer with no implementation context)
Accepted and folded into the design:
- Reducer is pure and total. The shuffled deck is passed in the `startHand` action (no RNG inside the reducer, so React StrictMode double-invoking it is harmless). Every `act` carries `handId`, `seq` and `seat`; mismatches are ignored, so double clicks and stale bot timers cannot act twice.
- `legalActions(state, seat)` is the single source of truth for engine, bots and UI. Raise payload is `raiseTo`. `allin` is normalised inside the reducer to call / full raise / short all-in.
- Reopening rule: per player we store `actedAtBet`. A player who already acted may re-raise only if `currentBet - actedAtBet >= minRaise` (so several short all-ins that add up to a full raise do reopen). A short all-in raises `currentBet` but not `minRaise`.
- Short blinds: post what you have and go all-in; `currentBet` stays the full big blind.
- Button: moves to the next seat with chips (simple rule, no dead button; documented). Heads-up: button is SB and acts first preflop.
- Pots: refund uncalled excess first, then build levels from non-folded contributions, folded chips fall into the pots, merge adjacent pots with the same eligible set, odd chips handed out one at a time from the seat left of the button, per pot.
- Busted bots rebuy automatically at the next hand so the table stays full; the human gets a Rebuy button. Chip conservation is asserted within each hand.
- Persistence is limited to settings and lifetime stats (versioned key, validated on load, try/catch).
- Extra tests: brute-force 21-combination oracle for the evaluator, naive oracle for pots, property test with a seeded RNG that mixes legal-random, real-bot and shove-heavy play and checks invariants each hand.
- Bot timer effect keyed on `(handId, seq)` with cleanup.
Not doing: Testing Library component tests (UI is thin; engine is where the risk is), burn cards.
