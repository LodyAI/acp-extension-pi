import { z } from "zod";

// The chunk is JSON text embedded in a control notification, itself embedded in
// RPC JSON. Leave room for both escaping layers and the surrounding envelopes.
const CHUNK_CHARACTERS = 1024 * 1024;
const MAX_ENTRY_CHARACTERS = 16 * 1024 * 1024;
const cursorSchema = z.object({
  entryId: z.string(),
  offset: z.number().int().nonnegative(),
});
const requestSchema = z.object({
  cursor: cursorSchema.optional(),
  leafId: z.string().nullable().optional(),
  close: z.literal(true).optional(),
});
const pageSchema = z.object({
  chunk: z.string().max(CHUNK_CHARACTERS),
  next: cursorSchema.nullable(),
  leafId: z.string().nullable(),
});
const entrySchema = z
  .object({
    id: z.string(),
    parentId: z.string().nullable(),
  })
  .passthrough();
type HistorySource = {
  getBranch(): readonly { id: string }[];
  getLeafId(): string | null;
};

/** One transient replay per runtime; Pi still owns all native history. */
export class HistoryPager {
  private replay?: {
    leafId: string | null;
    branch: ReturnType<HistorySource["getBranch"]>;
    index: number;
    offset: number;
    text?: string;
  };

  clear(): void {
    this.replay = undefined;
  }

  page(source: HistorySource, input: unknown) {
    try {
      const request = requestSchema.parse(input);
      const leafId = source.getLeafId();
      if (request.close) {
        this.clear();
        return { chunk: "", next: null, leafId };
      }
      if (request.cursor && request.leafId === undefined)
        throw new Error("Pi history cursor requires a leaf identity");
      if (request.leafId !== undefined && request.leafId !== leafId)
        throw new Error("Pi history branch changed during replay");
      if (!request.cursor) {
        this.replay = {
          leafId,
          branch: source.getBranch(),
          index: 0,
          offset: 0,
        };
      }
      const replay = this.replay;
      if (!replay) throw new Error("Pi history replay is no longer active");
      if (replay.leafId !== leafId)
        throw new Error("Pi history branch changed during replay");
      if (request.cursor) {
        if (request.cursor.entryId !== replay.branch[replay.index]?.id)
          throw new Error("Pi history cursor entry is missing or unexpected");
        if (request.cursor.offset !== replay.offset)
          throw new Error("Pi history cursor offset is invalid");
      }
      let chunk = "";
      while (
        replay.index < replay.branch.length &&
        chunk.length < CHUNK_CHARACTERS
      ) {
        // Keep only the current serialized entry while it spans multiple pages.
        replay.text ??= JSON.stringify(replay.branch[replay.index]) + "\n";
        const part = replay.text.slice(
          replay.offset,
          replay.offset + CHUNK_CHARACTERS - chunk.length,
        );
        chunk += part;
        replay.offset += part.length;
        if (replay.offset === replay.text.length) {
          replay.index++;
          replay.offset = 0;
          replay.text = undefined;
        }
      }
      const next =
        replay.index < replay.branch.length
          ? { entryId: replay.branch[replay.index].id, offset: replay.offset }
          : null;
      if (!next) this.clear();
      return { chunk, next, leafId };
    } catch (error) {
      this.clear();
      throw error;
    }
  }
}

/** Reassemble bounded pages, preserving native entry identity and all image bytes. */
export async function readHistory(
  fetchPage: (request: z.infer<typeof requestSchema>) => Promise<unknown>,
) {
  let failed = false;
  try {
    const entries: z.infer<typeof entrySchema>[] = [];
    let cursor: z.infer<typeof cursorSchema> | undefined;
    let leafId: string | null | undefined;
    let parts: string[] = [];
    let entryCharacters = 0;
    do {
      const page = pageSchema.parse(await fetchPage({ cursor, leafId }));
      if (leafId !== undefined && page.leafId !== leafId)
        throw new Error("Pi history branch changed during replay");
      leafId = page.leafId;
      if (
        page.next &&
        (!page.chunk ||
          (page.next.entryId === cursor?.entryId &&
            page.next.offset <= cursor.offset))
      )
        throw new Error("Pi history page did not advance");
      let start = 0;
      while (start < page.chunk.length) {
        const end = page.chunk.indexOf("\n", start);
        const part = page.chunk.slice(start, end === -1 ? undefined : end);
        parts.push(part);
        entryCharacters += part.length;
        if (entryCharacters > MAX_ENTRY_CHARACTERS)
          throw new Error("Pi history entry exceeds the size limit");
        if (end === -1) break;
        // Scan each chunk once and join only when the complete entry arrives.
        const entry = entrySchema.parse(JSON.parse(parts.join("")));
        if (entry.parentId !== (entries.at(-1)?.id ?? null))
          throw new Error("Pi history branch is not contiguous");
        entries.push(entry);
        parts = [];
        entryCharacters = 0;
        start = end + 1;
      }
      cursor = page.next ?? undefined;
    } while (cursor);
    if (entryCharacters || (entries.at(-1)?.id ?? null) !== leafId)
      throw new Error("Pi history ended with an incomplete branch");
    return entries;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      // Release the native-side iterator even if local page validation failed.
      await fetchPage({ close: true });
    } catch (error) {
      if (!failed) throw error;
    }
  }
}
