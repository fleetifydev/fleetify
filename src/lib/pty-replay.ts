/**
 * Replaying a PTY's early output. A login prints its URL within milliseconds,
 * before a `pty:data` listener registers (Tauri drops events nobody listens
 * to), so a view subscribes, then reads the PTY's buffered output
 * (`ptyBuffer`) and writes only the live chunks the buffer doesn't hold.
 */

/** The part of `pending` (chunks received since subscribing) that the
 *  buffered snapshot doesn't already hold. The backend appends to the buffer
 *  before emitting each chunk, so the snapshot ends with some prefix of
 *  `pending`; everything after that prefix is new. */
export function unseenTail(snapshot: string, pending: string): string {
  for (let k = Math.min(snapshot.length, pending.length); k > 0; k--) {
    if (snapshot.endsWith(pending.slice(0, k))) return pending.slice(k);
  }
  return pending;
}
