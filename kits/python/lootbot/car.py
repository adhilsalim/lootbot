"""The Lootbot car: connects to the game server and turns your async functions into moves.

You write a ``brain(state)`` coroutine. The kit calls it whenever your car is idle and
waits while it runs, so ``await car.move(3)`` simply returns when the move is done.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import mimetypes
import os
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Awaitable, Callable, Dict, List, Optional, Union
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import websockets

log = logging.getLogger("lootbot")

Brain = Callable[["State"], Awaitable[None]]
Handler = Callable[["Event"], Awaitable[None]]


class State(SimpleNamespace):
    """The car's state for one tick. Fields use the server's names, e.g. ``state.lineOfSight.type``."""


class Event(SimpleNamespace):
    """An event pushed by the server, e.g. ``e.name == "hit"`` with ``e.side`` and ``e.by``."""


class Kicked(Exception):
    """The host removed this agent."""


def _ns(value: Any, cls=SimpleNamespace):
    """Turn nested dicts into objects so fields read as attributes."""
    if isinstance(value, dict):
        return cls(**{k: _ns(v) for k, v in value.items()})
    if isinstance(value, list):
        return [_ns(v) for v in value]
    return value


class Car:
    """One robocar. Create it, register event handlers with ``@car.on(...)``, then ``car.run(brain)``.

    Args:
        server: Server address, e.g. ``"ws://192.168.1.20:8080"``. Defaults to ``$LOOTBOT_SERVER``.
        join_code: The code announced by the host. Defaults to ``$LOOTBOT_JOIN_CODE``.
        team: Your team name (max 20 characters). Defaults to ``$LOOTBOT_TEAM``.
        profile: Optional files to upload before joining::

            {"icon": "icon.png", "driver": "me.jpg", "passengers": ["a.jpg", "b.jpg"],
             "clips": {"gift": "yay.mp3", "hitEnemy": "pew.wav", "gotHit": "ouch.ogg",
                       "death": "noo.mp3", "win": "champions.mp3"}}

        token_file: Where to remember the car's token so a restarted program takes back the same car.
    """

    def __init__(
        self,
        server: Optional[str] = None,
        join_code: Optional[str] = None,
        team: Optional[str] = None,
        profile: Optional[Dict[str, Any]] = None,
        token_file: Optional[Union[str, Path]] = None,
    ):
        # LOOTBOT_SERVER_OVERRIDE lets the host run a team's unchanged code on the game laptop.
        self.server = (
            os.environ.get("LOOTBOT_SERVER_OVERRIDE") or server or os.environ.get("LOOTBOT_SERVER") or "ws://localhost:8080"
        ).rstrip("/")
        self.join_code = join_code or os.environ.get("LOOTBOT_JOIN_CODE") or ""
        self.team = team or os.environ.get("LOOTBOT_TEAM") or ""
        if not self.team:
            raise ValueError("Give your car a team name: Car(team='Falcon') or set LOOTBOT_TEAM.")
        self.profile = profile
        safe = "".join(c if c.isalnum() else "_" for c in self.team)
        env_token_file = os.environ.get("LOOTBOT_TOKEN_FILE")
        self.token_file = Path(env_token_file or token_file or f".lootbot-token-{safe}")

        #: Latest state from the server (``None`` until the first tick).
        self.state: Optional[State] = None
        self.token: Optional[str] = None

        self._ws = None
        self._handlers: Dict[str, List[Handler]] = {}
        self._brain: Optional[Brain] = None
        self._brain_task: Optional[asyncio.Task] = None
        self._lock: Optional[asyncio.Lock] = None
        self._state_waiters: List[asyncio.Future] = []
        self._result: Optional[asyncio.Future] = None
        self._test_request: Optional[dict] = None
        self._tasks: set = set()
        self._profile_id: Optional[str] = None

    # ------------------------------------------------------------------ public API

    def on(self, name: str):
        """Register an async handler for a server event (``"hit"``, ``"canCollectGift"``, …)."""

        def deco(fn: Handler) -> Handler:
            if not inspect.iscoroutinefunction(fn):
                raise TypeError(f"@car.on({name!r}) needs an async function")
            self._handlers.setdefault(name, []).append(fn)
            return fn

        return deco

    async def turn(self, degrees: float) -> float:
        """Turn right (positive) or left (negative). Returns the final heading."""
        r = await self._act("turn", [degrees])
        return r["heading"] if isinstance(r, dict) else r

    async def move(self, steps: float) -> float:
        """Drive forward (positive) or reverse (negative). Returns the steps actually moved."""
        r = await self._act("move", [steps])
        return r["moved"] if isinstance(r, dict) else r

    async def fire(self) -> SimpleNamespace:
        """Fire one bullet. Returns ``outcome`` = ``hit`` (with ``team``), ``miss`` or ``refused`` (with ``reason``)."""
        return _ns(await self._act("fire", []))

    async def collectGift(self) -> str:
        """Pick up the gift on this cell: ``"ok"`` or ``"nothing_here"``."""
        return await self._act("collectGift", [])

    async def collectAmmo(self) -> str:
        """Pick up ammo on this cell: ``"ok"`` or ``"nothing_here"``."""
        return await self._act("collectAmmo", [])

    async def collectEnergy(self) -> str:
        """Drink the energy drink on this cell: ``"ok"`` or ``"nothing_here"``."""
        return await self._act("collectEnergy", [])

    async def idle(self, ticks: int = 1) -> str:
        """Do nothing on purpose for some ticks."""
        return await self._act("idle", [ticks])

    async def stop(self) -> None:
        """Cancel the current move or turn early."""
        if self._ws and self.token:
            await self._send({"type": "stop", "token": self.token})

    def run(self, brain: Brain) -> None:
        """Connect, join and play until the program is stopped. Reconnects automatically."""
        if not inspect.iscoroutinefunction(brain):
            raise TypeError("brain must be an async function: async def brain(state): ...")
        self._brain = brain
        try:
            asyncio.run(self._main())
        except KeyboardInterrupt:
            print("Stopped.")
        except Kicked as e:
            print(f"Kicked: {e}")
            sys.exit(1)

    # ------------------------------------------------------------------ connection

    async def _main(self) -> None:
        self._lock = asyncio.Lock()
        self.token = self._load_token()
        if self.profile and not self.token:
            self._profile_id = await asyncio.to_thread(self._upload_profile)
        delay = 1.0
        while True:
            try:
                async with websockets.connect(self.server + "/agent", max_size=2**20) as ws:
                    self._ws = ws
                    delay = 1.0
                    await self._join()
                    async for raw in ws:
                        await self._dispatch(json.loads(raw))
                print("Connection closed by the server.")
            except (OSError, websockets.exceptions.WebSocketException) as e:
                print(f"Connection problem ({e.__class__.__name__}: {e}); retrying in {delay:.0f}s…")
            finally:
                self._ws = None
                self._fail_waiters()
            await asyncio.sleep(delay)
            delay = min(delay * 2, 10)

    async def _join(self) -> None:
        msg: Dict[str, Any] = {"type": "join", "joinCode": self.join_code, "teamName": self.team}
        if self.token:
            msg["token"] = self.token
        elif self._profile_id:
            msg["profile"] = {"id": self._profile_id}
        await self._send(msg)

    async def _send(self, msg: dict) -> None:
        if self._ws is not None:
            await self._ws.send(json.dumps(msg))

    async def _dispatch(self, m: dict) -> None:
        t = m.get("type")
        if t == "ping":
            await self._send({"type": "pong", "id": m["id"]})
        elif t == "joinResult":
            await self._on_join_result(m)
        elif t == "testRequest":
            self._test_request = m
        elif t == "state":
            await self._on_state(m)
        elif t == "actionResult":
            if m.get("practice"):
                return
            if self._result and not self._result.done():
                self._result.set_result(m)
        elif t == "event":
            await self._on_event(m)
        elif t == "error":
            print(f"Server: {m.get('reason')}")

    async def _on_join_result(self, m: dict) -> None:
        status = m.get("status")
        if m.get("accepted"):
            self.token = m["token"]
            self._save_token(self.token)
            print("Reconnected to your car." if status == "reconnected" else f"Accepted! You are driving {self.team}.")
        elif status == "pending":
            print("Waiting for the host to accept…")
        else:
            reason = m.get("reason", "declined")
            if self.token and reason == "Unknown token.":
                # The server restarted: join again as a new team.
                print("Saved token is unknown to this server; joining fresh.")
                self.token = None
                self._forget_token()
                if self.profile and not self._profile_id:
                    self._profile_id = await asyncio.to_thread(self._upload_profile)
                return
            raise SystemExit(f"Join refused: {reason}")

    async def _on_state(self, m: dict) -> None:
        if m.get("practice"):
            # Connection test: do what the server asks, otherwise answer with a one-tick idle.
            req = self._test_request or {"name": "idle", "args": [1]}
            self._test_request = None
            await self._send({"type": "action", "token": self.token, "tick": m["tick"], "name": req["name"], "args": req["args"]})
            return
        self.state = _ns(m, State)
        waiters, self._state_waiters = self._state_waiters, []
        for w in waiters:
            if not w.done():
                w.set_result(self.state)
        # Call the brain when the car is free and the previous brain call has finished.
        if (
            self._brain
            and self.state.alive
            and not self.state.busy
            and not self._lock.locked()
            and (self._brain_task is None or self._brain_task.done())
        ):
            self._brain_task = self._spawn(self._brain(self.state))

    async def _on_event(self, m: dict) -> None:
        name = m.get("name")
        if name == "kicked":
            raise Kicked(m.get("reason", "removed by the host"))
        if name == "gameEnded":
            print(f"Game over: {m.get('reason')}. Winner: {m.get('winner')}")
        for h in self._handlers.get(name, []):
            self._spawn(h(_ns(m, Event)))

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)

        def done(t: asyncio.Task) -> None:
            self._tasks.discard(t)
            if not t.cancelled() and t.exception() and not isinstance(t.exception(), _Disconnected):
                log.error("Error in your code", exc_info=t.exception())
                print(f"Error in your code: {t.exception()!r}")

        task.add_done_callback(done)
        return task

    # ------------------------------------------------------------------ actions

    async def _next_state(self) -> State:
        fut = asyncio.get_running_loop().create_future()
        self._state_waiters.append(fut)
        return await fut

    async def _act(self, name: str, args: list):
        """Send one action as soon as the car is idle, and wait for its result.

        One action runs at a time: calls from the brain and from event handlers queue up.
        If the server never received the action in time (late reply), it is sent again.
        """
        async with self._lock:
            state = self.state
            if state is None or state.busy or getattr(state, "_used", False):
                state = await self._next_state()
            while True:
                while state.busy or not state.alive:
                    state = await self._next_state()
                state._used = True
                self._result = asyncio.get_running_loop().create_future()
                await self._send({"type": "action", "token": self.token, "tick": state.tick, "name": name, "args": args})
                nxt = asyncio.ensure_future(self._next_state())
                done, _ = await asyncio.wait({self._result, nxt}, return_when=asyncio.FIRST_COMPLETED)
                if self._result in done:
                    nxt.cancel()
                    return self._result.result()["result"]
                state = nxt.result()
                if state.busy:
                    return (await self._result)["result"]
                # Not busy and no result: the action was too late for its tick. Try again.
                if self._result.done():
                    return self._result.result()["result"]

    def _fail_waiters(self) -> None:
        for w in self._state_waiters:
            if not w.done():
                w.set_exception(_Disconnected())
        self._state_waiters = []
        if self._result and not self._result.done():
            self._result.set_exception(_Disconnected())
        if self._brain_task and not self._brain_task.done():
            self._brain_task.cancel()

    # ------------------------------------------------------------------ profile and token

    def _upload_profile(self) -> Optional[str]:
        p = self.profile or {}
        files: List[tuple] = []
        for field in ("icon", "driver"):
            if p.get(field):
                files.append((field, p[field]))
        for i, path in enumerate(p.get("passengers", [])[:4], start=1):
            files.append((f"passenger{i}", path))
        for slot, path in (p.get("clips") or {}).items():
            files.append((f"clip_{slot}", path))
        url = urlparse(self.server)
        scheme = "https" if url.scheme == "wss" else "http"
        body, ctype = _multipart({"teamName": self.team}, files)
        req = Request(f"{scheme}://{url.netloc}/api/profile", data=body, headers={"Content-Type": ctype})
        try:
            with urlopen(req, timeout=60) as res:
                data = json.loads(res.read())
        except Exception as e:  # noqa: BLE001 - show the server's reason if there is one
            detail = getattr(e, "read", lambda: b"")()
            try:
                reason = json.loads(detail).get("error")
            except Exception:  # noqa: BLE001
                reason = str(e)
            print(f"Profile upload failed: {reason}. Joining without a profile.")
            return None
        for note in data.get("notes", []):
            print(f"Profile: {note}")
        print("Profile uploaded.")
        return data["id"]

    def _load_token(self) -> Optional[str]:
        try:
            return self.token_file.read_text().strip() or None
        except OSError:
            return None

    def _save_token(self, token: str) -> None:
        try:
            self.token_file.write_text(token)
        except OSError:
            pass

    def _forget_token(self) -> None:
        try:
            self.token_file.unlink()
        except OSError:
            pass


class _Disconnected(Exception):
    pass


def _multipart(fields: Dict[str, str], files: List[tuple]):
    boundary = uuid.uuid4().hex
    out = bytearray()
    for k, v in fields.items():
        out += f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    for field, path in files:
        data = Path(path).read_bytes()
        name = Path(path).name
        ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        out += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{name}"\r\n'
            f"Content-Type: {ctype}\r\n\r\n"
        ).encode()
        out += data + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"
