# Maze Robocar Game — Final Plan

Nov 2, 2026 · @Adhil Salim

## Overview

Teams write code that drives a robocar through a 2D maze; the car that collects the most gifts before the global timer ends wins. Nobody plays by hand. It is a programming game in the same family as Robocode, Battlecode and Screeps.

The whole game runs on the host's laptop. Everything else connects to it over the local Wi-Fi:

- **Game server** (host laptop): owns the maze, the rules, the timer and the scores. It is the only place where the game really exists, so nobody can cheat by claiming results.
- **Agent programs** (each team's laptop): connect over WebSocket, read their car's state and send actions. They never touch the game directly.
- **Admin page** (host): build and save maps, approve or decline agents, run the connection test, start, pause and stop the game.
- **Stage screen** (projector): shows the maze, cars, timer, scoreboard, intro and winner screens, and plays all audio.

The server moves the game forward in small fixed steps called **ticks** (5 to 10 per second). On each tick it sends every agent its state, applies the actions it received, resolves hits and pickups, then updates the stage screen.

## Game rules

The winner is the team holding the most gifts when the timer ends or when all gifts are collected.

**The map.** A 2D grid. Each cell is floor, wall, gift, ammo, energy drink or a spawn point. Walls block cars and bullets.

**Items.**

| Item | Effect | Notes |
| --- | --- | --- |
| Gift | +1 to the team's score | Every gift has a home cell set in the map builder |
| Ammo | Adds bullets, up to a maximum | Respawns at its cell after a delay set per map |
| Energy drink | Restores life, up to the maximum | Default 30 life per drink; respawns after a delay set per map |

A car must stand on an item's cell and call the matching collect function. Driving over it is not enough.

**Fire.** One shot per `fire()` call; no continuous fire. Each shot uses one bullet and starts a cooldown (default 1 second). The bullet travels straight ahead and stops at the first wall or car. A hit removes a set amount of life (default 25).

**Life and death.** Cars start with 100 life. At 0 life the car dies:

1. It disappears from the map and the death audio is queued.
2. If it holds at least 1 gift, it loses 1 gift. That gift goes back to its **original home cell**, not where the car died, so the dead car cannot simply grab it back after respawning. The gift returned is the one the car collected most recently.
3. After a short delay (default 3 seconds) it respawns at a free spawn point with full life and starting ammo.
4. For 2 seconds after respawn it cannot be damaged and cannot fire, so it cannot be killed again straight away.

**Collisions.** Cars cannot pass through walls or each other. A blocked move stops early and the agent gets a `blocked` event.

**Tie-break.** If gift counts are equal: fewer deaths wins, then more hits landed, then more life left at the end.

All the numbers above are defaults. Each map can change them (see Environment builder).

## Game lifecycle and global timer

A match always moves through six stages in this order, controlled from the admin page:

1. **Lobby.** The host picks a map and sets the duration. Agents send join requests; the host accepts or declines them.
2. **Ready check.** Accepted agents run the connection test. Start is enabled once every accepted agent is green (the host can override).
3. **Intro.** The stage screen shows each team in turn: name, icon, driver photo and the 4 passenger photos, a few seconds each. Cars appear at their spawn points.
4. **Running.** The global timer counts down and ticks run. The host can pause (timer and ticks freeze) or abort.
5. **Finished.** Triggered when the timer reaches zero or no gifts remain anywhere (on the map or able to return). All cars freeze; agents get `gameEnded`.
6. **Stats.** The stats table, then the winner screen with the winner's photos and the winner's win clip.

**The timer lives on the server, not in browsers.** The server sends the remaining time to the stage screen and to agents in every state update, so everyone sees the same clock even if a laptop's clock is wrong. A 3-2-1 countdown on the stage screen marks the switch from Intro to Running.

## Joining, approval and connection test

An agent can only control a car after the host approves it and it passes the connection test.

1. **Find the server.** The admin page shows the laptop's address (for example `ws://192.168.1.20:8080`) and a QR code. The host also announces a short **join code** at the event.
2. **Join request.** The team's program connects and sends: join code, team name, and profile files (icon, photos, voice clips). A wrong join code is rejected immediately.
3. **Host review.** The request appears in the admin page's Pending list with a preview of the photos and a play button for each clip. The host clicks **Accept** or **Decline**.
4. **Token.** On Accept, the server gives the agent a secret token. Every later message must carry it, and one token controls exactly one car. On Decline, the connection is closed with a reason.
5. **Connection test** (automatic, about 10 seconds):
   1. Ping 20 times and record the average and worst delay.
   2. Send a practice state and check the agent replies within the tick window.
   3. Dry-run `turn`, `move`, `fire` and a collect call in a hidden practice room, to prove the code works end to end.
6. **Result.** The admin page shows each agent as green (ready), amber (works but delay is high, over 100 ms) or red (failed). The host can rerun the test or kick the agent.

**Reconnecting.** If an agent drops during a match, its car stands still (idle). If it reconnects with the same token, it takes control again. Nobody else can take over that car.

**Kicking.** The host can remove any agent at any stage. A kicked car is removed from the map and its gifts go back to their home cells.

## Agent API

Each car does one action at a time; an action takes one or more ticks, and the agent learns the result when it finishes.

**Units.** The world is measured in cells. Positions are `(x, y)` with `(0, 0)` at the top-left. Heading is in degrees: 0 = facing up (north), 90 = right, 180 = down, 270 = left. Cars can face any angle.

**How time works.** Every tick the server sends the agent its state. If the car is idle, the agent may send one new action. If the agent sends nothing, or its reply arrives late, the car stays idle for that tick. The game never waits for a slow agent.

### Actions

| Function | What it does | Time taken (default) | Result returned |
| --- | --- | --- | --- |
| `turn(degrees)` | Positive turns right, negative turns left | 45° per tick | Final heading |
| `move(steps)` | Positive goes forward, negative reverses | 1 step per tick | Steps actually moved (less if blocked) |
| `fire()` | Fires one bullet straight ahead | 1 tick, then cooldown | `hit` (with target team), `miss`, or `refused` (no ammo / cooling down) |
| `collectGift()` | Picks up the gift on this cell | 1 tick | `ok` or `nothing_here` |
| `collectAmmo()` | Picks up ammo on this cell | 1 tick | `ok` or `nothing_here` |
| `collectEnergy()` | Drinks the energy drink on this cell | 1 tick | `ok` or `nothing_here` |
| `idle(ticks)` | Does nothing on purpose | the given ticks | done |

An agent can call `stop()` to cancel a long move or turn early. It is not counted as an action.

### State the agent can read (sent every tick)

| Field | Meaning |
| --- | --- |
| `position` | My `(x, y)` |
| `heading` | My heading in degrees |
| `life` / `maxLife` | My current and maximum life |
| `ammo` | Bullets left |
| `fireReady` | `true` if cooldown is over and ammo > 0 |
| `lastShot` | Result of my last shot: `hit`, `miss` or `none` |
| `myGifts` | Gifts I hold now |
| `totalGifts` | Gifts placed on this map |
| `giftsLeft` | Gifts still on the map |
| `timeLeft` | Seconds left on the global timer |
| `lineOfSight` | First thing straight ahead: `wall`, `gift`, `ammo`, `energy` or `agent` (with its team name), plus distance in cells |
| `standingOn` | Item on my current cell, or `none` |
| `busy` | `true` while an action is still running |
| `alive` / `protected` | Whether I am alive, and whether I am in after-respawn protection |
| `itemLocations` | List of gift, ammo and energy positions. **Only on maps where the host allows it**; otherwise `hidden` |
| `scoreboard` | Every team's gift count. Can also be hidden per map |

Line of sight reaches a set distance per map (default 10 cells). Agents never see the whole map unless `itemLocations` is turned on.

### Events (pushed the moment they happen)

| Event | When | Extra info |
| --- | --- | --- |
| `blocked` | A move hit a wall or car | What blocked it |
| `hit` | I was shot | Side: `front`, `back`, `left` or `right` (relative to my heading), and the shooter's team |
| `canCollectGift` | I arrived on a gift cell | — |
| `canCollectAmmo` | I arrived on an ammo cell | — |
| `canCollectEnergy` | I arrived on an energy cell | — |
| `died` | My life reached 0 | Who killed me |
| `otherAgentDied` | Any other car died (sent to every other agent) | Its team, who killed it, and whether it lost a gift. The returned gift's home cell is included only on maps that reveal item locations; otherwise agents must search for it |
| `respawned` | I am back on the map | New position |
| `gameStarted` / `gamePaused` / `gameResumed` / `gameEnded` | Match stage changes | — |

### Starter kits

Teams get a starter kit in **Python only**. The kit hides the WebSocket details so team code looks like this:

```python
@car.on("canCollectGift")
async def grab(e):
    await car.collectGift()

async def brain(state):
    if state.lineOfSight.type == "agent" and state.fireReady:
        await car.fire()
    elif state.lineOfSight.type == "wall" and state.lineOfSight.distance < 2:
        await car.turn(90)
    else:
        await car.move(1)

car.run(brain)
```

The kit also includes a sample bot that wanders and collects, so teams can test against something on day one.

## Message format

Every message is a small JSON object with a `type` field, sent over one WebSocket connection per agent. Any language that can open a WebSocket can play, even without the starter kit.

**Agent to server**

| `type` | Fields | When |
| --- | --- | --- |
| `join` | `joinCode`, `teamName`, `profile` (file references) | First message |
| `action` | `token`, `tick`, `name`, `args` | When idle and wants to act |
| `stop` | `token` | Cancel the current action |
| `pong` | `id` | Reply to a ping |

**Server to agent**

| `type` | Fields | When |
| --- | --- | --- |
| `joinResult` | `accepted`, `token` or `reason` | After host decision |
| `ping` | `id` | Connection test and every few seconds |
| `state` | `tick` + all state fields | Every tick |
| `actionResult` | `name`, `result` | When an action finishes |
| `event` | `name` + extra info | When it happens |

Example of a tick:

```json
{"type":"state","tick":412,"position":{"x":7.0,"y":3.0},"heading":90,"life":75,"ammo":4,"fireReady":true,"myGifts":2,"giftsLeft":9,"timeLeft":318,"lineOfSight":{"type":"agent","team":"Falcon","distance":4},"busy":false}
```

```json
{"type":"action","token":"t_8f2c…","tick":412,"name":"fire","args":[]}
```

The `tick` number in an action lets the server spot late replies. An action stamped with an old tick is ignored, and the car stays idle. Profile files (photos and clips) are uploaded over plain HTTP before joining, because they are too big to send comfortably over the WebSocket.

## Environment builder

The host draws maps on a clickable grid in the admin page and saves each one as a JSON file in a `maps/` folder.

**Editor tools**

1. Set the grid size (for example 30 × 20 cells).
2. Pick a brush: wall, floor (eraser), gift, ammo, energy drink, spawn point.
3. Click or drag to paint cells. A border of walls is added automatically.
4. Set the level rules in a side panel (table below).
5. Click **Validate**. The editor checks there are enough spawn points for the expected teams, at least one gift, and that every gift and spawn point can be reached from every spawn point.
6. Click **Save**. Maps can also be loaded, duplicated, renamed and deleted.
7. Click **Test run** to drop the built-in sample bots in and watch the map play for a minute.

**Level rules (per map)**

| Rule | Default | Why change it |
| --- | --- | --- |
| Reveal item locations | On | Turn off on hard levels so agents must search |
| Show scoreboard to agents | On | Turn off to hide how others are doing |
| Line of sight range | 10 cells | Shorter = harder |
| Starting / max life | 100 / 100 | — |
| Damage per hit | 25 | — |
| Starting / max ammo | 5 / 10 | — |
| Fire cooldown | 1 s | — |
| Energy per drink | 30 | — |
| Ammo and energy respawn delay | 20 s | Set to "never" for scarce maps |
| Respawn delay / protection | 3 s / 2 s | — |
| Gift lost on death | 1 | Set 0 for a gentler game |
| Match length | 10 min | — |
| Tick rate | 10 per second | Lower it if the Wi-Fi is weak |

**Map file (example)**

```json
{
  "name": "Level 1 - Open Field",
  "width": 30, "height": 20,
  "walls": [[5,3],[5,4],[5,5]],
  "gifts": [{"id":"g1","home":[12,7]}, {"id":"g2","home":[20,15]}],
  "ammo": [[8,10]],
  "energy": [[15,2]],
  "spawns": [[1,1],[28,1],[1,18],[28,18]],
  "rules": {"revealItems": true, "sightRange": 10, "matchSeconds": 600}
}
```

Each gift has an `id` and a `home` cell. The home cell is where it returns when a dying car loses it.

## Team profile

Each team uploads its profile once when joining; everything is optional except the team name.

| Item | Used for | Limit |
| --- | --- | --- |
| Team name | Scoreboard, banners, line of sight | 20 characters, must be unique |
| Icon | Drawn on the car and in the scoreboard | PNG/JPG, under 1 MB, cropped to a square |
| Driver photo | Intro and winner screens | PNG/JPG, under 1 MB |
| Passenger photos (×4) | Intro and winner screens | PNG/JPG, under 1 MB each |
| Clip: gift collected | Audio queue, priority 3 | MP3/WAV/OGG, max 3 s, under 500 KB |
| Clip: hit an enemy | Audio queue, priority 2 | same |
| Clip: got hit | Audio queue, priority 2 | same |
| Clip: death | Audio queue, priority 1 | same |
| Clip: win | Winner screen only, end of match | same |

On upload the server:

1. Rejects files over the limits, with a clear reason.
2. Shrinks images to a standard size so the stage screen stays fast.
3. Trims clips to 3 seconds and evens out their loudness to one fixed level (see Audio queue).
4. Shows everything in the host's approval preview.

The stage screen loads every accepted team's files during the Ready check, so nothing has to load mid-match. A team with no icon gets a coloured default; a missing clip is simply skipped.

## Audio queue

All sound plays from the stage screen only, one clip at a time, chosen by priority, with a 1-second gap between clips.

**Who decides what plays.** The server creates every sound entry (it knows who hit whom), puts it in the queue, and tells the stage screen what to play next. Team laptops never play game audio.

**Entries and priorities**

| Situation | Entry | Priority |
| --- | --- | --- |
| A shoots B and B dies | A's "hit" clip, then B's death clip | 1 |
| A car dies any other way | That car's death clip | 1 |
| A shoots B, B survives | A's "hit" clip, then B's "got hit" clip | 2 |
| A collects a gift | A's gift clip | 3 |
| Match won | Winner's win clip | Plays only on the winner screen, outside the queue |

A two-clip entry stays together: the second clip follows the first after the 1-second gap, and nothing jumps in between. If a team has no clip for that slot, that half is skipped.

**Queue rules**

1. Only one entry plays at a time. After it ends, wait 1 second, then start the next.
2. The next entry is the one with the highest priority (1 is highest). Among equals, the oldest goes first.
3. A new priority 1 entry jumps ahead of everything waiting, but never cuts off a clip that is already playing.
4. **Safety limit:** if more than 6 entries are waiting, drop the oldest priority 3 (gift) entries until 6 remain. Priority 1 and 2 entries are never dropped.
5. Clips are at most 3 seconds, so the longest entry (two clips plus gap) is about 7 seconds.
6. Pausing the match pauses the queue; aborting it clears the queue.
7. The game never waits for audio. Ticks keep running while clips play.

**Left and right speakers.** Each clip is panned by its car's position across the map when the entry was created: a car at the far left plays from the left speaker, one in the middle from both, one at the far right from the right speaker. In a two-clip entry, each clip uses its own car's position. This uses the browser's built-in Web Audio panning.

**Even loudness.** Every clip is normalised to the same loudness at upload, so panning and volume mean the same thing for every team. The admin page has one master volume slider for the room.

**Showing who is playing**

- A **Now playing** banner at the top of the stage screen: the team's icon, name and what happened ("Falcon hit Eagle", "Eagle is down", "Falcon collected a gift"), with a moving sound wave. A two-clip entry shows both teams, for example "Falcon → Eagle", and highlights whichever team's clip is playing right now.
- A **glowing ring** around the car whose clip is playing, so the audience can spot it on the map.
- An **Up next** strip showing the next 3 waiting entries as small icons.

**Browser rule.** Browsers block sound until someone clicks the page, so the stage screen opens with a large "Enable sound" button the host presses once before the match.

Every played entry is written to the match log, so replays play the same audio in the same order.

## Match log, replays and stats

Every match is saved to disk as it runs, so a crash loses at most a few seconds and any match can be replayed later.

**What is saved** (one folder per match, under `matches/<date>-<map name>/`):

- `match.json`: map used, rules, teams and their profile files, start and end time, final result.
- `ticks.jsonl`: one line per tick with every action received, every event, and every audio entry played. Written continuously.
- `snapshots/`: a full copy of the world every 5 seconds (all car positions, life, ammo, items on the map). These let a replay jump to any moment.

**Replays.** The stage screen can load any saved match and play it back at normal or double speed, with pause and a timeline to jump around. Audio and Now playing banners replay too.

**Stats screen** (shown at the end, one row per team, sorted by rank):

| Column | Meaning |
| --- | --- |
| Rank | Final position |
| Gifts | Gifts held at the end (the score) |
| Deaths | Times the car died |
| Hits landed / taken | Shots that hit others / shots that hit me |
| Accuracy | Hits landed ÷ shots fired |
| Kills | Enemies I finished off |
| Gifts lost | Gifts sent home because I died |
| Pickups | Ammo and energy drinks collected |
| Distance | Cells travelled |

Ranking: most gifts, then fewest deaths, then most hits landed, then most life left. After the table, the winner screen shows the winning team's name, icon, driver and passenger photos, and plays its win clip. The host can export the stats as CSV.

## Network delay and the host-run fallback

On a good local Wi-Fi a message takes about 2 to 20 ms, well under one 100 ms tick, so team laptops are the main way to play.

**Keeping delay low and fair**

1. Use a dedicated router on 5 GHz for the game only; never the shared college Wi-Fi.
2. Keep the tick rate relaxed (5 to 10 per second). Nothing in this game needs faster.
3. Late replies count as idle for that tick. The server never waits.
4. The connection test flags any agent with delay over 100 ms. That team moves closer to the router or plugs in a LAN cable.
5. Keep a few LAN cables and a small switch at the venue as backup.

**Fallback: run a team's agent on the host laptop.** If a team's laptop or connection fails, the host takes their agent code and runs it on the host laptop, connecting to `ws://localhost`. The code needs no changes because it talks through the same messages.

Each host-run agent runs **as a plain Python process on the host laptop, started from a terminal. No containers or extra security.**

Starting one is a single command at the event. This is optional and can be built last.

## Tech stack and project structure

One TypeScript repo: a Node.js server plus a React web app, with types shared between them so messages can't drift apart.

| Part | Choice | Why |
| --- | --- | --- |
| Server | Node.js + TypeScript | One language across server and screens |
| Web server and uploads | Express + multer | Serves the pages and accepts profile files |
| Live connection | `ws` (WebSocket) | Light and simple; works with any language |
| Admin page and stage screen | React + Vite | Fast to build; one app with two routes |
| Maze drawing | HTML Canvas (PixiJS if you want effects later) | Plenty for a 2D grid |
| Audio | Browser Web Audio API | Built-in queueing, volume and left/right panning |
| Clip loudness | ffmpeg (`loudnorm`) | Evens out every uploaded clip |
| Image resizing | sharp | Keeps the stage screen fast |
| Storage | JSON files on disk | No database to set up |
| Starter kits | Python package (pip) | Teams write game logic, not networking |

**Folder layout**

```text
maze-game/
  shared/        message types, rules defaults
  server/        game loop, rules, lobby, audio queue, logging
  web/           React app: /admin and /stage
  kits/python/   Python starter kit + sample bot
  maps/          saved maps
  matches/       saved match logs
  uploads/       team photos and clips
```

## Build order and rehearsal checklist

Build the game logic first with no graphics, then add one screen or feature at a time, testing each before moving on.

**Build order**

1. Shared message types and rule defaults (`shared/`).
2. Game logic on the server: map loading, movement, turning, line of sight, fire, pickups, death, respawn, gift return. Test with fake agents in the terminal.
3. Tick loop and global timer, with pause and abort.
4. Stage screen that draws the maze, cars, timer and scoreboard.
5. WebSocket join flow: join code, host Accept/Decline, tokens, reconnect.
6. Connection test and the ready badges on the admin page.
7. Map builder: grid editor, level rules, validate, save and load.
8. Match log, snapshots, stats screen and CSV export.
9. Profile uploads with image resizing and clip normalising; intro and winner screens.
10. Audio queue, panning, Now playing banner, glowing ring and Up next strip.
11. Python starter kit with a sample bot.
12. Replays.
13. Host-run fallback (optional).

**Rehearsal checklist (before the event)**

- [ ] Router set up on 5 GHz, laptop on a fixed IP, firewall port open
- [ ] At least 4 laptops join, pass the connection test and play a full match
- [ ] Delay checked with every laptop connected at once
- [ ] A laptop is unplugged mid-match and reconnects
- [ ] Projector and speakers tested; Enable sound pressed; left/right panning sounds right
- [ ] A busy fight tested so the audio safety limit is seen working
- [ ] Every map validated and test-run
- [ ] A full match replayed from its log
- [ ] Host-run fallback tested with one sample bot
- [ ] Starter kit, sample bot, and a one-page rules sheet shared with teams in advance
