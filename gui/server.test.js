const assert = require("node:assert/strict");
const test = require("node:test");

const { createDefaultBackend, startServer } = require("./server");

test("default backend persists the selected default output directory and uses it for export", async () => {
  let settings = {};
  const exportCalls = [];

  const backend = createDefaultBackend({
    checkHealthImpl: async () => ({ ok: true }),
    exportThreadToFileImpl: async (payload) => {
      exportCalls.push(payload);
      return {
        outputPath: "A:/Exports/Release Notes.md",
        thread: {
          id: "thread-1",
          name: "Release Notes",
        },
      };
    },
    listThreadsImpl: async () => [],
    loadSettings: async () => settings,
    pickDirectory: async () => "A:/Exports",
    saveSettings: async (nextSettings) => {
      settings = nextSettings;
    },
  });

  assert.deepEqual(await backend.getSettings(), {
    defaultOutputDir: null,
  });

  assert.deepEqual(await backend.selectDefaultOutputDirectory(), {
    defaultOutputDir: "A:/Exports",
  });

  const exportResult = await backend.exportThread({
    threadId: "thread-1",
    fileName: "Release Notes",
    withTools: true,
  });

  assert.deepEqual(exportCalls, [
    {
      fileName: "Release Notes",
      outputDir: "A:/Exports",
      threadId: "thread-1",
      withTools: true,
    },
  ]);

  assert.deepEqual(exportResult, {
    outputPath: "A:/Exports/Release Notes.md",
    threadTitle: "Release Notes",
  });
});

test("default backend rejects export when no default output directory is configured", async () => {
  const backend = createDefaultBackend({
    checkHealthImpl: async () => ({ ok: true }),
    exportThreadToFileImpl: async () => {
      throw new Error("should not run");
    },
    listThreadsImpl: async () => [],
    loadSettings: async () => ({}),
    pickDirectory: async () => "A:/Exports",
    saveSettings: async () => {},
  });

  await assert.rejects(
    () =>
      backend.exportThread({
        threadId: "thread-1",
      }),
    /default output directory is not configured/i,
  );
});

test("serves settings, threads, export, and static assets", async (t) => {
  const calls = [];
  const app = await startServer({
    host: "127.0.0.1",
    port: 0,
    backend: {
      checkHealth: async () => ({ ok: true }),
      getSettings: async () => ({
        defaultOutputDir: null,
      }),
      listThreads: async () => [
        {
          id: "thread-1",
          name: "Release Notes",
          preview: "Ship the GUI",
          updatedAt: 1700000000,
          cwd: "A:/Codes/project",
        },
      ],
      selectDefaultOutputDirectory: async () => ({
        defaultOutputDir: "A:/Exports",
      }),
      exportThread: async (payload) => {
        calls.push(payload);
        return {
          outputPath: "A:/Exports/Release Notes.md",
          threadTitle: "Release Notes",
        };
      },
    },
  });

  t.after(async () => {
    await app.close();
  });

  const healthResponse = await fetch(`${app.url}/api/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { ok: true });

  const settingsResponse = await fetch(`${app.url}/api/settings`);
  assert.equal(settingsResponse.status, 200);
  assert.deepEqual(await settingsResponse.json(), {
    defaultOutputDir: null,
  });

  const selectDirectoryResponse = await fetch(`${app.url}/api/settings/default-output-directory/select`, {
    method: "POST",
  });
  assert.equal(selectDirectoryResponse.status, 200);
  assert.deepEqual(await selectDirectoryResponse.json(), {
    defaultOutputDir: "A:/Exports",
    ok: true,
  });

  const threadsResponse = await fetch(`${app.url}/api/threads`);
  assert.equal(threadsResponse.status, 200);
  assert.deepEqual(await threadsResponse.json(), {
    threads: [
      {
        id: "thread-1",
        name: "Release Notes",
        preview: "Ship the GUI",
        updatedAt: 1700000000,
        cwd: "A:/Codes/project",
      },
    ],
  });

  const exportResponse = await fetch(`${app.url}/api/export`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      threadId: "thread-1",
      fileName: "Release Notes",
      withTools: true,
    }),
  });

  assert.equal(exportResponse.status, 200);
  assert.deepEqual(await exportResponse.json(), {
    ok: true,
    outputPath: "A:/Exports/Release Notes.md",
    threadTitle: "Release Notes",
  });
  assert.deepEqual(calls, [
    {
      threadId: "thread-1",
      fileName: "Release Notes",
      withTools: true,
    },
  ]);

  const pageResponse = await fetch(`${app.url}/`);
  assert.equal(pageResponse.status, 200);
  const pageHtml = await pageResponse.text();
  assert.match(pageHtml, /Codex Chat Export/);
  assert.match(pageHtml, /Choose Folder/);
  assert.match(pageHtml, /\/app\.js/);
  assert.match(pageHtml, /\/styles\.css/);

  const jsResponse = await fetch(`${app.url}/app.js`);
  assert.equal(jsResponse.status, 200);
  assert.match(await jsResponse.text(), /ensureDefaultOutputDirectory/);
});

test("rejects export requests without a thread id", async (t) => {
  const app = await startServer({
    host: "127.0.0.1",
    port: 0,
    backend: {
      checkHealth: async () => ({ ok: true }),
      getSettings: async () => ({
        defaultOutputDir: null,
      }),
      listThreads: async () => [],
      selectDefaultOutputDirectory: async () => ({
        defaultOutputDir: "A:/Exports",
      }),
      exportThread: async () => {
        throw new Error("should not run");
      },
    },
  });

  t.after(async () => {
    await app.close();
  });

  const response = await fetch(`${app.url}/api/export`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      fileName: "Missing Thread",
    }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "threadId is required",
    ok: false,
  });
});
