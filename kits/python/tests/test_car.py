"""Tests for the starter kit against a scripted fake game server."""

import asyncio
import json

import pytest
import websockets

from lootbot import Car


class FakeServer:
    """A one-client WebSocket server the test drives by hand."""

    def __init__(self):
        self.inbox: asyncio.Queue = asyncio.Queue()
        self.ws = None
        self.connected = asyncio.Event()
        self.server = None
        self.port = 0

    async def start(self):
        async def handler(ws):
            self.ws = ws
            self.connected.set()
            async for raw in ws:
                await self.inbox.put(json.loads(raw))

        self.server = await websockets.serve(handler, "localhost", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def send(self, msg):
        await self.ws.send(json.dumps(msg))

    async def recv(self, type_=None, timeout=2.0):
        while True:
            m = await asyncio.wait_for(self.inbox.get(), timeout)
            if type_ is None or m["type"] == type_:
                return m

    async def close(self):
        self.server.close()
        await self.server.wait_closed()


def state(tick, **kw):
    s = {
        "type": "state", "tick": tick, "position": {"x": 2, "y": 3}, "heading": 90, "life": 100, "maxLife": 100,
        "ammo": 5, "fireReady": True, "lastShot": "none", "myGifts": 0, "totalGifts": 2, "giftsLeft": 2,
        "timeLeft": 60, "lineOfSight": {"type": "wall", "distance": 5}, "standingOn": "none", "busy": False,
        "alive": True, "protected": False, "itemLocations": "hidden", "scoreboard": "hidden",
    }
    s.update(kw)
    return s


@pytest.fixture
async def server():
    s = await FakeServer().start()
    yield s
    await s.close()


async def start_car(server, tmp_path, brain, setup=lambda car: None, token=None):
    tf = tmp_path / "token"
    if token:
        tf.write_text(token)
    car = Car(server=f"ws://localhost:{server.port}", join_code="ABCD", team="Falcon", token_file=tf)
    setup(car)
    car._brain = brain
    task = asyncio.ensure_future(car._main())
    await asyncio.wait_for(server.connected.wait(), 2)
    return car, task, tf


async def accept(server):
    join = await server.recv("join")
    await server.send({"type": "joinResult", "accepted": False, "status": "pending"})
    await server.send({"type": "joinResult", "accepted": True, "token": "t_abc", "status": "accepted"})
    return join


async def test_join_saves_token_and_answers_pings_and_tests(server, tmp_path):
    async def brain(s):
        pass

    car, task, tf = await start_car(server, tmp_path, brain)
    join = await accept(server)
    assert join == {"type": "join", "joinCode": "ABCD", "teamName": "Falcon"}
    await server.send({"type": "ping", "id": 7})
    assert await server.recv("pong") == {"type": "pong", "id": 7}
    await asyncio.sleep(0.05)
    assert tf.read_text() == "t_abc"

    # Practice state with a test request: the kit performs the requested action itself.
    await server.send({"type": "testRequest", "name": "turn", "args": [90]})
    await server.send(state(0, practice=True))
    a = await server.recv("action")
    assert a == {"type": "action", "token": "t_abc", "tick": 0, "name": "turn", "args": [90]}
    # Without a request, a practice state gets a one-tick idle.
    await server.send(state(1, practice=True))
    assert (await server.recv("action"))["name"] == "idle"
    task.cancel()


async def test_brain_actions_are_stamped_and_return_results(server, tmp_path):
    results = []

    async def brain(s):
        if s.lineOfSight.type == "wall":
            results.append(await car.move(2))
            results.append(await car.turn(-90))

    car, task, _ = await start_car(server, tmp_path, brain)
    await accept(server)
    await server.send(state(10))
    a = await server.recv("action")
    assert (a["tick"], a["name"], a["args"]) == (10, "move", [2])
    await server.send(state(11, busy=True))
    await server.send({"type": "actionResult", "tick": 11, "name": "move", "result": {"moved": 2}})
    await server.send(state(12))
    t = await server.recv("action")
    assert (t["tick"], t["name"]) == (12, "turn")
    await server.send({"type": "actionResult", "tick": 12, "name": "turn", "result": {"heading": 0}})
    await asyncio.sleep(0.05)
    assert results == [2, 0]
    task.cancel()


async def test_late_action_is_sent_again_on_the_next_tick(server, tmp_path):
    out = []

    async def brain(s):
        out.append((await car.fire()).outcome)

    car, task, _ = await start_car(server, tmp_path, brain)
    await accept(server)
    await server.send(state(5))
    first = await server.recv("action")
    assert first["tick"] == 5
    # The server ignored it (too late): the next state is idle and no result came.
    await server.send(state(6))
    retry = await server.recv("action")
    assert (retry["tick"], retry["name"]) == (6, "fire")
    await server.send({"type": "actionResult", "tick": 6, "name": "fire", "result": {"outcome": "hit", "team": "Eagle"}})
    await asyncio.sleep(0.05)
    assert out == ["hit"]
    task.cancel()


async def test_event_handlers_run_and_queue_behind_the_brain(server, tmp_path):
    seen = []

    async def brain(s):
        pass

    def setup(car):
        @car.on("canCollectGift")
        async def grab(e):
            seen.append(e.name)
            await car.collectGift()

        @car.on("hit")
        async def hit(e):
            seen.append((e.side, e.by))

    car, task, _ = await start_car(server, tmp_path, brain, setup)
    await accept(server)
    await server.send(state(3, busy=True))
    await server.send({"type": "event", "name": "hit", "tick": 3, "side": "left", "by": "Eagle"})
    await server.send({"type": "event", "name": "canCollectGift", "tick": 3})
    await asyncio.sleep(0.05)
    assert seen == [("left", "Eagle"), "canCollectGift"]
    # Busy car: the collect waits for an idle tick.
    await server.send(state(4))
    a = await server.recv("action")
    assert (a["tick"], a["name"]) == (4, "collectGift")
    task.cancel()


async def test_reconnects_with_saved_token(server, tmp_path):
    async def brain(s):
        pass

    car, task, _ = await start_car(server, tmp_path, brain, token="t_saved")
    join = await server.recv("join")
    assert join["token"] == "t_saved"
    task.cancel()


async def test_unknown_token_falls_back_to_a_fresh_join(server, tmp_path):
    async def brain(s):
        pass

    car, task, tf = await start_car(server, tmp_path, brain, token="t_old")
    await server.recv("join")
    await server.send({"type": "joinResult", "accepted": False, "reason": "Unknown token."})
    await asyncio.sleep(0.05)
    assert not tf.exists()
    assert car.token is None
    task.cancel()
