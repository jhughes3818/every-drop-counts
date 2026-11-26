# Every Drop Counts

A 50–60 minute browser game for Year 7 Geography (Water in the world). Five teams run regions along one river. Taking more water makes a team richer, but every team shares one river-health meter, so a collapsed river costs everyone.

- **Board** (projector): the live river, health meter, Catchment Fund, scoreboard, cards and teacher controls.
- **Team devices** (phone, tablet or laptop): join with a 4-letter code and plan each season.

Node 18+, **no dependencies**, JSON file persistence, Server-Sent Events. The river is fictional and the numbers are not real data.

## Run it locally

```bash
npm start
```

Open <http://localhost:3000>, create a game (this opens the board), then join from other devices with the code.

## Deploy on Render

1. Push this folder to a GitHub repository.
2. In Render, choose **New → Blueprint** and pick the repo. `render.yaml` sets everything up. Or choose **New → Web Service** with:
   - Runtime: Node
   - Build command: `true` (nothing to install)
   - Start command: `node server.js`
   - Health check path: `/healthz`
3. Open the `onrender.com` URL.

**Free-tier caveats.** The service sleeps when idle, so open the board a minute before class to wake it. Saved games live in `data/games.json` and are lost on a redeploy or restart. To keep games across deploys, attach a Render persistent disk (paid) and set the `DATA_DIR` environment variable to its mount path, for example `/var/data`.

## How a game plays

Each season has four phases: **Forecast** (45 s, climate card), **Plan** (server timer: set intake, buy projects, give to the fund, make pledges, lock in), **Release** (hazard card, then the water runs down the river), and **Review** (points, river health, a class question). The teacher presses **Next** on the board to move on. Forecast, Plan and Release also advance on their own when their timers run out. Teams that haven't locked in when Plan ends get their previous season's intake.

Teacher controls on the board: start and advance, pause or resume the timer, +30 s, reset the timer, hold back the season's hazard and trigger it later, undo the season (until the next season starts), release a region to another device, mute a team's pledges, and end the game early. The final screen has the scoreboard, health bonus, a health chart and the debrief questions, plus **Print or save results**.

The board's browser remembers the teacher key, so refreshing it (or going back to the home page and clicking **Resume**) keeps the controls. Each team device gets a rejoin link that restores the same region.

## Year levels

| | Years 4–6 | Years 7–8 | Years 9–12 |
|---|---|---|---|
| Seasons / plan timer | 6 / 210 s | 8 / 150 s | 9 / 120 s |
| Pledges | off | on | on |
| Hazards per game | 1 | 2–3 | 3–4 |
| Fund | +2 steps | any amount | any amount |
| Illegal pumping and audits | off | off | on |
| Wording | simple | standard | adds terms |

You can override seasons (6–10), timer (60–300 s), team count (4, 5 or 6) and the practice season when you create a game. With 4 teams the computer runs the Highlands and releases everything. With 6 teams, Mountain Springs is added before Cotton Flats.

## Code layout

| Path | Contents |
|---|---|
| `game/rules.js` | **Every number**: regions, climates, hazards, projects, year levels, health. Tune here. |
| `game/logic.js` | Pure rules: `resolveSeason(state, decisions, hazard)` returns the new state plus an event log. The board animates from that log, so the animation can't disagree with the scoring. Seeded randomness (mulberry32), so any game replays exactly from its seed. |
| `server.js` | Routes, the phase state machine, timers, SSE, persistence and per-role views (teams never see other teams' plans, and the board sees no plans until Release). |
| `public/` | `index.html` (create/join), `board.html`, `team.html` with plain JS and CSS. The river is SVG. |
| `test/` | `logic.test.js`, `server.test.js` (`npm test`), `sim.js` (`npm run sim`), `browser.js` (Playwright). |

## Tests

```bash
npm test
```

Covers: the two worked examples from the spec; water conservation and legal values over 3,000+ random seasons; upstream ordering; pledges kept and broken; plan validation; flood and levee; the practice season; exact replay from the seed; final scoring; and a scripted class playing a full game over HTTP, including hidden information, plans rejected after the timer, a server restart mid-game, rejoin, region release, undo and timer expiry.

```bash
node test/browser.js
```

This needs Playwright. It runs the board plus five 390 px phones through a full game, checks that the board animation ends in the state the log describes, and saves screenshots at 1280×720 and 390×844.

## Balance (bots, 2,000 games, 5 teams). Needs a decision

Tuned in `rules.js` from the spec's starting values: Cotton Flats' yield is now 4,4,3,3,2,2,2,2,1,1 (was 5×4, 3×4, 1×2), health recovery is +4 (was +5), a bad season is −16 (was −15), and the Highlands turbines take at most 18 units (water above that spills). I added the turbine limit because without it the Highlands would score 26+ a season.

| Target | Result |
|---|---|
| All Greedy → crisis by season 6 in ≥ 80% | **Pass** (82%) |
| All Fair share → final health ≥ 60 in ≥ 80% | **Pass** (100%) |
| One team defects to Greedy → gains, but ≤ ~30% | **Pass** (Orchard +8%, Cotton +1%, Town +5%) |
| Mixed → no region wins > 35% | **Miss**: Cotton Flats wins 62% |
| Mixed → median scores within 25% | **Miss**: Delta median 57 vs Cotton 146 |
| Drought relief cheaper than the damage it prevents | **Borderline** with 5 teams (8 vs 8). Consider 6 or 7. |

The two misses come from the design, not the numbers. The Delta has no water decisions and scores only on what reaches the sea, so when other teams are greedy it collapses. Raising the Delta's points made it win 89% of fair games instead. This is the spec's open question *"Is it acceptable for the Delta team to have no water decisions, or should it get a stronger role?"* Options: give the Delta a small fixed income (fishing or tourism), let it sell environmental-water pledges, or score it relative to the other teams. Bots also don't use pledges the way students will, so the classroom pilot has the final say.

## Not in this version

Water quality and salinity, groundwater, the allocation-cap water market (Years 9–12 "optional"), a separate environmental water holder, accounts and a database. Castaway was not in this workspace, so this is a standalone server rather than a `platform/` extraction. The code keeps the same shape (codes, tokens, SSE hub, timers, JSON persistence), so it can be folded into a shared platform later.

**First Nations content.** The game doesn't score or depict First Nations communities. The final debrief list includes a prompt on the cultural, spiritual and aesthetic value of water (AC9HG7K03), with a note that the teacher should use material developed or reviewed with First Nations educators or a local Elder.
