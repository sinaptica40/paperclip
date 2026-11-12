import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readLocalAiCredentialFile } from "./local-ai-credential-file.js";

// Windows has no Unix owner or 0600 mode bits. These tests run only there and
// cover the Windows branch; the POSIX branch keeps its strict checks.
let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

describe.runIf(process.platform === "win32")("local credential files on Windows", () => {
  it("reads a regular credential file inside the login home", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-win-cred-"));
    const file = path.join(root, ".credentials.json");
    await writeFile(file, '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-x"}}');
    await expect(readLocalAiCredentialFile(file)).resolves.toContain("sk-ant-oat01-x");
  });

  it("rejects a directory and an oversized file", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-win-cred-"));
    const dir = path.join(root, "dir.json");
    await mkdir(dir);
    await expect(readLocalAiCredentialFile(dir)).rejects.toThrow();
    const big = path.join(root, "big.json");
    await writeFile(big, "x".repeat(64 * 1024 + 1));
    await expect(readLocalAiCredentialFile(big)).rejects.toThrow("Invalid credential file");
  });

  it("rejects a relative path", async () => {
    await expect(readLocalAiCredentialFile("relative.json")).rejects.toThrow();
  });
});
