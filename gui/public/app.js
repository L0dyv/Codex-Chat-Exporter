const state = {
  defaultOutputDir: null,
  selectedThreadId: null,
  threads: [],
};

const elements = {
  chooseDirectoryButton: document.getElementById("choose-directory-button"),
  exportForm: document.getElementById("export-form"),
  fileNameInput: document.getElementById("file-name"),
  modalChooseDirectoryButton: document.getElementById("modal-choose-directory-button"),
  outputDirDisplay: document.getElementById("output-dir-display"),
  refreshButton: document.getElementById("refresh-button"),
  result: document.getElementById("result"),
  setupModal: document.getElementById("setup-modal"),
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  submitButton: document.getElementById("submit-button"),
  threadIdInput: document.getElementById("thread-id"),
  threadList: document.getElementById("thread-list"),
  withToolsInput: document.getElementById("with-tools"),
};

function setStatus(kind, text) {
  elements.statusText.textContent = text;
  elements.statusDot.className = `status-dot status-${kind}`;
}

function setResult(message, tone = "neutral") {
  elements.result.className = `result-box-body result-${tone}`;
  elements.result.textContent = message;
  const box = elements.result.closest(".result-box");
  if (box) {
    box.className = `result-box result-box--${tone}`;
  }
}

function deriveFileName(thread) {
  return thread.name || thread.id;
}

function formatTimestamp(unixSeconds) {
  if (!unixSeconds) return "Unknown update time";
  return new Date(unixSeconds * 1000).toLocaleString();
}

function updateExportAvailability() {
  elements.submitButton.disabled = !state.defaultOutputDir;
}

function renderDefaultOutputDirectory() {
  elements.outputDirDisplay.textContent = state.defaultOutputDir || "Not configured yet.";
  elements.chooseDirectoryButton.textContent = state.defaultOutputDir ? "Change Folder" : "Choose Folder";
  elements.setupModal.classList.toggle("hidden", Boolean(state.defaultOutputDir));
  updateExportAvailability();
}

function selectThread(thread) {
  state.selectedThreadId = thread.id;
  elements.threadIdInput.value = thread.id;
  elements.fileNameInput.value = deriveFileName(thread);
  renderThreadList();
}

function renderThreadList() {
  if (!state.threads.length) {
    elements.threadList.innerHTML = '<p class="empty-state">No recent threads available. You can still export by manually entering a thread ID.</p>';
    return;
  }

  elements.threadList.innerHTML = state.threads
    .map((thread) => {
      const cardClass = thread.id === state.selectedThreadId ? "thread-card active" : "thread-card";
      return `
        <button class="${cardClass}" type="button" data-thread-id="${thread.id}">
          <strong>${thread.name || "Untitled Thread"}</strong>
          <p>${thread.preview || "No preview available."}</p>
          <div class="thread-meta">
            <span>${formatTimestamp(thread.updatedAt)}</span>
            <span>${thread.cwd || "Unknown cwd"}</span>
          </div>
        </button>
      `;
    })
    .join("");

  for (const button of elements.threadList.querySelectorAll("[data-thread-id]")) {
    button.addEventListener("click", () => {
      const thread = state.threads.find((item) => item.id === button.dataset.threadId);
      if (thread) {
        selectThread(thread);
      }
    });
  }
}

async function fetchSettings() {
  const response = await fetch("/api/settings");
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Failed to load settings");
  }

  state.defaultOutputDir = payload.defaultOutputDir || null;
  renderDefaultOutputDirectory();
}

async function fetchThreads() {
  const response = await fetch("/api/threads");
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Failed to load threads");
  }

  state.threads = payload.threads || [];
  renderThreadList();
}

async function fetchHealth() {
  const response = await fetch("/api/health");
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Codex is unavailable");
  }
}

async function ensureDefaultOutputDirectory() {
  if (state.defaultOutputDir) {
    renderDefaultOutputDirectory();
    return;
  }

  renderDefaultOutputDirectory();
  setResult("Choose a default save directory before exporting Markdown.", "error");
}

async function chooseDefaultDirectory() {
  elements.chooseDirectoryButton.disabled = true;
  elements.modalChooseDirectoryButton.disabled = true;
  setResult("Opening the folder picker...", "neutral");

  try {
    const response = await fetch("/api/settings/default-output-directory/select", {
      method: "POST",
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Failed to choose directory");
    }

    state.defaultOutputDir = payload.defaultOutputDir || null;
    renderDefaultOutputDirectory();

    if (!state.defaultOutputDir) {
      setResult("No folder selected. Export remains unavailable until a default directory is configured.", "error");
      return;
    }

    setResult(`Default save directory set to ${state.defaultOutputDir}`, "ok");
  } catch (error) {
    setResult(error.message, "error");
  } finally {
    elements.chooseDirectoryButton.disabled = false;
    elements.modalChooseDirectoryButton.disabled = false;
  }
}

async function refreshAll() {
  setStatus("idle", "Checking...");

  try {
    await fetchHealth();
    setStatus("ok", "Ready");
  } catch (error) {
    setStatus("error", "Unavailable");
    setResult(error.message, "error");
    state.threads = [];
    renderThreadList();
    return;
  }

  try {
    await fetchSettings();
    await fetchThreads();
    await ensureDefaultOutputDirectory();

    if (state.defaultOutputDir && !state.threads.length) {
      setResult("No recent threads returned. Manual export is still available.", "neutral");
    }
  } catch (error) {
    setResult(error.message, "error");
    state.threads = [];
    renderThreadList();
  }
}

async function handleExport(event) {
  event.preventDefault();

  if (!state.defaultOutputDir) {
    setResult("Choose a default save directory before exporting Markdown.", "error");
    return;
  }

  const payload = {
    threadId: elements.threadIdInput.value.trim(),
    fileName: elements.fileNameInput.value.trim(),
    withTools: elements.withToolsInput.checked,
  };

  elements.submitButton.disabled = true;
  elements.submitButton.classList.add("is-loading");
  setResult("Exporting Markdown...", "neutral");

  try {
    const response = await fetch("/api/export", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Export failed");
    }

    setResult(`Exported ${result.threadTitle} to ${result.outputPath}`, "ok");
  } catch (error) {
    setResult(error.message, "error");
  } finally {
    elements.submitButton.classList.remove("is-loading");
    updateExportAvailability();
  }
}

elements.chooseDirectoryButton.addEventListener("click", () => {
  chooseDefaultDirectory().catch((error) => {
    setResult(error.message, "error");
  });
});

elements.modalChooseDirectoryButton.addEventListener("click", () => {
  chooseDefaultDirectory().catch((error) => {
    setResult(error.message, "error");
  });
});

elements.refreshButton.addEventListener("click", () => {
  refreshAll().catch((error) => {
    setResult(error.message, "error");
  });
});

elements.exportForm.addEventListener("submit", (event) => {
  handleExport(event).catch((error) => {
    setResult(error.message, "error");
    updateExportAvailability();
  });
});

refreshAll().catch((error) => {
  setStatus("error", "Unavailable");
  setResult(error.message, "error");
});
