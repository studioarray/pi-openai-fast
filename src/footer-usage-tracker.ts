export interface FooterUsage {
  input?: number | undefined;
  output?: number | undefined;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
  cost?: { total?: number | undefined } | undefined;
}

export interface FooterUsageMessage {
  role?: string | undefined;
  usage?: FooterUsage | undefined;
}

export interface FooterUsageEntry {
  type: string;
  message?: FooterUsageMessage | undefined;
}

export interface FooterUsageSessionManager {
  getEntries(): readonly FooterUsageEntry[];
}

export interface FooterUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface FooterUsageSnapshot {
  totals: FooterUsageTotals;
}

function emptyTotals(): FooterUsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function numberOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addUsage(totals: FooterUsageTotals, usage: FooterUsage | undefined): void {
  totals.input += numberOrZero(usage?.input);
  totals.output += numberOrZero(usage?.output);
  totals.cacheRead += numberOrZero(usage?.cacheRead);
  totals.cacheWrite += numberOrZero(usage?.cacheWrite);
  totals.cost += numberOrZero(usage?.cost?.total);
}

function addEntry(snapshot: FooterUsageSnapshot, entry: FooterUsageEntry): void {
  if (entry.type !== "message" || entry.message?.role !== "assistant") return;
  addUsage(snapshot.totals, entry.message.usage);
}

/**
 * Maintains the footer's cumulative usage outside the render path.
 *
 * A session is scanned once when it becomes active. Lifecycle events then add
 * newly completed entries or reconcile once after an agent run, so repeated
 * renders read O(1) cached state without allocating a fresh entries array.
 */
export class FooterUsageTracker {
  private sessionManager: FooterUsageSessionManager | undefined;
  private current: FooterUsageSnapshot = { totals: emptyTotals() };

  reset(sessionManager: FooterUsageSessionManager): FooterUsageSnapshot {
    const snapshot: FooterUsageSnapshot = { totals: emptyTotals() };
    for (const entry of sessionManager.getEntries()) addEntry(snapshot, entry);
    this.sessionManager = sessionManager;
    this.current = snapshot;
    return snapshot;
  }

  snapshot(sessionManager: FooterUsageSessionManager): FooterUsageSnapshot {
    return this.sessionManager === sessionManager ? this.current : this.reset(sessionManager);
  }

  recordMessage(sessionManager: FooterUsageSessionManager, message: FooterUsageMessage): void {
    if (this.sessionManager !== sessionManager) this.reset(sessionManager);
    addEntry(this.current, { type: "message", message });
  }

  clear(): void {
    this.sessionManager = undefined;
    this.current = { totals: emptyTotals() };
  }
}
