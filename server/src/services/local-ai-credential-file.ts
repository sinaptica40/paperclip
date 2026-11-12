import { open, lstat, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { openRunnerApiWorkspaceFile } from "./native-runtime/runner-api-files.js";

const MAX_CREDENTIAL_BYTES = 64 * 1024;

/**
 * Windows has no Unix owner or mode bits, so the POSIX confinement cannot be
 * used there. The login home lives under the user's own profile, which Windows
 * already restricts to that user. This open refuses a path that goes through a
 * symlink or junction, then checks that the descriptor it opened is the same
 * file it inspected, so the path cannot be swapped between the check and the read.
 */
async function openWindowsCredentialFile(filename: string): Promise<FileHandle> {
  if (!path.isAbsolute(filename)) throw new Error("Credential file must have an absolute path");
  const before = await lstat(filename, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("Invalid credential file");
  const canonical = await realpath(filename);
  if (path.normalize(canonical).toLowerCase() !== path.normalize(filename).toLowerCase()) {
    throw new Error("Invalid credential file");
  }
  const file = await open(filename, "r");
  try {
    const opened = await file.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("Invalid credential file");
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

/** Bounded descriptor read; never follows symlinks or reopens a checked path. */
export async function readLocalAiCredentialFile(filename: string): Promise<string> {
  const windows = process.platform === "win32";
  const file = windows ? await openWindowsCredentialFile(filename) : await openRunnerApiWorkspaceFile(filename);
  try {
    const stat = await file.stat();
    // Owner and 0600 are Unix concepts; Windows relies on the profile ACL above.
    const ownedPrivately = windows || (stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600);
    if (!stat.isFile() || !ownedPrivately || stat.size > MAX_CREDENTIAL_BYTES) {
      throw new Error("Invalid credential file");
    }
    const bytes = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > MAX_CREDENTIAL_BYTES) throw new Error("Invalid credential file");
    return bytes.subarray(0, size).toString("utf8");
  } finally {
    await file.close();
  }
}
