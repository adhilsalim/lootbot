"""Sample bot: wanders the maze, picks up everything it stands on, and shoots cars ahead.

Run it:
    python sample_bot.py --server ws://192.168.1.20:8080 --code ABCD --team Falcon
"""

import argparse
import random

from lootbot import Car

parser = argparse.ArgumentParser()
parser.add_argument("--server", default=None, help="e.g. ws://192.168.1.20:8080 (or set LOOTBOT_SERVER)")
parser.add_argument("--code", default=None, help="join code (or set LOOTBOT_JOIN_CODE)")
parser.add_argument("--team", default=None, help="team name (or set LOOTBOT_TEAM)")
args = parser.parse_args()

car = Car(server=args.server, join_code=args.code, team=args.team)


@car.on("canCollectGift")
async def grab(e):
    await car.collectGift()


@car.on("hit")
async def ouch(e):
    print(f"Hit from the {e.side} by {e.by}!")


@car.on("died")
async def died(e):
    print(f"Down! Killed by {e.killedBy}.")


async def brain(state):
    sight = state.lineOfSight
    if state.standingOn == "gift":
        await car.collectGift()
    elif state.standingOn == "ammo":
        await car.collectAmmo()
    elif state.standingOn == "energy" and state.life < state.maxLife:
        await car.collectEnergy()
    elif sight.type == "agent" and state.fireReady:
        result = await car.fire()
        print(f"Fired: {result.outcome}")
    elif sight.type in ("wall", "agent") and sight.distance <= 1:
        await car.turn(random.choice([90, -90]))
    elif sight.type in ("gift", "ammo", "energy"):
        await car.move(sight.distance)
    elif random.random() < 0.15:
        await car.turn(random.choice([90, -90]))
    else:
        await car.move(1)


car.run(brain)
