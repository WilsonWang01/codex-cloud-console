import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

type Position = { anchor: string | null; offset: number; top: number; follow: boolean; seen: string; count?: number };
const storageKey = "codex-cloud-chat-reading-v1";
const validText = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit;
const validPosition = (value: Position) => value && (value.anchor === null || validText(value.anchor, 512))
  && Number.isFinite(value.offset) && Math.abs(value.offset) <= 1e8 && Number.isFinite(value.top) && value.top >= 0 && value.top <= 1e8
  && typeof value.follow === "boolean" && validText(value.seen, 1024)
  && (value.count === undefined || (Number.isInteger(value.count) && value.count >= 1 && value.count <= 2000));

export class ChatReadingPositions {
  private entries = new Map<string, Position>();
  private loaded = false;
  private writable = true;
  constructor(private storage: () => Pick<Storage, "getItem" | "setItem">) {}
  private load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = this.storage().getItem(storageKey);
      if (!raw) return;
      if (raw.length > 128_000) throw new Error("Reading cache is too large");
      const value = JSON.parse(raw);
      if (value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 40
        || value.entries.some((row: { key: string; position: Position }) => !row || !validText(row.key, 1024) || !validPosition(row.position))
        || new Set(value.entries.map((row: { key: string }) => row.key)).size !== value.entries.length) throw new Error("Unknown reading cache");
      for (const row of value.entries) this.entries.set(row.key, row.position);
    } catch { this.writable = false; }
  }
  get(key: string) { this.load(); const value = this.entries.get(key); return value ? { ...value } : null; }
  set(key: string, position: Position) {
    this.load();
    if (!validText(key, 1024) || !key || !validPosition(position)) return;
    this.entries.delete(key); this.entries.set(key, { anchor: position.anchor, offset: position.offset, top: position.top, follow: position.follow, seen: position.seen,
      ...(position.count === undefined ? {} : { count: position.count }) });
    // ponytail: a tab-local UI cache, not a second history or draft store.
    if (this.entries.size > 40) this.entries.delete(this.entries.keys().next().value!);
    if (this.writable) try {
      const raw = JSON.stringify({ version: 1, entries: [...this.entries].map(([key, position]) => ({ key, position })) });
      if (raw.length > 128_000) throw new Error("Reading cache is too large");
      this.storage().setItem(storageKey, raw);
    } catch { this.writable = false; }
  }
}

const positions = new ChatReadingPositions(() => window.sessionStorage);
export function chatReadingHistoryLimit(repoId: string, sessionId: string) {
  return Math.max(80, positions.get(JSON.stringify([repoId, sessionId]))?.count || 80);
}
export function chatReadingHistoryAnchor(repoId: string, sessionId: string) {
  const position = positions.get(JSON.stringify([repoId, sessionId]));
  return position?.follow ? null : position?.anchor || null;
}
type View = { key: string; position: Position; latest: string; ignoreTop: number | null; restoring: boolean; width: number; height: number; flush: () => void; schedule: () => void };

export function useChatReadingPosition(scroller: RefObject<HTMLDivElement | null>, key: string, ready: boolean, seen: string, messageCount = 80) {
  const view = useRef<View | null>(null);
  const [newProgress, setNewProgress] = useState(false);
  const capture = useCallback(() => {
    const current = view.current, node = scroller.current;
    if (!current || !node) return;
    const follow = node.scrollHeight - node.scrollTop - node.clientHeight < 96;
    const top = node.getBoundingClientRect().top;
    const anchor = follow ? null : [...node.querySelectorAll<HTMLElement>("[data-chat-message-id]")].find(item => item.getBoundingClientRect().bottom > top + 1);
    current.position = { anchor: anchor?.dataset.chatMessageId || null, offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
      top: node.scrollTop, follow, seen: follow ? current.latest : current.position.seen, count: current.position.count };
    current.schedule();
    if (follow) setNewProgress(false);
  }, [scroller]);

  // Keep layout subscriptions on the loaded view, not on each streamed token.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!ready || !key || !node) { setNewProgress(false); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const saved = positions.get(key);
    const current: View = { key, position: { ...(saved || { anchor: null, offset: 0, top: 0, follow: true, seen }), count: Math.min(2000, messageCount) }, latest: seen,
      ignoreTop: null, restoring: true, width: node.clientWidth, height: node.clientHeight,
      flush: () => { clearTimeout(timer); positions.set(key, current.position); },
      schedule: () => { clearTimeout(timer); timer = setTimeout(() => current.flush(), 200); } };
    view.current = current;
    setNewProgress(!current.position.follow && current.position.seen !== seen);
    const restore = () => {
      if (view.current !== current) return;
      const resized = current.width !== node.clientWidth || current.height !== node.clientHeight;
      current.width = node.clientWidth; current.height = node.clientHeight;
      if (current.position.follow) {
        if (!current.restoring && !resized) return;
        node.scrollTop = node.scrollHeight;
      } else {
        const anchor = [...node.querySelectorAll<HTMLElement>("[data-chat-message-id]")].find(item => item.dataset.chatMessageId === current.position.anchor);
        // Rewrapping may shorten the message; keep it visible without replacing its saved offset.
        const offset = anchor ? Math.max(current.position.offset, Math.min(44, anchor.getBoundingClientRect().height) - anchor.getBoundingClientRect().height) : 0;
        node.scrollTop = anchor ? node.scrollTop + anchor.getBoundingClientRect().top - node.getBoundingClientRect().top - offset : current.position.top;
      }
      current.ignoreTop = node.scrollTop;
    };
    const resize = new ResizeObserver(restore);
    resize.observe(node);
    for (const child of node.children) resize.observe(child);
    const mutations = new MutationObserver(records => {
      for (const record of records) {
        for (const child of record.removedNodes) if (child instanceof Element) resize.unobserve(child);
        for (const child of record.addedNodes) if (child instanceof Element) resize.observe(child);
      }
      restore();
    });
    mutations.observe(node, { childList: true });
    const hidden = () => { if (document.visibilityState === "hidden") current.flush(); };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", current.flush);
    restore();
    return () => {
      resize.disconnect(); mutations.disconnect();
      document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", current.flush);
      current.flush();
      if (view.current === current) view.current = null;
    };
  }, [key, ready, scroller]);

  useLayoutEffect(() => {
    const current = view.current, node = scroller.current;
    if (!current || current.key !== key || !node) return;
    current.latest = seen;
    current.position.count = Math.min(2000, messageCount);
    if (current.position.follow) {
      current.position.seen = seen;
      node.scrollTop = node.scrollHeight; current.ignoreTop = node.scrollTop;
      setNewProgress(false);
    } else if (current.position.seen !== seen) setNewProgress(true);
  }, [key, ready, seen, scroller, messageCount]);

  const onScroll = useCallback(() => {
    const current = view.current, node = scroller.current;
    if (!current || !node || current.width !== node.clientWidth || current.height !== node.clientHeight
      || (current.ignoreTop !== null && Math.abs(node.scrollTop - current.ignoreTop) < 1)) return;
    current.ignoreTop = null; capture();
  }, [capture, scroller]);
  const onUserIntent = useCallback(() => {
    const current = view.current;
    if (!current) return;
    current.ignoreTop = null;
    if (current.restoring) { current.restoring = false; capture(); }
  }, [capture]);
  const scrollToLatest = useCallback(() => {
    const current = view.current, node = scroller.current;
    if (!current || !node) return;
    current.restoring = true; current.position = { anchor: null, offset: 0, top: node.scrollHeight, follow: true, seen: current.latest, count: current.position.count };
    node.scrollTop = node.scrollHeight; current.ignoreTop = node.scrollTop; current.flush(); setNewProgress(false);
  }, [scroller]);
  return { onScroll, onUserIntent, scrollToLatest, newProgress };
}
