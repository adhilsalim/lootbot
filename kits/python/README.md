# Lootbot starter kit (Python)

Write a program that drives a robocar through a maze. The car holding the most gifts when the timer ends wins. Your program makes every decision: nobody steers by hand during the match.

This kit handles the networking for you. You write one function, `brain`, that looks at your car's state and decides what to do next.

## Contents

1. [Install](#1-install)
2. [Run the sample bot](#2-run-the-sample-bot)
3. [How your program runs](#3-how-your-program-runs)
4. [The world: grid, headings and sight](#4-the-world-grid-headings-and-sight)
5. [Actions](#5-actions)
6. [State](#6-state)
7. [Events](#7-events)
8. [Rules](#8-rules)
9. [Tips and common mistakes](#9-tips-and-common-mistakes)
10. [Team profile: icon, photos and sounds](#10-team-profile-icon-photos-and-sounds)
11. [Reconnecting](#11-reconnecting)
12. [When something goes wrong](#12-when-something-goes-wrong)
13. [Playing without the kit](#13-playing-without-the-kit)

## 1. Install

You need Python 3.9 or newer.

In the kit folder you were given (the one containing `pyproject.toml`), run:

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install .
```

This installs the `lootbot` package and its one dependency, `websockets`.

## 2. Run the sample bot

The host gives you a **server address** and a **join code** at the event. Then run:

```bash
python examples/sample_bot.py --server ws://192.168.1.20:8080 --code K7QM --team "Your Team"
```

You'll see:

```text
Waiting for the host to accept…
Accepted! You are driving Your Team.
```

Once you're accepted, the game runs a short connection test automatically, and the kit answers it for you. Your car starts moving when the host starts the match. At the end you'll see `Game over: time. Winner: …`.

The sample bot wanders, picks up whatever it stands on and shoots cars in front of it. Copy it as your starting point.

You can also leave the address, code and team name out of your code and set them as environment variables instead: `LOOTBOT_SERVER`, `LOOTBOT_JOIN_CODE` and `LOOTBOT_TEAM`. `Car()` uses them for anything you don't pass.

## 3. How your program runs

A minimal program:

```python
from lootbot import Car

car = Car(server="ws://192.168.1.20:8080", join_code="K7QM", team="Falcon")

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

The game runs in **ticks**: small fixed steps, 10 per second by default. Every tick the server sends your car's state. The kit calls `brain(state)` whenever your car is idle and your previous `brain` call has finished.

Each `await car.…()` sends one action and returns when that action is done. A move of 3 cells takes 3 ticks, so `await car.move(3)` returns about 0.3 seconds later with the number of cells actually moved:

```text
tick 40   state arrives, car idle   ->  brain(state) runs and calls await car.move(3)
tick 41   moving (state.busy is True, so brain is not called)
tick 42   moving
tick 43   move done                 ->  car.move returns 3, brain returns
tick 44   state arrives, car idle   ->  brain(state) runs again
```

Rules of thumb:

- **One action at a time.** If `brain` and an event handler both call actions, they wait in line.
- **If `brain` does nothing, it's called again next tick.** Returning without acting is fine.
- **Don't block.** Never use `time.sleep()`. Use `await car.idle(ticks)` to wait.
- **The game never waits for you.** If your program is slow, your car simply stands still that tick. If an action arrives too late for its tick, the kit sends it again on the next one.
- **`brain` isn't called while your car is dead.** It resumes after you respawn.
- **Errors don't stop your program.** An exception in `brain` is printed, and `brain` is called again on the next tick.

### Reacting in the middle of an action

A long action doesn't make your car deaf. Events (see [section 7](#7-events)) arrive the moment something happens, even halfway through `move(10)`. An event handler can call `await car.stop()` to cancel the running move or turn on the spot, and then act.

```python
TURN_TO_FACE = {"front": 0, "right": 90, "back": 180, "left": -90}

@car.on("hit")
async def shot_at(e):
    await car.stop()                  # cancel the move right now
    if TURN_TO_FACE[e.side]:
        await car.turn(TURN_TO_FACE[e.side])   # face the shooter
    if car.state.fireReady:
        await car.fire()              # and shoot back

async def brain(state):
    moved = await car.move(10)
    if moved < 10:
        return                        # interrupted (blocked or stopped): rethink next tick
    ...
```

Here is what happened when this ran against the real server:

```text
tick 0    brain calls move(10)
tick 1-6  moving
tick 7    "hit" event arrives (from the front) -> handler calls car.stop(); the car halts at once
tick 8    car.move(10) returns 8 in brain; the handler's actions go next
tick 8-   handler turns if needed, then fires back
```

What to know:

- **`stop()` takes effect immediately.** It doesn't wait its turn behind the running action.
- **The cancelled action still returns**, with what it managed so far: the cells moved, or the heading reached. Check the result in `brain` so you notice the interruption.
- **The handler's actions run before `brain`'s next ones.** Actions run in the order they were asked for, and the handler asked first.
- **Without `stop()`, a handler's action waits** until the current one finishes. That's fine for `collectGift()` on arrival, but too slow for dodging or shooting back.

## 4. The world: grid, headings and sight

The maze is a grid of square cells. `(0, 0)` is the **top-left** cell; `x` grows to the right and `y` grows **downward**. Each cell is either open floor or wall. Walls fill whole cells, and the outer border is always wall, so the cells you can drive on start at `(1, 1)`. You aren't told the map's size: you find the walls by looking.

```text
        x →   0   1   2   3   4   5
   y  0       #   #   #   #   #   #
   ↓  1       #   .   .   G   .   #        #  wall
      2       #   .   #   .   .   #        .  floor
      3       #   >   .   .   A   #        G  gift,  A  ammo
      4       #   #   #   #   #   #        >  your car at (1, 3), heading 90 (right)
```

**Heading** is in degrees:

```text
               0 (up)
               |
   270 (left) -+- 90 (right)
               |
              180 (down)
```

**Line of sight** is the first thing straight ahead of your car, counted from the cell next to it. In the diagram the car faces right. Cells (2, 3) and (3, 3) are floor, and the first thing it meets is the ammo at (4, 3), so:

```python
state.lineOfSight.type      # "ammo"
state.lineOfSight.distance  # 3   (the next cell is distance 1)
```

If nothing is within sight range, `type` is `"none"` and `distance` is `None`. A car, gift or item in the way hides whatever is behind it. You only ever see one line, so turn to look around.

**Stick to 0, 90, 180 and 270.** Cars can face any angle, but at diagonal headings (such as 45°) moves go diagonally and positions stop being whole numbers. Everything in this guide assumes straight lines.

## 5. Actions

| Call | What it does | Time (default) | Returns |
| --- | --- | --- | --- |
| `await car.turn(degrees)` | Positive turns right (clockwise), negative turns left | 45° per tick, so a 90° turn takes 2 ticks | New heading, e.g. `180` |
| `await car.move(steps)` | Positive drives forward, negative reverses | 1 cell per tick | Cells actually moved, e.g. `2.0`. Less than asked if a wall or car was in the way |
| `await car.fire()` | Fires one bullet straight ahead | 1 tick, then a 1 s cooldown | `.outcome`: `"hit"` (with `.team`), `"miss"`, or `"refused"` (with `.reason`: `"no_ammo"`, `"cooling_down"` or `"protected"`) |
| `await car.collectGift()` | Picks up the gift on your cell | 1 tick | `"ok"` or `"nothing_here"` |
| `await car.collectAmmo()` | Picks up the ammo on your cell | 1 tick | `"ok"` or `"nothing_here"` |
| `await car.collectEnergy()` | Drinks the energy drink on your cell | 1 tick | `"ok"` or `"nothing_here"` |
| `await car.idle(ticks)` | Waits on purpose | the given number of ticks | `"done"` |
| `await car.stop()` | Cancels a long move or turn early | instant | Nothing; the cancelled action returns what it managed so far |

Driving over an item does **not** pick it up. Stop on its cell and call the matching collect.

Reading results:

```python
moved = await car.move(5)
if moved < 5:
    print("something was in the way")

shot = await car.fire()
if shot.outcome == "hit":
    print("hit", shot.team)
elif shot.outcome == "refused":
    print("could not fire:", shot.reason)
```

## 6. State

`brain` receives the state, and the latest one is always in `car.state` too. Fields read as attributes, for example `state.position.x`.

| Field | Example | Meaning |
| --- | --- | --- |
| `tick` | `412` | Current tick number |
| `position.x`, `position.y` | `7.0`, `3.0` | Your cell. Use `round()` to get whole numbers |
| `heading` | `90` | Degrees: 0 up, 90 right, 180 down, 270 left |
| `life`, `maxLife` | `75`, `100` | Current and maximum life |
| `ammo` | `4` | Bullets left |
| `fireReady` | `True` | `True` only if you have ammo, the cooldown is over and you're not protected |
| `lastShot` | `"hit"` | Result of your last shot: `"hit"`, `"miss"` or `"none"` |
| `myGifts` | `2` | Gifts you hold |
| `totalGifts`, `giftsLeft` | `14`, `9` | Gifts on this map, and gifts still lying on it |
| `timeLeft` | `318.5` | Seconds left in the match |
| `lineOfSight.type` | `"agent"` | `"wall"`, `"gift"`, `"ammo"`, `"energy"`, `"agent"` (a car) or `"none"` |
| `lineOfSight.distance` | `4` | Cells to it (`None` when the type is `"none"`) |
| `lineOfSight.team` | `"Eagle"` | The car's team, when the type is `"agent"` |
| `standingOn` | `"gift"` | Item on your cell: `"gift"`, `"ammo"`, `"energy"` or `"none"` |
| `busy` | `False` | `True` while an action is still running |
| `alive` | `True` | `False` while you wait to respawn |
| `protected` | `False` | `True` for 2 s after respawning: you can't be damaged and can't fire |
| `itemLocations` | a list, or `"hidden"` | Every gift, ammo and energy drink on the map, each with `.type`, `.x` and `.y`. Only on maps where the host allows it |
| `scoreboard` | an object, or `"hidden"` | Gifts per team. `vars(state.scoreboard)` turns it into a dict like `{"Falcon": 2, "Eagle": 1}` |

Always check for `"hidden"` before using `itemLocations` or `scoreboard`:

```python
if state.itemLocations != "hidden":
    gifts = [(i.x, i.y) for i in state.itemLocations if i.type == "gift"]
```

## 7. Events

Events arrive the moment something happens, even while an action is running. Register a handler with `@car.on("name")`. The handler gets an event object with `.name`, `.tick` and the extra fields below.

| Event | When | Extra fields |
| --- | --- | --- |
| `blocked` | A move ran into something | `.by`: `"wall"` or `"agent"`; `.team` when it's a car |
| `hit` | You were shot | `.side`: `"front"`, `"back"`, `"left"` or `"right"` (relative to your heading); `.by`: the shooter's team |
| `canCollectGift`, `canCollectAmmo`, `canCollectEnergy` | You arrived on a cell with that item | — |
| `died` | Your life reached 0 | `.killedBy`: the team that killed you |
| `otherAgentDied` | Another car died | `.team`, `.killedBy`, `.lostGift` (`True` or `False`), and `.giftHome` (a list of cells with `.x` and `.y`) only on maps that reveal items |
| `respawned` | You're back on the map | `.position` |
| `gameStarted`, `gamePaused`, `gameResumed` | The match changed state | — |
| `gameEnded` | The match is over | `.reason` (`"time"`, `"gifts"` or `"aborted"`), `.winner` |

```python
@car.on("blocked")
async def bumped(e):
    if e.by == "agent":
        print("a car from team", e.team, "is in the way")
```

For reacting to `hit` while moving, see [Reacting in the middle of an action](#reacting-in-the-middle-of-an-action).

## 8. Rules

- **Winning:** the most gifts when the timer ends, or when no gifts are left on the map. Ties go to fewer deaths, then more hits landed, then more life left.
- **Collisions:** cars can't drive through walls or each other, and two cars never share a cell.
- **Shooting:** a bullet flies straight until it meets the first wall or car, with no range limit. A hit removes life. Each shot uses one bullet and starts a cooldown.
- **Dying:** at 0 life your car disappears and you lose the gift you collected most recently. It goes back to the cell it originally came from, not where you died. After a short wait you respawn at a free spawn point with full life and starting ammo, and you're protected for 2 seconds.
- **Pickups:** ammo and energy drinks reappear on their cell some time after being picked up. Gifts never reappear; they only move when a car dies.

The numbers below are defaults. **The host can change any of them per map**, so read your state rather than hard-coding them.

| Setting | Default |
| --- | --- |
| Ticks per second | 10 |
| Turn speed / move speed | 45° per tick / 1 cell per tick |
| Starting / maximum life | 100 / 100 |
| Damage per hit | 25 (4 hits kill) |
| Starting / maximum ammo | 5 / 10 |
| Ammo per pickup | 5 |
| Life per energy drink | 30 |
| Fire cooldown | 1 second |
| Ammo and energy reappear after | 20 seconds |
| Respawn delay / protection | 3 seconds / 2 seconds |
| Gifts lost on death | 1 |
| Sight range | 10 cells |
| Match length | 10 minutes |

## 9. Tips and common mistakes

| Do | Don't |
| --- | --- |
| `await car.move(1)` | `car.move(1)` without `await`: nothing waits for it, and your actions pile up |
| `await car.idle(5)` | `time.sleep(0.5)`: it freezes your whole program, event handlers included |
| Turn in multiples of 90 | Turn 45°: you'll start moving diagonally |
| `round(state.position.x)` | Use the raw float as a dictionary key |
| Remember the walls you've seen and plan routes on your own map | Drive at random: the map is never sent to you |
| Check `state.fireReady` before firing | Fire blindly: every refused shot wastes a tick |
| Collect what you're standing on (`state.standingOn`) | Expect driving over an item to pick it up |

Ideas to get started:

- **Build a map as you go.** Every line-of-sight reading tells you which cells are open and where a wall is. Every `blocked` event tells you where you couldn't go.
- **Look around.** You only see one line, so at junctions, turn to check the other directions.
- **Protect your gifts.** Every death costs a gift, so when your life is low, find an energy drink.

## 10. Team profile: icon, photos and sounds

Your team can have an icon on its car, photos on the intro and winner screens, and short sound clips that play when things happen. Everything is optional. The files are uploaded once, when you first join:

```python
car = Car(..., profile={
    "icon": "icon.png",
    "driver": "driver.jpg",
    "passengers": ["p1.jpg", "p2.jpg", "p3.jpg", "p4.jpg"],
    "clips": {
        "gift": "yay.mp3",          # you collected a gift
        "hitEnemy": "pew.wav",      # you hit another car
        "gotHit": "ouch.ogg",       # you were hit
        "death": "noo.mp3",         # you died
        "win": "champions.mp3",     # your team won (winner screen only)
    },
})
```

| File | Format | Limit |
| --- | --- | --- |
| Icon | PNG or JPG | Under 1 MB; cropped to a square |
| Driver and passenger photos | PNG or JPG | Under 1 MB each |
| Sound clips | MP3, WAV or OGG | Under 500 KB; anything longer than 3 seconds is cut to 3 seconds |

All clips are adjusted to the same loudness, so a loud one gains nothing. If an upload fails, the kit prints why (for example `Profile upload failed: Icon is over the 1 MB limit.`) and joins without a profile.

## 11. Reconnecting

When the host accepts you, the kit saves your car's secret token in a file called `.lootbot-token-<team>` in the folder you run from. As long as that file exists:

- If your connection drops, the car stands still and the kit keeps retrying until it reconnects.
- If you stop and restart your program, it takes back the same car, with its gifts and without needing approval again.

Don't share the token file: whoever has it controls your car. Delete it only if the host asks you to join again as a new team.

## 12. When something goes wrong

| Message | Meaning | What to do |
| --- | --- | --- |
| `Join refused: Wrong join code.` | The code doesn't match | Check the code the host announced |
| `Join refused: Team name "…" is already taken.` | Another team has that name, or your earlier program still holds it | Pick another name, or run from the folder that has your token file |
| `Waiting for the host to accept…` and nothing more | The host hasn't accepted you yet | Wait, or tell the host |
| `Connection problem (…); retrying in 1s…` | The server can't be reached | Check the address, and that you're on the game Wi-Fi |
| `Error in your code: …` | `brain` or a handler raised an exception | Fix it; your program keeps running in the meantime |
| `Kicked: Removed by the host.` | The host removed your team | Talk to the host |

If your car doesn't move after the match starts, `brain` is probably never calling an action, or calling one without `await`.

## 13. Playing without the kit

Any language with a WebSocket client can play. Connect to `ws://<server address>/agent` and exchange JSON messages: one object per message, each with a `type` field.

**You send:**

```json
{"type": "join", "joinCode": "K7QM", "teamName": "Falcon"}
{"type": "action", "token": "t_…", "tick": 412, "name": "move", "args": [3]}
{"type": "stop", "token": "t_…"}
{"type": "pong", "id": 7}
```

Action names are `turn`, `move`, `fire`, `collectGift`, `collectAmmo`, `collectEnergy` and `idle`. To reconnect, add `"token"` to the join message.

**You receive:**

| `type` | Fields | What to do |
| --- | --- | --- |
| `joinResult` | `accepted`, `status` (`pending`, `accepted`, `declined` or `reconnected`), `token`, `reason` | Keep the token and send it with every action |
| `ping` | `id` | Reply at once with `pong` and the same `id` |
| `state` | `tick` plus every field in [State](#6-state) | When `busy` is false, you may send one action stamped with this `tick`. Actions stamped with an older tick are ignored |
| `actionResult` | `name`, `result`, `tick` | Your action finished |
| `event` | `name` plus the fields in [Events](#7-events) | — |
| `testRequest` | `name`, `args` | Connection test: reply to the next practice `state` with exactly this action |
| `error` | `reason` | Something you sent was rejected |

During the connection test, the server sends `state` messages marked `"practice": true`. Answer every one: with the requested action if a `testRequest` came just before it, otherwise with `{"name": "idle", "args": [1]}`. Results marked `"practice": true` aren't part of the match.

To upload a profile without the kit, send a `multipart/form-data` POST to `http://<server address>/api/profile`. The fields are `teamName`, `icon`, `driver`, `passenger1` to `passenger4`, `clip_gift`, `clip_hitEnemy`, `clip_gotHit`, `clip_death` and `clip_win`. Put the `id` it returns in your join message as `"profile": {"id": "…"}`.
