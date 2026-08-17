/**
 * Git context detection — opencode adapter.
 * Same logic as pi-costlens's extension/git.ts; tool-agnostic code,
 * will move to @costlens/core in v1.5 (MULTI-TOOL.md §8).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAIN_BRANCHES = new Set(["main", "master", "develop", "dev"]);

export type GitContext = {
  isRepo: boolean;
  branch: string | null;
  isMainBranch: boolean;
};

/** Best-effort. Never throws — falls back to "not a repo". */
export async function detectGitContext(cwd: string): Promise<GitContext> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd, timeout: 2000 }
    );
    const branch = stdout.trim();
    if (!branch || branch === "HEAD") {
      return { isRepo: true, branch: null, isMainBranch: false };
    }
    return { isRepo: true, branch, isMainBranch: MAIN_BRANCHES.has(branch) };
  } catch {
    return { isRepo: false, branch: null, isMainBranch: false };
  }
}
