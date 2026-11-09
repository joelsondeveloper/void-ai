import assert from "node:assert/strict";
import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { UsageWindows } from "../src/governance/UsageWindows.js";

test("usage windows slide independently and survive reopening the database", () => {
  const directory = mkdtempSync(join(tmpdir(), "void-usage-"));
  const filename = join(directory, "usage.sqlite");
  const hour = 3_600_000;
  let now = 200 * hour;
  const initial = new UsageWindows(filename, () => now);
  initial.record({ inputTokens: 8, outputTokens: 12, reasoningTokens: 4 }, false);
  now += 5 * hour;
  initial.record(undefined, true);
  initial.close();
  const reopened = new UsageWindows(filename, () => now);
  try {
    assert.deepEqual(reopened.snapshot().map(({ attempts, unknownUsage, reasoningTokens }) =>
      [attempts, unknownUsage, reasoningTokens]), [[1, 1, 0], [2, 1, 4]]);
    now += 163 * hour;
    assert.deepEqual(reopened.snapshot().map(({ attempts, outputTokens }) => [attempts, outputTokens]), [[0, 0], [1, 0]]);
  } finally {
    reopened.close();
    rmSync(filename);
    rmdirSync(directory);
  }
});
