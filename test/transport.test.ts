import { describe, expect, it } from "vitest";
import { PiTransport } from "../src/transport.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
function wire(
  onEvent: (event: Record<string, unknown>) => Promise<void> = async () =>
    undefined,
) {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const sent = deferred<Record<string, unknown>>();
  const failure = deferred<Error>();
  const rpc = new PiTransport(
    {
      readable: new ReadableStream({
        start(controller) {
          output = controller;
        },
      }),
      writable: new WritableStream({
        write(bytes) {
          sent.resolve(JSON.parse(new TextDecoder().decode(bytes)));
        },
      }),
    },
    onEvent,
    (error) => failure.resolve(error),
  );
  return { rpc, output, sent, failure };
}

describe("Pi JSONL transport", () => {
  it("keeps fragmented UTF-8 and Unicode separators intact, and reads replies behind a blocked notification", async () => {
    const release = deferred<void>();
    const event = deferred<Record<string, unknown>>();
    const p = wire(async (value) => {
      event.resolve(value);
      await release.promise;
    });
    const result = p.rpc.request("get_state");
    const request = await p.sent.promise;
    const bytes = new TextEncoder().encode(
      JSON.stringify({ type: "notification", text: "中\u2028文\u2029" }) +
        "\r\n" +
        JSON.stringify({
          type: "response",
          id: request.id,
          command: "get_state",
          success: true,
          data: { ready: true },
        }) +
        "\n",
    );
    for (const byte of bytes) p.output.enqueue(Uint8Array.of(byte));
    await expect(result).resolves.toEqual({ ready: true });
    await expect(event.promise).resolves.toEqual({
      type: "notification",
      text: "中\u2028文\u2029",
    });
    release.resolve();
    await p.rpc.drain();
    p.output.close();
  });

  it.each(['{"type":', "not JSON\n"])(
    "rejects pending requests on malformed/truncated data: %s",
    async (input) => {
      const p = wire();
      const result = p.rpc.request("prompt");
      await p.sent.promise;
      p.output.enqueue(new TextEncoder().encode(input));
      p.output.close();
      await expect(result).rejects.toBeInstanceOf(Error);
      await expect(p.rpc.request("prompt")).rejects.toBeInstanceOf(Error);
    },
  );

  it("refuses a response correlated to a different command", async () => {
    const p = wire();
    const result = p.rpc.request("prompt");
    const request = await p.sent.promise;
    p.output.enqueue(
      new TextEncoder().encode(
        JSON.stringify({
          type: "response",
          id: request.id,
          command: "abort",
          success: true,
        }) + "\n",
      ),
    );
    await expect(result).rejects.toThrow("command mismatch");
    p.output.close();
  });
  it.each(["turn_end", "agent_end"])(
    "drains oversized redundant %s records without losing replies or settlement",
    async (type) => {
      const events: Record<string, unknown>[] = [];
      const p = wire(async (event) => {
        events.push(event);
      });
      const result = p.rpc.request("get_state");
      const request = await p.sent.promise;
      const image = {
        type: "image",
        mimeType: "image/png",
        data: "a".repeat(3 * 1024 * 1024),
      };
      const messages = Array.from({ length: 6 }, () => ({
        role: "toolResult",
        content: [image],
      }));
      const aggregate = JSON.stringify(
        type === "turn_end"
          ? { type, message: { role: "assistant" }, toolResults: messages }
          : { type, messages, willRetry: false },
      );
      // Split the header byte-by-byte, then fragment the large body like pipe I/O.
      for (const character of aggregate.slice(0, 40))
        p.output.enqueue(new TextEncoder().encode(character));
      for (let i = 40; i < aggregate.length; i += 65536)
        p.output.enqueue(
          new TextEncoder().encode(aggregate.slice(i, i + 65536)),
        );
      p.output.enqueue(
        new TextEncoder().encode(
          "\r\n" +
            JSON.stringify({
              type: "response",
              id: request.id,
              command: "get_state",
              success: true,
              data: { ready: true },
            }) +
            '\n{"type":"agent_settled","aborted":false}\n',
        ),
      );
      await expect(result).resolves.toEqual({ ready: true });
      await p.rpc.drain();
      expect(events).toEqual([{ type: "agent_settled", aborted: false }]);
      p.output.close();
    },
  );

  it("still rejects an oversized required message", async () => {
    const p = wire();
    const result = p.rpc.request("prompt");
    await p.sent.promise;
    p.output.enqueue(
      new TextEncoder().encode(
        JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: "a".repeat(16 * 1024 * 1024) },
        }) + "\n",
      ),
    );
    await expect(result).rejects.toThrow(
      "Pi RPC record exceeds the size limit",
    );
    p.output.close();
  });

  it("rejects an incomplete ignored aggregate rather than reporting settlement", async () => {
    const p = wire();
    const result = p.rpc.request("prompt");
    await p.sent.promise;
    p.output.enqueue(
      new TextEncoder().encode('{"type":"agent_end","messages":['),
    );
    p.output.close();
    await expect(result).rejects.toThrow("incomplete record");
  });

  it("fails EOF even when a queued event is awaiting a response", async () => {
    let rpc: PiTransport;
    const entered = deferred<void>();
    const p = wire(async () => {
      entered.resolve();
      await rpc.request("get_session_stats");
    });
    rpc = p.rpc;
    p.output.enqueue(new TextEncoder().encode('{"type":"agent_settled"}\n'));
    await entered.promise;
    p.output.close();
    await expect(p.failure.promise).resolves.toMatchObject({
      message: "Pi RPC connection closed",
    });
  });
});

describe("Pi transport failure decoration", () => {
  it("decorates EOF failures for pending and later requests", async () => {
    let output!: ReadableStreamDefaultController<Uint8Array>;
    const rpc = new PiTransport(
      {
        readable: new ReadableStream({
          start(controller) {
            output = controller;
          },
        }),
        writable: new WritableStream(),
      },
      async () => undefined,
      () => undefined,
      (error) =>
        new Error(
          `${error.message}\nTool "todo" conflicts with "/tmp/todo.ts"`,
        ),
    );
    const result = rpc.request("new_session");
    output.close();
    await expect(result).rejects.toThrow(
      'Pi RPC connection closed\nTool "todo" conflicts with "/tmp/todo.ts"',
    );
    await expect(rpc.request("new_session")).rejects.toThrow("conflicts with");
  });
});
