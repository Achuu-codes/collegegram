/**
 * Cursor (keyset) pagination.
 *
 * WHY NOT `skip`/`offset`:
 *   `.skip(n)` makes MongoDB walk and discard n documents on every request, so
 *   page 500 costs 500x page 1 — the query gets slower the deeper a user
 *   scrolls. Worse, the result is *wrong* on a live feed: if a new post is
 *   inserted between two requests, every subsequent row shifts down by one and
 *   the reader sees an item twice (or misses one entirely).
 *
 *   Keyset pagination instead asks "give me the rows after this exact point",
 *   which is an index seek rather than a scan: constant cost per page, and
 *   stable under concurrent inserts.
 *
 * THE TIE-BREAKER IS NOT OPTIONAL. Sorting by `score` alone is ambiguous —
 * hundreds of posts share a score of 0, and MongoDB makes no promise about
 * their relative order between two queries. Appending `_id` (unique, and
 * monotonically increasing for generated ObjectIds) makes the sort a total
 * order, which is the precondition for a cursor meaning anything at all.
 *
 * The cursor is base64url only to discourage clients from parsing it. It is
 * NOT secret and NOT tamper-proof: it carries no authorization, so the worst a
 * forged cursor can do is point at a different page of public data, and a
 * malformed one is rejected below.
 */
import { ValidationError } from "./errors.js";

export function encodeCursor({ value, id }) {
  const raw = `${value instanceof Date ? value.toISOString() : value}|${id}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

export function decodeCursor(cursor) {
  const raw = Buffer.from(String(cursor), "base64url").toString("utf8");
  const separator = raw.lastIndexOf("|");
  if (separator === -1) throw new ValidationError("Malformed cursor");

  const value = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  // 24 hex characters: an ObjectId. Rejecting here means a forged cursor fails
  // with a clean 400 instead of a CastError from the driver.
  if (!/^[a-f0-9]{24}$/i.test(id)) throw new ValidationError("Malformed cursor");

  return { value, id };
}

/**
 * Build the keyset filter for a descending sort on `field` then `_id`.
 *
 * The OR is the whole trick: take everything strictly past the cursor's sort
 * value, plus the rows that tie on that value but sit after it by id.
 */
export function keysetFilter(field, cursor) {
  if (!cursor) return {};
  const { value, id } = decodeCursor(cursor);
  const parsed = field === "createdAt" ? new Date(value) : Number(value);
  if (Number.isNaN(field === "createdAt" ? parsed.getTime() : parsed)) {
    throw new ValidationError("Malformed cursor");
  }

  return {
    $or: [{ [field]: { $lt: parsed } }, { [field]: parsed, _id: { $lt: id } }],
  };
}

/**
 * Trim an over-fetched result set into a page plus the cursor for the next one.
 *
 * We deliberately fetch `limit + 1` rows. That extra row is how we know whether
 * a next page exists without running a second `countDocuments` query — counting
 * a large collection is itself an expensive scan, and the only thing the client
 * actually needs is a boolean.
 */
export function toPage(docs, limit, field) {
  const hasMore = docs.length > limit;
  const items = hasMore ? docs.slice(0, limit) : docs;
  const last = items.at(-1);

  return {
    items,
    nextCursor:
      hasMore && last ? encodeCursor({ value: last[field], id: String(last._id) }) : null,
  };
}
