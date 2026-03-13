const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const scriptPath = path.join(__dirname, "export-codex-thread.js");

function writeFakeCodexShim(binDir) {
  const serverPath = path.join(binDir, "fake-codex.js");

  fs.writeFileSync(
    serverPath,
    `
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });
let initialized = false;

function reply(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    if (!message.params || !Object.prototype.hasOwnProperty.call(message.params, "capabilities")) {
      reply({ id: message.id, error: { message: "missing capabilities" } });
      return;
    }

    initialized = true;
    reply({ id: message.id, result: { userAgent: "fake-codex" } });
    return;
  }

  if (message.method === "initialized") {
    return;
  }

  if (message.method === "thread/read") {
    if (!initialized) {
      reply({ id: message.id, error: { message: "not initialized" } });
      return;
    }

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
                  content: [{
                    type: "text",
                    text: process.env.FAKE_FIRST_USER_TEXT || "Export this thread",
                    text_elements: [],
                  }],
                },
                {
                  type: "reasoning",
                  summary: ["Confirmed the exporter is reading the current protocol shape."],
                  content: [],
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

test("exports a thread through the app-server protocol", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-export-test-"));
  const binDir = path.join(tempRoot, "bin");
  const outputPath = path.join(tempRoot, "thread.md");

  fs.mkdirSync(binDir);
  writeFakeCodexShim(binDir);

  const result = spawnSync(
    process.execPath,
    [scriptPath, "thread-123", outputPath, "--with-tools"],
    {
      cwd: path.dirname(scriptPath),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(outputPath), true, "expected exporter to write markdown");

  const markdown = fs.readFileSync(outputPath, "utf8");
  assert.match(markdown, /^# Fake Export Thread/m);
  assert.match(markdown, /Thread ID: `thread-123`/);
  assert.match(markdown, /### User/);
  assert.match(markdown, /Export this thread/);
  assert.match(markdown, /### Reasoning summary/);
  assert.match(markdown, /Confirmed the exporter is reading the current protocol shape\./);
  assert.match(markdown, /### Codex/);
  assert.match(markdown, /Rendered thread content/);
});

test("uses the thread title as the default output filename when OUT.md is omitted", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-export-title-test-"));
  const binDir = path.join(tempRoot, "bin");
  const expectedPath = path.join(tempRoot, "Quarterly Review Launch Plan.md");

  fs.mkdirSync(binDir);
  writeFakeCodexShim(binDir);

  const result = spawnSync(process.execPath, [scriptPath, "thread-456"], {
    cwd: tempRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_THREAD_NAME: 'Quarterly: Review / Launch? Plan*',
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(expectedPath), true, "expected exporter to derive the filename from the thread title");
  assert.match(result.stdout, /Wrote Quarterly Review Launch Plan\.md/);
});

test("falls back to the first user message when the thread title is empty", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-export-message-test-"));
  const binDir = path.join(tempRoot, "bin");
  const expectedPath = path.join(tempRoot, "Export this chat please.md");

  fs.mkdirSync(binDir);
  writeFakeCodexShim(binDir);

  const result = spawnSync(process.execPath, [scriptPath, "thread-789"], {
    cwd: tempRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_THREAD_NAME: "   ",
      FAKE_FIRST_USER_TEXT: 'Export: this / chat? please*',
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(expectedPath), true, "expected exporter to derive the filename from the first user message");
  assert.match(result.stdout, /Wrote Export this chat please\.md/);
});
