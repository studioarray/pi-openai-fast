import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { FAST_STATUS_KEY } from "../src/capabilities.ts";
import { FAST_COMMAND_SAVE_FAILED_MESSAGE } from "../src/fast-command.ts";
import { FastConfigStore } from "../src/fast-config-store.ts";
import { FAST_DESIRED_HANDOFF_ENV } from "../src/fast-desired-handoff.ts";
import { registerPiOpenAIFast } from "../src/extension-lifecycle.ts";

const ANSI = {
  dim: "\x1b[38;5;8m",
  error: "\x1b[31m",
  warning: "\x1b[33m",
};

const THINKING_ANSI = {
  low: "\x1b[38;5;75m",
  high: "\x1b[38;5;147m",
};

async function tempHome() {
  return await mkdtemp(join(tmpdir(), "pi-openai-fast-lifecycle-"));
}

function createTheme(options = {}) {
  const theme = {
    fg(color, text) {
      return `${ANSI[color] ?? ""}${text}\x1b[39m`;
    },
  };

  if (options.thinkingLevels) {
    theme.getThinkingBorderColor = (level) => {
      options.thinkingLevels.push(level);
      return (text) => `${THINKING_ANSI[level] ?? ""}${text}\x1b[39m`;
    };
  }

  return theme;
}

class MemoryConfigStore {
  constructor(config, options = {}) {
    this.config = config;
    this.desiredActiveWriteResult = options.desiredActiveWriteResult ?? true;
    this.loadWarnings = options.loadWarnings ?? [];
    this.writeWarnings = options.writeWarnings ?? [];
    this.writes = [];
  }

  async load(cwd, options = {}) {
    this.lastLoadCwd = cwd;
    for (const warning of this.loadWarnings) {
      options.warn?.(warning);
    }
    return this.config;
  }

  async writeDesiredActive(cwd, desiredActive, options = {}) {
    this.writes.push({ cwd, desiredActive });
    for (const warning of this.writeWarnings) {
      options.warn?.(warning);
    }
    return this.desiredActiveWriteResult;
  }
}

class DelayedConfigStore extends MemoryConfigStore {
  constructor(config, options = {}) {
    super(config, options);
    this.loadCalls = [];
    this.loadGate = new Promise((resolve) => {
      this.resolveLoad = resolve;
    });
  }

  async load(cwd, options = {}) {
    this.loadCalls.push({ cwd });
    await this.loadGate;
    return await super.load(cwd, options);
  }
}

function model(provider, id) {
  return { provider, id };
}

function createContext(options = {}) {
  const cwd = options.cwd ?? "/work/repo";
  const currentModel = Object.hasOwn(options, "currentModel") ? options.currentModel : model("partner", "gpt-5.5");
  const notifications = [];
  const footer = {
    setFooterCalls: [],
    component: undefined,
    renderRequests: 0,
  };
  const footerData = {
    getGitBranch: () => options.gitBranch ?? null,
    getAvailableProviderCount: () => options.availableProviderCount ?? 1,
    getExtensionStatuses: () => new Map(Object.entries(options.extensionStatuses ?? {})),
  };
  const statusByKey = new Map(Object.entries(options.statuses ?? {}));
  const statusCalls = [];

  const tui = {
    requestRender() {
      footer.renderRequests += 1;
    },
  };
  const ui = {
    ...(options.hasNotify === false
      ? {}
      : {
          notify(message, type) {
            if (options.notifyThrows) {
              throw new Error("notification failed");
            }
            notifications.push({ message, type });
          },
        }),
  };

  if (options.captureStatus !== false) {
    ui.setStatus = (key, text) => {
      statusCalls.push({ key, text });
      if (text === undefined) {
        statusByKey.delete(key);
        return;
      }

      statusByKey.set(key, text);
    };
  }

  if (options.captureFooter) {
    ui.setFooter = (factory) => {
      footer.setFooterCalls.push(factory);
      footer.component = factory === undefined ? undefined : factory(tui, options.theme ?? createTheme(), footerData);
    };
  }

  return {
    ctx: {
      cwd,
      hasUI: true,
      model: currentModel,
      sessionManager: {
        getCwd: () => cwd,
        getSessionName: () => options.sessionName,
        getEntries: () => options.entries ?? [],
      },
      modelRegistry: {
        isUsingOAuth: () => options.usingSubscription === true,
      },
      getContextUsage: () => options.contextUsage ?? { percent: 10, contextWindow: currentModel?.contextWindow ?? 200_000 },
      ui,
    },
    footer,
    notifications,
    statusByKey,
    statusCalls,
  };
}

function createHarness(config, options = {}) {
  const commands = new Map();
  const handlers = new Map();
  const flags = new Map();
  const flagValues = new Map(Object.entries(options.flags ?? {}));
  const configStore =
    options.configStore ??
    new MemoryConfigStore(config, {
      desiredActiveWriteResult: options.desiredActiveWriteResult,
      loadWarnings: options.loadWarnings,
      writeWarnings: options.writeWarnings,
    });
  const pi = {
    registerCommand(name, options) {
      commands.set(name, options);
    },
    registerFlag(name, options) {
      flags.set(name, options);
      if (options.default !== undefined && !flagValues.has(name)) {
        flagValues.set(name, options.default);
      }
    },
    getFlag(name) {
      return flags.has(name) ? flagValues.get(name) : undefined;
    },
    getThinkingLevel() {
      const thinkingLevel = typeof options.thinkingLevel === "function" ? options.thinkingLevel() : options.thinkingLevel;
      return thinkingLevel ?? "off";
    },
    on(event, handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  };

  registerPiOpenAIFast(pi, { configStore, footerUsageTracker: options.footerUsageTracker });

  return { commands, handlers, flags, flagValues, configStore };
}

async function emit(harness, eventName, event, ctx) {
  const results = [];
  for (const handler of harness.handlers.get(eventName) ?? []) {
    results.push(await handler(event, ctx));
  }
  return results;
}

let inheritedFastDesiredHandoffEnv;

beforeEach(() => {
  inheritedFastDesiredHandoffEnv = process.env[FAST_DESIRED_HANDOFF_ENV];
  delete process.env[FAST_DESIRED_HANDOFF_ENV];
});

afterEach(() => {
  if (inheritedFastDesiredHandoffEnv === undefined) {
    delete process.env[FAST_DESIRED_HANDOFF_ENV];
  } else {
    process.env[FAST_DESIRED_HANDOFF_ENV] = inheritedFastDesiredHandoffEnv;
  }
});

async function withFastDesiredHandoffEnv(value, run) {
  const previous = process.env[FAST_DESIRED_HANDOFF_ENV];

  if (value === undefined) {
    delete process.env[FAST_DESIRED_HANDOFF_ENV];
  } else {
    process.env[FAST_DESIRED_HANDOFF_ENV] = value;
  }

  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env[FAST_DESIRED_HANDOFF_ENV];
    } else {
      process.env[FAST_DESIRED_HANDOFF_ENV] = previous;
    }
  }
}

async function captureConsoleWarnings(run) {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => {
    warnings.push(String(message));
  };

  try {
    await run();
  } finally {
    console.warn = originalWarn;
  }

  return warnings;
}

test("lifecycle registers --fast as a boolean startup flag", () => {
  const harness = createHarness({
    persistState: true,
    desiredActive: false,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
  });

  const flag = harness.flags.get("fast");
  assert.equal(flag?.type, "boolean");
  assert.equal(flag?.default, false);
  assert.equal(harness.flagValues.get("fast"), false);
});

test("lifecycle keeps settings JSON-only by not registering an interactive settings command", () => {
  const harness = createHarness({
    persistState: true,
    desiredActive: false,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
  });

  assert.equal(harness.commands.has("fast"), true);
  assert.equal(harness.commands.has("openai-fast-settings"), false);
});

test("lifecycle maintains footer usage outside the render path", async () => {
  const calls = [];
  const footerUsageTracker = {
    reset(sessionManager) {
      calls.push(["reset", sessionManager]);
    },
    recordMessage(sessionManager, message) {
      calls.push(["message", sessionManager, message]);
    },
    clear() {
      calls.push(["clear"]);
    },
  };
  const harness = createHarness(
    {
      persistState: true,
      desiredActive: false,
      supportedModels: ["partner/gpt-5.5"],
      footer: { mode: "replace", vars: {} },
    },
    { footerUsageTracker },
  );
  const { ctx } = createContext({
    currentModel: { provider: "partner", id: "gpt-5.5", reasoning: true, contextWindow: 200_000 },
  });
  const message = { role: "assistant", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } };

  await emit(harness, "session_start", { type: "session_start" }, ctx);
  await emit(harness, "message_end", { type: "message_end", message }, ctx);
  await emit(harness, "agent_end", { type: "agent_end", messages: [message] }, ctx);
  await emit(harness, "session_shutdown", { type: "session_shutdown" }, ctx);

  assert.deepEqual(calls, [
    ["reset", ctx.sessionManager],
    ["message", ctx.sessionManager, message],
    ["reset", ctx.sessionManager],
    ["clear"],
  ]);
});

test("status and off modes do not scan session entries for replacement-footer usage", async () => {
  for (const mode of ["status", "off"]) {
    const calls = [];
    const footerUsageTracker = {
      reset() { calls.push("reset"); },
      recordMessage() { calls.push("message"); },
      clear() { calls.push("clear"); },
    };
    const harness = createHarness(
      {
        persistState: true,
        desiredActive: false,
        supportedModels: ["partner/gpt-5.5"],
        footer: { mode, vars: {} },
      },
      { footerUsageTracker },
    );
    const { ctx } = createContext({
      currentModel: { provider: "partner", id: "gpt-5.5", reasoning: true, contextWindow: 200_000 },
    });

    await emit(harness, "session_start", { type: "session_start" }, ctx);
    await emit(harness, "message_end", { type: "message_end", message: { role: "assistant" } }, ctx);
    await emit(harness, "agent_end", { type: "agent_end", messages: [] }, ctx);
    assert.deepEqual(calls, [], `${mode} mode unexpectedly maintained replacement-footer usage`);
    await emit(harness, "session_shutdown", { type: "session_shutdown" }, ctx);
    assert.deepEqual(calls, ["clear"]);
  }
});

test("replace footer clone installs on startup while inactive and updates active label without reinstall", async () => {
  const harness = createHarness(
    {
      persistState: true,
      desiredActive: false,
      supportedModels: ["partner/gpt-5.5"],
      footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
    },
    { thinkingLevel: "xhigh" },
  );
  const { ctx, footer } = createContext({
    captureFooter: true,
    currentModel: { provider: "partner", id: "gpt-5.5", reasoning: true, contextWindow: 200_000 },
  });

  await emit(harness, "session_start", { type: "session_start" }, ctx);
  const inactiveOutput = footer.component.render(100).join("\n");

  await harness.commands.get("fast").handler("", ctx);
  const activeOutput = footer.component.render(100).join("\n");

  assert.equal(footer.setFooterCalls.length, 1);
  assert.match(inactiveOutput, /gpt-5\.5 • xhigh/);
  assert.doesNotMatch(inactiveOutput, /gpt-5\.5 fast/);
  assert.match(activeOutput, /gpt-5\.5 .*fast/);
  assert.equal(footer.renderRequests > 0, true);
});

test("thinking level changes re-render the replacement footer with the current thinking-border fast label", async () => {
  let thinkingLevel = "low";
  const thinkingLevels = [];
  const harness = createHarness(
    {
      persistState: true,
      desiredActive: true,
      supportedModels: ["partner/gpt-5.5"],
      footer: { mode: "replace", vars: {} },
    },
    { thinkingLevel: () => thinkingLevel },
  );
  const { ctx, footer } = createContext({
    captureFooter: true,
    currentModel: { provider: "partner", id: "gpt-5.5", reasoning: true, contextWindow: 200_000 },
    theme: createTheme({ thinkingLevels }),
  });

  await emit(harness, "session_start", { type: "session_start" }, ctx);
  const lowOutput = footer.component.render(100).join("\n");

  thinkingLevel = "high";
  await emit(harness, "thinking_level_select", { type: "thinking_level_select" }, ctx);
  const highOutput = footer.component.render(100).join("\n");

  assert.deepEqual(thinkingLevels, ["low", "high"]);
  assert.match(lowOutput, /gpt-5\.5 .*\x1b\[38;5;75mfast\x1b\[39m\x1b\[38;5;8m • low/);
  assert.match(highOutput, /gpt-5\.5 .*\x1b\[38;5;147mfast\x1b\[39m\x1b\[38;5;8m • high/);
  assert.equal(footer.setFooterCalls.length, 1);
  assert.equal(footer.renderRequests > 0, true);
});

test("lifecycle threads valid custom fast label color config into the replacement footer", async () => {
  const thinkingLevels = [];
  const harness = createHarness(
    {
      persistState: true,
      desiredActive: true,
      supportedModels: ["partner/gpt-5.5"],
      footer: { mode: "replace", vars: { brand: "#112233" }, darkFastColor: "brand" },
    },
    { thinkingLevel: "high" },
  );
  const { ctx, footer } = createContext({
    captureFooter: true,
    currentModel: { provider: "partner", id: "gpt-5.5", reasoning: true, contextWindow: 200_000 },
    theme: createTheme({ thinkingLevels }),
  });

  await emit(harness, "session_start", { type: "session_start" }, ctx);
  const output = footer.component.render(100).join("\n");

  assert.match(output, /gpt-5\.5 .*\x1b\[38;5;17mfast\x1b\[39m\x1b\[38;5;8m • high/);
  assert.deepEqual(thinkingLevels, []);
});

test("lifecycle treats loaded literal legacy fast label colors as no custom override", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const configStore = new FastConfigStore({ home });
  const globalPath = configStore.paths(cwd).global;
  const thinkingLevels = [];

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await writeFile(
    globalPath,
    JSON.stringify({
      persistState: true,
      desiredActive: true,
      supportedModels: ["partner/gpt-5.5"],
      footer: {
        mode: "replace",
        darkFastColor: " #FF50BE ",
        lightFastColor: " #D20000 ",
      },
    }),
  );

  const harness = createHarness(undefined, { configStore, thinkingLevel: "high" });
  const { ctx, footer } = createContext({
    cwd,
    captureFooter: true,
    currentModel: { provider: "partner", id: "gpt-5.5", reasoning: true, contextWindow: 200_000 },
    theme: createTheme({ thinkingLevels }),
  });

  await emit(harness, "session_start", { type: "session_start" }, ctx);
  const output = footer.component.render(100).join("\n");

  assert.match(output, /gpt-5\.5 .*\x1b\[38;5;147mfast\x1b\[39m\x1b\[38;5;8m • high/);
  assert.deepEqual(thinkingLevels, ["high"]);
  assert.doesNotMatch(output, /\x1b\[38;5;205mfast/);
  assert.doesNotMatch(output, /\x1b\[38;5;160mfast/);
});

test("session startup surfaces invalid fast label color warnings through UI and uses theme fallback", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const configStore = new FastConfigStore({ home });
  const globalPath = configStore.paths(cwd).global;
  const thinkingLevels = [];

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await writeFile(
    globalPath,
    JSON.stringify({
      persistState: true,
      desiredActive: true,
      supportedModels: ["partner/gpt-5.5"],
      footer: {
        mode: "replace",
        vars: {},
        darkFastColor: "missingBrand",
      },
    }),
  );

  const harness = createHarness(undefined, { configStore, thinkingLevel: "high" });
  const { ctx, footer, notifications } = createContext({
    cwd,
    captureFooter: true,
    currentModel: { provider: "partner", id: "gpt-5.5", reasoning: true, contextWindow: 200_000 },
    theme: createTheme({ thinkingLevels }),
  });

  await emit(harness, "session_start", { type: "session_start" }, ctx);
  const output = footer.component.render(100).join("\n");

  assert.deepEqual(
    notifications.filter(({ type }) => type === "warning").map(({ message }) => message),
    [
      `Ignored invalid Fast label color footer.darkFastColor at ${globalPath}: "missingBrand" (variable "missingBrand" is not defined).`,
    ],
  );
  assert.match(output, /gpt-5\.5 .*\x1b\[38;5;147mfast\x1b\[39m\x1b\[38;5;8m • high/);
  assert.deepEqual(thinkingLevels, ["high"]);
});

test("session startup routes invalid fast label color warnings to console when UI notifications are unavailable", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const configStore = new FastConfigStore({ home });
  const globalPath = configStore.paths(cwd).global;

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await writeFile(
    globalPath,
    JSON.stringify({
      persistState: false,
      desiredActive: false,
      supportedModels: ["partner/gpt-5.5"],
      footer: {
        mode: "replace",
        darkFastColor: "not a color",
      },
    }),
  );

  const harness = createHarness(undefined, { configStore });
  const { ctx } = createContext({ cwd, hasNotify: false, currentModel: model("partner", "gpt-5.5") });

  const warnings = await captureConsoleWarnings(async () => {
    await emit(harness, "session_start", { type: "session_start" }, ctx);
  });

  assert.deepEqual(warnings, [
    `[pi-openai-fast] Ignored invalid Fast label color footer.darkFastColor at ${globalPath}: "not a color" (it is not a supported color token).`,
  ]);
});

test("session startup routes config and handoff warnings to UI once for the current operation", async () => {
  const configWarning = {
    code: "config-supported-models-dropped",
    path: "/work/repo/.pi/extensions/pi-openai-fast.json",
    message: "Dropped invalid supported model entries.",
  };
  const harness = createHarness(
    {
      persistState: false,
      desiredActive: false,
      supportedModels: ["partner/gpt-5.5"],
      footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
    },
    { loadWarnings: [configWarning, configWarning] },
  );
  const { ctx, notifications } = createContext({ currentModel: model("partner", "gpt-5.5") });

  await withFastDesiredHandoffEnv("maybe", async () => {
    await emit(harness, "session_start", { type: "session_start" }, ctx);
  });

  assert.deepEqual(
    notifications.filter(({ type }) => type === "warning").map(({ message }) => message),
    [
      "Dropped invalid supported model entries.",
      'Ignoring invalid PI_OPENAI_FAST_DESIRED value "maybe"; expected exact value 1 or 0.',
    ],
  );
});

test("session startup routes operation warnings to console when UI notifications are unavailable", async () => {
  const configWarning = {
    code: "config-supported-models-not-array",
    path: "/work/repo/.pi/extensions/pi-openai-fast.json",
    message: "Ignored non-array supportedModels.",
  };
  const harness = createHarness(
    {
      persistState: false,
      desiredActive: false,
      supportedModels: ["partner/gpt-5.5"],
      footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
    },
    { loadWarnings: [configWarning] },
  );
  const { ctx } = createContext({ hasNotify: false, currentModel: model("partner", "gpt-5.5") });

  const warnings = await captureConsoleWarnings(async () => {
    await emit(harness, "session_start", { type: "session_start" }, ctx);
  });

  assert.deepEqual(warnings, ["[pi-openai-fast] Ignored non-array supportedModels."]);
});

test("warning sink failures do not fail startup or command handling", async () => {
  const loadWarning = {
    code: "config-supported-models-all-invalid",
    path: "/work/repo/.pi/extensions/pi-openai-fast.json",
    message: "All supportedModels entries were invalid.",
  };
  const writeWarning = {
    code: "config-write-failed",
    path: "/work/repo/.pi/extensions/pi-openai-fast.json",
    message: "Could not write Fast config.",
  };
  const harness = createHarness(
    {
      persistState: true,
      desiredActive: false,
      supportedModels: ["partner/gpt-5.5"],
      footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
    },
    { desiredActiveWriteResult: false, loadWarnings: [loadWarning], writeWarnings: [writeWarning] },
  );
  const { ctx } = createContext({ notifyThrows: true, currentModel: model("partner", "gpt-5.5") });

  await assert.doesNotReject(async () => {
    await emit(harness, "session_start", { type: "session_start" }, ctx);
  });
  await assert.doesNotReject(async () => {
    await harness.commands.get("fast").handler("", ctx);
  });
});

test("concurrent startup and model selection share config IO while applying event-specific state", async () => {
  const loadWarning = {
    code: "config-read-failed",
    path: "/work/repo/.pi/extensions/pi-openai-fast.json",
    message: "Loaded fallback Fast config.",
  };
  const config = {
    persistState: true,
    desiredActive: true,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "status", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
  };
  const configStore = new DelayedConfigStore(config, { loadWarnings: [loadWarning] });
  const harness = createHarness(config, { configStore });
  const { ctx: startupCtx, notifications: startupNotifications } = createContext({
    currentModel: model("partner", "gpt-5.4"),
  });
  const {
    ctx: selectedCtx,
    notifications: selectedNotifications,
    statusByKey,
  } = createContext({ currentModel: model("partner", "gpt-5.4") });

  const startup = emit(harness, "session_start", { type: "session_start" }, startupCtx);
  assert.equal(configStore.loadCalls.length, 1);

  const modelSelection = emit(
    harness,
    "model_select",
    { type: "model_select", model: model("partner", "gpt-5.5") },
    selectedCtx,
  );
  assert.equal(configStore.loadCalls.length, 1);

  configStore.resolveLoad();
  await Promise.all([startup, modelSelection]);
  const [requestPayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    selectedCtx,
  );

  assert.deepEqual(requestPayload, { model: "gpt-5.5", service_tier: "priority" });
  assert.equal(statusByKey.get(FAST_STATUS_KEY), "fast");
  assert.equal(startupNotifications.filter(({ message }) => message === loadWarning.message).length, 1);
  assert.equal(selectedNotifications.filter(({ message }) => message === loadWarning.message).length, 1);

  await emit(harness, "model_select", { type: "model_select", model: model("partner", "gpt-5.4") }, selectedCtx);
  assert.equal(configStore.loadCalls.length, 1);
});

test("concurrent command handling shares config IO before applying command-specific state", async () => {
  const config = {
    persistState: false,
    desiredActive: false,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "status", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
  };
  const configStore = new DelayedConfigStore(config);
  const harness = createHarness(config, { configStore });
  const { ctx: startupCtx } = createContext({ currentModel: model("partner", "gpt-5.4") });
  const { ctx: commandCtx, statusByKey } = createContext({ currentModel: model("partner", "gpt-5.5") });

  const startup = emit(harness, "session_start", { type: "session_start" }, startupCtx);
  assert.equal(configStore.loadCalls.length, 1);

  const command = harness.commands.get("fast").handler("", commandCtx);
  assert.equal(configStore.loadCalls.length, 1);

  configStore.resolveLoad();
  await Promise.all([startup, command]);
  const [requestPayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    commandCtx,
  );

  assert.deepEqual(requestPayload, { model: "gpt-5.5", service_tier: "priority" });
  assert.equal(statusByKey.get(FAST_STATUS_KEY), "fast");
  assert.equal(process.env[FAST_DESIRED_HANDOFF_ENV], "1");
});

test("same-process replacement reads valid desired handoff on before non-persistent config defaults", async () => {
  const harness = createHarness({
    persistState: false,
    desiredActive: false,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
  });
  const { ctx } = createContext({ currentModel: model("partner", "gpt-5.5") });

  await emit(harness, "session_start", { type: "session_start" }, ctx);
  const [initialPayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    ctx,
  );

  await withFastDesiredHandoffEnv("1", async () => {
    await emit(harness, "session_start", { type: "session_start" }, ctx);
    const [replacementPayload] = await emit(
      harness,
      "before_provider_request",
      { type: "before_provider_request", payload: { model: "gpt-5.5" } },
      ctx,
    );

    assert.deepEqual(replacementPayload, { model: "gpt-5.5", service_tier: "priority" });
  });

  assert.equal(initialPayload, undefined);
  assert.deepEqual(harness.configStore.writes, []);
});

test("valid desired handoff on derives active state from the selected model", async () => {
  await withFastDesiredHandoffEnv("1", async () => {
    const unsupportedRun = createHarness({
      persistState: false,
      desiredActive: false,
      supportedModels: ["partner/gpt-5.5"],
      footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
    });
    const { ctx: unsupportedCtx } = createContext({ currentModel: model("partner", "gpt-5.4") });

    await emit(unsupportedRun, "session_start", { type: "session_start" }, unsupportedCtx);
    const [unsupportedPayload] = await emit(
      unsupportedRun,
      "before_provider_request",
      { type: "before_provider_request", payload: { model: "gpt-5.4" } },
      unsupportedCtx,
    );

    const absentModelRun = createHarness({
      persistState: false,
      desiredActive: false,
      supportedModels: ["partner/gpt-5.5"],
      footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
    });
    const { ctx: absentModelCtx } = createContext({ currentModel: undefined });

    await emit(absentModelRun, "session_start", { type: "session_start" }, absentModelCtx);
    const [absentPayload] = await emit(
      absentModelRun,
      "before_provider_request",
      { type: "before_provider_request", payload: { model: "gpt-5.5" } },
      absentModelCtx,
    );
    await emit(
      absentModelRun,
      "model_select",
      { type: "model_select", model: model("partner", "gpt-5.5") },
      absentModelCtx,
    );
    const [activatedPayload] = await emit(
      absentModelRun,
      "before_provider_request",
      { type: "before_provider_request", payload: { model: "gpt-5.5" } },
      absentModelCtx,
    );

    assert.equal(unsupportedPayload, undefined);
    assert.equal(absentPayload, undefined);
    assert.deepEqual(activatedPayload, { model: "gpt-5.5", service_tier: "priority" });
  });
});

test("same-process replacement reads valid desired handoff off before persisted desired-on config", async () => {
  const harness = createHarness({
    persistState: true,
    desiredActive: true,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
  });
  const { ctx } = createContext({ currentModel: model("partner", "gpt-5.5") });

  await emit(harness, "session_start", { type: "session_start" }, ctx);
  const [initialPayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    ctx,
  );

  await withFastDesiredHandoffEnv("0", async () => {
    await emit(harness, "session_start", { type: "session_start" }, ctx);
    const [replacementPayload] = await emit(
      harness,
      "before_provider_request",
      { type: "before_provider_request", payload: { model: "gpt-5.5" } },
      ctx,
    );

    assert.equal(replacementPayload, undefined);
  });

  assert.deepEqual(initialPayload, { model: "gpt-5.5", service_tier: "priority" });
  assert.deepEqual(harness.configStore.writes, []);
});

test("desired handoff on does not leak into provider payloads or replace footer while inactive", async () => {
  await withFastDesiredHandoffEnv("1", async () => {
    const harness = createHarness({
      persistState: false,
      desiredActive: false,
      supportedModels: ["partner/gpt-5.5"],
      footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
    });
    const { ctx, footer } = createContext({
      captureFooter: true,
      currentModel: model("partner", "gpt-5.4"),
    });

    await emit(harness, "session_start", { type: "session_start" }, ctx);
    const inactiveOutput = footer.component.render(100).join("\n");
    const [inactivePayload] = await emit(
      harness,
      "before_provider_request",
      { type: "before_provider_request", payload: { model: "gpt-5.4" } },
      ctx,
    );

    await emit(harness, "model_select", { type: "model_select", model: model("partner", "gpt-5.5") }, ctx);
    const activeOutput = footer.component.render(100).join("\n");
    const [activePayload] = await emit(
      harness,
      "before_provider_request",
      { type: "before_provider_request", payload: { model: "gpt-5.5" } },
      ctx,
    );

    assert.equal(inactivePayload, undefined);
    assert.doesNotMatch(inactiveOutput, /\bfast\b/);
    assert.deepEqual(activePayload, { model: "gpt-5.5", service_tier: "priority" });
    assert.match(activeOutput, /fast/);
  });
});

test("session-only /fast desired-on does not leak into provider payloads or replace footer while inactive", async () => {
  const harness = createHarness({
    persistState: false,
    desiredActive: false,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
  });
  const { ctx, footer } = createContext({
    captureFooter: true,
    currentModel: model("partner", "gpt-5.4"),
  });

  await harness.commands.get("fast").handler("", ctx);
  const inactiveOutput = footer.component.render(100).join("\n");
  const [inactivePayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.4" } },
    ctx,
  );

  await emit(harness, "model_select", { type: "model_select", model: model("partner", "gpt-5.5") }, ctx);
  const activeOutput = footer.component.render(100).join("\n");
  const [activePayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    ctx,
  );

  assert.equal(process.env[FAST_DESIRED_HANDOFF_ENV], "1");
  assert.equal(inactivePayload, undefined);
  assert.doesNotMatch(inactiveOutput, /\bfast\b/);
  assert.deepEqual(activePayload, { model: "gpt-5.5", service_tier: "priority" });
  assert.match(activeOutput, /fast/);
});

test("invalid desired handoff warns once and falls through to config-derived startup state", async () => {
  await withFastDesiredHandoffEnv("true", async () => {
    const nonPersistentRun = createHarness({
      persistState: false,
      desiredActive: false,
      supportedModels: ["partner/gpt-5.5"],
      footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
    });
    const { ctx: nonPersistentCtx, notifications: nonPersistentNotifications } = createContext({
      currentModel: model("partner", "gpt-5.5"),
    });

    await emit(nonPersistentRun, "session_start", { type: "session_start" }, nonPersistentCtx);
    const [nonPersistentPayload] = await emit(
      nonPersistentRun,
      "before_provider_request",
      { type: "before_provider_request", payload: { model: "gpt-5.5" } },
      nonPersistentCtx,
    );

    const persistedRun = createHarness({
      persistState: true,
      desiredActive: true,
      supportedModels: ["partner/gpt-5.5"],
      footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
    });
    const { ctx: persistedCtx, notifications: persistedNotifications } = createContext({
      currentModel: model("partner", "gpt-5.5"),
    });

    await emit(persistedRun, "session_start", { type: "session_start" }, persistedCtx);
    const [persistedPayload] = await emit(
      persistedRun,
      "before_provider_request",
      { type: "before_provider_request", payload: { model: "gpt-5.5" } },
      persistedCtx,
    );

    const expectedWarning = {
      message: 'Ignoring invalid PI_OPENAI_FAST_DESIRED value "true"; expected exact value 1 or 0.',
      type: "warning",
    };
    assert.equal(nonPersistentPayload, undefined);
    assert.deepEqual(persistedPayload, { model: "gpt-5.5", service_tier: "priority" });
    assert.deepEqual(nonPersistentNotifications, [expectedWarning]);
    assert.deepEqual(persistedNotifications, [expectedWarning]);
    assert.deepEqual(nonPersistentRun.configStore.writes, []);
    assert.deepEqual(persistedRun.configStore.writes, []);
  });
});

test("a fresh process without inherited desired handoff does not retain session-only Fast intent", async () => {
  await withFastDesiredHandoffEnv("1", async () => {
    const inheritedRun = createHarness({
      persistState: false,
      desiredActive: false,
      supportedModels: ["partner/gpt-5.5"],
      footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
    });
    const { ctx } = createContext({ currentModel: model("partner", "gpt-5.5") });

    await emit(inheritedRun, "session_start", { type: "session_start" }, ctx);
    const [inheritedPayload] = await emit(
      inheritedRun,
      "before_provider_request",
      { type: "before_provider_request", payload: { model: "gpt-5.5" } },
      ctx,
    );

    assert.deepEqual(inheritedPayload, { model: "gpt-5.5", service_tier: "priority" });
  });

  const freshRun = createHarness({
    persistState: false,
    desiredActive: false,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
  });
  const { ctx } = createContext({ currentModel: model("partner", "gpt-5.5") });

  await emit(freshRun, "session_start", { type: "session_start" }, ctx);
  const [freshPayload] = await emit(
    freshRun,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    ctx,
  );

  assert.equal(freshPayload, undefined);
  assert.deepEqual(freshRun.configStore.writes, []);
});

test("session-only /fast on writes desired handoff and survives same-process replacement without config writes", async () => {
  const harness = createHarness({
    persistState: false,
    desiredActive: false,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
  });
  const { ctx } = createContext({ currentModel: model("partner", "gpt-5.5") });

  await emit(harness, "session_start", { type: "session_start" }, ctx);
  await harness.commands.get("fast").handler("", ctx);
  const [activePayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    ctx,
  );
  await emit(harness, "session_start", { type: "session_start" }, ctx);
  const [replacementPayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    ctx,
  );

  assert.equal(process.env[FAST_DESIRED_HANDOFF_ENV], "1");
  assert.deepEqual(activePayload, { model: "gpt-5.5", service_tier: "priority" });
  assert.deepEqual(replacementPayload, { model: "gpt-5.5", service_tier: "priority" });
  assert.deepEqual(harness.configStore.writes, []);
});

test("session-only /fast off writes desired handoff and survives same-process replacement without config writes", async () => {
  await withFastDesiredHandoffEnv("1", async () => {
    const harness = createHarness({
      persistState: false,
      desiredActive: false,
      supportedModels: ["partner/gpt-5.5"],
      footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
    });
    const { ctx } = createContext({ currentModel: model("partner", "gpt-5.5") });

    await emit(harness, "session_start", { type: "session_start" }, ctx);
    await harness.commands.get("fast").handler("", ctx);
    const [inactivePayload] = await emit(
      harness,
      "before_provider_request",
      { type: "before_provider_request", payload: { model: "gpt-5.5" } },
      ctx,
    );
    await emit(harness, "session_start", { type: "session_start" }, ctx);
    const [replacementPayload] = await emit(
      harness,
      "before_provider_request",
      { type: "before_provider_request", payload: { model: "gpt-5.5" } },
      ctx,
    );

    assert.equal(process.env[FAST_DESIRED_HANDOFF_ENV], "0");
    assert.equal(inactivePayload, undefined);
    assert.equal(replacementPayload, undefined);
    assert.deepEqual(harness.configStore.writes, []);
  });
});

test("--fast loads persisted false as in-memory desired true without writing config", async () => {
  const harness = createHarness(
    {
      persistState: true,
      desiredActive: false,
      supportedModels: ["partner/gpt-5.5"],
      footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
    },
    { flags: { fast: true } },
  );
  const { ctx } = createContext({ currentModel: model("partner", "gpt-5.5") });

  await emit(harness, "session_start", { type: "session_start" }, ctx);
  const [requestPayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    ctx,
  );

  assert.deepEqual(requestPayload, { model: "gpt-5.5", service_tier: "priority" });
  assert.deepEqual(harness.configStore.writes, []);
});

test("--fast overrides inherited handoff off and seeds desired-on handoff without writing config", async () => {
  await withFastDesiredHandoffEnv("0", async () => {
    const harness = createHarness(
      {
        persistState: true,
        desiredActive: false,
        supportedModels: ["partner/gpt-5.5"],
        footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
      },
      { flags: { fast: true } },
    );
    const { ctx } = createContext({ currentModel: model("partner", "gpt-5.5") });

    await emit(harness, "session_start", { type: "session_start" }, ctx);
    const [requestPayload] = await emit(
      harness,
      "before_provider_request",
      { type: "before_provider_request", payload: { model: "gpt-5.5" } },
      ctx,
    );

    assert.deepEqual(requestPayload, { model: "gpt-5.5", service_tier: "priority" });
    assert.equal(process.env[FAST_DESIRED_HANDOFF_ENV], "1");
    assert.deepEqual(harness.configStore.writes, []);
  });
});

test("--fast seeds desired handoff while active state still requires a supported selected model", async () => {
  const harness = createHarness(
    {
      persistState: true,
      desiredActive: false,
      supportedModels: ["partner/gpt-5.5"],
      footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
    },
    { flags: { fast: true } },
  );
  const { ctx, notifications } = createContext({ currentModel: model("partner", "gpt-5.4") });

  await emit(harness, "session_start", { type: "session_start" }, ctx);
  const [requestPayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.4" } },
    ctx,
  );

  assert.equal(requestPayload, undefined);
  assert.equal(process.env[FAST_DESIRED_HANDOFF_ENV], "1");
  assert.deepEqual(harness.configStore.writes, []);
  assert.deepEqual(notifications, [
    {
      message: "Fast Mode is requested but inactive because the current model is not supported.",
      type: "warning",
    },
  ]);
});

test("--fast with no startup model keeps intent and activates after a supported model is selected", async () => {
  const harness = createHarness(
    {
      persistState: true,
      desiredActive: false,
      supportedModels: ["partner/gpt-5.5"],
      footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
    },
    { flags: { fast: true } },
  );
  const { ctx, notifications } = createContext({ currentModel: undefined });

  await emit(harness, "session_start", { type: "session_start" }, ctx);
  const [inactivePayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    ctx,
  );
  await emit(
    harness,
    "model_select",
    { type: "model_select", model: model("partner", "gpt-5.5") },
    ctx,
  );
  const [activePayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    ctx,
  );

  assert.equal(inactivePayload, undefined);
  assert.deepEqual(activePayload, { model: "gpt-5.5", service_tier: "priority" });
  assert.deepEqual(harness.configStore.writes, []);
  assert.deepEqual(notifications, [
    {
      message: "Fast Mode is requested but inactive because no model is selected.",
      type: "warning",
    },
  ]);
});

test("--fast seeds handoff for descendants but does not change persisted false preference", async () => {
  const persistedConfig = {
    persistState: true,
    desiredActive: false,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
  };
  const firstRun = createHarness(persistedConfig, { flags: { fast: true } });
  const { ctx: firstCtx } = createContext({ currentModel: model("partner", "gpt-5.5") });
  await emit(firstRun, "session_start", { type: "session_start" }, firstCtx);
  const [firstPayload] = await emit(
    firstRun,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    firstCtx,
  );

  const descendantRun = createHarness(persistedConfig);
  const { ctx: descendantCtx } = createContext({ currentModel: model("partner", "gpt-5.5") });
  await emit(descendantRun, "session_start", { type: "session_start" }, descendantCtx);
  const [descendantPayload] = await emit(
    descendantRun,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    descendantCtx,
  );

  await withFastDesiredHandoffEnv(undefined, async () => {
    const laterFreshRun = createHarness(persistedConfig);
    const { ctx: laterFreshCtx } = createContext({ currentModel: model("partner", "gpt-5.5") });
    await emit(laterFreshRun, "session_start", { type: "session_start" }, laterFreshCtx);
    const [laterFreshPayload] = await emit(
      laterFreshRun,
      "before_provider_request",
      { type: "before_provider_request", payload: { model: "gpt-5.5" } },
      laterFreshCtx,
    );

    assert.equal(laterFreshPayload, undefined);
    assert.deepEqual(laterFreshRun.configStore.writes, []);
  });

  assert.deepEqual(firstPayload, { model: "gpt-5.5", service_tier: "priority" });
  assert.deepEqual(descendantPayload, { model: "gpt-5.5", service_tier: "priority" });
  assert.equal(process.env[FAST_DESIRED_HANDOFF_ENV], "1");
  assert.deepEqual(firstRun.configStore.writes, []);
  assert.deepEqual(descendantRun.configStore.writes, []);
});

test("/fast warns once when requested on an unsupported model and provider requests do not repeat it", async () => {
  const harness = createHarness({
    persistState: false,
    desiredActive: false,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
  });
  const { ctx, notifications } = createContext({ currentModel: model("partner", "gpt-5.4") });

  await harness.commands.get("fast").handler("", ctx);
  await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.4" } },
    ctx,
  );
  await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.4" } },
    ctx,
  );

  assert.deepEqual(notifications, [
    {
      message: "Fast Mode is requested but inactive because the current model is not supported.",
      type: "warning",
    },
  ]);
});

test("session startup warns once when Fast Mode is requested without a selected model", async () => {
  const harness = createHarness({
    persistState: true,
    desiredActive: true,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
  });
  const { ctx, notifications } = createContext({ currentModel: undefined });

  await emit(harness, "session_start", { type: "session_start" }, ctx);
  await emit(harness, "session_start", { type: "session_start" }, ctx);
  await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    ctx,
  );

  assert.deepEqual(notifications, [
    {
      message: "Fast Mode is requested but inactive because no model is selected.",
      type: "warning",
    },
  ]);
});

test("model switches activate or deactivate requested Fast Mode without clearing intent", async () => {
  const harness = createHarness({
    persistState: true,
    desiredActive: true,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
  });
  const { ctx, notifications } = createContext({ currentModel: model("partner", "gpt-5.5") });

  await emit(harness, "session_start", { type: "session_start" }, ctx);
  const [activePayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    ctx,
  );
  assert.deepEqual(activePayload, { model: "gpt-5.5", service_tier: "priority" });

  await emit(
    harness,
    "model_select",
    { type: "model_select", model: model("partner", "gpt-5.4") },
    ctx,
  );
  const [inactivePayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.4" } },
    ctx,
  );
  assert.equal(inactivePayload, undefined);

  await emit(
    harness,
    "model_select",
    { type: "model_select", model: model("partner", "gpt-5.5") },
    ctx,
  );
  const [reactivatedPayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    ctx,
  );
  assert.deepEqual(reactivatedPayload, { model: "gpt-5.5", service_tier: "priority" });

  await emit(
    harness,
    "model_select",
    { type: "model_select", model: model("partner", "gpt-5.4") },
    ctx,
  );

  assert.deepEqual(notifications, [
    {
      message: "Fast Mode is requested but inactive because the current model is not supported.",
      type: "warning",
    },
    {
      message: "Fast Mode is requested but inactive because the current model is not supported.",
      type: "warning",
    },
  ]);
});

test("lifecycle registers /fast and injects priority for an active allow-listed non-OpenAI provider", async () => {
  const harness = createHarness({
    persistState: true,
    desiredActive: false,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
  });
  const { ctx } = createContext();

  await harness.commands.get("fast").handler("", ctx);
  const [requestPayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5", temperature: 0.2 } },
    ctx,
  );

  assert.equal(process.env[FAST_DESIRED_HANDOFF_ENV], "1");
  assert.deepEqual(harness.configStore.writes, [{ cwd: "/work/repo", desiredActive: true }]);
  assert.deepEqual(requestPayload, { model: "gpt-5.5", temperature: 0.2, service_tier: "priority" });
});

test("/fast warns when the Desired Fast State toggles but cannot be saved", async () => {
  const harness = createHarness(
    {
      persistState: true,
      desiredActive: false,
      supportedModels: ["partner/gpt-5.5"],
      footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
    },
    { desiredActiveWriteResult: false },
  );
  const { ctx, notifications } = createContext();

  await harness.commands.get("fast").handler("", ctx);
  const [requestPayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    ctx,
  );

  assert.equal(process.env[FAST_DESIRED_HANDOFF_ENV], "1");
  assert.deepEqual(harness.configStore.writes, [{ cwd: "/work/repo", desiredActive: true }]);
  assert.deepEqual(notifications, [{ message: FAST_COMMAND_SAVE_FAILED_MESSAGE, type: "warning" }]);
  assert.deepEqual(requestPayload, { model: "gpt-5.5", service_tier: "priority" });
});

test("/fast surfaces structured config write warnings through UI without duplicate save-failure warnings", async () => {
  const writeWarning = {
    code: "config-write-failed",
    path: "/work/repo/.pi/extensions/pi-openai-fast.json",
    message: "Could not write structured Fast config warning.",
  };
  const harness = createHarness(
    {
      persistState: true,
      desiredActive: false,
      supportedModels: ["partner/gpt-5.5"],
      footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
    },
    { desiredActiveWriteResult: false, writeWarnings: [writeWarning, writeWarning] },
  );
  const { ctx, notifications } = createContext();

  await harness.commands.get("fast").handler("", ctx);

  assert.deepEqual(
    notifications.filter(({ type }) => type === "warning").map(({ message }) => message),
    ["Could not write structured Fast config warning."],
  );
  assert.equal(
    notifications.some(({ message }) => message === FAST_COMMAND_SAVE_FAILED_MESSAGE),
    false,
  );
});

test("/fast routes structured config write warnings to console when UI notifications are unavailable", async () => {
  const writeWarning = {
    code: "config-malformed-write-refused",
    path: "/work/repo/.pi/extensions/pi-openai-fast.json",
    message: "Could not save until the config is manually repaired.",
  };
  const harness = createHarness(
    {
      persistState: true,
      desiredActive: false,
      supportedModels: ["partner/gpt-5.5"],
      footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
    },
    { desiredActiveWriteResult: false, writeWarnings: [writeWarning] },
  );
  const { ctx } = createContext({ hasNotify: false });

  const warnings = await captureConsoleWarnings(async () => {
    await harness.commands.get("fast").handler("", ctx);
  });

  assert.deepEqual(warnings, ["[pi-openai-fast] Could not save until the config is manually repaired."]);
});

test("status mode publishes only active fast status and never installs a custom footer", async () => {
  const harness = createHarness({
    persistState: true,
    desiredActive: false,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "status", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
  });
  const { ctx, footer, statusCalls, statusByKey } = createContext({
    captureFooter: true,
    currentModel: model("partner", "gpt-5.5"),
    statuses: { "other-extension": "busy" },
  });

  await emit(harness, "session_start", { type: "session_start" }, ctx);
  assert.deepEqual(footer.setFooterCalls, []);
  assert.deepEqual(statusCalls.at(-1), { key: FAST_STATUS_KEY, text: undefined });
  assert.equal(statusByKey.get("other-extension"), "busy");

  await harness.commands.get("fast").handler("", ctx);
  const [activePayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    ctx,
  );

  assert.deepEqual(activePayload, { model: "gpt-5.5", service_tier: "priority" });
  assert.deepEqual(statusCalls.at(-1), { key: FAST_STATUS_KEY, text: "fast" });
  assert.equal(statusByKey.get(FAST_STATUS_KEY), "fast");
  assert.equal(statusByKey.get("other-extension"), "busy");
});

test("status mode does not publish status when active fast state is false", async () => {
  const harness = createHarness({
    persistState: true,
    desiredActive: true,
    supportedModels: ["partner/gpt-5.4"],
    footer: { mode: "status", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
  });
  const { ctx, footer, statusCalls, statusByKey } = createContext({
    captureFooter: true,
    currentModel: model("partner", "gpt-5.5"),
  });

  await emit(harness, "session_start", { type: "session_start" }, ctx);
  assert.deepEqual(footer.setFooterCalls, []);
  assert.deepEqual(statusCalls.at(-1), { key: FAST_STATUS_KEY, text: undefined });
  assert.equal(statusByKey.has(FAST_STATUS_KEY), false);

  await emit(
    harness,
    "model_select",
    { type: "model_select", model: model("partner", "gpt-5.4") },
    ctx,
  );
  const [activePayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.4" } },
    ctx,
  );

  assert.deepEqual(activePayload, { model: "gpt-5.4", service_tier: "priority" });
  assert.deepEqual(statusCalls.at(-1), { key: FAST_STATUS_KEY, text: "fast" });
});

test("status mode with desired handoff on publishes fast only while active", async () => {
  await withFastDesiredHandoffEnv("1", async () => {
    const harness = createHarness({
      persistState: false,
      desiredActive: false,
      supportedModels: ["partner/gpt-5.5"],
      footer: { mode: "status", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
    });
    const { ctx, footer, statusCalls, statusByKey } = createContext({
      captureFooter: true,
      currentModel: model("partner", "gpt-5.4"),
      statuses: { "other-extension": "busy" },
    });

    await emit(harness, "session_start", { type: "session_start" }, ctx);
    const [inactivePayload] = await emit(
      harness,
      "before_provider_request",
      { type: "before_provider_request", payload: { model: "gpt-5.4" } },
      ctx,
    );

    await emit(harness, "model_select", { type: "model_select", model: model("partner", "gpt-5.5") }, ctx);
    const [activePayload] = await emit(
      harness,
      "before_provider_request",
      { type: "before_provider_request", payload: { model: "gpt-5.5" } },
      ctx,
    );

    assert.deepEqual(footer.setFooterCalls, []);
    assert.equal(inactivePayload, undefined);
    assert.deepEqual(statusCalls.at(-2), { key: FAST_STATUS_KEY, text: undefined });
    assert.deepEqual(activePayload, { model: "gpt-5.5", service_tier: "priority" });
    assert.deepEqual(statusCalls.at(-1), { key: FAST_STATUS_KEY, text: "fast" });
    assert.equal(statusByKey.get(FAST_STATUS_KEY), "fast");
    assert.equal(statusByKey.get("other-extension"), "busy");
  });
});

test("status mode keeps theme colors out of status text while model changes drive active state", async () => {
  const thinkingLevels = [];
  const harness = createHarness({
    persistState: true,
    desiredActive: true,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "status", vars: {}, darkFastColor: "#112233" },
  });
  const { ctx, footer, statusCalls, statusByKey } = createContext({
    captureFooter: true,
    currentModel: model("partner", "gpt-5.4"),
    theme: createTheme({ thinkingLevels }),
  });

  await emit(harness, "session_start", { type: "session_start" }, ctx);
  const [initialPayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.4" } },
    ctx,
  );

  await emit(harness, "model_select", { type: "model_select", model: model("partner", "gpt-5.5") }, ctx);
  const [activePayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    ctx,
  );

  await emit(harness, "model_select", { type: "model_select", model: model("partner", "gpt-5.4") }, ctx);
  const [inactivePayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.4" } },
    ctx,
  );

  assert.deepEqual(footer.setFooterCalls, []);
  assert.equal(initialPayload, undefined);
  assert.deepEqual(activePayload, { model: "gpt-5.5", service_tier: "priority" });
  assert.equal(inactivePayload, undefined);
  assert.deepEqual(statusCalls.at(-3), { key: FAST_STATUS_KEY, text: undefined });
  assert.deepEqual(statusCalls.at(-2), { key: FAST_STATUS_KEY, text: "fast" });
  assert.deepEqual(statusCalls.at(-1), { key: FAST_STATUS_KEY, text: undefined });
  assert.equal(statusCalls.some(({ text }) => typeof text === "string" && text.includes("\x1b")), false);
  assert.equal(statusByKey.has(FAST_STATUS_KEY), false);
  assert.deepEqual(thinkingLevels, []);
});

test("off mode leaves footer and status output untouched while service tier follows active state", async () => {
  const thinkingLevels = [];
  const harness = createHarness({
    persistState: true,
    desiredActive: true,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "off", vars: {}, darkFastColor: "#112233" },
  });
  const { ctx, footer, statusByKey } = createContext({
    captureFooter: true,
    currentModel: model("partner", "gpt-5.4"),
    statuses: { "other-extension": "busy" },
    theme: createTheme({ thinkingLevels }),
  });

  await emit(harness, "session_start", { type: "session_start" }, ctx);
  const [initialPayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.4" } },
    ctx,
  );

  await emit(harness, "model_select", { type: "model_select", model: model("partner", "gpt-5.5") }, ctx);
  const [activePayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    ctx,
  );

  await emit(harness, "model_select", { type: "model_select", model: model("partner", "gpt-5.4") }, ctx);
  const [inactivePayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.4" } },
    ctx,
  );

  assert.deepEqual(footer.setFooterCalls, []);
  assert.equal(initialPayload, undefined);
  assert.deepEqual(activePayload, { model: "gpt-5.5", service_tier: "priority" });
  assert.equal(inactivePayload, undefined);
  assert.equal(statusByKey.has(FAST_STATUS_KEY), false);
  assert.equal(statusByKey.get("other-extension"), "busy");
  assert.deepEqual(thinkingLevels, []);
});

test("off mode does not install footer or publish status but still injects service tier when active", async () => {
  const harness = createHarness({
    persistState: false,
    desiredActive: false,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "off", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
  });
  const { ctx, footer, statusCalls } = createContext({
    captureFooter: true,
    currentModel: model("partner", "gpt-5.5"),
  });

  await emit(harness, "session_start", { type: "session_start" }, ctx);
  assert.deepEqual(footer.setFooterCalls, []);

  await harness.commands.get("fast").handler("", ctx);
  const [activePayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    ctx,
  );

  assert.deepEqual(activePayload, { model: "gpt-5.5", service_tier: "priority" });
  assert.deepEqual(footer.setFooterCalls, []);
  assert.deepEqual(statusCalls.at(-1), { key: FAST_STATUS_KEY, text: undefined });
});

test("off mode with desired handoff on leaves footer and status output untouched while active", async () => {
  await withFastDesiredHandoffEnv("1", async () => {
    const harness = createHarness({
      persistState: false,
      desiredActive: false,
      supportedModels: ["partner/gpt-5.5"],
      footer: { mode: "off", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
    });
    const { ctx, footer, statusByKey } = createContext({
      captureFooter: true,
      currentModel: model("partner", "gpt-5.5"),
      statuses: { "other-extension": "busy" },
    });

    await emit(harness, "session_start", { type: "session_start" }, ctx);
    const [activePayload] = await emit(
      harness,
      "before_provider_request",
      { type: "before_provider_request", payload: { model: "gpt-5.5" } },
      ctx,
    );

    assert.deepEqual(activePayload, { model: "gpt-5.5", service_tier: "priority" });
    assert.deepEqual(footer.setFooterCalls, []);
    assert.equal(statusByKey.has(FAST_STATUS_KEY), false);
    assert.equal(statusByKey.get("other-extension"), "busy");
  });
});

test("session shutdown clears owned footer and status state", async () => {
  const harness = createHarness({
    persistState: true,
    desiredActive: true,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "status", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
  });
  const { ctx, footer, statusCalls, statusByKey } = createContext({
    currentModel: model("partner", "gpt-5.5"),
    captureFooter: true,
    statuses: { "other-extension": "busy" },
  });

  await emit(harness, "session_start", { type: "session_start" }, ctx);

  assert.deepEqual(statusCalls.at(-1), { key: FAST_STATUS_KEY, text: "fast" });
  assert.equal(statusByKey.get("other-extension"), "busy");

  await emit(harness, "session_shutdown", { type: "session_shutdown" }, ctx);

  assert.deepEqual(statusCalls.at(-1), { key: FAST_STATUS_KEY, text: undefined });
  assert.equal(footer.setFooterCalls.length, 0);
  assert.equal(statusByKey.has(FAST_STATUS_KEY), false);
  assert.equal(statusByKey.get("other-extension"), "busy");
});

test("session shutdown clears owned replace footer only when still owned by this extension", async () => {
  const harness = createHarness({
    persistState: true,
    desiredActive: false,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
  });
  const { ctx, footer } = createContext({
    currentModel: model("partner", "gpt-5.5"),
    captureFooter: true,
  });

  await emit(harness, "session_start", { type: "session_start" }, ctx);
  assert.equal(footer.setFooterCalls.length, 1);

  await emit(harness, "session_shutdown", { type: "session_shutdown" }, ctx);

  assert.equal(footer.setFooterCalls.length, 2);
  assert.equal(footer.setFooterCalls.at(-1), undefined);
});

test("startup and provider requests in headless mode do not rely on UI callbacks", async () => {
  const harness = createHarness({
    persistState: true,
    desiredActive: true,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
  });
  const { ctx } = createContext({
    currentModel: model("partner", "gpt-5.5"),
    hasNotify: false,
    captureStatus: false,
    captureFooter: false,
  });

  ctx.ui = {};

  await emit(harness, "session_start", { type: "session_start" }, ctx);
  const [activePayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    ctx,
  );

  assert.deepEqual(activePayload, { model: "gpt-5.5", service_tier: "priority" });
});

test("startup and provider requests do not rely on ui object being present", async () => {
  const harness = createHarness({
    persistState: true,
    desiredActive: true,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
  });
  const { ctx } = createContext({
    currentModel: model("partner", "gpt-5.5"),
    hasNotify: false,
    captureStatus: false,
    captureFooter: false,
  });

  ctx.ui = undefined;

  await emit(harness, "session_start", { type: "session_start" }, ctx);
  const [activePayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    ctx,
  );

  assert.deepEqual(activePayload, { model: "gpt-5.5", service_tier: "priority" });
});

test("/fast command is robust when UI notifications are unavailable", async () => {
  const harness = createHarness({
    persistState: false,
    desiredActive: false,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "replace", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
  });
  const { ctx } = createContext({
    currentModel: model("partner", "gpt-5.5"),
    hasNotify: false,
  });

  await harness.commands.get("fast").handler("", ctx);
  const [activePayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    ctx,
  );

  assert.deepEqual(activePayload, { model: "gpt-5.5", service_tier: "priority" });
});

test("lifecycle smoke/regression sweep composes hooks, commands, and cleanup", async () => {
  const harness = createHarness({
    persistState: true,
    desiredActive: false,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "status", vars: {}, darkFastColor: "#ff50be", lightFastColor: "#d20000" },
  }, { flags: { fast: false } });
  const { ctx, footer, statusByKey, statusCalls } = createContext({
    captureFooter: true,
    currentModel: model("partner", "gpt-5.5"),
    statuses: { "other-extension": "busy" },
  });

  const flag = harness.flags.get("fast");
  assert.equal(flag?.type, "boolean");
  assert.equal(harness.flagValues.get("fast"), false);
  assert.equal(harness.commands.has("fast"), true);
  assert.equal(harness.commands.has("openai-fast-settings"), false);

  await emit(harness, "session_start", { type: "session_start" }, ctx);
  assert.deepEqual(footer.setFooterCalls, []);
  assert.deepEqual(statusCalls.at(-1), { key: FAST_STATUS_KEY, text: undefined });

  await harness.commands.get("fast").handler("", ctx);
  const [activePayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    ctx,
  );
  assert.deepEqual(activePayload, { model: "gpt-5.5", service_tier: "priority" });
  assert.equal(statusByKey.get(FAST_STATUS_KEY), "fast");

  await emit(harness, "model_select", { type: "model_select", model: model("partner", "gpt-5.4") }, ctx);
  const [unsupportedPayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.4" } },
    ctx,
  );
  assert.equal(unsupportedPayload, undefined);
  assert.deepEqual(statusCalls.at(-1), { key: FAST_STATUS_KEY, text: undefined });

  await emit(harness, "model_select", { type: "model_select", model: model("partner", "gpt-5.5") }, ctx);
  const [reactivatedPayload] = await emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5.5" } },
    ctx,
  );
  assert.deepEqual(reactivatedPayload, { model: "gpt-5.5", service_tier: "priority" });
  assert.equal(statusByKey.get(FAST_STATUS_KEY), "fast");

  await emit(harness, "session_shutdown", { type: "session_shutdown" }, ctx);

  assert.deepEqual(statusCalls.at(-1), { key: FAST_STATUS_KEY, text: undefined });
  assert.equal(statusByKey.has(FAST_STATUS_KEY), false);
  assert.equal(statusByKey.get("other-extension"), "busy");
});
