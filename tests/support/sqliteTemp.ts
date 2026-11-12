import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const directories = new Set<string>();

// node:test runs after() hooks in registration order, and Windows cannot unlink a SQLite file that is still open.
// A "remove the directory" hook registered before the "close the database" hook therefore fails with EBUSY there.
// Removing at process exit runs after every hook of every test in the file, on any platform.
process.once("exit", () => {
  for (const directory of directories) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      process.stderr.write(`# temp directory left behind, a handle is still open: ${directory}\n`);
    }
  }
});

/** A fresh temp directory, removed when the test process exits. */
export function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.add(directory);
  return directory;
}

/** Whether the SQLite bundled with this Node was built with FTS5. Node 22.14 on Windows, for one, was not. */
export const hasFts5: boolean = (() => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE probe USING fts5(x)");
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
})();

/** `skip` option for tests that force the FTS5 search path: false when it can run, otherwise the reason. */
export const withoutFts5: false | string = hasFts5 ? false : "o SQLite deste Node não tem FTS5";

/** A search mode this runtime has, for tests that are not about the search path. */
export const anySearchMode: "fts5" | "fallback" = hasFts5 ? "fts5" : "fallback";
