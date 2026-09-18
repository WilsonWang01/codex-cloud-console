export type DraftContent = { input: string; attachments: unknown[]; revision?: number };
type DraftResponse = { draft: DraftContent };

export class DraftPersistence {
  private revisions = new Map<string, number>();
  private pending = new Map<string, Promise<unknown>>();

  constructor(
    private read: (repoId: string, sessionId: string) => Promise<DraftResponse>,
    private write: (repoId: string, sessionId: string, draft: DraftContent, revision: number) => Promise<DraftResponse>,
    private storage: Storage,
  ) {}

  key(repoId: string, sessionId: string) { return `codex-cloud-draft:${repoId}:${sessionId}`; }

  seed(repoId: string, sessionId: string, draft?: DraftContent | null) {
    const key = this.key(repoId, sessionId);
    if (this.pending.has(key) && this.revisions.has(key)) return;
    const local = this.recover(repoId, sessionId);
    if (!this.revisions.has(key) || !local) this.revisions.set(key, local?.revision ?? draft?.revision ?? 0);
  }

  recover(repoId: string, sessionId: string): DraftContent | null {
    try {
      const value = JSON.parse(this.storage.getItem(this.key(repoId, sessionId)) || "null");
      return value && typeof value.input === "string" && Array.isArray(value.attachments) ? value : null;
    } catch { return null; }
  }

  remember(repoId: string, sessionId: string, draft: DraftContent) {
    const key = this.key(repoId, sessionId);
    try { this.storage.setItem(key, JSON.stringify({ ...draft, revision: this.revisions.get(key) ?? draft.revision })); } catch { /* Server persistence still works when local storage is unavailable. */ }
  }

  async save(repoId: string, sessionId: string, draft: DraftContent) {
    const key = this.key(repoId, sessionId);
    this.remember(repoId, sessionId, draft);
    const previous = this.pending.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (!this.revisions.has(key)) this.seed(repoId, sessionId, (await this.read(repoId, sessionId)).draft);
      const result = await this.write(repoId, sessionId, draft, this.revisions.get(key)!);
      this.revisions.set(key, result.draft.revision ?? 0);
      const local = this.recover(repoId, sessionId);
      if (local && JSON.stringify([local.input, local.attachments]) === JSON.stringify([draft.input, draft.attachments])) {
        try { this.storage.removeItem(key); } catch { /* Best effort local cleanup. */ }
      } else if (local) {
        this.remember(repoId, sessionId, local);
      }
      return result;
    });
    this.pending.set(key, next);
    try { return await next; }
    finally { if (this.pending.get(key) === next) this.pending.delete(key); }
  }

  async drain(repoId: string, sessionId: string) { await this.pending.get(this.key(repoId, sessionId)); }

  accept(repoId: string, sessionId: string, draft: DraftContent) {
    this.revisions.set(this.key(repoId, sessionId), draft.revision ?? 0);
  }
}
