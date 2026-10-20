import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { HistoryPager, readHistory } from "../src/history.js";

describe("bounded native history replay", () => {
  it.each([
    { count: 1, size: 15 * 1024 * 1024 },
    { count: 256, size: 128 * 1024 },
  ])(
    "traverses a branch once and serializes each entry once ($count entries)",
    async ({ count, size }) => {
      let serializations = 0;
      const text = "a".repeat(size);
      const branch = Array.from({ length: count }, (_, index) => ({
        id: `entry-${index}`,
        parentId: index ? `entry-${index - 1}` : null,
        toJSON() {
          serializations++;
          return { id: this.id, parentId: this.parentId, text };
        },
      }));
      const source = {
        getBranch: vi.fn(() => branch),
        getLeafId: () => branch.at(-1)!.id,
      };
      const pager = new HistoryPager();
      const entries = await readHistory(async (request) =>
        pager.page(source, request),
      );
      expect(entries).toHaveLength(count);
      expect(source.getBranch).toHaveBeenCalledTimes(1);
      expect(serializations).toBe(count);
    },
  );

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
    const pager = new HistoryPager();
    const entries = await readHistory(async (request) => {
      const page = pager.page(manager, request);
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
    const pager = new HistoryPager();
    await expect(
      readHistory(async (request) => {
        if (request.cursor)
          manager.appendMessage({
            role: "user",
            content: "changed",
            timestamp: 2,
          });
        return pager.page(manager, request);
      }),
    ).rejects.toThrow("branch changed");
  });

  it("handles an empty branch and rejects invalid cursors", async () => {
    const manager = SessionManager.inMemory("/work");
    const pager = new HistoryPager();
    expect(
      await readHistory(async (request) => pager.page(manager, request)),
    ).toEqual([]);
    const id = manager.appendMessage({
      role: "user",
      content: "hello".repeat(300000),
      timestamp: 1,
    });
    expect(() =>
      pager.page(manager, { cursor: { entryId: id, offset: 0 } }),
    ).toThrow("leaf identity");
    pager.page(manager, {});
    expect(() =>
      pager.page(manager, {
        leafId: id,
        cursor: { entryId: "missing", offset: 0 },
      }),
    ).toThrow("missing");
    pager.page(manager, {});
    expect(() =>
      pager.page(manager, {
        leafId: id,
        cursor: { entryId: id, offset: 100000 },
      }),
    ).toThrow("offset");
  });

  it("releases replay state on completion, explicit close, reset and invalid continuation", () => {
    const manager = SessionManager.inMemory("/work");
    manager.appendMessage({
      role: "user",
      content: "a".repeat(2 * 1024 * 1024),
      timestamp: 1,
    });
    for (const reason of ["complete", "close", "reset", "error"]) {
      const pager = new HistoryPager();
      const first = pager.page(manager, {});
      expect(first.next).not.toBeNull();
      const continuation = { cursor: first.next!, leafId: first.leafId };
      if (reason === "complete") {
        let page = first;
        while (page.next)
          page = pager.page(manager, {
            cursor: page.next,
            leafId: page.leafId,
          });
      } else if (reason === "close") {
        pager.page(manager, { close: true });
      } else if (reason === "reset") {
        pager.clear();
      } else {
        expect(() =>
          pager.page(manager, {
            ...continuation,
            cursor: {
              ...continuation.cursor,
              offset: continuation.cursor.offset + 1,
            },
          }),
        ).toThrow("offset");
      }
      expect(() => pager.page(manager, continuation)).toThrow(
        "no longer active",
      );
      expect(pager.page(manager, {}).next).toEqual(first.next);
    }
  });

  it("closes the native replay when client-side validation fails", async () => {
    const manager = SessionManager.inMemory("/work");
    manager.appendMessage({
      role: "user",
      content: "a".repeat(2 * 1024 * 1024),
      timestamp: 1,
    });
    const pager = new HistoryPager();
    const requests: unknown[] = [];
    let continuation: unknown;
    await expect(
      readHistory(async (request) => {
        requests.push(request);
        const page = pager.page(manager, request);
        if (request.close) return page;
        continuation = { cursor: page.next, leafId: page.leafId };
        return { ...page, chunk: '{"id":"bad","parentId":"missing"}\n' };
      }),
    ).rejects.toThrow("not contiguous");
    expect(requests.at(-1)).toEqual({ close: true });
    expect(() => pager.page(manager, continuation)).toThrow("no longer active");
  });

  it("preserves the original failure if cleanup fails, and fails successful reads when cleanup loses the connection", async () => {
    await expect(
      readHistory(async (request) => {
        if (request.close) throw new Error("cleanup failed");
        throw new Error("original failure");
      }),
    ).rejects.toThrow("original failure");
    await expect(
      readHistory(async (request) => {
        if (request.close) throw new Error("connection closed");
        return { chunk: "", next: null, leafId: null };
      }),
    ).rejects.toThrow("connection closed");
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
