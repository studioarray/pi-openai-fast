import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_FAST_CONFIG, FastConfigStore } from "../src/fast-config-store.ts";

async function tempHome() {
  return await mkdtemp(join(tmpdir(), "pi-openai-fast-"));
}

test("default config matches the PRD config contract", () => {
  assert.deepEqual(DEFAULT_FAST_CONFIG, {
    persistState: false,
    desiredActive: false,
    supportedModels: [
      "openai/gpt-5.4",
      "openai/gpt-5.5",
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-luna",
      "openai-codex/gpt-5.4",
      "openai-codex/gpt-5.5",
      "openai-codex/gpt-5.6-sol",
      "openai-codex/gpt-5.6-terra",
      "openai-codex/gpt-5.6-luna",
    ],
    footer: {
      mode: "replace",
      vars: {},
    },
  });
});

test("uses the required global and project config paths", () => {
  const store = new FastConfigStore({ home: "/home/user" });

  assert.deepEqual(store.paths("/work/repo"), {
    project: join("/work/repo", ".pi", "extensions", "pi-openai-fast.json"),
    global: join("/home/user", ".pi", "agent", "extensions", "pi-openai-fast.json"),
  });
});

test("creates global defaults when no config file exists", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const store = new FastConfigStore({ home });
  const globalPath = store.paths(cwd).global;

  assert.deepEqual(await store.load(cwd), DEFAULT_FAST_CONFIG);
  assert.deepEqual(JSON.parse(await readFile(globalPath, "utf8")), DEFAULT_FAST_CONFIG);
});

test("merges defaults before global config and project config overrides global config", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const store = new FastConfigStore({ home });
  const paths = store.paths(cwd);

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(
    paths.global,
    JSON.stringify({
      persistState: false,
      desiredActive: true,
      supportedModels: [" global/model "],
      footer: { mode: "status" },
    }),
  );
  await writeFile(
    paths.project,
    JSON.stringify({
      desiredActive: false,
      supportedModels: [],
      footer: { darkFastColor: "#abcdef" },
    }),
  );

  assert.deepEqual(await store.load(cwd), {
    persistState: false,
    desiredActive: false,
    supportedModels: [],
    footer: {
      mode: "status",
      vars: {},
      darkFastColor: "#abcdef",
    },
  });
});

test("normalizes supported model entries and warns about dropped invalid entries", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const warnings = [];
  const store = new FastConfigStore({ home, warn: (warning) => warnings.push(warning) });
  const globalPath = store.paths(cwd).global;

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await writeFile(
    globalPath,
    JSON.stringify({
      supportedModels: [
        " openai/gpt-5.5 ",
        " openai/gpt-5.4 ",
        "",
        "   ",
        "missing-slash",
        "/missing-provider",
        "missing-id/",
        "openai/gpt-*",
        "openai/gpt-5.*",
        "openai/gpt 5.5",
        123,
        null,
      ],
    }),
  );

  assert.deepEqual((await store.load(cwd)).supportedModels, ["openai/gpt-5.5", "openai/gpt-5.4"]);
  assert.deepEqual(
    warnings.map(({ code, path }) => ({ code, path })),
    [{ code: "config-supported-models-dropped", path: globalPath }],
  );
  assert.match(warnings[0].message, /openai\/gpt-\*/);
  assert.match(warnings[0].message, /openai\/gpt-5\.\*/);
});

test("load can route warnings to an operation-local collector", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const constructorWarnings = [];
  const operationWarnings = [];
  const store = new FastConfigStore({ home, warn: (warning) => constructorWarnings.push(warning) });
  const globalPath = store.paths(cwd).global;

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await writeFile(globalPath, JSON.stringify({ supportedModels: "openai/gpt-5.5" }));

  await store.load(cwd, { warn: (warning) => operationWarnings.push(warning) });

  assert.deepEqual(constructorWarnings, []);
  assert.deepEqual(
    operationWarnings.map(({ code, path }) => ({ code, path })),
    [{ code: "config-supported-models-not-array", path: globalPath }],
  );
});

test("warns when a non-empty supportedModels list has no valid entries", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const warnings = [];
  const store = new FastConfigStore({ home, warn: (warning) => warnings.push(warning) });
  const globalPath = store.paths(cwd).global;

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await writeFile(
    globalPath,
    JSON.stringify({
      supportedModels: ["", "missing-slash", "openai/gpt-*", 123],
    }),
  );

  assert.deepEqual((await store.load(cwd)).supportedModels, []);
  assert.deepEqual(
    warnings.map(({ code, path }) => ({ code, path })),
    [
      { code: "config-supported-models-dropped", path: globalPath },
      { code: "config-supported-models-all-invalid", path: globalPath },
    ],
  );
});

test("accepts explicit empty supportedModels without warning", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const warnings = [];
  const store = new FastConfigStore({ home, warn: (warning) => warnings.push(warning) });
  const globalPath = store.paths(cwd).global;

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await writeFile(globalPath, JSON.stringify({ supportedModels: [] }));

  assert.deepEqual((await store.load(cwd)).supportedModels, []);
  assert.deepEqual(warnings, []);
});

test("uses legacy active only when desiredActive is missing", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const store = new FastConfigStore({ home });
  const paths = store.paths(cwd);

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await writeFile(paths.global, JSON.stringify({ active: true }));
  assert.equal((await store.load(cwd)).desiredActive, true);

  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(paths.project, JSON.stringify({ desiredActive: false, active: true }));
  assert.equal((await store.load(cwd)).desiredActive, false);
});

test("creates global defaults with desiredActive when writing without an existing config", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const store = new FastConfigStore({ home });
  const globalPath = store.paths(cwd).global;

  await store.writeDesiredActive(cwd, true);

  assert.deepEqual(JSON.parse(await readFile(globalPath, "utf8")), {
    ...DEFAULT_FAST_CONFIG,
    desiredActive: true,
  });
});

test("writes desiredActive to an existing project config and omits legacy active", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const store = new FastConfigStore({ home });
  const paths = store.paths(cwd);

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(paths.global, JSON.stringify({ desiredActive: false }));
  await writeFile(paths.project, JSON.stringify({ desiredActive: false, active: true, projectOnly: true }));

  await store.writeDesiredActive(cwd, true);

  assert.deepEqual(JSON.parse(await readFile(paths.global, "utf8")), { desiredActive: false });
  assert.deepEqual(JSON.parse(await readFile(paths.project, "utf8")), {
    desiredActive: true,
    projectOnly: true,
  });
});

test("preserves unknown fields while sanitizing invalid known fields on writes", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const warnings = [];
  const store = new FastConfigStore({ home, warn: (warning) => warnings.push(warning) });
  const projectPath = store.paths(cwd).project;

  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(
    projectPath,
    JSON.stringify({
      persistState: "yes",
      desiredActive: "no",
      active: true,
      supportedModels: [" partner/gpt-5.5 ", 7, "missing-slash"],
      footer: {
        mode: "invalid",
        vars: { brand: "#fff", invalid: 7 },
        darkFastColor: "definitely not a color",
        lightFastColor: "#010101",
        unknownFooter: { keep: true },
      },
      unknownTop: { keep: true },
    }),
  );

  await store.writeDesiredActive(cwd, true);

  assert.deepEqual(JSON.parse(await readFile(projectPath, "utf8")), {
    desiredActive: true,
    supportedModels: ["partner/gpt-5.5"],
    footer: {
      vars: { brand: "#fff" },
      lightFastColor: "#010101",
      unknownFooter: { keep: true },
    },
    unknownTop: { keep: true },
  });
  assert.deepEqual(
    warnings.map(({ code, path, name }) => ({ code, path, name })),
    [
      { code: "config-supported-models-dropped", path: projectPath, name: undefined },
      { code: "config-fast-label-color-invalid", path: projectPath, name: "footer.darkFastColor" },
    ],
  );
});

test("falls back to defaults and warns when config cannot be read", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const warnings = [];
  const store = new FastConfigStore({ home, warn: (warning) => warnings.push(warning) });
  const globalPath = store.paths(cwd).global;

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await writeFile(globalPath, "{not-json");

  assert.deepEqual(await store.load(cwd), DEFAULT_FAST_CONFIG);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "config-read-failed");
  assert.equal(warnings[0].path, globalPath);
});

test("invalid string footer colors are omitted and reported on load while valid color siblings remain", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const warnings = [];
  const store = new FastConfigStore({ home, warn: (warning) => warnings.push(warning) });
  const globalPath = store.paths(cwd).global;

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await writeFile(
    globalPath,
    JSON.stringify({
      footer: {
        mode: "status",
        vars: { brand: "#123456" },
        darkFastColor: "definitely not a color",
        lightFastColor: "brand",
      },
    }),
  );

  assert.deepEqual((await store.load(cwd)).footer, {
    mode: "status",
    vars: { brand: "#123456" },
    lightFastColor: "brand",
  });
  assert.deepEqual(
    warnings.map(({ code, path, name, value }) => ({ code, path, name, value })),
    [
      {
        code: "config-fast-label-color-invalid",
        path: globalPath,
        name: "footer.darkFastColor",
        value: '"definitely not a color"',
      },
    ],
  );
});

test("warns about invalid fast label color types and indexes without overriding lower-priority valid colors", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const warnings = [];
  const store = new FastConfigStore({ home, warn: (warning) => warnings.push(warning) });
  const paths = store.paths(cwd);

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(
    paths.global,
    JSON.stringify({
      footer: {
        darkFastColor: "#123456",
        lightFastColor: "#654321",
      },
    }),
  );
  await writeFile(
    paths.project,
    JSON.stringify({
      footer: {
        darkFastColor: { not: "a color" },
        lightFastColor: 256,
      },
    }),
  );

  assert.deepEqual((await store.load(cwd)).footer, {
    ...DEFAULT_FAST_CONFIG.footer,
    darkFastColor: "#123456",
    lightFastColor: "#654321",
  });
  assert.deepEqual(
    warnings.map(({ code, path, name, value }) => ({ code, path, name, value })),
    [
      {
        code: "config-fast-label-color-invalid",
        path: paths.project,
        name: "footer.darkFastColor",
        value: '{"not":"a color"}',
      },
      { code: "config-fast-label-color-invalid", path: paths.project, name: "footer.lightFastColor", value: "256" },
    ],
  );
});

test("valid custom and variable-valued footer colors are preserved on load", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const store = new FastConfigStore({ home });
  const globalPath = store.paths(cwd).global;

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await writeFile(
    globalPath,
    JSON.stringify({
      footer: {
        vars: { brand: "#123456" },
        darkFastColor: "#abcdef",
        lightFastColor: "brand",
      },
    }),
  );

  assert.deepEqual((await store.load(cwd)).footer, {
    ...DEFAULT_FAST_CONFIG.footer,
    vars: { brand: "#123456" },
    darkFastColor: "#abcdef",
    lightFastColor: "brand",
  });
});

test("literal legacy fast label colors are treated as unset on load", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const store = new FastConfigStore({ home });
  const globalPath = store.paths(cwd).global;

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await writeFile(
    globalPath,
    JSON.stringify({
      footer: {
        vars: { legacyPink: "#ff50be" },
        darkFastColor: "  #FF50BE ",
        lightFastColor: " #D20000 ",
      },
    }),
  );

  assert.deepEqual((await store.load(cwd)).footer, {
    ...DEFAULT_FAST_CONFIG.footer,
    vars: { legacyPink: "#ff50be" },
  });
});

test("variable-valued fast label overrides remain user-owned even when they resolve to legacy literals", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const store = new FastConfigStore({ home });
  const globalPath = store.paths(cwd).global;

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await writeFile(
    globalPath,
    JSON.stringify({
      footer: {
        vars: { legacyPink: "#ff50be", legacyRed: "#d20000" },
        darkFastColor: "legacyPink",
        lightFastColor: "legacyRed",
      },
    }),
  );

  assert.deepEqual((await store.load(cwd)).footer, {
    ...DEFAULT_FAST_CONFIG.footer,
    vars: { legacyPink: "#ff50be", legacyRed: "#d20000" },
    darkFastColor: "legacyPink",
    lightFastColor: "legacyRed",
  });
});

test("missing and circular fast label color variables warn and are ignored as overrides", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const warnings = [];
  const store = new FastConfigStore({ home, warn: (warning) => warnings.push(warning) });
  const paths = store.paths(cwd);

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(paths.global, JSON.stringify({ footer: { darkFastColor: "#123456" } }));
  await writeFile(
    paths.project,
    JSON.stringify({
      footer: {
        vars: { loop: "loop" },
        darkFastColor: "missingBrand",
        lightFastColor: "loop",
      },
    }),
  );

  assert.deepEqual((await store.load(cwd)).footer, {
    ...DEFAULT_FAST_CONFIG.footer,
    vars: { loop: "loop" },
    darkFastColor: "#123456",
  });
  assert.deepEqual(
    warnings.map(({ code, path, name, value, message }) => ({ code, path, name, value, message })),
    [
      {
        code: "config-fast-label-color-invalid",
        path: paths.project,
        name: "footer.darkFastColor",
        value: '"missingBrand"',
        message: `Ignored invalid Fast label color footer.darkFastColor at ${paths.project}: "missingBrand" (variable "missingBrand" is not defined).`,
      },
      {
        code: "config-fast-label-color-invalid",
        path: paths.project,
        name: "footer.lightFastColor",
        value: '"loop"',
        message: `Ignored invalid Fast label color footer.lightFastColor at ${paths.project}: "loop" (variable "loop" resolves circularly).`,
      },
    ],
  );
});

test("prototype-name fast label color variables warn and fall back without crashing config load", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const warnings = [];
  const store = new FastConfigStore({ home, warn: (warning) => warnings.push(warning) });
  const paths = store.paths(cwd);

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(paths.global, JSON.stringify({ footer: { darkFastColor: "#123456" } }));
  await writeFile(paths.project, JSON.stringify({ footer: { darkFastColor: "toString" } }));

  await assert.doesNotReject(async () => {
    assert.deepEqual((await store.load(cwd)).footer, {
      ...DEFAULT_FAST_CONFIG.footer,
      darkFastColor: "#123456",
    });
  });
  assert.deepEqual(
    warnings.map(({ code, path, name, value, message }) => ({ code, path, name, value, message })),
    [
      {
        code: "config-fast-label-color-invalid",
        path: paths.project,
        name: "footer.darkFastColor",
        value: '"toString"',
        message: `Ignored invalid Fast label color footer.darkFastColor at ${paths.project}: "toString" (variable "toString" is not defined).`,
      },
    ],
  );
});

test("higher-priority legacy literals do not override lower-priority custom fast label colors", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const store = new FastConfigStore({ home });
  const paths = store.paths(cwd);

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(
    paths.global,
    JSON.stringify({
      footer: {
        darkFastColor: "#123456",
        lightFastColor: "#654321",
      },
    }),
  );
  await writeFile(
    paths.project,
    JSON.stringify({
      footer: {
        darkFastColor: " #ff50be ",
        lightFastColor: " #D20000 ",
      },
    }),
  );

  assert.deepEqual((await store.load(cwd)).footer, {
    ...DEFAULT_FAST_CONFIG.footer,
    darkFastColor: "#123456",
    lightFastColor: "#654321",
  });
});

test("higher-priority non-legacy literals override lower-priority legacy fast label colors", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const store = new FastConfigStore({ home });
  const paths = store.paths(cwd);

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(
    paths.global,
    JSON.stringify({
      footer: {
        darkFastColor: "#ff50be",
        lightFastColor: "#d20000",
      },
    }),
  );
  await writeFile(
    paths.project,
    JSON.stringify({
      footer: {
        darkFastColor: "#123456",
        lightFastColor: "#654321",
      },
    }),
  );

  assert.deepEqual((await store.load(cwd)).footer, {
    ...DEFAULT_FAST_CONFIG.footer,
    darkFastColor: "#123456",
    lightFastColor: "#654321",
  });
});

test("valid numeric and empty footer color values are preserved", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const store = new FastConfigStore({ home });
  const globalPath = store.paths(cwd).global;

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await writeFile(
    globalPath,
    JSON.stringify({
      footer: {
        darkFastColor: 123,
        lightFastColor: "",
      },
    }),
  );

  assert.deepEqual((await store.load(cwd)).footer, {
    ...DEFAULT_FAST_CONFIG.footer,
    darkFastColor: 123,
    lightFastColor: "",
  });
});

test("valid string color indexes are normalized on writes while footer siblings are preserved", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const store = new FastConfigStore({ home });
  const projectPath = store.paths(cwd).project;

  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(
    projectPath,
    JSON.stringify({
      footer: {
        darkFastColor: " 42 ",
        lightFastColor: "",
        unknownFooter: { keep: true },
      },
    }),
  );

  await store.writeDesiredActive(cwd, true);

  assert.deepEqual(JSON.parse(await readFile(projectPath, "utf8")), {
    desiredActive: true,
    footer: {
      darkFastColor: "42",
      lightFastColor: "",
      unknownFooter: { keep: true },
    },
  });
});

test("successful writes remove literal legacy fast label colors while preserving user config fields", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const store = new FastConfigStore({ home });
  const projectPath = store.paths(cwd).project;

  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(
    projectPath,
    JSON.stringify({
      persistState: true,
      footer: {
        mode: "status",
        vars: { legacyPink: "#ff50be", keep: "value", drop: 7 },
        darkFastColor: " #FF50BE ",
        lightFastColor: " #d20000 ",
        unknownFooter: { keep: true },
      },
      unknownTop: { keep: true },
    }),
  );

  await store.writeDesiredActive(cwd, true);

  assert.deepEqual(JSON.parse(await readFile(projectPath, "utf8")), {
    persistState: true,
    desiredActive: true,
    footer: {
      mode: "status",
      vars: { legacyPink: "#ff50be", keep: "value" },
      unknownFooter: { keep: true },
    },
    unknownTop: { keep: true },
  });
});

test("successful writes preserve numeric and variable-valued fast label color overrides", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const store = new FastConfigStore({ home });
  const projectPath = store.paths(cwd).project;

  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(
    projectPath,
    JSON.stringify({
      footer: {
        vars: { legacyRed: "#d20000", keep: "value", drop: 7 },
        darkFastColor: 42,
        lightFastColor: " legacyRed ",
      },
    }),
  );

  await store.writeDesiredActive(cwd, true);

  assert.deepEqual(JSON.parse(await readFile(projectPath, "utf8")), {
    desiredActive: true,
    footer: {
      vars: { legacyRed: "#d20000", keep: "value" },
      darkFastColor: 42,
      lightFastColor: "legacyRed",
    },
  });
});

test("invalid known config values fall back without losing valid nested siblings", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const warnings = [];
  const store = new FastConfigStore({ home, warn: (warning) => warnings.push(warning) });
  const globalPath = store.paths(cwd).global;

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await writeFile(
    globalPath,
    JSON.stringify({
      persistState: "yes",
      desiredActive: "no",
      active: true,
      supportedModels: "openai/gpt-5.5",
      footer: {
        mode: "invalid",
        vars: { brand: "#fff", invalid: 7 },
        darkFastColor: "definitely not a color",
        lightFastColor: "#010101",
      },
    }),
  );

  assert.deepEqual(await store.load(cwd), {
    ...DEFAULT_FAST_CONFIG,
    footer: {
      ...DEFAULT_FAST_CONFIG.footer,
      vars: { brand: "#fff" },
      lightFastColor: "#010101",
    },
  });
  assert.deepEqual(
    warnings.map(({ code, path, name }) => ({ code, path, name })),
    [
      { code: "config-supported-models-not-array", path: globalPath, name: undefined },
      { code: "config-fast-label-color-invalid", path: globalPath, name: "footer.darkFastColor" },
    ],
  );
});

test("refuses malformed selected project config writes without falling back to global", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const warnings = [];
  const store = new FastConfigStore({ home, warn: (warning) => warnings.push(warning) });
  const paths = store.paths(cwd);
  const malformedProjectConfig = "{not-json\n";

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(paths.global, JSON.stringify({ desiredActive: false, globalOnly: true }));
  await writeFile(paths.project, malformedProjectConfig);

  const saved = await store.writeDesiredActive(cwd, true);

  assert.equal(saved, false);
  assert.equal(await readFile(paths.project, "utf8"), malformedProjectConfig);
  assert.deepEqual(JSON.parse(await readFile(paths.global, "utf8")), { desiredActive: false, globalOnly: true });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "config-malformed-write-refused");
  assert.equal(warnings[0].path, paths.project);
  assert.match(warnings[0].message, /manual repair/);
});

test("refuses selected global config writes when JSON is not an object", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const warnings = [];
  const store = new FastConfigStore({ home, warn: (warning) => warnings.push(warning) });
  const globalPath = store.paths(cwd).global;
  const nonObjectConfig = "[]\n";

  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await writeFile(globalPath, nonObjectConfig);

  const saved = await store.writeDesiredActive(cwd, true);

  assert.equal(saved, false);
  assert.equal(await readFile(globalPath, "utf8"), nonObjectConfig);
  assert.deepEqual(
    warnings.map(({ code, path }) => ({ code, path })),
    [{ code: "config-malformed-write-refused", path: globalPath }],
  );
});

test("refuses unreadable selected write target without throwing", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const warnings = [];
  const store = new FastConfigStore({ home, warn: (warning) => warnings.push(warning) });
  const projectPath = store.paths(cwd).project;

  await mkdir(projectPath, { recursive: true });

  const saved = await store.writeDesiredActive(cwd, true);

  assert.equal(saved, false);
  assert.ok(
    warnings.some((warning) => warning.code === "config-malformed-write-refused" && warning.path === projectPath),
  );
});

test("writes desiredActive to the config target without changing other persisted fields", async () => {
  const home = await tempHome();
  const cwd = join(home, "repo");
  const store = new FastConfigStore({ home });
  const globalPath = store.paths(cwd).global;
  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await writeFile(
    globalPath,
    JSON.stringify(
      {
        persistState: true,
        desiredActive: false,
        supportedModels: ["partner/gpt-5.5"],
        footer: { mode: "status", vars: { brand: "#fff" } },
        unknown: { keep: true },
      },
      null,
      2,
    ),
  );

  await store.writeDesiredActive(cwd, true);

  assert.deepEqual(JSON.parse(await readFile(globalPath, "utf8")), {
    persistState: true,
    desiredActive: true,
    supportedModels: ["partner/gpt-5.5"],
    footer: { mode: "status", vars: { brand: "#fff" } },
    unknown: { keep: true },
  });
});
