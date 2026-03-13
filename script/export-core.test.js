const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { exportThreadToFile, listThreads } = require("./export-core");

function writeFakeCodexShim(binDir) {
  const serverPath = path.join(binDir, "fake-codex.js");

  fs.writeFileSync(
    serverPath,
    `
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });
let initialized = false;
const fakeThreads = JSON.parse(process.env.FAKE_THREADS_JSON || "[]");

function reply(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    initialized = true;
    reply({ id: message.id, result: { userAgent: "fake-codex" } });
    return;
  }

  if (message.method === "initialized") {
    return;
  }

  if (!initialized) {
    reply({ id: message.id, error: { message: "not initialized" } });
    return;
  }

  if (message.method === "thread/list") {
    reply({
      id: message.id,
      result: {
        data: fakeThreads,
        nextCursor: null,
      },
    });
    return;
  }

  if (message.method === "thread/read") {
    reply({
      id: message.id,
      result: {
        thread: {
          id: message.params.threadId,
          name: process.env.FAKE_THREAD_NAME || "Fake Export Thread",
          turns: [
            {
              items: [
                {
                  type: "userMessage",
                  content: [
                    {
                      type: "text",
                      text: process.env.FAKE_FIRST_USER_TEXT || "Export this thread",
                      text_elements: [],
                    },
                  ],
                },
                {
                  type: "agentMessage",
                  text: "Rendered thread content",
                },
              ],
            },
          ],
        },
      },
    });
  }
});
`.trimStart(),
    "utf8",
  );

  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(binDir, "codex.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.js" %*\r\n`,
      "utf8",
    );
    return;
  }

  const shimPath = path.join(binDir, "codex");
  fs.writeFileSync(
    shimPath,
    `#!/usr/bin/env sh\n"${process.execPath}" "$(dirname "$0")/fake-codex.js" "$@"\n`,
    "utf8",
  );
  fs.chmodSync(shimPath, 0o755);
}

test("lists threads through the shared app-server client", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-export-core-list-"));
  const binDir = path.join(tempRoot, "bin");

  fs.mkdirSync(binDir);
  writeFakeCodexShim(binDir);

  const threads = await listThreads({
    limit: 30,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      FAKE_THREADS_JSON: JSON.stringify([
        {
          id: "thread-b",
          name: "Newest Thread",
          preview: "Latest preview",
          updatedAt: 200,
          createdAt: 150,
          cwd: "A:/Codes/project-b",
          path: "A:/threads/thread-b.json",
          status: "idle",
          modelProvider: "openai",
          cliVersion: "0.0.0",
          source: "cli",
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          ephemeral: false,
          turns: [],
        },
        {
          id: "thread-a",
          name: "Older Thread",
          preview: "Older preview",
          updatedAt: 100,
          createdAt: 50,
          cwd: "A:/Codes/project-a",
          path: "A:/threads/thread-a.json",
          status: "idle",
          modelProvider: "openai",
          cliVersion: "0.0.0",
          source: "cli",
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          ephemeral: false,
          turns: [],
        },
      ]),
    },
  });

  assert.equal(threads.length, 2);
  assert.equal(threads[0].id, "thread-b");
  assert.equal(threads[1].id, "thread-a");
  assert.equal(threads[0].name, "Newest Thread");
});

test("exports a thread into the requested output directory with a derived filename", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-export-core-write-"));
  const binDir = path.join(tempRoot, "bin");
  const outputDir = path.join(tempRoot, "out");

  fs.mkdirSync(binDir);
  fs.mkdirSync(outputDir);
  writeFakeCodexShim(binDir);

  const result = await exportThreadToFile({
    threadId: "thread-123",
    outputDir,
    withTools: false,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      FAKE_THREAD_NAME: 'Quarterly: Review / Launch? Plan*',
    },
  });

  assert.equal(path.basename(result.outputPath), "Quarterly Review Launch Plan.md");
  assert.equal(fs.existsSync(result.outputPath), true);

  const markdown = fs.readFileSync(result.outputPath, "utf8");
  assert.match(markdown, /^# Quarterly: Review \/ Launch\? Plan\*/m);
  assert.match(markdown, /Thread ID: `thread-123`/);
  assert.match(markdown, /Rendered thread content/);
});
