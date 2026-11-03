import { useEffect, useRef, useState } from "react";

export function wsUrl(path: string) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${path}`;
}

/**
 * Keep a WebSocket open to `path`, reconnecting after drops.
 * `onMessage` receives parsed JSON. Returns a `send` function and the connection status.
 */
export function useSocket<In, Out = unknown>(path: string | null, onMessage: (msg: In) => void) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    if (!path) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const open = () => {
      const ws = new WebSocket(wsUrl(path));
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => handler.current(JSON.parse(e.data));
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(open, 1000);
      };
    };
    open();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [path]);

  const send = (msg: Out) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(msg));
  };
  return { send, connected };
}

export function formatTime(sec: number) {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
