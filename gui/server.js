const http = require("node:http");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const {
  checkCodexAvailability,
  exportThreadToFile,
  listThreads,
} = require("../script/export-core");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const SETTINGS_PATH = path.resolve(__dirname, "..", ".ai", "gui-settings.json");

function normalizeSettings(settings = {}) {
  return {
    defaultOutputDir: settings.defaultOutputDir || null,
  };
}

async function loadSettingsFromDisk(settingsPath = SETTINGS_PATH) {
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    return normalizeSettings(JSON.parse(raw));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return normalizeSettings();
    }
    throw error;
  }
}

async function saveSettingsToDisk(settings, settingsPath = SETTINGS_PATH) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(normalizeSettings(settings), null, 2)}\n`, "utf8");
  return normalizeSettings(settings);
}

async function pickDirectoryWithPowerShell({ execFileImpl = execFile } = {}) {
  if (process.platform !== "win32") {
    throw new Error("native directory picker is currently implemented only on Windows");
  }

  // Use IFileOpenDialog COM interface with FOS_PICKFOLDERS for a modern
  // Explorer-style folder picker (breadcrumb bar, search, favorites).
  // GetForegroundWindow() is used as the owner handle to keep the dialog
  // in front of the current window (fixes z-order issues).
  const csharpSource = `
using System;
using System.Runtime.InteropServices;

[Flags]
public enum FOS : uint {
    PICKFOLDERS       = 0x00000020,
    FORCEFILESYSTEM   = 0x00000040,
    NOCHANGEDIR       = 0x00000008,
    PATHMUSTEXIST     = 0x00000800
}

public enum SIGDN : uint {
    FILESYSPATH = 0x80058000
}

[ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IFileDialog {
    [PreserveSig] int Show(IntPtr hwndOwner);
    void SetFileTypes();
    void SetFileTypeIndex();
    void GetFileTypeIndex();
    void Advise();
    void Unadvise();
    void SetOptions(FOS fos);
    void GetOptions(out FOS fos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
}

[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellItem {
    void BindToHandler();
    void GetParent();
    void GetDisplayName(SIGDN sigdnName,
        [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes();
    void Compare();
}

[ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7"),
 ClassInterface(ClassInterfaceType.None)]
public class FileOpenDialog {}

public static class FolderPicker {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("shcore.dll")]
    static extern int SetProcessDpiAwareness(int awareness);

    public static string ShowDialog(string title) {
        try { SetProcessDpiAwareness(2); } catch {}
        var dialog = (IFileDialog)new FileOpenDialog();
        dialog.SetOptions(
            FOS.PICKFOLDERS |
            FOS.FORCEFILESYSTEM |
            FOS.NOCHANGEDIR |
            FOS.PATHMUSTEXIST);
        dialog.SetTitle(title);

        int hr = dialog.Show(GetForegroundWindow());
        if (hr != 0) return string.Empty;

        IShellItem item;
        dialog.GetResult(out item);
        string path;
        item.GetDisplayName(SIGDN.FILESYSPATH, out path);
        return path;
    }
}
`;

  const command = [
    `Add-Type -TypeDefinition @'\n${csharpSource}\n'@`,
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Write-Output ([FolderPicker]::ShowDialog('Select default Markdown export folder'))",
  ].join("; ");

  return await new Promise((resolve, reject) => {
    execFileImpl(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", command],
      { windowsHide: false },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message || String(error)).trim()));
          return;
        }

        const selectedPath = String(stdout || "").trim();
        resolve(selectedPath || null);
      },
    );
  });
}

function createDefaultBackend({
  checkHealthImpl = checkCodexAvailability,
  exportThreadToFileImpl = exportThreadToFile,
  listThreadsImpl = listThreads,
  loadSettings = loadSettingsFromDisk,
  pickDirectory = pickDirectoryWithPowerShell,
  saveSettings = saveSettingsToDisk,
} = {}) {
  async function getSettings() {
    return normalizeSettings(await loadSettings());
  }

  return {
    async checkHealth() {
      return checkHealthImpl();
    },
    async getSettings() {
      return getSettings();
    },
    async listThreads() {
      const threads = await listThreadsImpl({
        archived: false,
        limit: 30,
        sortKey: "updated_at",
      });

      return threads.map((thread) => ({
        id: thread.id,
        name: thread.name,
        preview: thread.preview,
        updatedAt: thread.updatedAt,
        cwd: thread.cwd,
      }));
    },
    async selectDefaultOutputDirectory() {
      const selectedPath = await pickDirectory();
      if (!selectedPath) {
        return {
          ...await getSettings(),
          cancelled: true,
        };
      }

      await saveSettings({
        defaultOutputDir: selectedPath,
      });

      return {
        defaultOutputDir: selectedPath,
      };
    },
    async exportThread({ fileName, threadId, withTools }) {
      const settings = await getSettings();
      if (!settings.defaultOutputDir) {
        throw new Error("default output directory is not configured");
      }

      const result = await exportThreadToFileImpl({
        threadId,
        fileName,
        outputDir: settings.defaultOutputDir,
        withTools,
      });

      return {
        outputPath: result.outputPath,
        threadTitle: result.thread.name || result.thread.id,
      };
    },
  };
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  res.end(body);
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "content-length": Buffer.byteLength(body),
    "content-type": contentType,
  });
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function getStaticAsset(publicDir, pathname) {
  const target = pathname === "/" ? "/index.html" : pathname;
  const resolvedPath = path.resolve(publicDir, `.${target}`);

  if (!resolvedPath.startsWith(path.resolve(publicDir))) {
    return null;
  }

  return resolvedPath;
}

function getContentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  return "application/octet-stream";
}

async function handleRequest(req, res, { backend, publicDir }) {
  const url = new URL(req.url, "http://127.0.0.1");

  if (req.method === "GET" && url.pathname === "/api/health") {
    try {
      sendJson(res, 200, await backend.checkHealth());
    } catch (error) {
      sendJson(res, 503, {
        ok: false,
        error: error.message || String(error),
      });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/settings") {
    try {
      sendJson(res, 200, await backend.getSettings());
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error.message || String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/settings/default-output-directory/select") {
    try {
      const result = await backend.selectDefaultOutputDirectory();
      sendJson(res, 200, {
        ok: !result.cancelled,
        defaultOutputDir: result.defaultOutputDir || null,
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error.message || String(error),
      });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/threads") {
    try {
      sendJson(res, 200, { threads: await backend.listThreads() });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error.message || String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/export") {
    let payload;
    try {
      payload = JSON.parse((await readRequestBody(req)) || "{}");
    } catch {
      sendJson(res, 400, {
        ok: false,
        error: "request body must be valid JSON",
      });
      return;
    }

    if (!payload.threadId || !String(payload.threadId).trim()) {
      sendJson(res, 400, {
        ok: false,
        error: "threadId is required",
      });
      return;
    }

    try {
      const exportInput = {
        threadId: String(payload.threadId).trim(),
        withTools: Boolean(payload.withTools),
      };

      if (payload.fileName) {
        exportInput.fileName = String(payload.fileName);
      }

      const result = await backend.exportThread(exportInput);

      sendJson(res, 200, {
        ok: true,
        outputPath: result.outputPath,
        threadTitle: result.threadTitle,
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error.message || String(error),
      });
    }
    return;
  }

  if (req.method === "GET") {
    const assetPath = getStaticAsset(publicDir, url.pathname);
    if (!assetPath || !fs.existsSync(assetPath) || fs.statSync(assetPath).isDirectory()) {
      sendText(res, 404, "Not Found");
      return;
    }

    sendText(res, 200, fs.readFileSync(assetPath, "utf8"), getContentType(assetPath));
    return;
  }

  sendText(res, 405, "Method Not Allowed");
}

async function startServer({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  backend = createDefaultBackend(),
  publicDir = path.join(__dirname, "public"),
} = {}) {
  const server = http.createServer((req, res) => {
    handleRequest(req, res, { backend, publicDir }).catch((error) => {
      sendJson(res, 500, {
        ok: false,
        error: error.message || String(error),
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const serverPort = typeof address === "object" && address ? address.port : port;

  return {
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    host,
    port: serverPort,
    server,
    url: `http://${host}:${serverPort}`,
  };
}

if (require.main === module) {
  startServer({
    host: process.env.HOST || DEFAULT_HOST,
    port: process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT,
  })
    .then((app) => {
      console.log(`Codex Chat Export v0.1.0 running at ${app.url}`);
      console.log(`Settings file: ${SETTINGS_PATH}`);
    })
    .catch((error) => {
      console.error(error.message || error);
      process.exit(1);
    });
}

module.exports = {
  SETTINGS_PATH,
  createDefaultBackend,
  loadSettingsFromDisk,
  pickDirectoryWithPowerShell,
  saveSettingsToDisk,
  startServer,
};

