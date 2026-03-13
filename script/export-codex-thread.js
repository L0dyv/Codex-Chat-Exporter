#!/usr/bin/env node

const path = require("node:path");

const { exportThreadToFile } = require("./export-core");

const argv = process.argv.slice(2);
if (argv.length < 1) {
  console.error("Usage: node export-codex-thread.js <THREAD_ID> [OUT.md] [--with-tools]");
  process.exit(1);
}

const threadId = argv[0];
const explicitOutPath = argv[1] && !argv[1].startsWith("--") ? argv[1] : null;
const withTools = argv.includes("--with-tools");

async function main() {
  const result = await exportThreadToFile({
    threadId,
    outputPath: explicitOutPath,
    withTools,
  });

  console.log(`Wrote ${explicitOutPath || path.basename(result.outputPath)}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
