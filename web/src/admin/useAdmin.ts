import { useState } from "react";
import type { AdminCommand, AdminState, ServerToAdmin } from "@lootbot/shared";
import { useSocket } from "../lib/socket";

const KEY_STORE = "lootbot-admin-key";

/** Admin key from `?key=` (remembered in localStorage) or a previous visit. */
export function useAdminKey() {
  const [key, setKeyState] = useState<string | null>(() => {
    const fromUrl = new URLSearchParams(location.search).get("key");
    if (fromUrl) {
      localStorage.setItem(KEY_STORE, fromUrl);
      history.replaceState(null, "", location.pathname);
      return fromUrl;
    }
    return localStorage.getItem(KEY_STORE);
  });
  const setKey = (k: string | null) => {
    if (k) localStorage.setItem(KEY_STORE, k);
    else localStorage.removeItem(KEY_STORE);
    setKeyState(k);
  };
  return [key, setKey] as const;
}

export interface Toast { id: number; kind: "error" | "info"; text: string }

export function useAdmin(key: string | null) {
  const [state, setState] = useState<AdminState | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = (kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  };
  const { send, connected } = useSocket<ServerToAdmin, AdminCommand>(
    key ? `/ws/admin?key=${encodeURIComponent(key)}` : null,
    (msg) => {
      if (msg.type === "state") setState(msg);
      else toast(msg.type, msg.message);
    },
  );
  return { state, send, connected, toasts, toast };
}

/** Fetch an admin-only HTTP endpoint with the key attached. */
export async function adminFetch(key: string, url: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}), ...init.headers, "x-admin-key": key },
  });
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}
