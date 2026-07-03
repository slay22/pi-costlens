/**
 * Git context detection.
 *
 * Used to map the current working directory to a feature id (= branch name,
 * or "unassigned" for main / detached HEAD / no git).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAIN_BRANCHES = new Set(["main", "master", "develop", "dev"]);

export type GitContext = {
  isRepo: boolean;
  branch: string | null; // null when not a repo, or in detached HEAD
  isMainBranch: boolean;
};

/** Best-effort detection. Never throws — falls back to "not a repo". */
export async function detectGitContext(cwd: string): Promise<GitContext> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd, timeout: 2000 }
    );
    const branch = stdout.trim();
    if (!branch || branch === "HEAD") {
      // Detached HEAD or empty repo
      return { isRepo: true, branch: null, isMainBranch: false };
    }
    return {
      isRepo: true,
      branch,
      isMainBranch: MAIN_BRANCHES.has(branch),
    };
  } catch {
    return { isRepo: false, branch: null, isMainBranch: false };
  }
}
