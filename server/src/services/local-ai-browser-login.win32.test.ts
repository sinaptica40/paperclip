import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startLocalBrowserLogin } from "./local-ai-browser-login.js";

type Handler<T> = (value: T) => void;
const spawned: Array<{ file: string; args: string[]; env: Record<string, string | undefined> }> = [];
let script: (terminal: FakeTerminal) => void = () => {};

class FakeTerminal {
  written: string[] = [];
  killed = false;
  kills = 0;
  private data: Handler<string>[] = [];
  private exit: Handler<{ exitCode: number }>[] = [];
  onData(cb: Handler<string>) { this.data.push(cb); }
  onExit(cb: Handler<{ exitCode: number }>) { this.exit.push(cb); }
  emit(text: string) { for (const cb of this.data) cb(text); }
  finish(exitCode: number) { for (const cb of this.exit) cb({ exitCode }); }
  write(input: string) { this.written.push(input); }
  kill() { this.killed = true; this.kills += 1; this.finish(1); }
}

vi.mock("node-pty", () => ({
  default: {},
  spawn: vi.fn((file: string, args: string[], options: { env: Record<string, string | undefined> }) => {
    spawned.push({ file, args, env: options.env });
    const terminal = new FakeTerminal();
    queueMicrotask(() => script(terminal));
    return terminal;
  }),
}));
vi.mock("../vendor/paperclip-runner/index.js", () => ({ resolveCodexCommand: vi.fn() }));

const initialPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
let home: string | undefined;
afterEach(async () => {
  Object.defineProperty(process, "platform", initialPlatform);
  spawned.length = 0;
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});

const url = "https://claude.com/cai/oauth/authorize?client_id=cid&code=abcdefgh&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&response_type=code&scope=user&state=0123456789abcdef";

describe("local browser subscription login on Windows", () => {
  it("signs in to Claude through a Windows terminal instead of the Python bridge", async () => {
    Object.defineProperty(process, "platform", { ...initialPlatform, value: "win32" });
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-win-login-"));
    let terminal!: FakeTerminal;
    script = (t) => {
      terminal = t;
      t.emit("Welcome to Claude Code\r\nBrowser didn't open? Use the url below to sign in (c to copy)\r\n");
      t.emit(`${url}\r\n`);
      t.emit("Paste code here if prompted >\r\n");
    };
    vi.stubEnv("ANTHROPIC_API_KEY", "must-not-leak");
    const login = startLocalBrowserLogin("anthropic", home);
    await vi.waitFor(() => expect(login.authorizationUrl).toBe(url), { timeout: 5000 });

    expect(spawned).toHaveLength(1);
    expect(spawned[0].file.toLowerCase()).not.toContain("python");
    expect(spawned[0].args).toContain("setup-token");
    expect(spawned[0].env.CLAUDE_CONFIG_DIR).toBe(home);
    expect(spawned[0].env.ANTHROPIC_API_KEY).toBe("");

    login.submitCode?.("fixture-code");
    await vi.waitFor(() => expect(terminal.written).toEqual(["fixture-code", "\r"]), { timeout: 5000 });
    terminal.emit("✓ Long-lived authentication token created successfully!\r\n\r\nYour OAuth token (valid for 1 year):\r\n\r\nsk-ant-oat01-AAAABBBBCCCCDDDDEEEE11112222FFFFGGGG_HHHH-IIII\r\n\r\nStore this token securely. You won't be able to see it again.\r\n");
    await new Promise((resolve) => setTimeout(resolve, 100));
    terminal.finish(0);
    await vi.waitFor(() => expect(login.outcome).toBe("success"), { timeout: 5000 });
    const credential = JSON.parse(await readFile(path.join(home, ".credentials.json"), "utf8"));
    expect(credential.claudeAiOauth.accessToken).toMatch(/^sk-ant-oat01-/);
  });

  it("stops the Windows terminal when sign-in is cancelled", async () => {
    Object.defineProperty(process, "platform", { ...initialPlatform, value: "win32" });
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-win-login-"));
    let terminal!: FakeTerminal;
    script = (t) => { terminal = t; t.emit(`Browser didn't open? Use the url below to sign in (c to copy)\r\n${url}\r\nPaste code here if prompted >\r\n`); };
    const login = startLocalBrowserLogin("anthropic", home);
    await vi.waitFor(() => expect(login.authorizationUrl).toBe(url), { timeout: 5000 });
    login.abort();
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    // Closing a ConPTY twice can crash the server, so it must be closed once.
    expect(terminal.kills).toBe(1);
  });
});
