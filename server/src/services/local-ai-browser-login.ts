import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { open } from "node:fs/promises";
import { constants, existsSync, statSync } from "node:fs";
import path from "node:path";
import { runSetupTokenLogin } from "@paperclipai/adapter-claude-local/server";
import { runDeviceLogin } from "@paperclipai/adapter-codex-local/server";
import { ensureCommandResolvable, resolveCommandForLogs } from "@paperclipai/adapter-utils/server-utils";
import { resolveCodexCommand, startAntigravityBrowserLogin } from "../vendor/paperclip-runner/index.js";
import { createConPtyOutputNormalizer } from "./conpty-output.js";

export type LocalBrowserLoginState = {
  authorizationUrl?: string;
  code?: string;
  outcome?: "success" | "failure";
  error?: string;
  submitCode?: (code: string) => void;
  abort: () => void;
};

// Node has no built-in PTY API. Python's standard-library pty module supplies
// the terminal required by both CLIs. The Docker image already includes
// python3. This bridge forwards only bytes; provider output is never logged.
const PYTHON_PTY_BRIDGE = String.raw`
import errno, os, pty, select, signal, sys
pid, master = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
def stop(_signal, _frame):
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    sys.exit(1)
signal.signal(signal.SIGTERM, stop)
while True:
    readable, _, _ = select.select([master, 0], [], [])
    if 0 in readable:
        data = os.read(0, 4096)
        if data: os.write(master, data)
        else: stop(None, None)
    if master in readable:
        try: data = os.read(master, 4096)
        except OSError as error:
            if error.errno == errno.EIO: break
            raise
        if not data: break
        os.write(1, data)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

type LoginTerminal = { write(input: string): void; kill(): void };

/** Find an executable the way Windows does, because node-pty needs a full path. */
function resolveWindowsExecutable(command: string, env: NodeJS.ProcessEnv): string | null {
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const hasExtension = extensions.some((extension) => command.toLowerCase().endsWith(extension.toLowerCase()));
  const directories = path.isAbsolute(command) ? [""] : (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const base = directory ? path.join(directory, command) : command;
    for (const candidate of hasExtension ? [base] : extensions.map((extension) => base + extension)) {
      try { if (existsSync(candidate) && statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
    }
  }
  return null;
}

/**
 * Windows has no Python pty module, so the provider CLI runs in a ConPTY through
 * node-pty. It is loaded only here, so other platforms never need the package.
 */
async function startWindowsTerminal(
  executable: string, args: string[], env: NodeJS.ProcessEnv,
  onData: (chunk: string) => void, attach: (terminal: LoginTerminal) => void,
): Promise<{ exitCode: number | null }> {
  const file = resolveWindowsExecutable(executable, env);
  if (!file) throw new Error("Browser login executable not found");
  const pty = await import("node-pty");
  // A .cmd or .bat launcher must run through the command interpreter.
  const script = /\.(cmd|bat)$/i.test(file);
  const [command, commandArgs] = script ? [env.ComSpec ?? "cmd.exe", ["/d", "/c", file, ...args]] : [file, args];
  // A wide terminal keeps the long sign-in URL on one row.
  const terminal = pty.spawn(command, commandArgs, {
    name: "xterm-256color", cols: 500, rows: 50, cwd: process.cwd(),
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
  });
  let exited = false;
  let killed = false;
  // Stop and dispose both ask for a kill. Closing a pseudoconsole twice can crash
  // the whole server process, so only the first request reaches node-pty.
  attach({
    write: (input) => { if (!exited && !killed) terminal.write(input); },
    kill: () => { if (exited || killed) return; killed = true; try { terminal.kill(); } catch { /* already gone */ } },
  });
  const normalize = createConPtyOutputNormalizer();
  terminal.onData((chunk) => onData(normalize(chunk)));
  return new Promise((resolve) => terminal.onExit(({ exitCode }) => { exited = true; resolve({ exitCode }); }));
}

/** Run the same browser-code login used by sandbox connections on the local host. */
export function startLocalBrowserLogin(provider: "anthropic" | "openai" | "google", home: string): LocalBrowserLoginState {
  if (provider === "google") return startAntigravityBrowserLogin(home);
  const controller = new AbortController();
  const state: LocalBrowserLoginState = { abort: () => controller.abort() };
  const args = provider === "anthropic" ? ["setup-token"] : ["login", "--device-auth"];
  let terminal: LoginTerminal | null = null;
  const driver = {
    async start(_command: string, onData: (chunk: string) => void): Promise<{ exitCode: number | null }> {
      let executable = "claude";
      if (provider === "openai") {
        const legacyPlatform = !((process.platform === "linux" || process.platform === "darwin")
          && (process.arch === "x64" || process.arch === "arm64"));
        try {
          if (legacyPlatform) {
            await ensureCommandResolvable("codex", home, process.env);
            executable = path.resolve(home, await resolveCommandForLogs("codex", home, process.env));
          } else {
            executable = resolveCodexCommand();
          }
        } catch {
          state.error = legacyPlatform
            ? "Codex browser sign-in requires the Codex CLI on this platform. Install Codex on this execution host and ensure codex is on Paperclip's PATH, then start sign-in again."
            : "Codex browser sign-in requires an installed Codex CLI. Install Codex on this execution host or restore Paperclip's runtime dependencies, then start sign-in again.";
          throw new Error("Browser login runtime unavailable");
        }
      }
      if (controller.signal.aborted) throw new Error("Local sign-in cancelled before launch");
      const env = { ...process.env,
        ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "",
        OPENAI_API_KEY: "", CODEX_API_KEY: "",
        CLAUDE_CONFIG_DIR: provider === "anthropic" ? home : process.env.CLAUDE_CONFIG_DIR,
        CODEX_HOME: provider === "openai" ? home : process.env.CODEX_HOME,
        BROWSER: "true",
      };
      if (process.platform === "win32") {
        try {
          return await startWindowsTerminal(executable, args, env, onData, (attached) => { terminal = attached; });
        } catch {
          state.error = "Browser sign-in could not start a Windows terminal. Make sure the CLI is installed and on Paperclip's PATH, then start sign-in again.";
          throw new Error("Browser login terminal unavailable");
        }
      }
      return new Promise((resolve, reject) => {
        const child: ChildProcessWithoutNullStreams = spawn("python3", ["-u", "-c", PYTHON_PTY_BRIDGE, executable, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
        terminal = { write: (input) => { child.stdin.write(input); }, kill: () => { child.kill("SIGTERM"); } };
        child.stdout.on("data", (bytes: Buffer) => onData(bytes.toString("utf8")));
        // Provider output may contain secrets. Never log or retain stderr.
        child.stderr.resume();
        child.once("error", () => {
          state.error = "Browser sign-in requires Python 3 and a working local terminal. Install Python 3 on this execution host, then start sign-in again.";
          reject(new Error("Browser login terminal unavailable"));
        });
        child.once("close", (exitCode) => resolve({ exitCode }));
      });
    },
    write(input: string) { terminal?.write(input); },
    stop() { terminal?.kill(); },
    async dispose() { terminal?.kill(); },
    async readFile(file: string) { const { readLocalAiCredentialFile } = await import("./local-ai-credential-file.js"); return Buffer.from(await readLocalAiCredentialFile(file)); },
  };
  if (provider === "anthropic") {
    let deliverCode: ((code: string) => void) | undefined;
    const codeReady = new Promise<string>((resolve) => { deliverCode = resolve; });
    state.submitCode = (code) => { deliverCode?.(code); deliverCode = undefined; };
    void runSetupTokenLogin(driver, {
      timeoutMs: 300_000, signal: controller.signal,
      onPrompt: (prompt) => { state.authorizationUrl = prompt.url; },
      provideCode: (signal) => new Promise<string>((resolve, reject) => {
        const abort = () => reject(new Error("Local sign-in cancelled"));
        if (signal.aborted) { abort(); return; }
        signal.addEventListener("abort", abort, { once: true });
        codeReady.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      }),
      onCredential: async (bytes) => {
        const file = await open(path.join(home, ".credentials.json"),
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try {
          await file.writeFile(JSON.stringify({ claudeAiOauth: { accessToken: bytes.toString("utf8") } }));
        } finally {
          await file.close();
        }
      },
    }).then((result) => { state.outcome = result.outcome === "success" ? "success" : "failure"; })
      .catch(() => { state.outcome = "failure"; });
  } else {
    void runDeviceLogin(driver, {
      timeoutMs: 300_000, signal: controller.signal,
      onPrompt: (prompt) => { state.authorizationUrl = prompt.url; state.code = prompt.code; },
    }).then((result) => { state.outcome = result.outcome === "success" ? "success" : "failure"; })
      .catch(() => { state.outcome = "failure"; });
  }
  return state;
}
