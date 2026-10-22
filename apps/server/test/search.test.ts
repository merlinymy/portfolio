/**
 * Merging the two rankings (src/rag/search.ts), without the database. The search itself is tested
 * against the real passages by npm run test:search.
 * Run: npm test -w @portfolio/server
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fuse } from "../src/rag/search.ts";

test("a passage near the top of both rankings beats one at the top of only one", () => {
  const merged = fuse([
    ["only-meaning", "both", "c"],
    ["only-keyword", "both", "d"],
  ]).map((m) => m.id);
  assert.equal(merged[0], "both");
});

test("a passage in only one ranking still counts", () => {
  const merged = fuse([["a", "b"], []]);
  assert.deepEqual(
    merged.map((m) => m.id),
    ["a", "b"],
  );
  assert.ok(merged[0].score > merged[1].score);
});

test("ties are broken the same way every time", () => {
  const once = fuse([["x"], ["y"]]).map((m) => m.id);
  const again = fuse([["y"], ["x"]]).map((m) => m.id);
  assert.deepEqual(once, again);
});
