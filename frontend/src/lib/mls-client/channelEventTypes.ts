/**
 * Which server frames belong to the channel-event handler, declared once for every client.
 *
 * WHY THIS IS NOT AN INLINE `startsWith`. It was one, spelled separately in `WebMlsService` and
 * `TauriMlsService`, and it read `type.startsWith('channel.')`. The server has published
 * `workspace.updated`, `workspace.role.changed` and `workspace.deleted` for as long as those
 * features have existed, and `channelEventHandler` has had a branch for each of them - so all three
 * were dispatched by the server, forwarded by the gateway, delivered to the socket, and dropped on
 * the floor by a prefix test that had never been told about them. `workspace.role.permissions`, the
 * announcement written the same day, was the fourth. Measured on production 2026-08-20 by COMM-20,
 * whose second administrator's grid stayed wrong because the only thing that would have corrected it
 * never arrived.
 *
 * A ROUTING TABLE SPREAD ACROSS TWO FILES AS A STRING PREFIX IS A CONTRACT NOBODY DECLARES. It lives
 * here now, both clients ask it, and adding a family is one edit rather than two silent omissions.
 *
 * IT ALSO ROUTED `post_created`, WHICH NO SERVER HAS EVER SENT. The gateway broadcast it on
 * receiving a Kafka `post.created` record; nothing ever produced that topic, `handleChannelEvent`
 * had no branch for the type, and a frame that DID arrive would have reached its final
 * `[ERROR] Unhandled channel event type` line on every connected client. The consumer and the
 * broker went on 2026-08-31, so the entry named a sender that cannot exist. Routing a name to a
 * handler that does not implement it is not forward compatibility - it is a defect with a test
 * pinning it green.
 */

/** Families of server frame the channel-event handler owns, matched by prefix. */
const CHANNEL_EVENT_PREFIXES = ['channel.', 'workspace.'] as const;

/**
 * Whether `type` is a frame `handleChannelEvent` is responsible for.
 *
 * Answered from the frame's NAME alone, deliberately: the socket layer must decide where a frame
 * goes without knowing what any of them mean, and a client that had to understand a payload to route
 * it would silently drop every event added after it shipped - which is the defect above.
 */
export function isChannelEventFrame(type: string): boolean {
  if (!type) return false;
  return CHANNEL_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix));
}

/** The transport's own keepalive frames, which carry nothing and belong to no handler. */
const HEARTBEAT_FRAMES = ['ping', 'pong'] as const;

/**
 * Whether `type` is a keepalive rather than a message.
 *
 * THE SAME LESSON AS ABOVE, FOUND AGAIN ON A PHONE. `WebMlsService` returned early on `ping`/`pong`
 * with an inline comparison; `TauriMlsService` never learned to, so every keepalive the gateway
 * answered (`{"type":"pong"}`, one per 8 s heartbeat) reached the fall-through branch and printed
 * `frame type "pong" reached no handler - the server is sending something this client does not
 * route`. Thirteen of them in ninety seconds on the Mi 9T on 2026-09-06, for ever, on every mobile
 * client - a warning ACCUSING the server of a defect, on the one frame the server is required to
 * send. That is worse than silence: it is the line a reader learns to skip, standing in front of
 * the real ones this branch exists to surface.
 *
 * So it is a predicate both clients ask, not a comparison each remembers separately.
 */
export function isHeartbeatFrame(type: string): boolean {
  return (HEARTBEAT_FRAMES as readonly string[]).includes(type);
}
