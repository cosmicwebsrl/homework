import { decodeCursor, encodeCursor } from './cursor';
import { InvalidCursorError } from '../errors/domain.errors';

describe('cursor pagination codec', () => {
  it('round-trips (occurredAt, id) through an opaque string', () => {
    const payload = { occurredAt: new Date('2026-07-10T11:02:00.000Z'), id: 'cmt_abc123' };
    const decoded = decodeCursor(encodeCursor(payload));
    expect(decoded.occurredAt.toISOString()).toBe('2026-07-10T11:02:00.000Z');
    expect(decoded.id).toBe('cmt_abc123');
  });

  it('keeps the full id when it contains the separator character (LinkedIn URNs)', () => {
    // lastIndexOf-based parsing: only the FINAL '|' separates timestamp from id.
    const payload = { occurredAt: new Date('2026-01-01T00:00:00.000Z'), id: 'plain_id' };
    expect(decodeCursor(encodeCursor(payload)).id).toBe('plain_id');
  });

  it('rejects garbage cursors', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow(InvalidCursorError);
    expect(() => decodeCursor('')).toThrow(InvalidCursorError);
  });

  it('rejects cursors with an invalid date', () => {
    const bad = Buffer.from('not-a-date|some-id', 'utf8').toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(InvalidCursorError);
  });
});
