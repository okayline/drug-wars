# Changelog

## v1.2.2 — 2026-10-26 05:49 HST

- Removed: the small lines I wrote that the original doesn't show: "YOU CAN'T AFFORD THAT MUCH!", "YOU CAN'T HOLD THAT MUCH!", "YOU DON'T HAVE THAT MUCH!" (buy, sell, bank), "YOU CAN'T DO THAT, MAN!" (loan). A number that's too big now just returns you to the menu. Also removed my second intro screen ("PAY OFF THE LOAN SHARK, THEN MAKE AS MUCH MONEY...") and the plain placeholder prompts from v1.2.1.
- Changed: every event, offer and chase message now uses the original's wording (read from the TI-BASIC source through a summary, not the raw file): the events 3 to 8, 14, 15, 16 and 17, the gun, weed and trenchcoat offers, the Hardass chase (including THEY'RE FIRING AT YOU!!, the pig, gun and dammage views), and the doctor offer.
- Added: the chase line THEY'RE FIRING AT YOU!!, which is in the original.
- Not changed: the DEALERS menu and its messages (new in v1.2.0), the About pages, and the key bindings.

## v1.2.1 — 2026-10-26 05:47 HST

- Removed: the 10 event and chase messages I wrote myself (not from the original): the heroin cheap/expensive messages, the coke bust, the subway mugging, the dead-dude find, the acid flood (these events now happen with no message), the paraquat weed wording and train-death story, the Hardass intro, "YOU'VE BEEN HIT!!", the "killed all of them / carcass" line.
- Changed: the offers and the chase now use bare plain prompts: "BUY A [gun] FOR $400?", "SMOKE SOME WEED?", "YOU DIED.", "BUY A TRENCHCOAT FOR $200?", "[n] PIGS ARE CHASING YOU.", "YOU'RE HIT.", "YOU GOT $[n].", "PAY $1000 FOR A DOCTOR?". The two event messages and the chase lines that came from the original are unchanged.

## v1.2.0 — 2026-10-26 05:38 HST

Player dealing.

- Added: DEALERS on the main menu (8th item; the menu now scrolls). SEE DEALS lists the deals other players have put up in the city you're in and lets you buy; POST A DEAL puts some of your stash up at your own price. A deal is up the moment you post it and stays up for a day.
- Added: cash from your deals that sold comes back to the same game, on your next JET (and counts toward the final score). It never goes to a different game.
- Added: a small server (`src/worker.js`) with 4 routes (`/api/market`, `/api/list`, `/api/buy`, `/api/claim`), tables `drugwars_*` in the moba-beat database (`migrations/001_dealers.sql`), and a hash-chained ledger of every finished deal (`src/ledger.js`). Players are a cookie, no names. `npm test` (5 tests, no dependencies).
- Limits: a deal is 1 to 100 units at 1 to 150000 each; 5 deals up at once per player; you can't buy your own deal.
- Changed: `wrangler.jsonc` now runs the Worker (assets are served by it; `/api/*` goes to the Worker first) and binds the moba-beat database.
- Removed: nothing. The solo game is unchanged, and without the server the DEALERS menu just says the dealers can't be reached.

## v1.1.1 — 2026-10-26 05:28 HST

- Added: `wrangler.jsonc` so Cloudflare serves the game (the `drug-wars` Worker was only showing "Hello world").
- Changed: `index.html` moved to `public/index.html`.
- Removed: nothing.

## v1.1 — 2026-10-26 05:24 HST

- Added: WINDOW key opens a 3-page About screen on the LCD in the game's pixel font (what the game is, the goal, tips). ENTER or WINDOW pages through; MODE or DEL closes it and returns to where you were.
- Changed: the blue label above WINDOW says "About" instead of "TblSet"; the version under the calculator says v1.1.
- Removed: nothing.

## v1.0 — 2026-10-26 05:20 HST

First release.

- Added: Drugwar clone, one HTML page (`index.html`), single player. Rules and numbers come from the TI-82/83 BASIC "J.M.'S DRUGWAR 2.00": 30 days, $2000 cash, $5000 loan shark debt, 100-space trenchcoat, 6 drugs, 6 places, 10%/day loan interest, 6%/day bank interest, Officer Hardass chases, random events, score 1–100.
- Added: TI-82-style calculator shell (labelled "DW-82", no brand name or logo) with a 96×64 pixel LCD and 5×7 pixel font.
- Added: key bindings — 2nd = ENTER, MODE = CLEAR, DEL = back/erase, ALPHA = +100, X,T,θ = −100, STAT = MAX, ▲▼ = menu cursor or ±1, ◀▶ = ±10. Blue labels above each key say what it does. Keyboard also works (0–9, Enter, Esc, Backspace, arrows).
- Changed from the original: buy/sell pick the drug from a menu instead of typing its price; game starts in the Bronx; some event messages are reworded (heroin/coke price events, chase intro) because the exact originals weren't readable.
- Removed: keypad rows from MATH/MATRX down (number keys, ENTER, CLEAR and the rest) — their jobs moved to the keys above. Removed the explainer text under the calculator; it now shows the version number.
