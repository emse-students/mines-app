# Databases

## PostgreSQL

**Image**: `postgres:15-alpine`  
**Port**: 5432 (container), 5433 (dev host)  
**Database**: `auth_db`

## Reaching it from a workstation

`ssh canari`, then `docker exec` into the container `infrastructure-postgres-1` as user `canari`.
**`auth_db` is the ONLY database** - every service shares it, social-service included, whose
`DB_DATABASE` default `canari_social` **does not exist on prod**; a command that names it fails and
the failure looks like a permissions problem.

**THE CONTAINER NAME IS THE ONLY THING THAT SAYS WHICH ESTATE YOU ARE IN, so read it before you
write.** The same host is to carry a second Postgres for `dev.canari-emse.fr` - compose project
`canari-dev`, so container `canari-dev-postgres-1`, holding a full copy of production's data
([dev-environment](dev-environment.md)). Two containers, the same user, the same database name, the
same table contents: nothing in a `psql` prompt distinguishes them. Prefer selecting by compose
label over typing a name, which is what `infrastructure/dev/copy-prod-to-dev.sh` does and why it
cannot be pointed at production:

```
docker ps --filter label=com.docker.compose.project=infrastructure \
          --filter label=com.docker.compose.service=postgres --format '{{.Names}}'
```

**Use the PowerShell tool for any of these, never Bash** - Git Bash strips the backslashes out of
the cloudflared `ProxyCommand` in the SSH config, and the connection dies with an opaque error.
Quote SQL single-outer, doubled-inner:

```
ssh canari 'docker exec ... psql -U canari -d auth_db -x -c "SELECT ... WHERE id = ''uuid''"'
```

Single shared database host for all relational data. The database name is `auth_db`; logical separation is by schema/table prefix, not by database.

Table names below are the live production names (TypeORM's default strategy snake_cases the entity
class name, so most are singular unless the entity declares `@Entity('...')`).

| Service | Tables (key ones) |
|---|---|
| core-service | `users` (the personal notepad is a `notes` column, not a table), `platform_config` |
| chat-delivery-service | `key_package`, `one_time_key_package`, `queued_message`, `dm_groups`, `dm_group_members`, `dm_device_group_memberships`, `dm_user_dismissed_groups`, `group_invites`, `mls_commit_log`, `mls_group_info`, `push_token`, `revoked_device`, `pin_verifier` |
| social-service | `channel_workspaces`, `channels`, `channel_members`, `channel_roles`, `channel_messages`, `channel_key_distributions`, `workspace_invites`, `forms`, `submissions`, `form_reminders`, `associations`, `association_members`, `association_products`, `association_categories`, `association_documents`, `purchase_records`, `webhook_deliveries` |

Full schema: see `docs/wiki/architecture.md` (PostgreSQL schema overview section).

### Migrations

NestJS services use TypeORM. In development `synchronize: true` auto-syncs the schema from the
entities; in production `synchronize: false`, so **every entity change needs a hand-written SQL file**
in that service's `src/migrations/` directory or the column simply will not exist in production.

The CD workflow applies them (`.github/workflows/serve-prod.yml`, "Run database migrations"): it collects
`apps/*/src/migrations/*.sql`, sorts by path, and applies each file that is not yet recorded in the
`schema_migrations` ledger (`filename`, `checksum`, `applied_at`), inside the postgres container with
`ON_ERROR_STOP=1`. A failing migration fails the deploy.

Rules, all of them load-bearing:

- **Idempotent, always.** A deploy that dies mid-run leaves later files unrecorded, so the next
  deploy re-runs them. Use `IF NOT EXISTS` / `IF EXISTS`, or a `DO $$ ... IF EXISTS ... $$` guard for
  DDL that has no such clause.
- **Never edit an applied migration.** The checksum is recorded; a changed file only produces a CI
  warning, because production keeps the version it already ran. Write a new migration instead.
- **Quote camelCase columns.** TypeORM's default naming strategy preserves camelCase, so unquoted
  `writePolicy` would be folded to `writepolicy` and the entity would not find it.
- **One number per service directory.** Numbers are per-service and gaps are fine (deleted
  migrations leave holes at 023 and 026-029 in social-service); duplicates are not, because ordering
  then depends on the rest of the filename.
- **One-shot data backfills are a trap.** Before the ledger existed every file replayed on every
  deploy, so a backfill kept re-applying: migration 004 re-granted `MANAGE_STRIPE_CONNECT` and 016
  re-enabled `cotisationEnabled`, silently reverting admin changes. The ledger fixes this going
  forward; keep backfills narrowly conditioned anyway.

The file set is a **patch set, not a schema**. It assumes a database that TypeORM already created;
migration 001 starts with `ALTER TABLE users`. A brand-new production database is bootstrapped from a
backup restore (see `backup.md`), never by replaying migrations.

To check production against the entities, dump `information_schema.columns` and compare with the
`@Column` declarations - drift is silent otherwise.

### Backup

PostgreSQL is backed up daily via `pg_dump -d auth_db --clean --if-exists` (logical dump, gzip). See `docs/wiki/infrastructure/backup.md`.

---

## MongoDB - REMOVED 2026-08-18

There was a `mongo:latest` container, `chat_db` was declared as its database, and this page said
social-service used it for posts, polls, comments and reactions. **None of it was true.** Those
live in PostgreSQL as TypeORM entities; no service ever held a MongoDB connection string, and the
database `chat_db` was never even created - the instance carried `admin`, `config` and `local` and
nothing else, measured on 2026-08-11 and again on 2026-08-18. `chat-delivery-service` waited on it
to become healthy before booting, which delayed every start for a container it never opened a
socket to. It was still dumped nightly into a 116-byte archive listed in the backup manifest, where
a line reads as a backup.

Service, volumes, `depends_on` and backup step are all gone. The deploy of `40e4f801` removed the
container; `infrastructure_mongo_data` (480 MB), `infrastructure_mongo_config` and `local_mongo_data`
(0 B each) were deleted by hand the same day, since a volume outlives the compose file that named
it. Before deleting the 480 MB, the volume was mounted into a throwaway `mongod` one last time and
asked directly: `admin` 40 KB, `config` 102 KB, `local` 94 KB - **237 KB of MongoDB's own bookkeeping
inside 480 MB of preallocated WiredTiger files**, and not one application byte. That is the third
independent measurement, and the only one taken after the container was already gone.

---

## Redis

**Image**: `redis:alpine`  
**Port**: 6379 (container), 6380 (dev host)

Redis is used for three distinct purposes:

### Pub/Sub channels

| Channel | Producer | Consumer | Payload |
|---|---|---|---|
| `chat:messages` | chat-delivery-service | chat-gateway | `{ recipientId, deviceId, proto, groupId, senderId, … }` |
| `chat:channel_events` | social-service | chat-gateway | `{ type, data, userIds[], timestamp }` |

### Presence keys

`user:online:{userId}:{deviceId}` — TTL 20 seconds, refreshed on each WebSocket Pong. Deleted immediately on clean disconnect.

### History streams

`history:{groupId}` — Redis Stream. Appended to by chat-delivery-service on each `POST /api/mls/send`. Read incrementally by clients via `GET /api/mls/history/:groupId?after=<streamId>`.

### Other keys

| Key | Type | Purpose |
|---|---|---|
| `group:members:{groupId}` | Set | Active device members for a group (for welcome forward) |
| `pending_welcomes:{userId}` | List | WS frames queued while device is offline |
| `add-lock:{groupId}` | String | Distributed add-lock (1s TTL) |

Redis is **not persisted** (no AOF/RDB in the default config). Presence and pending frames are ephemeral; history streams are the durable record.

---

## Garage

**Image**: `dxflrs/garage:v2.3.0` (migrated from MinIO 2026-08-14, unmaintained upstream - see
[docker](docker.md))  
**S3 API port**: 3900 (container), configurable dev host port (default 19100, var name
`GARAGE_API_HOST_PORT`)  
**Admin API port**: 3903 (container) - health check and CLI, which MinIO had no equivalent of

S3-compatible object storage. Used exclusively by media-service, through the same generic
`minio` npm S3 client as before (Garage implements every S3 operation it calls).

| Bucket | Contents |
|---|---|
| `canari-media` (`GARAGE_BUCKET`) | Both encrypted media blobs (AES-256-GCM, client-side encrypted) and resized public images (logos, avatars) - `storage.service.ts` puts both in this one bucket. `MINIO_PUBLIC_BUCKET` was not read anywhere in the code (removed 2026-08-07). Every remaining variable was renamed `MINIO_*` -> `GARAGE_*` on 2026-08-18. |

The `garage_data` (object bytes) and `garage_meta` (bucket/key metadata) Docker volumes are
backed up via the deduplicated restic repository in `infrastructure/backup/backup-objects.sh`,
not as a tar archive. See [backup](backup.md).

### Finding every media reference a COPY carries but cannot serve

A copy of production - into `dev.canari-emse.fr` or into a local stack - fetches a Postgres dump and
nothing else. Neither touches Garage, so every media id in the restored rows names a blob that
exists only in production's store, and `infrastructure/lib/copy-strips.sh` clears them all and then
COUNTS what is left, refusing the restore unless the answer is zero.

**That count enumerates COLUMNS, which is a claim about a schema, and it goes stale in silence.** It
reported 0 over three rows that still pointed at production's store on 2026-09-05: a post COMMENT
can carry an attachment, and `posts.comments` is a jsonb array of objects whose `media` sits one
level below anything a column list can see. The feed 404ed while the copy's own verification passed.

**What settles it is asking the database rather than reading harder.** This walks every text and
jsonb column, and it is what found that one - run it against a fresh copy after any schema change
that adds a place a media reference can hide, and add whatever it names to BOTH the strip and the
count in `copy-strips.sh` (which deliberately cannot run this itself: `dev-copy-guards.test.sh`
fails the build if that file so much as mentions `docker exec` or `psql`, because the allowlist of
writable targets belongs in the script that owns the target):

```sh
docker exec canari-local-postgres-1 psql -U admin -d auth_db -tAc "
do \$\$ declare r record; n bigint; begin
  for r in select c.table_name, c.column_name from information_schema.columns c
           join information_schema.tables t on t.table_name = c.table_name
             and t.table_schema = 'public' and t.table_type = 'BASE TABLE'
           where c.table_schema = 'public'
             and c.data_type in ('text','jsonb','character varying') loop
    execute format('select count(*) from %I where %I::text ~ %L',
                   r.table_name, r.column_name, 'mediaId|/api/media/') into n;
    if n > 0 then raise notice 'RESIDUE % . % rows=%', r.table_name, r.column_name, n; end if;
  end loop; end \$\$;"
```

It answered nothing at all on the local estate of 2026-09-05, after the `posts.comments` strip and
the ten that predate it - so the enumeration is complete AS OF that schema, and only as of it.
