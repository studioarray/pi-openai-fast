import assert from "node:assert/strict";
import { test } from "node:test";
import { FooterUsageTracker } from "../src/footer-usage-tracker.ts";

function assistant(usage) {
  return { type: "message", message: { role: "assistant", usage } };
}

function manager(entries, calls) {
  return {
    getEntries() {
      calls.value += 1;
      return entries;
    },
  };
}

test("tracker scans once and serves unchanged snapshots without getEntries calls", () => {
  const calls = { value: 0 };
  const entries = [assistant({ input: 100, output: 20, cacheRead: 50, cacheWrite: 50, cost: { total: 0.1 } })];
  const sessionManager = manager(entries, calls);
  const tracker = new FooterUsageTracker();

  const first = tracker.snapshot(sessionManager);
  for (let index = 0; index < 500; index += 1) {
    assert.equal(tracker.snapshot(sessionManager), first);
  }

  assert.equal(calls.value, 1);
  assert.deepEqual(first.totals, { input: 100, output: 20, cacheRead: 50, cacheWrite: 50, cost: 0.1 });
});

test("assistant message events update totals incrementally while other roles are ignored", () => {
  const calls = { value: 0 };
  const sessionManager = manager([], calls);
  const tracker = new FooterUsageTracker();
  tracker.reset(sessionManager);

  tracker.recordMessage(sessionManager, {
    role: "assistant",
    usage: { input: 200, output: 30, cacheRead: 100, cacheWrite: 100, cost: { total: 0.2 } },
  });
  tracker.recordMessage(sessionManager, {
    role: "toolResult",
    usage: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999, cost: { total: 9.99 } },
  });

  const snapshot = tracker.snapshot(sessionManager);
  assert.equal(calls.value, 1);
  assert.deepEqual(snapshot.totals, { input: 200, output: 30, cacheRead: 100, cacheWrite: 100, cost: 0.2 });
});

test("agent-end reconciliation replaces incremental state with persisted session truth", () => {
  const calls = { value: 0 };
  const entries = [];
  const sessionManager = manager(entries, calls);
  const tracker = new FooterUsageTracker();
  tracker.reset(sessionManager);
  tracker.recordMessage(sessionManager, {
    role: "assistant",
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } },
  });

  entries.push(assistant({ input: 120, output: 12, cacheRead: 0, cacheWrite: 0, cost: { total: 0.12 } }));
  const reconciled = tracker.reset(sessionManager);

  assert.equal(calls.value, 2);
  assert.deepEqual(reconciled.totals, { input: 120, output: 12, cacheRead: 0, cacheWrite: 0, cost: 0.12 });
});

test("manager identity changes trigger a fresh scan", () => {
  const firstCalls = { value: 0 };
  const secondCalls = { value: 0 };
  const first = manager([assistant({ input: 1 })], firstCalls);
  const second = manager([assistant({ input: 2 })], secondCalls);
  const tracker = new FooterUsageTracker();

  assert.equal(tracker.snapshot(first).totals.input, 1);
  assert.equal(tracker.snapshot(second).totals.input, 2);
  assert.equal(firstCalls.value, 1);
  assert.equal(secondCalls.value, 1);
});
