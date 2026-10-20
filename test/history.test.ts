import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { historyPage, readHistory } from "../src/history.js";

describe("bounded native history replay", () => {
  it("preserves large images, escaped text and Unicode across pages, using only Pi's current branch", async () => {
    const manager = SessionManager.inMemory("/work");
    const root = manager.appendMessage({
      role: "user",
      timestamp: 1,
      content: [
        { type: "text", text: '图😀\\\n\u2028\u2029"'.repeat(200000) },
        {
          type: "image",
          data: "a".repeat(4 * 1024 * 1024),
          mimeType: "image/png",
        },
      ],
    });
    manager.appendMessage({ role: "user", content: "abandoned", timestamp: 2 });
    manager.branch(root);
    manager.appendMessage({ role: "user", content: "current", timestamp: 3 });
    const before = manager.getEntries();
    let pages = 0;
    const entries = await readHistory(async (request) => {
      const page = historyPage(manager, request);
      pages++;
      const notification = {
        type: "extension_ui_request",
        method: "notify",
        message:
          "lody-rpc:" +
          JSON.stringify({ type: "lody_control", id: "id", data: page }),
      };
      expect(JSON.stringify(notification).length).toBeLessThan(
        16 * 1024 * 1024,
      );
      return page;
    });
    expect(pages).toBeGreaterThan(4);
    expect(entries).toEqual(manager.getBranch());
    expect(entries).toHaveLength(2);
    expect(manager.getEntries()).toEqual(before);
  });

  it("rejects a branch change between pages", async () => {
    const manager = SessionManager.inMemory("/work");
    manager.appendMessage({
      role: "user",
      content: "a".repeat(2 * 1024 * 1024),
      timestamp: 1,
    });
    await expect(
      readHistory(async (request) => {
        if (request.cursor)
          manager.appendMessage({
            role: "user",
            content: "changed",
            timestamp: 2,
          });
        return historyPage(manager, request);
      }),
    ).rejects.toThrow("branch changed");
  });

  it("handles an empty branch and rejects invalid cursors", async () => {
    const manager = SessionManager.inMemory("/work");
    expect(
      await readHistory(async (request) => historyPage(manager, request)),
    ).toEqual([]);
    const id = manager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: 1,
    });
    expect(() =>
      historyPage(manager, { cursor: { entryId: id, offset: 0 } }),
    ).toThrow("leaf identity");
    expect(() =>
      historyPage(manager, {
        leafId: id,
        cursor: { entryId: "missing", offset: 0 },
      }),
    ).toThrow("missing");
    expect(() =>
      historyPage(manager, {
        leafId: id,
        cursor: { entryId: id, offset: 100000 },
      }),
    ).toThrow("offset");
  });

  it("rejects incomplete, discontinuous and nonadvancing history", async () => {
    await expect(
      readHistory(async () => ({ chunk: '{"id":', leafId: "a", next: null })),
    ).rejects.toThrow("incomplete branch");
    await expect(
      readHistory(async () => ({
        chunk: '{"id":"a","parentId":"missing"}\n',
        leafId: "a",
        next: null,
      })),
    ).rejects.toThrow("not contiguous");
    await expect(
      readHistory(async () => ({
        chunk: "",
        leafId: "a",
        next: { entryId: "a", offset: 0 },
      })),
    ).rejects.toThrow("did not advance");
  });
});
