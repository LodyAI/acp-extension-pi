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

/** Read Pi's current branch through its readonly manager; never open/migrate files. */
export function historyPage(source: HistorySource, input: unknown) {
  const request = requestSchema.parse(input);
  const leafId = source.getLeafId();
  if (request.cursor && request.leafId === undefined)
    throw new Error("Pi history cursor requires a leaf identity");
  if (request.leafId !== undefined && request.leafId !== leafId)
    throw new Error("Pi history branch changed during replay");
  const branch = source.getBranch();
  let index = request.cursor
    ? branch.findIndex((entry) => entry.id === request.cursor!.entryId)
    : 0;
  if (index < 0) throw new Error("Pi history cursor entry is missing");
  let offset = request.cursor?.offset ?? 0;
  let chunk = "";
  while (index < branch.length && chunk.length < CHUNK_CHARACTERS) {
    const text = JSON.stringify(branch[index]) + "\n";
    if (offset >= text.length)
      throw new Error("Pi history cursor offset is invalid");
    const part = text.slice(offset, offset + CHUNK_CHARACTERS - chunk.length);
    chunk += part;
    offset += part.length;
    if (offset === text.length) {
      index++;
      offset = 0;
    }
  }
  return {
    chunk,
    next: index < branch.length ? { entryId: branch[index].id, offset } : null,
    leafId,
  };
}

/** Reassemble bounded pages, preserving native entry identity and all image bytes. */
export async function readHistory(
  fetchPage: (request: z.infer<typeof requestSchema>) => Promise<unknown>,
) {
  const entries: z.infer<typeof entrySchema>[] = [];
  let cursor: z.infer<typeof cursorSchema> | undefined;
  let leafId: string | null | undefined;
  let buffer = "";
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
    buffer += page.chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      if (end > MAX_ENTRY_CHARACTERS)
        throw new Error("Pi history entry exceeds the size limit");
      const entry = entrySchema.parse(JSON.parse(buffer.slice(0, end)));
      if (entry.parentId !== (entries.at(-1)?.id ?? null))
        throw new Error("Pi history branch is not contiguous");
      entries.push(entry);
      buffer = buffer.slice(end + 1);
    }
    if (buffer.length > MAX_ENTRY_CHARACTERS)
      throw new Error("Pi history entry exceeds the size limit");
    cursor = page.next ?? undefined;
  } while (cursor);
  if (buffer || (entries.at(-1)?.id ?? null) !== leafId)
    throw new Error("Pi history ended with an incomplete branch");
  return entries;
}
