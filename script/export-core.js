const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

function startAppServer({
  spawnImpl = spawn,
  env = process.env,
  cwd = process.cwd(),
  platform = process.platform,
  comspec = process.env.ComSpec,
} = {}) {
  if (platform === "win32") {
    return spawnImpl(comspec || "cmd.exe", ["/d", "/s", "/c", "codex app-server"], {
      stdio: ["pipe", "pipe", "inherit"],
      env,
      cwd,
    });
  }

  return spawnImpl("codex", ["app-server"], {
    stdio: ["pipe", "pipe", "inherit"],
    env,
    cwd,
  });
}

function createAppServerClient(options = {}) {
  const proc = startAppServer(options);
  const rl = readline.createInterface({ input: proc.stdout });
  let nextId = 1;
  let settled = false;
  const pending = new Map();

  function settleAll(error) {
    if (settled) return;
    settled = true;

    for (const { reject } of pending.values()) {
      reject(error);
    }
    pending.clear();
  }

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (settled) {
        reject(new Error("codex app-server is not available"));
        return;
      }

      const id = nextId++;
      pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ method, id, params }) + "\n");
    });
  }

  rl.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id == null || !pending.has(message.id)) {
      return;
    }

    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);

    if (message.error) {
      reject(new Error(message.error.message || JSON.stringify(message.error)));
      return;
    }

    resolve(message.result);
  });

  proc.on("exit", (code) => {
    settleAll(new Error(`codex app-server exited with code ${code}`));
  });

  proc.on("error", (error) => {
    settleAll(error);
  });

  async function initialize() {
    await send("initialize", {
      clientInfo: {
        name: "codex-md-export",
        title: "Codex Markdown Exporter",
        version: "0.2.0",
      },
      capabilities: null,
    });

    proc.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  }

  async function close() {
    rl.close();
    if (!proc.killed && proc.exitCode == null) {
      proc.kill();
    }
  }

  return { close, initialize, send };
}

function codeFence(text, lang = "") {
  const body = String(text ?? "").replace(/\r\n/g, "\n").trimEnd();
  return `\`\`\`${lang}\n${body}\n\`\`\`\n`;
}

function sanitizeFilename(name) {
  const sanitized = String(name ?? "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  if (!sanitized) return "";

  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(sanitized)) {
    return `_${sanitized}`;
  }

  return sanitized;
}

function ensureMarkdownFilename(name) {
  const sanitized = sanitizeFilename(name);
  if (!sanitized) return "";
  return sanitized.toLowerCase().endsWith(".md") ? sanitized : `${sanitized}.md`;
}

function extractUserText(content = []) {
  return content
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join(" ")
    .trim();
}

function getDefaultBasename(thread, fallbackThreadId) {
  const titledName = sanitizeFilename(thread.name);
  if (titledName) return titledName;

  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (const turn of turns) {
    for (const item of turn.items || []) {
      if (item.type !== "userMessage") continue;

      const userText = sanitizeFilename(extractUserText(item.content));
      if (userText) return userText;
    }
  }

  return sanitizeFilename(thread.id) || fallbackThreadId;
}

function renderUserContent(content = []) {
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "image") return `![image](${part.url})`;
      if (part.type === "localImage") return `![local image](${part.path})`;
      return codeFence(JSON.stringify(part, null, 2), "json");
    })
    .join("\n\n");
}

function renderItem(item, withTools) {
  switch (item.type) {
    case "userMessage":
      return `### User\n\n${renderUserContent(item.content)}\n`;

    case "agentMessage":
      return `### Codex\n\n${item.text || ""}\n`;

    case "plan":
      if (!withTools) return "";
      return `### Plan\n\n${item.text || ""}\n`;

    case "reasoning":
      if (!withTools) return "";
      return `### Reasoning summary\n\n${(item.summary || []).join("\n\n")}\n`;

    case "commandExecution": {
      if (!withTools) return "";
      let out = "### Command\n\n";
      if (item.command) out += codeFence(item.command, "bash");
      if (item.cwd) out += `Working directory: \`${item.cwd}\`\n\n`;
      if (item.aggregatedOutput) out += codeFence(item.aggregatedOutput, "text");
      if (item.exitCode !== undefined) out += `Exit code: \`${item.exitCode}\`\n\n`;
      return out;
    }

    case "fileChange": {
      if (!withTools) return "";
      let out = "### File changes\n\n";
      for (const change of item.changes || []) {
        out += `#### \`${change.path}\`\n\n`;
        out += `Kind: \`${change.kind}\`\n\n`;
        if (change.diff) out += codeFence(change.diff, "diff");
      }
      return out;
    }

    case "webSearch": {
      if (!withTools) return "";
      let out = "### Web search\n\n";
      if (item.query) out += `Query: \`${item.query}\`\n\n`;
      if (item.action) out += codeFence(JSON.stringify(item.action, null, 2), "json");
      return out;
    }

    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabToolCall":
      if (!withTools) return "";
      return `### ${item.type}\n\n${codeFence(JSON.stringify(item, null, 2), "json")}`;

    default:
      if (!withTools) return "";
      return `### ${item.type}\n\n${codeFence(JSON.stringify(item, null, 2), "json")}`;
  }
}

function renderThread(thread, { withTools = false } = {}) {
  const title = thread.name || `Codex thread ${thread.id}`;
  let out = `# ${title}\n\n`;
  out += `Thread ID: \`${thread.id}\`\n\n`;

  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  turns.forEach((turn, index) => {
    out += `## Turn ${index + 1}\n\n`;
    for (const item of turn.items || []) {
      const block = renderItem(item, withTools);
      if (block) out += block + "\n";
    }
  });

  return out.trimEnd() + "\n";
}

async function readThread({
  threadId,
  includeTurns = true,
  ...options
}) {
  const client = createAppServerClient(options);

  try {
    await client.initialize();
    const result = await client.send("thread/read", {
      threadId,
      includeTurns,
    });

    if (!result.thread) {
      throw new Error("No thread returned by thread/read");
    }

    return result.thread;
  } finally {
    await client.close();
  }
}

async function listThreads({
  limit = 30,
  sortKey = "updated_at",
  archived = false,
  cursor = null,
  cwd = null,
  searchTerm = null,
  modelProviders = null,
  sourceKinds = null,
  ...options
} = {}) {
  const client = createAppServerClient(options);

  try {
    await client.initialize();
    const result = await client.send("thread/list", {
      limit,
      sortKey,
      archived,
      cursor,
      cwd,
      searchTerm,
      modelProviders,
      sourceKinds,
    });

    const data = Array.isArray(result.data) ? result.data : [];
    return [...data].sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
  } finally {
    await client.close();
  }
}

async function checkCodexAvailability(options = {}) {
  const client = createAppServerClient(options);

  try {
    await client.initialize();
    return { ok: true };
  } finally {
    await client.close();
  }
}

async function exportThreadToFile({
  threadId,
  outputPath = null,
  outputDir = process.cwd(),
  fileName = null,
  withTools = false,
  ...options
}) {
  const thread = await readThread({ threadId, includeTurns: true, ...options });
  const markdown = renderThread(thread, { withTools });

  const resolvedOutputPath = outputPath
    ? path.resolve(outputPath)
    : path.resolve(outputDir, ensureMarkdownFilename(fileName || getDefaultBasename(thread, threadId)));

  fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
  fs.writeFileSync(resolvedOutputPath, markdown, "utf8");

  return {
    markdown,
    outputPath: resolvedOutputPath,
    thread,
  };
}

module.exports = {
  checkCodexAvailability,
  codeFence,
  createAppServerClient,
  ensureMarkdownFilename,
  exportThreadToFile,
  extractUserText,
  getDefaultBasename,
  listThreads,
  readThread,
  renderThread,
  sanitizeFilename,
  startAppServer,
};
