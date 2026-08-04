import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FooterClone } from "../src/footer-clone.ts";
import { FastLabelFormatter } from "../src/fast-label-formatter.ts";
import { FooterUsageTracker } from "../src/footer-usage-tracker.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ANSI = {
  dim: "\x1b[38;5;8m",
  error: "\x1b[31m",
  warning: "\x1b[33m",
};

const THINKING_ANSI = {
  minimal: "\x1b[38;5;69m",
  low: "\x1b[38;5;75m",
  medium: "\x1b[38;5;111m",
  high: "\x1b[38;5;147m",
  xhigh: "\x1b[38;5;183m",
};

function createTheme(options = {}) {
  const theme = {
    fg(color, text) {
      return `${ANSI[color] ?? ""}${text}\x1b[39m`;
    },
  };

  if (options.name !== undefined) {
    theme.name = options.name;
  }

  if (options.withThinkingBorder !== false) {
    theme.getThinkingBorderColor = (level) => {
      options.thinkingLevels?.push(level);
      return (text) => `${THINKING_ANSI[level] ?? ""}${text}\x1b[39m`;
    };
  }

  return theme;
}

function createFooterData(overrides = {}) {
  return {
    getGitBranch: () => "main",
    getAvailableProviderCount: () => 2,
    getExtensionStatuses: () =>
      new Map([
        ["zeta", "zeta\nstatus"],
        ["alpha", "alpha\tstatus"],
      ]),
    onBranchChange: undefined,
    ...overrides,
  };
}

function assistantEntry(usage) {
  return {
    type: "message",
    message: {
      role: "assistant",
      usage: {
        input: 1500,
        output: 20_000,
        cacheRead: 300,
        cacheWrite: 40_000,
        cost: { total: 0.1234 },
        ...usage,
      },
    },
  };
}

function createContext(overrides = {}) {
  const model = overrides.model ?? {
    provider: "openai",
    id: "gpt-5.5",
    reasoning: true,
    contextWindow: 200_000,
  };

  return {
    model,
    sessionManager: {
      getCwd: () => "/Users/alice/project",
      getSessionName: () => "demo-session",
      getEntries: () => [
        assistantEntry(),
        assistantEntry({ input: 500, output: 1000, cacheRead: 200, cacheWrite: 0, cost: { total: 0.001 } }),
      ],
    },
    modelRegistry: {
      isUsingOAuth: () => true,
    },
    getContextUsage: () => ({ percent: 75.234, contextWindow: 200_000 }),
    ...overrides,
  };
}

function createClone({
  active = false,
  context = createContext(),
  footerData = createFooterData(),
  theme = createTheme(),
  thinkingLevel = "xhigh",
  getThinkingLevel,
  fastLabelColors,
  usageTracker,
} = {}) {
  return new FooterClone({
    context,
    footerData,
    theme,
    labelFormatter: new FastLabelFormatter(),
    isFastActive: () => active,
    getThinkingLevel: getThinkingLevel ?? (() => thinkingLevel),
    fastLabelColors,
    usageTracker,
  });
}

test("dispose marks clone as no longer owned", () => {
  const clone = createClone();

  assert.equal(clone.isOwnedByExtension(), true);
  clone.dispose();
  assert.equal(clone.isOwnedByExtension(), false);
});

test("branch change subscription is disposed when footer clone unmounts", () => {
  const listeners = [];
  const renderRequests = { value: 0 };
  const footerData = createFooterData({
    onBranchChange: (listener) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    },
  });

  const clone = new FooterClone({
    context: createContext(),
    footerData,
    theme: createTheme(),
    labelFormatter: new FastLabelFormatter(),
    isFastActive: () => false,
    getThinkingLevel: () => "xhigh",
    tui: {
      requestRender() {
        renderRequests.value += 1;
      },
    },
  });

  assert.equal(listeners.length, 1);
  listeners.at(0)();
  assert.equal(renderRequests.value, 1);

  clone.dispose();
  listeners.forEach((listener) => listener());
  assert.equal(renderRequests.value, 1);
});

test("repeated renders reuse event-driven usage without rescanning session entries", () => {
  let inspectedEntries = 0;
  let getEntriesCalls = 0;
  const countedAssistantEntry = (usage) => ({
    get type() {
      inspectedEntries += 1;
      return "message";
    },
    message: { role: "assistant", usage },
  });
  const entries = [
    countedAssistantEntry({ input: 1000, output: 2000, cost: { total: 0.01 } }),
    countedAssistantEntry({ input: 500, output: 250, cost: { total: 0.02 } }),
  ];
  const context = createContext({
    sessionManager: {
      getCwd: () => "/Users/alice/project",
      getSessionName: () => "cache-test",
      getEntries: () => {
        getEntriesCalls += 1;
        return entries;
      },
    },
  });
  const usageTracker = new FooterUsageTracker();
  const clone = createClone({ context, usageTracker });

  const first = clone.render(120).join("\n");
  assert.equal(getEntriesCalls, 1);
  assert.equal(inspectedEntries, 2);
  assert.match(first, /↑1\.5k/);
  assert.match(first, /↓2\.3k/);
  assert.match(first, /\$0\.030/);

  const second = clone.render(80).join("\n");
  assert.equal(getEntriesCalls, 1);
  assert.equal(inspectedEntries, 2);
  assert.match(second, /↑1\.5k/);

  entries.push(countedAssistantEntry({ input: 500, output: 750, cost: { total: 0.04 } }));
  usageTracker.reset(context.sessionManager);
  const third = clone.render(120).join("\n");
  assert.equal(getEntriesCalls, 2);
  assert.equal(inspectedEntries, 5);
  assert.match(third, /↑2\.0k/);
  assert.match(third, /↓3\.0k/);
  assert.match(third, /\$0\.070/);
});

test("message lifecycle updates usage without rescanning session entries", () => {
  let getEntriesCalls = 0;
  const entries = [assistantEntry({ input: 1000, output: 2000, cost: { total: 0.01 } })];
  const sessionManager = {
    getCwd: () => "/Users/alice/project",
    getSessionName: () => "event-cache-test",
    getEntries: () => {
      getEntriesCalls += 1;
      return entries;
    },
  };
  const usageTracker = new FooterUsageTracker();
  const clone = createClone({ context: createContext({ sessionManager }), usageTracker });

  for (let index = 0; index < 500; index += 1) clone.render(120);
  assert.equal(getEntriesCalls, 1);

  usageTracker.recordMessage(sessionManager, assistantEntry({
    input: 500,
    output: 250,
    cost: { total: 0.02 },
  }).message);
  const changed = clone.render(120).join("\n");
  assert.equal(getEntriesCalls, 1);
  assert.match(changed, /↑1\.5k/);
  assert.match(changed, /↓2\.3k/);
  assert.match(changed, /\$0\.030/);
});

test("event-driven usage cache remains scoped to the session manager identity", () => {
  let firstCalls = 0;
  let secondCalls = 0;
  const manager = (input, count) => ({
    getCwd: () => "/Users/alice/project",
    getSessionName: () => "manager-identity-test",
    getEntries: () => {
      count.value += 1;
      return [assistantEntry(input)];
    },
  });
  const firstCount = { get value() { return firstCalls; }, set value(value) { firstCalls = value; } };
  const secondCount = { get value() { return secondCalls; }, set value(value) { secondCalls = value; } };
  let context = createContext({ sessionManager: manager({ input: 1000 }, firstCount) });
  const clone = new FooterClone({
    getContext: () => context,
    footerData: createFooterData(),
    theme: createTheme(),
    labelFormatter: new FastLabelFormatter(),
    isFastActive: () => false,
    getThinkingLevel: () => "xhigh",
  });

  clone.render(120);
  context = createContext({ sessionManager: manager({ input: 2000 }, secondCount) });
  const second = clone.render(120).join("\n");
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 1);
  assert.match(second, /↑2\.0k/);
});

test("inactive clone preserves Pi default footer information without a fast label", () => {
  const originalHome = process.env.HOME;
  process.env.HOME = "/Users/alice";
  try {
    const lines = createClone({ active: false }).render(120);
    const output = lines.join("\n");

    assert.equal(lines.length, 3);
    assert.match(lines[0], /~\/project \(main\) • demo-session/);
    assert.match(output, /↑2\.0k/);
    assert.match(output, /↓21k/);
    assert.match(output, /R500/);
    assert.match(output, /W40k/);
    assert.match(output, /\$0\.124 \(sub\)/);
    assert.match(output, /75\.2%\/200k \(auto\)/);
    assert.match(output, /\(openai\) gpt-5\.5 • xhigh/);
    assert.match(output, /alpha status zeta status/);
    assert.doesNotMatch(output, /gpt-5\.5 fast/);
    assert.equal(lines.every((line) => visibleWidth(line) <= 120), true);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

test("active clone inserts the fast label after the model name before thinking level", () => {
  const lines = createClone({ active: true }).render(120);
  const output = lines.join("\n");

  assert.match(output, /\(openai\) gpt-5\.5 .*fast/);
  assert.doesNotMatch(output, /fast • gpt-5\.5/);
  assert.equal(lines.every((line) => visibleWidth(line) <= 120), true);
});

test("active clone with no configured fast label color uses the current thinking-border color", () => {
  const thinkingLevels = [];
  let thinkingLevel = "low";
  const clone = createClone({
    active: true,
    theme: createTheme({ thinkingLevels }),
    getThinkingLevel: () => thinkingLevel,
  });

  const lowLine = clone.render(120)[1] ?? "";
  thinkingLevel = "high";
  const highLine = clone.render(120)[1] ?? "";

  assert.deepEqual(thinkingLevels, ["low", "high"]);
  assert.match(lowLine, /gpt-5\.5 .*\x1b\[38;5;75mfast\x1b\[39m\x1b\[38;5;8m • low/);
  assert.match(highLine, /gpt-5\.5 .*\x1b\[38;5;147mfast\x1b\[39m\x1b\[38;5;8m • high/);
  assert.equal(visibleWidth("\x1b[38;5;75mfast\x1b[39m"), 4);
});

test("active clone sends each non-off thinking level to the thinking-border renderer", () => {
  const thinkingLevels = [];
  const theme = createTheme({ thinkingLevels });

  for (const thinkingLevel of ["minimal", "low", "medium", "high", "xhigh"]) {
    const statsLine = createClone({ active: true, theme, thinkingLevel }).render(120)[1] ?? "";
    assert.match(statsLine, new RegExp(`fast\\x1b\\[39m\\x1b\\[38;5;8m • ${thinkingLevel}`));
  }

  assert.deepEqual(thinkingLevels, ["minimal", "low", "medium", "high", "xhigh"]);
});

test("theme-derived active fast label preserves surrounding footer sections", () => {
  const originalHome = process.env.HOME;
  process.env.HOME = "/Users/alice";
  try {
    const thinkingLevels = [];
    const lines = createClone({ active: true, theme: createTheme({ thinkingLevels }), thinkingLevel: "high" }).render(120);
    const output = lines.join("\n");

    assert.equal(lines.length, 3);
    assert.match(lines[0], /~\/project \(main\) • demo-session/);
    assert.match(output, /↑2\.0k/);
    assert.match(output, /↓21k/);
    assert.match(output, /R500/);
    assert.match(output, /W40k/);
    assert.match(output, /\$0\.124 \(sub\)/);
    assert.match(output, /75\.2%\/200k \(auto\)/);
    assert.match(output, /\(openai\) gpt-5\.5 .*\x1b\[38;5;147mfast\x1b\[39m\x1b\[38;5;8m • high/);
    assert.match(output, /alpha status zeta status/);
    assert.deepEqual(thinkingLevels, ["high"]);
    assert.equal(lines.every((line) => visibleWidth(line) <= 120), true);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

test("active clone falls back to dim fast label for off, missing, unexpected, or unsupported thinking theme", () => {
  const thinkingLevels = [];
  const theme = createTheme({ thinkingLevels });

  for (const getThinkingLevel of [() => "off", () => undefined, () => "surprise"]) {
    const statsLine = createClone({ active: true, theme, getThinkingLevel }).render(120)[1] ?? "";
    assert.match(statsLine, /gpt-5\.5 .*\x1b\[38;5;8mfast\x1b\[39m\x1b\[38;5;8m • thinking off/);
    assert.doesNotMatch(statsLine, /\x1b\[38;5;205mfast|\x1b\[38;5;160mfast/);
  }

  const noThemeApiLine = createClone({
    active: true,
    theme: createTheme({ withThinkingBorder: false }),
    thinkingLevel: "high",
  }).render(120)[1] ?? "";

  assert.deepEqual(thinkingLevels, []);
  assert.match(noThemeApiLine, /gpt-5\.5 .*\x1b\[38;5;8mfast\x1b\[39m\x1b\[38;5;8m • high/);
  assert.equal(visibleWidth(noThemeApiLine) <= 120, true);
});

test("active clone reapplies dim styling after a configured colored fast label", () => {
  const lines = createClone({ active: true, fastLabelColors: { dark: "#112233", vars: {} } }).render(120);
  const statsLine = lines[1] ?? "";

  assert.match(statsLine, /\x1b\[38;5;17mfast\x1b\[39m\x1b\[38;5;8m • xhigh/);
});

test("explicit active-theme fast label color overrides the thinking-border renderer", () => {
  const thinkingLevels = [];
  const lightLine = createClone({
    active: true,
    theme: createTheme({ name: "light", thinkingLevels }),
    thinkingLevel: "high",
    fastLabelColors: { dark: "#112233", light: "#445566", vars: {} },
  }).render(120)[1] ?? "";
  const darkLine = createClone({
    active: true,
    theme: createTheme({ name: "dark", thinkingLevels }),
    thinkingLevel: "high",
    fastLabelColors: { dark: "#112233", light: "#445566", vars: {} },
  }).render(120)[1] ?? "";

  assert.match(lightLine, /\x1b\[38;5;59mfast\x1b\[39m\x1b\[38;5;8m • high/);
  assert.match(darkLine, /\x1b\[38;5;17mfast\x1b\[39m\x1b\[38;5;8m • high/);
  assert.deepEqual(thinkingLevels, []);
});

test("missing active-theme fast label override falls back to the theme-matched renderer instead of the sibling field", () => {
  const thinkingLevels = [];
  const lightLine = createClone({
    active: true,
    theme: createTheme({ name: "light", thinkingLevels }),
    thinkingLevel: "high",
    fastLabelColors: { dark: "#112233", vars: {} },
  }).render(120)[1] ?? "";
  const nonLightLine = createClone({
    active: true,
    theme: createTheme({ name: "nocturne", thinkingLevels }),
    thinkingLevel: "low",
    fastLabelColors: { light: "#445566", vars: {} },
  }).render(120)[1] ?? "";

  assert.match(lightLine, /\x1b\[38;5;147mfast\x1b\[39m\x1b\[38;5;8m • high/);
  assert.doesNotMatch(lightLine, /\x1b\[38;5;17mfast/);
  assert.match(nonLightLine, /\x1b\[38;5;75mfast\x1b\[39m\x1b\[38;5;8m • low/);
  assert.doesNotMatch(nonLightLine, /\x1b\[38;5;59mfast/);
  assert.deepEqual(thinkingLevels, ["high", "low"]);
});

test("ANSI fast label color preserves visible width-based truncation", () => {
  const context = createContext({ model: { provider: "openai", id: "gpt-5.5", reasoning: false, contextWindow: 200_000 } });
  const footerData = createFooterData({
    getExtensionStatuses: () =>
      new Map([
        ["zeta", "zeta status extension"],
        ["alpha", "alpha status extension"],
        ["omega", "omega status extension with extra text"],
      ]),
  });

  const lines = createClone({ active: true, context, footerData, fastLabelColors: { dark: "#112233", vars: {} } }).render(72);
  const renderLine = lines[1] ?? "";

  assert.match(renderLine, /\x1b\[38;5;8m.*\x1b\[38;5;17mfast\x1b\[39m/);
  assert.equal(visibleWidth(renderLine) <= 72, true);
  assert.equal(visibleWidth(lines[2]) <= 72, true);
});

test("clone truncates every rendered line to the terminal width", () => {
  const lines = createClone({ active: true }).render(32);

  assert.equal(lines.length, 3);
  assert.equal(lines.every((line) => visibleWidth(line) <= 32), true);
});

test("clone renders safely at very narrow widths", () => {
  const lines = createClone({ active: true }).render(1);

  assert.equal(lines.every((line) => visibleWidth(line) <= 1), true);
});

test("unknown context percentage renders safely after compaction", () => {
  const context = createContext({ getContextUsage: () => ({ percent: null, contextWindow: 200_000 }) });
  const lines = createClone({ context }).render(120);

  assert.match(lines.join("\n"), /\?\/200k \(auto\)/);
});

test("footer clone source pins Pi default footer source and retains MIT attribution", async () => {
  const source = await readFile(resolve(repoRoot, "src", "footer-clone.ts"), "utf8");

  assert.match(source, /@earendil-works\/pi-coding-agent v0\.75\.3/);
  assert.match(source, /144b93861f339ce353531f6873d377a1e4b2f5c4/);
  assert.match(source, /packages\/coding-agent\/src\/modes\/interactive\/components\/footer\.ts/);
  assert.match(source, /MIT License/);
  assert.match(source, /Copyright \(c\) 2025 Mario Zechner/);
});
