const PENDING_ACK_STORAGE_KEY = 'canari_pending_message_acks';
const ACK_BACKOFF_MS = [500, 2000, 5000] as const;

/**
 * The longest one ACK attempt may stay on the wire before it is abandoned and retried.
 *
 * A HANG-GUARD, IN THE SHAPE `PENDING_PAGE_STALL_MS` ALREADY USES, and it became load-bearing the
 * day the pull started waiting for this request. Until then a wedged ack was harmless: every call
 * site `void`s it, so a promise that never settled cost nothing. `fetchPendingMessages` now awaits
 * `ackInFlight` to stop a pull overtaking this device's own acknowledgement - which means a request
 * with no deadline is no longer a hung request, it is a stalled MAILBOX, and every later ack behind
 * it in the chain is stalled too.
 *
 * A RETRY LOOP IS NOT A DEADLINE. The four attempts here bound how many times this gives up, never
 * how long one of them may take, and the difference is the whole failure: `fetch` waits on an open
 * socket indefinitely. What this number has to exceed is a round trip to the history service under
 * load, and ten seconds of total silence is already pathological - the same argument, and the same
 * value, as the pull's own guard.
 */
const ACK_ATTEMPT_TIMEOUT_MS = 10_000;

interface PendingAckPayload {
  userId: string;
  deviceId: string;
  messageIds: string[];
}

/** Reads persisted ACK ids from sessionStorage (survives reload). */
export function readPersistedPendingAcks(): PendingAckPayload | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(PENDING_ACK_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PendingAckPayload;
  } catch {
    return null;
  }
}

function persistPendingAcks(payload: PendingAckPayload | null): void {
  if (typeof sessionStorage === 'undefined') return;
  if (!payload || payload.messageIds.length === 0) {
    sessionStorage.removeItem(PENDING_ACK_STORAGE_KEY);
    return;
  }
  sessionStorage.setItem(PENDING_ACK_STORAGE_KEY, JSON.stringify(payload));
}

/**
 * Drops any persisted pending ACKs. Call on logout / user switch so a different
 * user can't have the previous user's message ids ACKed under their identity.
 */
export function clearPersistedPendingAcks(): void {
  persistPendingAcks(null);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POSTs message ACKs with exponential backoff; persists failed ids for the next session.
 */
export async function ackMessagesWithRetry(
  historyUrl: string,
  headers: Record<string, string>,
  body: PendingAckPayload,
  log?: (msg: string) => void
): Promise<void> {
  const persisted = readPersistedPendingAcks();
  const messageIds = [...new Set([...(persisted?.messageIds ?? []), ...body.messageIds])];
  if (messageIds.length === 0) return;

  const payload: PendingAckPayload = {
    userId: body.userId,
    deviceId: body.deviceId,
    messageIds,
  };

  for (let attempt = 0; attempt <= ACK_BACKOFF_MS.length; attempt++) {
    try {
      // `AbortController` AND NOT `AbortSignal.timeout`, which the oldest WKWebView this ships to
      // does not have - and a missing static here would throw before the request was even made.
      const giveUp = new AbortController();
      const abandon = setTimeout(() => giveUp.abort(), ACK_ATTEMPT_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(`${historyUrl}/api/mls/messages/ack`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true,
          signal: giveUp.signal,
        });
      } finally {
        clearTimeout(abandon);
      }
      if (res.ok) {
        persistPendingAcks(null);
        log?.(`[ACK] ${messageIds.length} message(s) acknowledged`);
        return;
      }
      log?.(`[ACK] HTTP ${res.status} attempt ${attempt + 1}`);
    } catch (e) {
      log?.(`[ACK] failed attempt ${attempt + 1}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (attempt < ACK_BACKOFF_MS.length) {
      await sleep(ACK_BACKOFF_MS[attempt]);
    }
  }

  persistPendingAcks(payload);
  log?.(`[ACK] ${messageIds.length} id(s) persisted for retry on next connect`);
}
