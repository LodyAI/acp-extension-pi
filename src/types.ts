import type { ClientSideConnection } from "@agentclientprotocol/sdk";
export type AgentConnection = Pick<
  ClientSideConnection,
  | "initialize"
  | "newSession"
  | "resumeSession"
  | "prompt"
  | "cancel"
  | "setSessionConfigOption"
  | "request"
>;
export type PiStream = {
  protocol: "pi";
  writable: WritableStream<Uint8Array>;
  readable: ReadableStream<Uint8Array>;
};
