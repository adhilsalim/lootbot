# Lootbot

A programming game: teams write code that drives a robocar through a 2D maze, collecting gifts and shooting rivals. The game runs on the host's laptop; teams connect over local Wi-Fi.

## Setup (host laptop)

Needs Node.js 20+ and, for the sample bots, Python 3.9+.

```bash
npm install
npm run build        # builds the admin page and stage screen
npm start            # starts the game server on port 8080 (PORT=… to change)
```

The terminal prints the admin page link (with its key), the stage screen link, the address agents connect to, and the join code. Set `LOOTBOT_ADMIN_KEY` and `LOOTBOT_JOIN_CODE` to choose them yourself.

- **Admin page** `http://localhost:8080/admin?key=…`: accept teams, run connection tests, pick a map, start/pause/abort, map builder, replays, stats CSV.
- **Stage screen** `http://localhost:8080/stage`: open on the projector and press **Enable sound** once.

Clips are trimmed and levelled with the ffmpeg binary bundled by `ffmpeg-static`; set `FFMPEG_PATH` to use another one.

## Running a match

1. Teams start their bots (see [kits/python/README.md](kits/python/README.md)). They appear under **Pending requests**; check the preview and **Accept**.
2. Each accepted agent runs the connection test automatically: green (ready), amber (works but slow, over 100 ms) or red (failed).
3. Pick a map and duration, **Go to ready check**, then **Start**. Intro → 3-2-1 → match → stats → winner screen.

Every match is saved under `matches/<date>-<map>/` and can be replayed from the **Replays** tab.

## If a team's laptop fails

Copy their bot to the host laptop and run:

```bash
npm run host-agent -- path/to/their_bot.py "Team Name"
```

It takes over the team's existing car (same token), connects to `ws://localhost`, and runs their code unchanged as a plain Python process.

## Development

```bash
npm run dev -w server      # server with reload (port 8080)
npm run dev -w web         # Vite dev server on :5173, proxies to the game server
npm run demo               # start a test run with built-in bots straight away
npm test                   # server and shared tests
npm run typecheck
npx tsx server/src/game/sim.ts maps/level-1-open-field.json 4 60   # terminal simulation, no graphics

cd kits/python && python -m venv .venv && .venv/bin/pip install -e ".[test]" && .venv/bin/pytest
```

Layout: `shared/` message types and rule defaults · `server/` game loop, rules, lobby, audio queue, logging · `web/` admin page and stage screen · `kits/python/` starter kit and sample bot · `maps/` saved maps · `matches/` match logs · `uploads/` team photos and clips.
