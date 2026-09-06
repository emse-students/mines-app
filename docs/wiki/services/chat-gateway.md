# chat-gateway

**Stack**: Rust / Axum / Tokio  
**Port**: 3000  
**Source**: `apps/chat-gateway/`

## Responsibilities

The chat-gateway is the real-time transport layer. It:

- Accepts WebSocket connections from clients and routes MLS frames to the correct recipient.
- Manages online presence in Redis.

It does **not** perform encryption, store messages, or make business logic decisions — those belong to `chat-delivery-service`.

## Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/ws` | yes (JWT cookie) | WebSocket upgrade |
| GET | `/api/presence` | yes | Online presence for a user |
| GET | `/api/admin/presence` | yes (global admin) | Admin view of all connected devices |
| GET | `/api/health` | no | Liveness probe |

Auth is enforced by Nginx `auth_request` before the request reaches the gateway.

## Internal state (`AppState`)

Shared across all handlers as `Arc<AppState>`:

```rust
pub struct AppState {
    // "userId:deviceId" -> live senders keyed by conn_id (multiple tabs = multiple entries)
    pub connected_users: Arc<Mutex<HashMap<String, HashMap<u64, mpsc::Sender<String>>>>>,
    pub next_conn_id: AtomicU64,
    pub redis_client: Client,
    pub jwt_secret: String,
}
```

Each connection is assigned a unique `conn_id` from `next_conn_id` at registration, so a
connection can be removed by identity rather than by `is_closed()` - which has a race with an
aborted send task whose receiver the runtime has not dropped yet.

Two `AppState` methods own the whole "may I delete the presence key" decision, and are the only
readers of that invariant:

| Method | Question | Caller |
|---|---|---|
| `remove_session(conn_key, conn_id)` | unregister this connection; does another live session remain? | `ConnectionGuard::drop` |
| `has_other_sessions(conn_key, conn_id)` | without unregistering, does another live session remain? | `handle_disconnect` |

A `ConnectionGuard` is created per WebSocket connection. Its `Drop` impl calls `remove_session` and
deletes the Redis presence key only when nothing else holds it.

## WebSocket authentication

Token is extracted in this priority order:

1. Cookie `canari_ws_token`
2. Query parameter `token=`

If the JWT is invalid or absent, the connection is rejected with code `4401`.

## Connection lifecycle

1. HTTP upgrade to WebSocket.
2. JWT validation -> extract `userId`.
3. Register in `connected_users["userId:deviceId"]` (mpsc sender).
4. Set Redis `user:online:{userId}:{deviceId}` (TTL 20s).
5. Drain `pending_welcomes:{userId}` (Redis list of WS frames queued while offline).
6. Spawn `ws_read_loop` (client frames) and `ws_write_loop` (mpsc -> WS).

## WebSocket message routing

On each WebSocket connection, the gateway registers the user+device key (`userId:deviceId`) in the in-memory `connected_users` map (a `Mutex<HashMap<String, HashMap<String, Sender>>>`).

Two Redis channels are consumed:

### `chat:messages`

Published by `chat-delivery-service` when a message is queued for a specific device. Payload shape:

```json
{
  "recipientId": "user123",
  "deviceId": "dev456",
  "senderId": "…",
  "senderDeviceId": "…",
  "groupId": "…",
  "proto": "<base64-encoded MLS ciphertext or JSON notification>",
  "isWelcome": false,
  "isCommit": false,
  "isWelcomeRequest": false,
  "ratchetTree": null,
  "queuedMessageId": "…"
}
```

**Control frames** (`isWelcomeRequest: true`): the `proto` field contains a base64-encoded JSON notification (welcome invite). The gateway decodes it and relays as plain JSON text — no MLS envelope.

**MLS frames**: the gateway relays the full JSON as-is to the client's WebSocket channel.

If the target device is not connected, the message stays in the DB queue in `chat-delivery-service` and is fetched via `fetchPendingMessages` on reconnect — it is not lost.

### Welcome forward (`welcome_request` / `reinvite_request`)

When a client sends a `welcome_request` frame, the gateway:

1. Reads group members from Redis `group:members:{groupId}`.
2. For each target device found in `connected_users` -> sends via mpsc sender.
3. If the target device is offline -> stores the frame in Redis `pending_welcomes:{userId}` (LPUSH). Drained at next connection (step 5 of the lifecycle above).

### `chat:channel_events`

Published by `social-service` for channel membership changes, role updates, etc. Payload shape:

```json
{
  "userIds": ["user1", "user2"],
  "type": "channel_event",
  "data": { … }
}
```

The gateway fans out the frame to all connected devices of each listed user.

## No Kafka consumer, and no broker - removed 2026-08-31

This gateway subscribed to a `post.created` topic under group `chat-gateway-broadcast` and
broadcast every record to **all** connected sockets as `{ type: "post_created", data: ... }`. It was
correct code with three separate reasons never to run:

1. **Nothing produced the topic, ever.** No `kafka` symbol exists anywhere in social-service.
   Measured on prod 2026-08-31: `kafka-topics --list` returned `__consumer_offsets` and nothing
   else, 42 hours into an uptime. The consumer logged `UnknownTopicOrPartition` at every boot.
2. **The two names never matched.** `libs/shared-rust` declared `TOPIC_POST_CREATED = "post_created"`
   while this file subscribed to the literal `"post.created"` - a producer written against the
   shared constant would have published past its only consumer, silently. That crate was itself
   deleted on 2026-08-31: with the broker gone it described a contract nothing in the system
   spoke, and this gateway named it as a path dependency without using a line of it.
3. **The client had no branch for the frame.** `post_created` was routed to `handleChannelEvent`,
   which implements no case for it, so a delivered record would have reached that handler's final
   `[ERROR] Unhandled channel event type` line on every connected client.

The consumer, `rdkafka`, and the `kafka` + `zookeeper` containers were removed together. They cost
1.09 GiB resident on production; this gateway does its whole job in 6.4 MiB.

**If real-time posts are wanted, they belong on the Redis path above**, which already carries eleven
event families and targets named recipients. The Kafka broadcast had no such filter: a post in a
private community would have gone to every socket on the server.

## Presence

Presence keys are stored in Redis as `user:online:{userId}:{deviceId}` with a 20-second TTL, refreshed on each WebSocket Pong. When delivery fails for a device and all senders are gone, the gateway proactively deletes the presence key so `chat-delivery-service` stops routing via pub/sub.

### The key is per DEVICE, the event is per CONNECTION

Two tabs of one browser share a `deviceId`, so they share one presence key while holding two
connections. Every path that deletes the key must therefore discount the connection it is acting
for and check whether any other one survives - the key answers "is this DEVICE online", never "is
this CONNECTION leaving".

Two paths delete it, and both ask that question through `AppState`:

- `ConnectionGuard::drop` - runs on every exit path, including cancellation and panic. Calls
  `remove_session`; on `true` it logs `[presence] Skipping DEL for {conn_key} - another session is
  still active` and returns.
- `handle_disconnect` - the app's own `{"type":"disconnect"}` frame, sent at `beforeunload` so
  peers see the user offline without waiting out the TTL. The sending connection is still
  registered at that moment, so it calls `has_other_sessions` and logs `[presence] Explicit
  disconnect from {conn_key} (conn_id=N) - skipping DEL, another session is still active`.

Until 2026-08-16 the second path deleted unconditionally, so a tab navigating away marked the whole
device offline; `drop` then ran, saw the survivor, and took the skip branch, so the guard written to
protect the key was exactly what stopped it being restored. Peers read the user offline until the
surviving socket's next `refresh_presence`. The decision is covered by five unit tests in
`state.rs` that need neither Redis nor a socket.

## CORS: the list is a fact about the clients

`ALLOW_ORIGIN` is a comma-separated allowlist, `*` allows all, and `chat_gateway_cors_layer`
(`main.rs`) turns it into the `CorsLayer` wrapping every route. nginx does not speak CORS for any
of them - it proxies `/api/ws`, `/api/presence` and `/api/admin/presence` straight through - so
this layer is the only one answering, which is why the value has to be right here and nowhere else.

**It served `*` in production until 2026-08-30, and the allowlist CD wrote had never reached the
container.** `docker-compose.prod.yml` set `ALLOW_ORIGIN: "*"` as a **literal** on the service, and
a literal there wins over anything in `infrastructure/.env`, so `upsert_env_var "ALLOW_ORIGIN" ...`
in `deploy.yml` had been writing a value nothing read since the iOS login incident. Measured twice:

```
docker exec infrastructure-chat-gateway-1 printenv ALLOW_ORIGIN   -> *
OPTIONS https://canari-emse.fr/api/presence  Origin: https://evil.example
  -> 200, access-control-allow-origin: *
```

That stayed a P2 rather than a P1 because this layer sets no `Allow-Credentials`: nothing
credentialed could be read back cross-origin. It is also why the gateway was never implicated in
the iOS login failure - it accepted the very origin the four Nest services refused.

**The service now reads `${ALLOW_ORIGIN:?...}`, which stops the deploy when the variable is absent
rather than picking a default.** Both available defaults are wrong: a wildcard silently re-opens
this, and a single origin silently cuts every Tauri client off `/api/presence`. An absent
declaration is a mistake, and a mistake that picks a policy is worse than one that stops.

### Every entry, and why it is there

Enumerated in `infrastructure/.env.example`, written by `serve-prod.yml`, and pinned by the tests in
`main.rs` that drive a real preflight through the layer:

| Origin | Client |
|---|---|
| `https://canari-emse.fr` | the deployed site (`FRONTEND_URL`) |
| `https://dev.canari-emse.fr` | a proxied CNAME onto this **same** tunnel, not a second environment - a list built from `FRONTEND_URL` alone would refuse a hostname this stack serves |
| `http://localhost:1420` | Vite dev server / Tauri desktop dev |
| `http://127.0.0.1:1420` | the same, spelt as `tauri.conf.json`'s `devUrl` actually spells it |
| `http://tauri.localhost`, `https://tauri.localhost` | the Tauri WebView on Android and Windows |
| `tauri://localhost` | the Tauri WebView on iOS, macOS and Linux - WebKit keeps the custom scheme |

The Tauri app calls this gateway **cross-origin** (its page is served from `tauri://localhost`, the
API from `https://canari-emse.fr`), so dropping a spelling costs that platform `/api/presence` with
no server-side error to show for it. This list is exact-match where the Nest services accept any
loopback port, which is why both `localhost` and `127.0.0.1` are spelt out. Keep it in step with
`TAURI_WEBVIEW_ORIGINS` in `apps/*/src/cors-origins.ts`.

### Verifying it, and why the deploy's colour is not the proof

A `HeaderValue` accepts almost any printable ASCII, so a **wrong** origin parses happily and simply
matches nothing - only an empty list stops the boot, which the tests pin. What proves the policy is
reading the header back off the deployed gateway:

```
OPTIONS https://canari-emse.fr/api/presence  Origin: <each entry>  -> echoes that origin
OPTIONS https://canari-emse.fr/api/presence  Origin: https://evil.example  -> no ACAO header
```

The layer also sends `Vary: origin`, which a shared cache needs before it can hold more than one
client's answer; a test asserts it for the same reason.

**Measured on prod 2026-08-30**, after the deploy that carried the fix, at BOTH layers - inside the
network against `http://chat-gateway:3000` and through the public edge - because only the second is
what a browser meets and only the first isolates this layer from nginx:

```
ALLOW_ORIGIN in the container   -> all seven entries present  (docker inspect)
each of the seven origins       -> echoed back verbatim, no '*' anywhere
https://evil.example.com        -> HTTP 200, no ACAO header
                                -> vary: origin
```

A preflight carries no cookies, so `auth_request` cannot see a session on it - the edge answers the
`OPTIONS` 200 either way, which is why the unknown origin's proof is the ABSENCE of the header and
never a status code. Run it from `infrastructure-frontend-1`, the one container on that network with
`curl`.

### The variable used to feed three consumers that wanted a single origin

`frontend-ssr`'s `ORIGIN` - adapter-node's public origin - read `${ALLOW_ORIGIN:-...}` and was
measured on prod holding the whole comma-separated list as one origin. It reads `FRONTEND_URL` now.
The nginx `frontend` service's `ORIGIN`, `VITE_GATEWAY_URL` and `VITE_DELIVERY_URL` read it too and
are **deleted**: that image is `nginx:stable-alpine` serving a build with no entrypoint
substituting anything, and a `VITE_` variable is baked in at BUILD time by the workflows writing
`frontend/.env`. **A variable read by two consumers with different shapes is one of them being
wrong**, and nothing said so for either.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `REDIS_URL` | no | `redis://127.0.0.1/` | Redis connection string |
| `JWT_SECRET` | yes | - | HS256 JWT secret (shared with core-service) |
| `ALLOW_ORIGIN` | **yes under compose** | `*` (binary only) | CORS allowlist. `docker-compose.prod.yml` uses `${ALLOW_ORIGIN:?}` and the deploy stops without it; the binary's own `*` default is for running it by hand and logs a WARN accusing the missing declaration |
| `RUST_LOG` | no | `chat_gateway=debug,tower_http=debug` | Log filter |
