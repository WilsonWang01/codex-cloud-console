export type ConversationStream = {
  signal: AbortSignal;
  isCurrent: () => boolean;
  finish: () => boolean;
};

// Owns the visible subscription, not the remote task. Aborting only disconnects HTTP.
export class ConversationStreamScope {
  private controller: AbortController | null = null;

  get active() { return this.controller !== null; }

  detach() {
    const previous = this.controller;
    this.controller = null;
    previous?.abort();
    return Boolean(previous);
  }

  begin(): ConversationStream {
    this.detach();
    const controller = new AbortController();
    this.controller = controller;
    return {
      signal: controller.signal,
      isCurrent: () => this.controller === controller,
      finish: () => {
        if (this.controller !== controller) return false;
        this.detach();
        return true;
      },
    };
  }
}
