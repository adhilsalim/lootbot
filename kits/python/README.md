# Lootbot Python starter kit

Write code that drives a robocar through the maze. The car that holds the most gifts when the timer ends wins.

## Install

```bash
pip install ./kits/python        # from the game repo; or: pip install websockets, and copy the lootbot/ folder next to your bot
```

Python 3.9 or newer.

## Run the sample bot

```bash
python examples/sample_bot.py --server ws://192.168.1.20:8080 --code ABCD --team Falcon
```

The host shows the server address and join code at the event. Your program waits until the host accepts it, then runs a short automatic connection test. The kit answers the test for you.

## Your bot

```python
from lootbot import Car

car = Car(server="ws://192.168.1.20:8080", join_code="ABCD", team="Falcon")

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

The kit calls `brain(state)` whenever your car is idle. Each `await car.…()` returns when the action has finished. Your car does one action at a time: if an event handler and `brain` both act, the actions queue up.

If your program loses its connection, the car stands still and the kit reconnects. The kit saves your car's token in `.lootbot-token-<team>`, so restarting your program takes back the same car. Do not share that file.

## Profile (optional)

Upload a team icon, photos and sound clips when you first join:

```python
car = Car(..., profile={
    "icon": "icon.png",                       # PNG/JPG under 1 MB, cropped to a square
    "driver": "driver.jpg",                   # PNG/JPG under 1 MB
    "passengers": ["p1.jpg", "p2.jpg", "p3.jpg", "p4.jpg"],
    "clips": {                                # MP3/WAV/OGG, max 3 s, under 500 KB
        "gift": "yay.mp3", "hitEnemy": "pew.wav", "gotHit": "ouch.ogg",
        "death": "noo.mp3", "win": "champions.mp3",
    },
})
```

## Actions

| Call | What it does | Time | Returns |
| --- | --- | --- | --- |
| `await car.turn(degrees)` | Positive turns right, negative left | 45° per tick | Final heading |
| `await car.move(steps)` | Positive forward, negative reverse | 1 cell per tick | Cells actually moved |
| `await car.fire()` | One bullet straight ahead | 1 tick, then 1 s cooldown | `.outcome`: `hit` (with `.team`), `miss`, or `refused` (with `.reason`) |
| `await car.collectGift()` | Pick up the gift on your cell | 1 tick | `"ok"` or `"nothing_here"` |
| `await car.collectAmmo()` | Pick up ammo on your cell | 1 tick | `"ok"` or `"nothing_here"` |
| `await car.collectEnergy()` | Drink the energy drink on your cell | 1 tick | `"ok"` or `"nothing_here"` |
| `await car.idle(ticks)` | Wait on purpose | the given ticks | `"done"` |
| `await car.stop()` | Cancel a long move or turn early | instant | — |

Driving over an item does not pick it up. Stand on its cell and call the matching collect.

## State (`state.…` or `car.state.…`)

| Field | Meaning |
| --- | --- |
| `position.x`, `position.y` | Your cell. `(0, 0)` is the top-left |
| `heading` | Degrees: 0 = up, 90 = right, 180 = down, 270 = left |
| `life`, `maxLife` | Current and maximum life |
| `ammo`, `fireReady` | Bullets left; `True` if you can fire now |
| `lastShot` | `hit`, `miss` or `none` |
| `myGifts`, `totalGifts`, `giftsLeft` | Your gifts, gifts on this map, gifts still on the map |
| `timeLeft` | Seconds left on the match timer |
| `lineOfSight.type` | First thing straight ahead: `wall`, `gift`, `ammo`, `energy`, `agent` or `none` |
| `lineOfSight.distance`, `lineOfSight.team` | Cells to it; team name if it is a car |
| `standingOn` | `gift`, `ammo`, `energy` or `none` |
| `busy` | `True` while an action is running |
| `alive`, `protected` | Alive? In the 2 s protection after respawning? |
| `itemLocations` | List of items (`.type`, `.x`, `.y`) — or `"hidden"` on hard maps |
| `scoreboard` | Gifts per team — or `"hidden"` |

## Events (`@car.on("name")`)

| Event | Extra fields |
| --- | --- |
| `blocked` | `by` (`wall` or `agent`), `team` |
| `hit` | `side` (`front`, `back`, `left`, `right`), `by` |
| `canCollectGift`, `canCollectAmmo`, `canCollectEnergy` | — |
| `died` | `killedBy` |
| `otherAgentDied` | `team`, `killedBy`, `lostGift`, `giftHome` (only on maps that reveal items) |
| `respawned` | `position` |
| `gameStarted`, `gamePaused`, `gameResumed`, `gameEnded` | `gameEnded` has `reason`, `winner` |

## Rules in one minute

- Most gifts at the end wins. Ties: fewer deaths, then more hits landed, then more life left.
- A hit removes 25 life. At 0 life you die: you lose your most recent gift (it goes back to its home cell), then respawn after 3 s with full life and 2 s of protection (no damage, no firing).
- Ammo and energy drinks reappear 20 s after pickup.
- These are defaults: each map can change them.

## Without the kit

Any language with a WebSocket client can play. Connect to `ws://<server>/agent` and exchange JSON messages; see `docs/context.md` ("Message format") in the game repo.
