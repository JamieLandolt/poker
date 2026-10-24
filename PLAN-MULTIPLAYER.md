# Poker v2: multiplayer, modern look, leaderboard

## Goals
- Real players sit around one table (up to 9 seats). No bots. Share a table code or link to join.
- Players can join or leave at any time, including mid-hand, without breaking the hand.
- Rebuy when you lose all chips. A leaderboard shows buy-ins, chips and net result per player.
- Modern dark look, oval table, you always sit at the bottom, a satisfying deal animation.
- Same deploy path as v1: Vercel + `poker.jland.me`. Auto-deploy from GitHub once the Vercel GitHub link works.

## Architecture (server-authoritative, no websocket server)
Vercel hosts static files and serverless functions only, so no websockets. We use the stack already used for Streakly:
- **Firebase Auth (anonymous)**: every browser gets a stable `uid` with no sign-up. Name is typed once and stored locally and on the table.
- **Firestore** is the realtime channel. Clients only READ it with `onSnapshot`. Security rules deny every client write.
- **One Vercel function `api/table.ts`** (firebase-admin) is the only writer. Client sends `{code, type, ...}` with its ID token. The function runs a Firestore **transaction**: load table -> verify uid -> run the pure engine -> write new state. Transactions give us one-action-at-a-time per table, so two clicks or two players cannot race.
- Documents:
  - `tables/{code}`: public state (seats, stacks, board, bets, pot, toAct, deadline, log, leaderboard records, `revealed` hole cards at showdown only).
  - `tables/{code}/hands/{uid}`: that player's hole cards. Rules: readable only when `request.auth.uid == uid`.
  - `tables/{code}/secret/deck`: remaining deck. Rules: no client access at all.
- **No timers on the server.** Serverless cannot tick. Instead every open client calls `tick` (with random jitter) when a deadline passes (turn timer, next-hand delay, stale-seat cleanup). `tick` is idempotent: the transaction re-checks the clock and does nothing if someone else already advanced the table.
- Local dev: Vite dev middleware serves `/api/table` using the same handler against the real Firestore (service account in `.env.local`). Unit tests use an in-memory store behind the same `Store` interface.

## One-time setup the owner must do (about 5 minutes)
1. Create a new Firebase project (separate from Streakly so Streakly's rules and data are never touched). Free Spark plan is enough.
2. Authentication -> Sign-in method -> enable **Anonymous**. Authentication -> Settings -> Authorized domains -> add `poker.jland.me`.
3. Firestore Database -> create (production mode, a region near Australia, e.g. australia-southeast1). Paste in the rules from `firestore.rules`.
4. Project settings -> General -> add a Web app -> copy the config values (public, safe to put in `.env`).
5. Project settings -> Service accounts -> Generate new private key. This secret file never goes in git; it is added as the Vercel env var `FIREBASE_SERVICE_ACCOUNT` (base64) and to `.env.local`.

## Game model
Reuse the tested betting engine unchanged where possible (pure reducer, `legalActions`, side pots, evaluator).
- **Table layer** (`src/engine/table.ts`) wraps it. Seats are fixed positions 0..8, each `null` or `{uid, name, stack, status, timeouts, lastSeen}`. Status: `active` (dealt into next hand), `sitOut` (skipped), `busted` (0 chips, waiting for rebuy).
- At hand start the table layer builds the list of **participants** (active seats with chips) and runs the existing engine on that compact list, mapping engine index <-> seat <-> uid. Anyone not a participant (just joined, sitting out, busted) is simply not in the hand.
- Engine change: `startHand` takes the button as an explicit input (table layer picks it), no automatic bot rebuys, plus a new `foldOut(state, idx)` to fold a player out of turn (leaving, or timed out while not acting).
- Button: moves to the next seat clockwise that has an eligible player (seat index based, no dead button; documented).
- Hand flow: `waiting` (fewer than 2 eligible) -> `betting` -> `handOver` (showdown shown for ~6 s) -> auto start next hand when 2+ eligible. `nextHandAt` is stored; clients call `tick`.
- **Turn timer** 20 s (fixed default, setting). On expiry: auto-check if possible, else fold. Two timeouts in a row -> `sitOut` until the player presses "I'm back".

## Edge cases (and the decision for each)
1. **Join mid-hand**: seated immediately as `active` but not in the current hand; sees the table, is dealt in next hand. Seat choice is theirs; if full, they spectate.
2. **Leave mid-hand** (button, closed tab, or stale): if in the hand they are folded out via `foldOut` (their chips already in stay in the pot). If it was their turn, the fold advances the hand. Seat freed at hand end; stack is recorded as `cashedOut` in their leaderboard record.
3. **Disconnect / closed tab**: clients `ping` every 15 s. A seat with no ping for 45 s is treated as sitting out; at 2 minutes it is removed as a leave. Refresh within that window keeps the seat (same anonymous uid).
4. **Leaving when it is down to 2, or 1, players in a hand**: `foldOut` ends the hand immediately (last player standing wins, no showdown). Everyone all-in and someone leaves: they were already committed, their cards still play (leaving after all-in does not forfeit; seat is released at hand end). Rule: only a player who is *not* all-in is folded on leave.
5. **Heads-up transition** when one of three leaves between hands: button/blind rules recomputed each hand from the participant list (heads-up: button is small blind).
6. **Rebuy**: only when stack is 0 (between hands or when busted); +1 buy-in, stack = start stack. Busted players are `busted` and skipped until they rebuy; if they do nothing for 2 minutes the seat is freed. A rebuy request mid-hand for a player who is still in the hand with 0 chips (all-in) is applied at hand end, never mid-hand.
7. **Rejoin after leaving**: same uid gets the same leaderboard record; sitting again counts as a new buy-in (they cashed out when they left).
8. **Same person two tabs**: one uid, one seat. Both tabs see the same state; actions are idempotent via `handId` + `seq`.
9. **Stale clicks**: every `act` carries `handId`, `seq`, `seat`; the function rejects mismatches without error noise. Buttons are disabled while a request is in flight.
10. **Two players act at the same instant / `tick` and `act` collide**: both go through the transaction; second sees the new `seq` and no-ops.
11. **Clock skew**: all deadlines use server time; the client countdown is display only, derived from `deadline - serverNow` offset estimated from the last response. `tick` is only honoured if server `now > deadline`.
12. **Hole-card privacy**: public doc never contains hole cards or the deck before showdown; at showdown only live (non-folded) players' cards are revealed; fold-wins reveal nothing. Tests assert this on the public document and check the rules file denies reads of other uids.
13. **Owner leaves**: ownership passes to the next seated player (owner only changes blinds/stack for the next hand). Changing settings mid-hand applies next hand.
14. **Table code collisions / bad codes**: 5-char codes without ambiguous letters; create retries on collision; unknown code shows a friendly "table not found".
15. **Abuse limits**: names trimmed to 16 chars, stripped of control characters; max 9 seats; max 200 requests/min/uid soft limit by a per-uid timestamp counter in the table doc is not worth it for friends; documented as out of scope.
16. **Leaderboard**: per uid `{name, buyIns, cashedOut, handsWon, biggestPot}`; net = current stack + cashedOut - buyIns x startStack. Kept for players who left. Duplicate names get a suffix. Sorted by net, shows buy-ins prominently.
17. **Chip conservation invariant**: sum(stacks) + pot-in-play + sum(cashedOut) == sum(buyIns x startStack). Asserted in tests after every operation.
18. **Document size/growth**: log capped at 40 lines; players map capped at 30 records (oldest left players dropped from the board with a note).
19. **Empty tables**: everyone leaves -> table goes `waiting`; doc remains (cheap). Tables are not auto-deleted.
20. **Auth failure / offline**: UI shows a reconnecting banner; the client keeps retrying `onSnapshot` and re-pings.

## UI / look
- Dark navy background with soft glow, glass panels, emerald felt oval with a subtle rail glow, gold accent. System font stack, tabular numbers, big readable cards.
- Seats positioned on an ellipse with trig, rotated so **you are always bottom centre**. Mobile: ellipse becomes a tall oval, seats shrink.
- Seat: avatar circle (colour from uid hash, initial), name, stack, action label, dealer button, a **timer ring** around the avatar for the active player, folded seats dimmed, empty seats show "Sit" (+ and click).
- Table centre: pot, board, deck stack. Bets slide toward the middle as small chip stacks; at the end of a hand the pot chips fly to the winner(s) and a gold glow plays.
- **Deal animation**: a deck sits at the dealer button. At hand start, cards leave the deck one at a time, clockwise from left of the button, two rounds, ~110 ms apart, each flying along a curved path (translate + rotate + slight scale) to its seat. Your two cards land face-down then flip (3D rotateY) face-up after dealing finishes. Flop: three cards slide out from the deck and flip in sequence (staggered), turn and river flip individually with a small pause. Showdown: opponents' cards flip face-up. Everything respects `prefers-reduced-motion` (fade only).
- Animation correctness: animate only when `handId` changes while the page is open; if a player loads/joins mid-hand the cards just appear (no replay). Animations are CSS-only and driven by index (`--i` delay), so a re-render never restarts them (cards keyed by `handId + seat + index`).
- Panels: Leaderboard (buy-ins column, net, chips, hands won, left players dimmed), Log, Share link, Settings (owner only). Sound: none in v1 of this rework.
- Landing screen: name field, "Create table" (blinds, stack), "Join with code". Table URL is `https://poker.jland.me/#ABCDE` (hash route, no Vercel rewrite needed).

## Tests
- Existing engine tests stay green.
- New engine tests: `foldOut` (out of turn, ends hand when 1 left, completes round, all-in player not folded), explicit button.
- Table layer (in-memory store, simulated clock): join/leave/rebuy/sit-out flows; property test applying random join, leave, act, tick, rebuy, disconnect over thousands of steps, asserting conservation (rule 17), unique seats, no stuck hand (a hand always completes with the clock advanced), button on an eligible seat, privacy of the public doc.
- Handler tests: auth required, wrong uid cannot act for another seat, stale `seq` ignored, tick idempotent.
- Manual E2E: two or three browser contexts (separate anonymous users via a `?guest=N` dev switch) playing hands, leaving mid-hand, rejoining, rebuying.

## Steps
1. Plan review by an independent agent, fold in fixes.
2. Engine changes + tests. Table layer + tests (in-memory).
3. Firestore store, `api/table.ts`, rules, dev middleware.
4. Client: auth, subscriptions, tick/ping loop, UI, animations.
5. Owner does Firebase setup; E2E test locally; set Vercel env vars; deploy; connect GitHub auto-deploy.

## Added requests
- **Nicknames chosen on join.** Opening a table link (`https://poker.jland.me/#ABCDE`) shows a "Join table" card first: nickname field (1-16 chars, prefilled from last time, required), then pick a seat. The name is stored in the browser and in the player record. Changing it later is allowed from the player menu (applies to the table immediately, leaderboard follows). Duplicate names get a ` (2)` suffix on the server so the leaderboard stays unambiguous.
- **Join via link.** Table creator gets a "Copy invite link" button; the link works for anyone, no account. If the code does not exist: "Table not found" with a button to create one. If you are already seated at that table (refresh, new tab), you skip the join card and go straight back to your seat.
- **Log hidden by default.** The hand log lives in a collapsible panel with a Show/Hide log toggle, collapsed on first load. The choice is remembered per browser (localStorage, try/catch). When hidden, the latest action still shows in each seat's label and the hand result banner, so nothing important is lost. Leaderboard stays as its own toggle.
- **Blind markers.** Besides the white dealer "D" button, the small blind and big blind seats get their own markers: a blue "SB" chip and a red/orange "BB" chip next to the seat, plus the posted blind amount as a small chip stack in front of the seat (same style as bets). Heads-up: the dealer is also the SB, so that seat shows both "D" and "SB". Markers come from the hand's `button`, `sb`, `bb` seat indexes stored in the public doc and update every hand (including when a blind seat's player leaves: the marker stays until the hand ends). A blind who could only post part of the blind shows the smaller amount. Animation: the blind chips slide in from the seat to the bet spot right after the deal.

## Review changes (independent reviewer, folded in)
**Privacy / security**
- The full engine state (hole cards + deck) lives only in `tables/{code}/secret/hand` (server-only). The public doc is built by an explicit allow-list copy function `publicView(full)`, never by stripping fields. Per-player hole cards are written to `hands/{uid}` with the `handId` inside. Privacy test deep-scans the public doc for any dealt card before showdown.
- Rules: `hands/{uid}` allows `get` only (no `list`) for that uid; everything else denies client reads and all writes. Rules tests for cross-uid reads, a deck read and a collection query.
- Only players who contest a pot are revealed at showdown (`result.hands` filtered the same way); fold-wins reveal nothing.
- The handler generates the shuffle with `crypto.randomBytes`, outside the transaction callback (callbacks may retry), and never accepts a client deck. The acting seat is derived from the verified uid, never from the client. Validate code format, integer `raiseTo`, body size, name length.
- Owner can **kick** a player (AFK/abusive). Known limit: anonymous uids are free, so clearing browser storage creates a new identity and a fresh leaderboard row.

**Chips**
- Money is tracked as `invested` chips per player (sum of buy-in amounts), not `buyIns x startStack`, so settings changes never corrupt net. Settings (blinds, start stack) apply only at the start of the next hand. Net = stack + cashedOut - invested; buy-in count shown separately.
- Leaving: not all-in -> `foldOut` and the remaining stack is cashed out immediately in the same transaction. All-in -> stays in the hand, cashed out from the post-payout stack in the same transaction that finishes the hand, then seat freed.
- Rebuy only with stack 0 and not currently contesting a hand (an all-in player who loses gets the rebuy option after the payout; a winner is rejected). A leaver cannot re-sit until their old seat's hand is over.
- Conservation invariant: stacks + chips committed in the hand + cashedOut == invested (refund and odd chips included).

**Timers / serverless**
- To avoid every client hammering the transaction at the deadline: the acting player's client calls `tick` at the deadline, other clients at `deadline + 2 s x their seat-order rank`. `tick` returns early without writing when nothing is due. Server adds ~1 s grace so a click at 19.9 s is not auto-folded; act at exactly the deadline wins. Clients also `tick` on `visibilitychange` and first snapshot.
- Presence: `ping` every 30 s writes only `tables/{code}/presence/{uid}` (no table transaction). Stale detection runs inside `tick`/`act` transactions.
- Function region `syd1` to sit near an Australian Firestore region. UI treats the response as errors-only and updates from `onSnapshot`, with a pending state on buttons.
- Cost estimate for friends-scale play: each action = 1 transaction (about 3 reads, 2-4 writes) plus one snapshot fan-out per player; hand start writes up to N+2 docs. Comfortably inside Firebase's free tier for casual use.

**Engine fit**
- Engine ids stay compact indexes. The hand stores a `participants` list (seat, uid) for its whole duration; payouts/winners/hands are mapped to seat/uid only when published. `foldOut`: marks folded, bumps `seq`, keeps `toAct` unless the leaver was acting; calls `advance` only if one player is left or the round is complete. Tests for all four cases plus heads-up.
- Remove bot code paths, the human-only `rebuy`, the "You" log wording; logs use sanitized names only. No `dangerouslySetInnerHTML`.
- Join rule stated explicitly: free join, no forced post, new players enter the blind rotation normally. Dead-button rule: none (button goes to the next eligible seat after the previous button seat). Test: a blind that cannot cover the blind.
- Log capped at 15 lines in the public doc; leaderboard only rewritten when it changes. `hands/*` docs overwritten at each deal and removed at hand end.

**Animation / React**
- Animate a hand only if the page saw the previous phase live: keep a ref of last seen `handId`; skip when the first snapshot has a hand in progress, when `metadata.fromCache`, or when the user joined mid-hand. Hole cards flip only when the table doc `handId` equals the `handId` in your `hands/{uid}` doc (no flash of last hand's cards). All-in runouts arrive as one update; the client staggers flop/turn/river reveals visually (about 1 s apart). Pot-to-winner and blind-slide animations fire once on phase transitions (`betting -> handOver`) from a ref. Seat rotation uses seat index, spectators have no seat.
