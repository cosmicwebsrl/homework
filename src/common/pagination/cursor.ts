import { InvalidCursorError } from '../errors/domain.errors';

/**
 * Opaque keyset-pagination cursor over the (occurredAt, id) tuple.
 *
 * Keyset ("seek") pagination was chosen over OFFSET because comment lists are
 * append-heavy: OFFSET pages shift when new comments arrive (duplicates/skips)
 * and degrade linearly on deep pages. The composite index
 * (platformPostId, occurredAt, id) makes every page an index range scan.
 */
export interface CursorPayload {
  occurredAt: Date;
  id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(`${payload.occurredAt.toISOString()}|${payload.id}`, 'utf8').toString(
    'base64url',
  );
}

export function decodeCursor(cursor: string): CursorPayload {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new InvalidCursorError();
  }
  const sep = decoded.lastIndexOf('|');
  if (sep === -1) {
    throw new InvalidCursorError();
  }
  const occurredAt = new Date(decoded.slice(0, sep));
  const id = decoded.slice(sep + 1);
  if (Number.isNaN(occurredAt.getTime()) || !id) {
    throw new InvalidCursorError();
  }
  return { occurredAt, id };
}
