import {
  Injectable,
  Logger,
  ForbiddenException,
  BadRequestException,
  GoneException,
  ServiceUnavailableException,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, MoreThanOrEqual, LessThan, EntityManager } from 'typeorm';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { QueuedMessage } from '../entities/queued-message.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { MlsCommitLog } from '../entities/mls-commit-log.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { resolveUserDisplayName, resolveUserDisplayNamesBatch } from '../utils/display-name';
import { activeRevocationWhere } from '../utils/revocation';
import {
  deleteGroupOwnedRows,
  deleteGroupRedisKeys,
  totalGroupOwnedRows,
} from '../utils/group-purge';
import {
  buildPushDataFields,
  buildApnsRequest,
  LONGEST_FALLBACK_LOCALE,
  buildInternalApnsRequest,
  inlineProtoBudget,
  measureDataFields,
  measureApnsPayload,
  FCM_DATA_LIMIT,
  PushMessageInput,
} from './push-payload';
import {
  sanitizeQueryValue,
  sanitizeOptionalQueryValue,
  sanitizeStringIdList,
  assertCallerOwnsUserId,
} from '../utils/sanitize';
import {
  HISTORY_STREAM_MAXLEN,
  PENDING_FETCH_CHUNK_ROWS,
  PENDING_PAGE_MAX_BYTES,
  RETENTION_WINDOW_MS,
} from '../retention.constants';

export interface SendMessageBody {
  proto?: string;
  /**
   * LEGACY CONTENT PATH ONLY, and unset there too by every client shipped since MLS.
   *
   * The proto path ignores it entirely and resolves recipients from `dm_device_group_memberships`
   * - which is what `libs/proto/canari.proto` has always specified ("leave empty = derive from
   * group members"). It used to be read first there, with the DB resolve behind an
   * `ops.length === 0` guard labelled a Redis cache miss; since nothing has ever filled this
   * field, that guard was true on every send and the "fallback" was the design.
   */
  recipients?: { userId: string; deviceId?: string }[];
  senderId?: string;
  senderDeviceId?: string;
  groupId?: string;
  isWelcome?: boolean;
  isCommit?: boolean;
  /** userId:deviceId pairs to skip (e.g. invitee already receiving a Welcome) */
  excludeDeviceIds?: string[];
  /** When true, FCM is sent (for MLS state sync) but no notification is displayed (read receipts, own-device copies). */
  silent?: boolean;
  /**
   * When true, the frame is appended to the group's shared history stream so a device that was
   * absent can still obtain it.
   *
   * Independent of {@link silent}. Until 2026-08-12 the two were the same boolean, and because
   * every control frame is silent by construction, no reaction, edit, deletion or read receipt
   * ever had a shared copy. See `docs/wiki/protocols/history-reconciliation.md`.
   *
   * The server holds ciphertext only, so it cannot classify a frame: the sender declares this.
   * Absent means "fall back to the old meaning of `silent`" - the only thing a client predating
   * the split can be interpreted as.
   */
  durable?: boolean;
  // legacy fields (frontend fallback / group fan-out)
  content?: string;
  type?: string;
}

export interface SendMessageResult {
  status: string;
  queued: number;
  sent: number;
}

export interface ValidateCommitBody {
  groupId: string;
  deviceId: string;
  baseEpoch: number;
  /**
   * Base64 serialised MLS Commit. REQUIRED: an accepted commit is recorded in the epoch-indexed
   * commit-log (rung-1 replay) and fanned out to members in the SAME call - a single atomic
   * validate -> store -> broadcast round-trip.
   *
   * Kept optional in the TYPE because it arrives over HTTP and is validated in {@link
   * validateCommit}, which refuses the call outright when it is absent: a commit nothing can
   * replay may not advance the epoch, the epoch it would skip being unrefillable for ever.
   */
  proto?: string;
  /** Sender user id, for the fan-out envelope (required when `proto` is present). */
  senderId?: string;
  /** userId:deviceId pairs to skip in the commit fan-out (inviter self, freshly-welcomed invitee). */
  excludeDeviceIds?: string[];
  /**
   * Base64 GroupInfo for the epoch this commit CREATES (`baseEpoch + 1`), exported by the
   * committing device before it submitted. Stored in the same transaction as the epoch advance, so
   * the published external-join base can never trail the group. See {@link validateCommit}.
   */
  groupInfo?: string;
}

export interface ValidateCommitResult {
  accepted: boolean;
  newEpoch?: number;
  currentEpoch?: number;
  reason?: string;
}

/** One replayable commit returned by the `sinceEpoch` endpoint. */
export interface CommitLogEntry {
  baseEpoch: number;
  proto: string;
}

export interface CommitsSinceResult {
  /** Ordered commits with `baseEpoch >= sinceEpoch`, ascending. */
  commits: CommitLogEntry[];
  /** Server `activeEpoch` at read time (the epoch the caller should reach after replay). */
  activeEpoch: number;
  /**
   * True when the caller's `sinceEpoch` is below the retained floor (older commits were pruned):
   * rung-1 replay cannot fully catch them up, so the caller must fall back to rung-2 (re-Welcome).
   */
  belowFloor: boolean;
  /**
   * The first epoch the log cannot supply, when one exists at or above `sinceEpoch` and below
   * `activeEpoch`. `commits` is then the applicable PREFIX - everything up to the hole - and no
   * replay can pass it, so the caller escalates to rung-2 instead of discovering it by failing.
   *
   * `belowFloor` is the same question asked about the START of the range and cannot answer this
   * one: a hole in the MIDDLE leaves the floor perfectly fine. Group `7da231f8` ran 0..129 with 121
   * absent for two days and every check passed (`docs/wiki/backlog.md`).
   */
  gapAt?: number;
}

/** Commit-log retention: keep ~1 year so rung-1 replay covers almost every gap (commits are tiny). */
const COMMIT_LOG_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
/** Per-group safety cap: never keep more than this many commits for one group (bounds runaway growth). */
const COMMIT_LOG_MAX_PER_GROUP = 20_000;

export interface SendWelcomeBody {
  targetDeviceId: string;
  targetUserId?: string;
  senderUserId?: string;
  welcomePayload: string;
  ratchetTreePayload?: string;
  groupId: string;
}

export interface NotifyWelcomeRequestBody {
  groupId: string;
  requesterUserId: string;
  requesterDeviceId: string;
}

/**
 * The most members one history election may be asked to skip.
 *
 * A chase excludes exactly one member per step, so this bounds nothing a real conversation does -
 * it bounds what a malformed or hostile client can make the server hold and compare per request.
 */
const MAX_HISTORY_EXCLUSIONS = 128;

/**
 * The longest member key an election will consider skipping, and it is measured rather than picked.
 *
 * A member key is `userId:deviceId`. A user id is a 64-character hex digest, and a device id is
 * `<platform>-<that same 64-character digest>-<mint>-<suffix>` - so a real one on this platform is
 * **147 characters for a browser and 149 for the phone**, both measured on 2026-09-05.
 *
 * IT USED TO BE 128, WHICH IS SHORTER THAN EVERY KEY THIS SERVER HAS EVER ISSUED. The filter
 * dropped them all, silently, and the exclusion list has therefore never excluded anybody: the
 * coverage chase - whose entire termination argument is *"the next election EXCLUDES every member
 * that has stated one, so each step of the walk removes exactly one member"* - could not remove one,
 * and the client's own guard against a server that ignores an exclusion fired instead, stopping the
 * walk. Found by HEAL-REVOKE-7, which asked the server nine times to skip a sleeping phone and was
 * handed it back every time. The number came from `MAX_HISTORY_EXCLUSIONS` beside it - two limits
 * that look alike and count different things, one of them never checked against a real key.
 *
 * 256 leaves room for a longer platform prefix or mint without being an invitation: the guard is
 * against a hostile client making this server hold and compare something large, and 128 keys of 256
 * characters is 32 kB at worst.
 */
const MAX_MEMBER_KEY_LENGTH = 256;

export interface NotifyHistoryRequestBody extends NotifyWelcomeRequestBody {
  /**
   * Member keys (`userId:deviceId`) this requester has already heard from, and does not want elected
   * again.
   *
   * It exists so a requester chasing a gap can walk its members instead of re-drawing the same one:
   * a device whose window is narrower than the range asked for says so, and the next election skips
   * it. **The set only ever grows within one chase, which is what bounds it** - see
   * `historyReconcile.ts`.
   *
   * The server reads it as an opaque set of keys. It never learns why a member was excluded, and it
   * is not an authorisation boundary: excluding a member only removes it from THIS election.
   */
  exclude?: string[];
}

/** One group cursor for batch history fetch. */
export interface HistoryBatchRequestItem {
  groupId: string;
  after?: string;
  limit?: number;
  /** Inclusive upper bound - see {@link HistoryBatchResponse.heads}. */
  until?: string;
}

export interface HistoryBatchResponse {
  histories: Record<string, Record<string, unknown>[]>;
  /**
   * Per group, the stream's last entry id AT THE MOMENT THIS PAGE WAS READ - the caller's upper
   * bound for the rest of its walk, passed back as `until`.
   *
   * It exists so a replay and the live delivery queue can never both hand MLS the same frame. The
   * archive holds every frame, including the ones still queued for delivery, so a walk whose upper
   * bound is "the tail whenever I get there" necessarily covers rows written while it was walking -
   * precisely the ones the queue is about to deliver. Pinning the bound at the start makes the two
   * sets disjoint: everything above the head is the queue's, by construction.
   *
   * Absent for a group that holds no history at all (nothing to bound).
   */
  heads: Record<string, string>;
}

/** Redis stream MAXLEN (~1000) — upper bound for a full catch-up page. */
const HISTORY_FULL_PAGE_LIMIT = 1000;
/** Smaller default when `after` is set (incremental catch-up). */
const HISTORY_INCREMENTAL_DEFAULT_LIMIT = 200;
/**
 * Max groups per batch request (guards payload size and Redis fan-out).
 *
 * MIRRORED BY `HISTORY_BATCH_MAX_GROUPS` in `frontend/src/lib/mls-client/mlsDeliveryApi.ts`, which
 * is the size the client chunks its catch-up at. Nothing on the wire negotiates it, so changing
 * this number without changing that one puts every client past the cap back to one request per
 * conversation - which is what it did until 2026-08-24. `messaging.history-bound.spec.ts` pins it.
 */
const HISTORY_BATCH_MAX_GROUPS = 50;

export interface AckMessagesBody {
  userId: string;
  deviceId: string;
  messageIds: string[];
}

@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  /**
   * Maximum window, looking back from the activation moment, for re-delivering to a device
   * becoming `active` the messages it missed while `pending` (DF2). Bounds the re-notification so
   * a device left `pending` for a long time does not trigger an avalanche of notifications.
   */
  private static readonly ACTIVATION_REDELIVER_WINDOW_MS = 5 * 60 * 1000;

  constructor(
    @InjectRepository(QueuedMessage)
    private queuedMessageRepo: Repository<QueuedMessage>,
    @InjectRepository(GroupMember)
    private groupMemberRepo: Repository<GroupMember>,
    @InjectRepository(Group) private groupRepo: Repository<Group>,
    @InjectRepository(KeyPackage)
    private keyPackageRepo: Repository<KeyPackage>,
    @InjectRepository(OneTimeKeyPackage)
    private oneTimeKeyPackageRepo: Repository<OneTimeKeyPackage>,
    @InjectRepository(DeviceGroupMembership)
    private deviceGroupRepo: Repository<DeviceGroupMembership>,
    @InjectRepository(PushToken)
    private pushTokenRepo: Repository<PushToken>,
    @InjectRepository(MlsCommitLog)
    private commitLogRepo: Repository<MlsCommitLog>,
    @InjectRepository(MlsGroupInfo)
    private groupInfoRepo: Repository<MlsGroupInfo>,
    @InjectRepository(RevokedDevice)
    private revokedDeviceRepo: Repository<RevokedDevice>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis
  ) {}

  /**
   * Whether a device may be given - or keep - an `active` routing membership.
   *
   * A device good enough to be MESSAGED must be at least as valid as one good enough to be
   * INVITED. `getPendingInvitations` already refuses to serve an invitation for a device that is
   * on the revocation denylist or has no static KeyPackage, and `sendWelcome` hard-fails without
   * one; the paths that mark a membership `active` checked neither. That asymmetry is WP-GHOST-1:
   * a device deleted through the product (footprint purged, denylisted) was resurrected as an
   * `active` membership by a PEER whose local MLS tree still carried its leaf, after which
   *
   *   - the fan-out kept queueing every message to it (`status = 'active'`),
   *   - `getUserDevices` could not list it (it filters on KeyPackage), so its owner could not
   *     delete it a second time,
   *   - `cleanupStaleDevices` enumerates candidates FROM `key_package`, so it never saw it,
   *   - `detectStaleDevices` pre-filtered on `updatedAt`, which peers keep bumping.
   *
   * Measured on production 2026-08-06: nine such devices held 97 353 of the 98 210 queued rows.
   * One of them, `tauri-...-ms8xyqkk-2rwh`, was revoked on 2026-07-31 and its membership rows were
   * still being written on 2026-08-04.
   *
   * Returns a reason rather than throwing: callers differ in what they owe the client (a 403, a
   * skip, or a log), and every one of them must be able to say WHY in its own log line.
   */
  async deviceAddressability(
    userId: string,
    deviceId: string
  ): Promise<{ ok: boolean; reason?: 'revoked' | 'no_key_package' }> {
    const revoked = await this.revokedDeviceRepo.findOne({
      where: activeRevocationWhere({ userId, deviceId }),
    });
    if (revoked) return { ok: false, reason: 'revoked' };
    const keyPackage = await this.keyPackageRepo.findOne({
      where: { userId, deviceId },
      select: { id: true },
    });
    if (!keyPackage) return { ok: false, reason: 'no_key_package' };
    return { ok: true };
  }

  /**
   * Deletes the entire server footprint of a device (per-device state):
   * device<->group memberships, static KeyPackage, one-time prekeys, push tokens,
   * undelivered queued messages, and Redis routing set membership.
   *
   * Does NOT touch `dm_group_members` (user-level membership shared across the user's
   * devices) nor the `RevokedDevice` denylist (specific to explicit deletion, outside GC).
   * Shared between manual device deletion and the stale-device GC to avoid duplicated
   * purge logic.
   */
  async purgeDeviceFootprint(
    userId: string,
    deviceId: string
  ): Promise<{
    groupsCleaned: number;
    keyPackagesDeleted: number;
    oneTimeKeyPackagesDeleted: number;
    queuedMessagesDeleted: number;
  }> {
    const memberships = await this.deviceGroupRepo.find({
      where: { userId, deviceId },
      select: { groupId: true },
    });
    const groupIds = [...new Set(memberships.map((m) => m.groupId))];

    await this.deviceGroupRepo.delete({ userId, deviceId });

    const memberKey = `${userId}:${deviceId}`;
    for (const gid of groupIds) {
      await this.redis.srem(`group:members:${gid}`, memberKey);
    }

    const [kpResult, otkpResult, queuedResult] = await Promise.all([
      this.keyPackageRepo.delete({ userId, deviceId }),
      this.oneTimeKeyPackageRepo.delete({ userId, deviceId }),
      this.queuedMessageRepo.delete({ recipientId: userId, deviceId }),
      this.pushTokenRepo.delete({ userId, deviceId }),
    ]);

    return {
      groupsCleaned: groupIds.length,
      keyPackagesDeleted: kpResult.affected ?? 0,
      oneTimeKeyPackagesDeleted: otkpResult.affected ?? 0,
      queuedMessagesDeleted: queuedResult.affected ?? 0,
    };
  }

  private makeTraceId(scope: string): string {
    const { randomUUID } = crypto;
    return `${scope}-${randomUUID().slice(0, 8)}`;
  }

  /**
   * Binds a client-supplied `requesterUserId` to the authenticated caller.
   *
   * The welcome/history-request fan-out relays a control frame naming the requester so that peers
   * re-invite (or re-deliver history to) that identity. Because the requester device is typically
   * NOT yet a group member, membership cannot be checked here - the only meaningful gate is that a
   * caller may solicit re-invites/history for THEIR OWN identity only. Without this, a session
   * holder could forge `requesterUserId` to spoof another user across the fan-out.
   *
   * `authUserIdRaw` is the `x-user-id` header injected by nginx after auth. When it is absent
   * (legacy no-op, matching the rest of the authz campaign) the check is skipped; when present it
   * must equal the body's requester, otherwise a ForbiddenException is thrown.
   */
  private assertRequesterMatchesCaller(
    authUserIdRaw: string | undefined,
    requesterUserId: string,
    traceId: string,
    scope: string
  ): void {
    const authUserId = sanitizeOptionalQueryValue(authUserIdRaw, 'x-user-id');
    if (authUserId && authUserId.toLowerCase() !== requesterUserId.toLowerCase()) {
      this.logger.warn(
        `[${scope}][${traceId}] AUTHZ FAIL caller=${authUserId} != requester=${requesterUserId}`
      );
      throw new ForbiddenException('requesterUserId does not match the authenticated caller');
    }
  }

  private isTerminalPushTokenError(error: unknown): boolean {
    const rawCode =
      typeof error === 'object' && error && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    const code = typeof rawCode === 'string' ? rawCode : '';

    return (
      code === 'messaging/invalid-registration-token' ||
      code === 'messaging/registration-token-not-registered'
    );
  }

  /**
   * Whether FCM refused a message for SIZE rather than for the token or the network.
   *
   * Classified on the error CODE, never on its prose: `messaging/payload-size-limit-exceeded` is
   * the documented code, and `invalid-argument` is what the v1 endpoint returns for the same
   * condition. The message ("Message is too large. The maximum is 4K (4096 bytes).") is only used
   * to narrow the second, because `invalid-argument` covers other faults too - and a distinction
   * carried in prose is one exactly this call site may make.
   *
   * @param error - Whatever `getMessaging().send()` threw.
   */
  private isPayloadTooLargeError(error: unknown): boolean {
    const asRecord = typeof error === 'object' && error ? (error as Record<string, unknown>) : {};
    const code = typeof asRecord.code === 'string' ? asRecord.code : '';
    if (code === 'messaging/payload-size-limit-exceeded') return true;
    const message = typeof asRecord.message === 'string' ? asRecord.message : '';
    return code === 'messaging/invalid-argument' && /too large/i.test(message);
  }

  /**
   * Send a data-only FCM push to every token registered for a given queued
   * message's recipient.  Data-only means onMessageReceived() fires even when
   * the app is in the background, letting the Android service decrypt and
   * display the notification locally.
   */
  private async sendFcmForQueued(
    queued: QueuedMessage,
    traceId: string,
    groupId: string,
    senderId: string,
    silent = false
  ): Promise<void> {
    if (getApps().length === 0) return;

    const pushTokens = await this.pushTokenRepo.find({
      where: { userId: queued.recipientId, deviceId: queued.deviceId },
    });

    if (pushTokens.length === 0) {
      this.logger.log(
        `[PUSH_SEND][${traceId}] No push token for user=${queued.recipientId} device=${queued.deviceId}`
      );
      return;
    }

    // Resolve group name for a meaningful fallback when the Android service
    // cannot decrypt (app killed, JNI state unavailable).
    let groupName = '';
    try {
      const group = await this.groupRepo.findOne({
        where: { id: groupId },
        select: { name: true, isGroup: true },
      });
      groupName = group?.isGroup ? (group?.name ?? '') : '';
    } catch {
      /* non-fatal */
    }

    // Resolve sender display name so the notification title is human-readable
    // when decryption fails in the background (SQLite lock / MLS state absent).
    const senderName = await resolveUserDisplayName(this.groupRepo.manager, senderId);

    // Inline ciphertext eliminates the extra HTTP round-trip in the Kotlin
    // service and avoids auth issues when the app is cold-started. FCM caps the
    // DATA MAP at 4 KB, keys included - so what the ciphertext may occupy is
    // whatever the other nine fields leave, computed from the fields themselves
    // (`inlineProtoBudget`). A constant chosen ahead of them bounded the wrong
    // quantity and let a long sender or group name push the map past the limit.
    const protoB64 = queued.proto ?? queued.content ?? '';

    // Shared, transport-agnostic description consumed by both the FCM data
    // payload and the APNs custom keys (see push-payload.ts).
    const messageInput: PushMessageInput = {
      groupId,
      queuedMessageId: queued.id,
      senderId,
      senderName,
      groupName,
      // Filled in below once the budget the other fields leave is known.
      proto: '',
      // Own-device copies, read receipts and welcome packets are not shown.
      silent: silent || queued.recipientId === senderId,
      isWelcome: !!queued.isWelcome,
      createdAt: queued.createdAt.toISOString(),
    };

    const budget = inlineProtoBudget(messageInput);
    const protoBytes = Buffer.byteLength(protoB64, 'utf8');
    const inlineProto = protoBytes > 0 && protoBytes <= budget ? protoB64 : '';
    messageInput.proto = inlineProto;
    if (protoBytes > budget) {
      // Not an error: the client fetches the ciphertext instead. It IS worth a line, because a
      // budget that is routinely too small is the fixed fields growing, and nothing else watches
      // them - `senderName` and `groupName` are unbounded user text.
      this.logger.log(
        `[PUSH_SEND][${traceId}] proto not inlined: ${protoBytes}B over a ${budget}B budget ` +
          `(senderName=${Buffer.byteLength(senderName, 'utf8')}B groupName=${Buffer.byteLength(groupName, 'utf8')}B)`
      );
    }

    const dataFields = buildPushDataFields(messageInput);
    const dataBytes = measureDataFields(dataFields);

    // Single transport for every device: FCM. Android receives the data-only
    // message (onMessageReceived fires foreground + background); iOS pushes are
    // relayed by FCM to APNs via the apns block (the .p8 APNs auth key is
    // configured in the Firebase console, so no direct APNs provider is needed).
    // Sized on the longest fallback body, which is what `inlineProtoBudget` admitted the ciphertext
    // against: the per-device substitution below can only make a payload SHORTER than this.
    const sizingRequest = buildApnsRequest(messageInput, dataFields, LONGEST_FALLBACK_LOCALE);
    const apnsBytes = measureApnsPayload(sizingRequest.payload);
    // Neither depends on the language, so both are decided once for every device.
    const { pushType: apnsPushType, priority: apnsPriority } = sizingRequest;

    // ONE BLOCK PER TOKEN, BECAUSE THE PLATFORM IS KNOWN HERE. Every message used to carry BOTH
    // the `data` map and an `apns` payload that `buildApnsRequest` spreads the same fields into -
    // so the ciphertext travelled twice in one message, and FCM sizes the message, not the half
    // the device will read. Measured on the shape that failed: data 3 789 B + apns 4 005 B =
    // 7 794 B against a 4 096 B limit, for a proto the old guard had passed. That is what refused
    // ten pushes in one run, twice over (2026-08-29 and 2026-08-30). FCM ignores the apns block
    // for an Android token and the data map is redundant for an iOS one - the APNs payload is
    // self-contained by design - so each token now carries exactly the half it reads.
    for (const pt of pushTokens) {
      try {
        await getMessaging().send(
          pt.platform === 'ios'
            ? {
                token: pt.token,
                apns: {
                  // Built HERE and not once above: the fallback body is the one sentence this
                  // server still composes, and only the token says which language to compose it
                  // in. Everything else in the payload is identical across devices.
                  payload: buildApnsRequest(messageInput, dataFields, pt.locale).payload,
                  headers: {
                    'apns-push-type': apnsPushType,
                    'apns-priority': String(apnsPriority),
                  },
                },
              }
            : {
                token: pt.token,
                data: dataFields,
                android: {
                  priority: 'high',
                  ttl: 86_400_000,
                },
              }
        );
        this.logger.log(
          `[PUSH_SEND][${traceId}] FCM sent user=${queued.recipientId} device=${pt.deviceId} platform=${pt.platform} inlineProto=${!!inlineProto} bytes=${pt.platform === 'ios' ? apnsBytes : dataBytes}`
        );
      } catch (e) {
        if (this.isTerminalPushTokenError(e)) {
          await this.pushTokenRepo.delete({ id: pt.id });
          this.logger.warn(
            `[PUSH_SEND][${traceId}] Deleted invalid push token user=${queued.recipientId} device=${pt.deviceId}`
          );
        }
        this.logger.warn(
          `[PUSH_SEND][${traceId}] FCM failed user=${queued.recipientId} device=${pt.deviceId} err=${String(e)}`
        );
        // A size refusal is the one failure whose cause is entirely in our hands, and the error
        // FCM returns names no quantity at all - ten of them in one run said only "too large".
        // The payload is right here, so report what was actually sent: the data map as FCM counts
        // it, the APNs payload it is ALSO spread into (whether that duplication counts towards the
        // same 4096 is the open question), and the largest single field.
        if (this.isPayloadTooLargeError(e)) {
          const [largestKey, largestValue] = Object.entries(dataFields).reduce((a, b) =>
            Buffer.byteLength(b[1], 'utf8') > Buffer.byteLength(a[1], 'utf8') ? b : a
          );
          this.logger.warn(
            `[PUSH_SIZE][${traceId}] refused over size on ${pt.platform}: ` +
              `sent=${pt.platform === 'ios' ? apnsBytes : dataBytes}B (limit ${FCM_DATA_LIMIT}) ` +
              `data=${dataBytes}B apnsPayload=${apnsBytes}B ` +
              `largest=${largestKey}:${Buffer.byteLength(largestValue, 'utf8')}B inlineProto=${!!inlineProto}`
          );
        }
      }
    }
  }

  /**
   * Schedule a deferred FCM fallback for an "online" device.
   *
   * Android keeps the WebSocket TCP connection alive even when the app is
   * backgrounded/frozen, making `redis.exists(presence_key)` return true.
   * We send via WebSocket first, then check after DELAY_MS whether the client
   * ACKed the message.  If it has not (app could not process the WS frame),
   * we fire an FCM push so the user still gets a notification.
   */
  private scheduleDeferredPush(
    queued: QueuedMessage,
    traceId: string,
    groupId: string,
    senderId: string,
    silent = false
  ): void {
    const DELAY_MS = 10_000;
    // setTimeout expects () => void; extract the async work into a separate
    // method to satisfy @typescript-eslint/no-misused-promises.
    setTimeout(() => {
      void this.runDeferredPush(queued, traceId, groupId, senderId, silent).catch((e) =>
        this.logger.warn(`[PUSH_DEFERRED][${traceId}] deferred push error: ${e}`)
      );
    }, DELAY_MS);
  }

  private async runDeferredPush(
    queued: QueuedMessage,
    traceId: string,
    groupId: string,
    senderId: string,
    silent = false
  ): Promise<void> {
    const stillQueued = await this.queuedMessageRepo.findOne({
      where: { id: queued.id },
    });
    if (!stillQueued) {
      // Client ACKed via WebSocket - nothing to do.
      return;
    }
    this.logger.log(
      `[PUSH_DEFERRED][${traceId}] queuedId=${queued.id} still unACKed after 10 s → FCM fallback`
    );
    await this.sendFcmForQueued(queued, `${traceId}-def`, groupId, senderId, silent);
  }

  /**
   * Persists and delivers an MLS application message to all group members.
   * Handles the proto path - every live client, plus the two PushSecret routes and the commit
   * fan-out - and a legacy plaintext-`content` path no shipped client has taken since MLS.
   * For online recipients, publishes via Redis pub/sub and schedules a deferred FCM fallback.
   * For offline recipients, schedules an immediate FCM push (non-blocking).
   */
  async sendMessage(body: SendMessageBody, authUserIdRaw?: string): Promise<SendMessageResult> {
    const traceId = this.makeTraceId('send');

    // `senderId` is what the shared log records as the author of the frame, and what a device
    // replaying the log attributes the message - and every mutation in it - to. It was taken from
    // the body and never compared to the authenticated caller, so a member could write frames into
    // a group's log under another member's name. Absent header = an internal caller (the gateway),
    // which never crosses nginx and therefore has none; same rule as every other route here.
    if (body.senderId) {
      this.assertRequesterMatchesCaller(authUserIdRaw, body.senderId, traceId, 'SEND');
    }

    const ops: QueuedMessage[] = [];
    let sentCount = 0;

    this.logger.log(
      `[SEND][${traceId}] START group=${body.groupId ?? 'none'} sender=${body.senderId ?? 'unknown'}:${body.senderDeviceId ?? 'unknown'} hasProto=${!!body.proto} isWelcome=${!!body.isWelcome} isCommit=${!!body.isCommit}`
    );

    if (body.proto) {
      // ── Proto path: proto = base64(raw MLS ciphertext) ────────────────────
      //
      // The recipient set is RESOLVED HERE, from the membership table. It is the path, not a
      // repair of one. It used to sit behind `if (ops.length === 0)`, after a loop over
      // `body.recipients`, under a comment reading "Fallback: recipients not provided (Redis
      // cache miss)" - and NO caller has ever populated that field: not the client
      // (`postApplicationMessage` posts six keys and none is `recipients`), not the gateway (the
      // word does not occur anywhere in its source), not either PushSecret route, not the commit
      // fan-out. `libs/proto/canari.proto` says so outright: "leave empty = derive from group
      // members". So the guard was true on every send, the "fallback" was the only path, and it
      // announced a cache miss on 100 % of traffic for a cache it never read. A fallback is a
      // signal, never a path: named one, it went unexamined for as long as it existed.
      const { proto } = body;
      if (body.groupId) {
        const groupId = body.groupId;

        // A SEND FROM A DEVICE THAT HOLDS NO LEAF IS UNDECRYPTABLE FOR EVERY RECIPIENT, and the
        // server holds the fact that says so before it queues a single row. A membership that is
        // not `active` means no Welcome was ever honoured, so the device is not in the MLS tree:
        // whatever it encrypts is ciphertext nobody in the group can open, fanned out to every
        // active device, while its author watches it leave. Measured on prod 2026-09-02:
        // `web-...-mtbep8vs-5oxb` sat `pending` in group `7da231f8` and sent six messages in 24
        // seconds - 30 rows of guaranteed garbage (`docs/wiki/backlog.md`).
        //
        // Refusing is not a policy preference. Accepting it is the shape the durable rules name
        // outright: handing an operation to a layer certain to refuse it, in order to classify the
        // refusal, when the discriminator was already known here.
        //
        // HANDSHAKE FRAMES ARE EXEMPT, and that is the whole subtlety. An external-commit join is
        // performed BY a device that is legitimately not active yet - `validateCommit` promotes it
        // precisely because such a device never receives a Welcome - so gating commits and Welcomes
        // here would wall up the one door out of `pending`.
        const isHandshake = !!body.isCommit || !!body.isWelcome;
        if (!isHandshake && body.senderId && body.senderDeviceId) {
          const senderMembership = await this.deviceGroupRepo.findOne({
            where: { groupId, deviceId: body.senderDeviceId },
          });
          if (!senderMembership) {
            // Not refused: a missing row is a different defect from a `pending` one, with causes
            // this seam cannot see. It is logged because nothing else would ever show it.
            this.logger.warn(
              `[SEND][${traceId}] sender has NO membership row group=${groupId} device=${body.senderDeviceId}`
            );
          } else if (senderMembership.status !== 'active') {
            this.logger.error(
              `[SEND][${traceId}] REJECT sender_not_active group=${groupId} ` +
                `device=${body.senderDeviceId} status=${senderMembership.status} - the device holds ` +
                `no leaf, so nothing it encrypts can be opened by anyone in the group`
            );
            throw new ForbiddenException({
              error: 'sender_not_active',
              groupId,
              deviceId: body.senderDeviceId,
              status: senderMembership.status,
            });
          }
        }

        const memberships = await this.deviceGroupRepo.find({
          where: {
            groupId,
            status: 'active' as const,
          },
        });
        const excludeSet = new Set<string>(body.excludeDeviceIds ?? []);
        const isSender = (m: { userId: string; deviceId: string }) =>
          m.userId === body.senderId && m.deviceId === body.senderDeviceId;
        // A device with no static KeyPackage does not exist server-side: it cannot be invited, it
        // cannot be Welcomed, and it is not even listed to its own owner - so queueing for it is
        // storage that nothing will ever collect or read (WP-GHOST-1). Deliberately narrow: an
        // `active` membership whose device merely went quiet still has its KeyPackage for the
        // whole 90-day window, so a legitimately offline device is never dropped.
        const liveDeviceIds = memberships.length
          ? new Set(
              (
                await this.keyPackageRepo.find({
                  where: {
                    deviceId: In([...new Set(memberships.map((m) => m.deviceId))]),
                  },
                  select: { userId: true, deviceId: true },
                })
              ).map((kp) => `${kp.userId}:${kp.deviceId}`)
            )
          : new Set<string>();
        const targets = memberships.filter(
          (m) =>
            !isSender(m) &&
            !excludeSet.has(`${m.userId}:${m.deviceId}`) &&
            liveDeviceIds.has(`${m.userId}:${m.deviceId}`)
        );
        const ghosts = memberships.filter(
          (m) =>
            !isSender(m) &&
            !excludeSet.has(`${m.userId}:${m.deviceId}`) &&
            !liveDeviceIds.has(`${m.userId}:${m.deviceId}`)
        );
        if (ghosts.length > 0) {
          // The outbox is best-effort at every step, so every swallowed branch logs - that is all
          // a dropped recipient leaves behind.
          this.logger.warn(
            `[SEND][${traceId}] SKIPPED_NO_KEY_PACKAGE group=${groupId} ` +
              `devices=${ghosts.map((m) => `${m.userId}:${m.deviceId}`).join(',')}`
          );
        }
        for (const m of targets) {
          ops.push(
            this.queuedMessageRepo.create({
              recipientId: m.userId,
              deviceId: m.deviceId,
              senderId: body.senderId,
              senderDeviceId: body.senderDeviceId,
              groupId,
              isWelcome: body.isWelcome,
              isCommit: body.isCommit,
              proto,
              createdAt: new Date(),
            })
          );
        }

        // The gateway's routing set is OWNED by `activateDeviceMembership`, which writes it at
        // the pending->active transition - the moment membership is decided. What remains here is
        // a RECONCILIATION, and it exists for one historical reason: Redis ran without a volume
        // until 2026-08-12, so the sets that died with the container have no other writer until
        // each device happens to re-activate. Measured on prod 2026-08-15: of the 23 groups
        // holding active memberships, the 15 that HAVE a set are complete to the row - 0 missing,
        // 0 stale - so this adds nothing at all on any group it has ever run against, and the 11
        // rows spread over the 8 setless groups are the whole of what it still has to repair.
        //
        // It therefore reports only when it CHANGES something, and it accuses when it does: an
        // active device absent from this set is one the gateway silently fails to reach
        // (`broadcast_to_group_members` proceeds with an empty member list and sends to nobody)
        // and one that can never be elected to answer a `welcome_request` or a `history_request`.
        // Firing at all means an owner did not write, and the fix belongs there.
        //
        // Reconciled against every LIVE member, not against `targets`: the sender is excluded from
        // its own delivery and an `excludeDeviceIds` entry from this one send, but both are
        // routable members like any other, and leaving them out made the repair incomplete by
        // construction - a member missing from the set is unelectable for ever.
        const routable = memberships
          .filter((m) => liveDeviceIds.has(`${m.userId}:${m.deviceId}`))
          .map((m) => `${m.userId}:${m.deviceId}`);
        if (routable.length > 0) {
          const added = await this.redis.sadd(`group:members:${groupId}`, ...routable);
          if (added > 0) {
            this.logger.warn(
              `[SEND][${traceId}] MEMBERS_CACHE_REPAIRED group=${groupId} added=${added} of=${routable.length}` +
                ` - these active devices were absent from the gateway routing set and unreachable by it`
            );
          }
        }
      }
    } else {
      // ── Legacy path (frontend fallback / group fan-out) ───────────────────
      //
      // A FALLBACK IS A SIGNAL, NEVER A PATH. This branch predates MLS and writes `content` instead
      // of `proto`; the database says nothing has taken it - 817 of 817 queued rows carry `proto`
      // and `content` is NULL on every one, back to 2026-07-28. That is strong but it is not a
      // census: the queue holds only what was UNDELIVERED, so a legacy message delivered instantly
      // leaves no row behind, and the service log window is one container lifetime. So the branch
      // accuses instead of answering silently, and its removal date is set from what this line does
      // or does not print (see docs/wiki/legacy-compatibility.md).
      this.logger.warn(
        `[SEND][${traceId}] LEGACY_CONTENT_PATH sender=${body.senderId ?? 'unknown'}:${body.senderDeviceId ?? 'unknown'} ` +
          `group=${body.groupId ?? 'none'} - a client sent no proto; this path is retired and its caller must be found`
      );
      const senderId = sanitizeQueryValue(body.senderId, 'senderId');
      const senderDeviceId = sanitizeOptionalQueryValue(body.senderDeviceId, 'senderDeviceId');
      const groupId = sanitizeQueryValue(body.groupId, 'groupId');
      const rawContent: unknown = body.content;
      const rawType: unknown = body.type;

      if (typeof rawContent !== 'string' || rawContent.length === 0) {
        throw new BadRequestException('content is required');
      }

      const safeContent: string = rawContent;
      const safeType: string =
        typeof rawType === 'string' && rawType.length > 0 ? rawType : 'message';

      const targetList: { userId: string; deviceId: string }[] = [];

      if (!body.recipients || body.recipients.length === 0) {
        const members = await this.groupMemberRepo.find({ where: { groupId } });
        const memberUserIds = members.map((m) => m.userId).filter((id) => id !== senderId);

        if (memberUserIds.length > 0) {
          const devices = await this.keyPackageRepo.find({
            where: { userId: In(memberUserIds) },
          });
          for (const d of devices) {
            targetList.push({ userId: d.userId, deviceId: d.deviceId });
          }
        }
      } else {
        for (const r of body.recipients) {
          const recipientUserId = sanitizeQueryValue(r.userId, 'recipients.userId');
          if (r.deviceId) {
            const recipientDeviceId = sanitizeQueryValue(r.deviceId, 'recipients.deviceId');
            targetList.push({
              userId: recipientUserId,
              deviceId: recipientDeviceId,
            });
          } else {
            console.warn(
              'Skipping recipient without deviceId. Fan-out is disabled for MLS security.'
            );
          }
        }
      }

      for (const r of targetList) {
        ops.push(
          this.queuedMessageRepo.create({
            recipientId: r.userId,
            deviceId: r.deviceId,
            senderId,
            senderDeviceId,
            groupId,
            content: safeContent,
            type: safeType,
            createdAt: new Date(),
          })
        );
      }
    }

    // The sender declares durability (`body.durable`); the server sees ciphertext and can classify
    // nothing. It is needed BEFORE the persist below, because it decides who is even a recipient.
    const durable = body.durable ?? !body.silent;

    // Who is reachable right now. Asked once and reused by both the filter below and the delivery
    // loop, which used to ask Redis the same question a second time per recipient.
    const online = new Map<string, boolean>();
    for (const queued of ops) {
      const k = `${queued.recipientId}:${queued.deviceId}`;
      if (!online.has(k)) online.set(k, !!(await this.redis.exists(`user:online:${k}`)));
    }

    // A TRANSPORT frame is addressed to whoever is online NOW, and to nobody else.
    //
    // It is the same argument that keeps these frames out of the history stream one block below, and
    // it is stronger here. A transport frame is one half of a rendezvous that expires in 60 s
    // (`DIGEST_TTL_MS`), so a row drained by a device that reconnects later is answered by nothing
    // at all - and the reconciliation probe is elected only among devices Redis reports ONLINE, so
    // an offline device could not have been the responder even if it had the frame. Queueing it
    // wrote a row per member device and woke each of them with a silent FCM push, for an exchange
    // they were structurally unable to join. A device that comes back probes on its own connection.
    const toDeliver = durable
      ? ops
      : ops.filter((q) => online.get(`${q.recipientId}:${q.deviceId}`) === true);
    if (!durable && toDeliver.length < ops.length) {
      // NAMING THE DEVICES IT DROPPED, because the count alone cannot say which cause this was.
      // "the device really was offline" and "the group named a device that is not the live one" both
      // arrive here as `count=1`, they want opposite fixes, and telling them apart meant reading
      // Redis by hand against a group the run had already deleted. Measured on 2026-08-25 (COMM-18):
      // a phone's seed request was dropped for one offline recipient while the only device it could
      // have meant was answering pings throughout, and this line could not settle which. The ids are
      // exactly what the presence lookup was keyed on, so they are the evidence it owed.
      const skipped = ops
        .filter((q) => online.get(`${q.recipientId}:${q.deviceId}`) !== true)
        .map((q) => q.deviceId);
      this.logger.log(
        `[SEND][${traceId}] TRANSPORT_SKIPPED_OFFLINE count=${ops.length - toDeliver.length} ` +
          `group=${body.groupId ?? ''} devices=${skipped.join(',')} ` +
          `- no row, no push: the rendezvous would expire first`
      );
    }

    // 1. Persist ALL messages first (survives crashes / timing races)
    if (toDeliver.length > 0) {
      await this.enqueueForLiveGroup(toDeliver, body.groupId, 'SEND', traceId);
      this.logger.log(`[SEND][${traceId}] QUEUED count=${toDeliver.length}`);
    } else {
      // TWO CAUSES, AND THE SENTENCE USED TO NAME NEITHER. `toDeliver` empties for one of exactly
      // two reasons and they want opposite readings: a group that named no other device has nobody
      // to queue for and nothing is wrong, while a TRANSPORT frame whose every recipient went offline
      // is a rendezvous that will now expire unanswered. A warning that cannot say which is a warning
      // its reader learns to skip - and this one fires on the ordinary path, during an invite into a
      // group whose other members have not joined yet.
      this.logger.warn(
        `[SEND][${traceId}] No message queued after validation - recipients=${ops.length} durable=${durable}` +
          (ops.length === 0
            ? ' - the group named no other device, so there was nobody to queue for'
            : ' - every recipient device is offline and this frame is transport-only')
      );
    }

    // 1b. Append to the group's shared history stream, so a device that was absent can obtain the
    // frame without a peer being online.
    //
    // `durable` is computed above, where it also decides the recipient set. Two things are still
    // excluded here rather than by the client:
    //  - Welcome / Commit: MLS epoch-transition frames that cannot be replayed out of order.
    //  - anything without a group or a sender: there is no stream to write to.
    //
    // This condition used to read `!body.silent`. Since every control frame is silent by
    // construction, that excluded every reaction, edit, deletion and read receipt from the only
    // shared copy that exists - the defect this rework removes
    // (`docs/wiki/protocols/history-reconciliation.md`).
    if (
      body.proto &&
      !body.isWelcome &&
      !body.isCommit &&
      durable &&
      body.groupId &&
      body.senderId
    ) {
      try {
        const historyKey = `history:${body.groupId}`;
        // ONE ROUND TRIP FOR THE THREE COMMANDS. They are a single statement about the stream -
        // append it, bound it, keep the key alive - and issuing them one await at a time paid a
        // round trip each on the hot send path for no added guarantee.
        const written = await this.redis
          .pipeline()
          .xadd(
            historyKey,
            'MAXLEN',
            '~',
            String(HISTORY_STREAM_MAXLEN),
            '*',
            'sender_id',
            body.senderId,
            // THE DEVICE, NOT ONLY THE USER - and it is written here because here is the only place
            // it is still known. `history:{gid}` is ONE stream per group and must hold this device's
            // own frames, because every other member reads it; MLS then refuses them by construction
            // (`CannotDecryptOwnMessage`). `sender_id` cannot filter them: a user's OTHER device's
            // frames are both decryptable and wanted. So without this field a replay learns which
            // rows are its own only by handing each one to MLS to be refused - measured at 5 certain
            // failures per capture, every capture, and thousands per full replay of a 4 282-message
            // DM. Never learn by failing what a fact could have told you.
            'sender_device_id',
            body.senderDeviceId ?? '',
            'content',
            body.proto,
            'timestamp',
            new Date().toISOString(),
            // The stream used to hold visible messages only, so every consumer could assume a frame
            // read from it was showable. It now also holds mutations, and the server cannot tell
            // them apart afterwards - the payload is ciphertext. So visibility is recorded here, at
            // the one point where it is known. See `redeliverMissedDuringActivationWindow`, which
            // notifies from this stream and would otherwise ring for every reaction.
            'silent',
            body.silent ? '1' : '0'
          )
          // THE AGE BOUND - the one the rest of the system already claims and this stream alone did
          // not honour. `MAXLEN` bounds the stream by COUNT, which says nothing about how far back
          // it reaches: a group under the cap kept every frame it ever held, because the cap was
          // never met and the TTL above is refreshed on every write. Measured on production
          // 2026-08-17: four of five streams still carried rows from before 2026-08-15, at 1 to 11
          // entries each. Four compatibility shims are retired on "no row older than the retention
          // window can still exist" (`docs/wiki/legacy-compatibility.md`), and that sentence was
          // simply not true of an active group.
          //
          // EXACT, NOT `~`: an approximate trim stops at node boundaries and keeps up to a node's
          // worth of older entries, and a date that nothing may be older than cannot be
          // approximate. The cost is bounded - each entry is deleted once, ever, and the stream is
          // capped at `HISTORY_STREAM_MAXLEN`.
          .xtrim(historyKey, 'MINID', String(Date.now() - RETENTION_WINDOW_MS))
          // Refresh TTL on every write so abandoned groups are evicted after the offline-recovery
          // window of inactivity. Same window as every other staleness threshold, by construction.
          .expire(historyKey, Math.floor(RETENTION_WINDOW_MS / 1000))
          .exec();

        // A pipeline reports per-command failures in its RESULTS, not by throwing, so the `catch`
        // below never sees them. Left unread, a stream that stopped being trimmed or expired would
        // look exactly like one that was.
        if (!written) {
          this.logger.warn(`[HISTORY][${traceId}] pipeline aborted group=${body.groupId}`);
        } else {
          written.forEach(([err], i) => {
            if (err) {
              const name = ['XADD', 'XTRIM', 'EXPIRE'][i] ?? `command ${i}`;
              this.logger.warn(
                `[HISTORY][${traceId}] ${name} failed group=${body.groupId}: ${String(err)}`
              );
            }
          });
        }
        this.logger.log(`[HISTORY][${traceId}] XADD group=${body.groupId}`);
      } catch (e) {
        this.logger.warn(`[HISTORY][${traceId}] XADD failed group=${body.groupId}: ${String(e)}`);
      }
    }

    // 2. Best-effort real-time delivery for online recipients
    for (const queued of toDeliver) {
      // Reuses the answer taken above rather than asking Redis a second time. A device that went
      // offline in between is covered the same way it always was: the row survives and its next
      // pull redelivers it.
      const isOnline = online.get(`${queued.recipientId}:${queued.deviceId}`) === true;
      this.logger.log(
        `[SEND][${traceId}] recipient=${queued.recipientId}:${queued.deviceId} online=${isOnline} queuedId=${queued.id}`
      );
      if (isOnline) {
        const envelope = JSON.stringify({
          recipientId: queued.recipientId,
          deviceId: queued.deviceId,
          senderId: body.senderId ?? '',
          senderDeviceId: body.senderDeviceId ?? '',
          groupId: body.groupId ?? '',
          isWelcome: body.isWelcome ?? false,
          isCommit: body.isCommit ?? false,
          proto: queued.proto ?? queued.content ?? '',
          queuedMessageId: queued.id,
          createdAt: queued.createdAt.toISOString(),
        });
        await this.redis.publish('chat:messages', envelope);
        sentCount++;
        this.logger.log(
          `[SEND][${traceId}] PUBLISHED recipient=${queued.recipientId}:${queued.deviceId} queuedId=${queued.id}`
        );

        // Deferred FCM fallback: Android keeps the WebSocket TCP connection alive
        // even when the app is in the background, so `isOnline` can be true while
        // the app can no longer process WebSocket frames. If the queued message is
        // still unACKed after DEFERRED_PUSH_DELAY_MS, the WebSocket delivery failed
        // silently → fall back to FCM so the user still gets a notification.
        // Welcome packages use a silent push (no visible notification) so the
        // app can process the MLS welcome without spamming the user.
        //
        // NOT for a transport frame. The fallback exists to deliver something LATER that is still
        // worth having; a rendezvous half is worth nothing after 60 s, so the push would wake the
        // device to hand it an expired exchange. The Redis PUBLISH above is the whole delivery
        // mechanism for this class, and missing it costs one deferred repair, not a message.
        if (durable) {
          this.scheduleDeferredPush(
            queued,
            traceId,
            body.groupId ?? '',
            body.senderId ?? '',
            body.isCommit || body.isWelcome ? true : (body.silent ?? false)
          );
        }
      } else {
        // Offline recipient: FCM push (silent for commits/welcomes).
        // Fire-and-forget: the message is already persisted; blocking on FCM
        // (often 2-5 s per device) would stall POST /send for the sender.
        //
        // Unreachable for a transport frame - the filter above kept only online recipients - and
        // guarded anyway, so that changing the filter cannot quietly restore the push.
        if (durable) {
          void this.sendFcmForQueued(
            queued,
            traceId,
            body.groupId ?? '',
            body.senderId ?? '',
            body.isCommit || body.isWelcome ? true : (body.silent ?? false)
          ).catch((e) =>
            this.logger.warn(`[PUSH_SEND][${traceId}] async FCM error queuedId=${queued.id}: ${e}`)
          );
        }
      }
    }

    // The count REPORTED is the count actually written, not the count considered - a transport frame
    // drops its offline recipients above, and a log that still said `ops.length` would describe rows
    // that do not exist.
    this.logger.log(`[SEND][${traceId}] DONE queued=${toDeliver.length} realtime=${sentCount}`);

    return { status: 'processed', queued: toDeliver.length, sent: sentCount };
  }

  /**
   * Epoch-gated commit: validates that the sender's baseEpoch matches the
   * group's activeEpoch before allowing the commit through.
   * Prevents MLS epoch forks caused by concurrent commits from multiple devices.
   *
   * Returns accepted=true with newEpoch on success, or accepted=false with
   * currentEpoch and a reason string when the commit is rejected.
   */
  async validateCommit(body: ValidateCommitBody): Promise<ValidateCommitResult> {
    const traceId = this.makeTraceId('commit');
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const baseEpoch =
      typeof body.baseEpoch === 'number' && Number.isFinite(body.baseEpoch)
        ? Math.floor(body.baseEpoch)
        : -1;

    if (baseEpoch < 0) {
      this.logger.warn(
        `[COMMIT][${traceId}] Invalid baseEpoch=${body.baseEpoch} group=${groupId} device=${deviceId}`
      );
      throw new BadRequestException('baseEpoch must be a non-negative integer');
    }

    // A COMMIT THAT CANNOT BE REPLAYED MAY NOT ADVANCE THE EPOCH.
    //
    // Without `proto` there is nothing to record, so the counter moves and the log gains no row -
    // a hole by construction, and a permanent one: `IDX_mls_commit_log_group_epoch` is UNIQUE on
    // `(groupId, baseEpoch)`, so no later call can ever refill the epoch this one skipped, and
    // every device that stops there needs a destructive re-Welcome to move again. The old code
    // took this path in silence, under `if (body.proto)`, without even the warning that the
    // failure branch below it had.
    //
    // `proto` was documented optional for backward compatibility, and nothing needs that: the only
    // caller, `submitCommit` in `frontend/src/lib/mls-client/mlsDeliveryApi.ts`, has always taken
    // `protoBase64` as a REQUIRED argument. Held as a const so the epoch-advance transaction below
    // reads a value the compiler knows is present.
    const commitProto = body.proto;
    if (!commitProto) {
      this.logger.error(
        `[COMMIT][${traceId}] REJECT no_proto group=${groupId} device=${deviceId} baseEpoch=${baseEpoch}`
      );
      throw new BadRequestException(
        'proto is required: a commit that cannot be replayed may not advance the epoch'
      );
    }

    this.logger.log(
      `[COMMIT][${traceId}] START group=${groupId} device=${deviceId} baseEpoch=${baseEpoch}`
    );

    // Serialize via Redis lock to prevent TOCTOU races.
    // Two devices sending commits at the same epoch would both read the same
    // activeEpoch - the lock ensures only one gets through.
    const lockKey = `mls:commitlock:${groupId}`;
    const lockAcquired = await this.redis.set(lockKey, deviceId, 'EX', 5, 'NX');
    if (lockAcquired !== 'OK') {
      // Another commit is being validated right now - reject to retry.
      const group = await this.groupRepo.findOne({ where: { id: groupId } });
      this.logger.warn(
        `[COMMIT][${traceId}] REJECT concurrent_commit group=${groupId} currentEpoch=${group?.activeEpoch ?? 0}`
      );
      return {
        accepted: false,
        currentEpoch: group?.activeEpoch ?? 0,
        reason: 'concurrent_commit',
      };
    }

    try {
      const group = await this.groupRepo.findOne({ where: { id: groupId } });
      if (!group) {
        this.logger.error(`[COMMIT][${traceId}] Group not found: ${groupId}`);
        throw new BadRequestException(`Group ${groupId} not found`);
      }

      // Strict epoch gate: the submitted baseEpoch must match the server's activeEpoch exactly.
      // A genuinely uninitialized group (just created) OR freshly re-bootstrapped
      // (reset-epoch -> activeEpoch=0 then force_create_group restarting at MLS epoch 0)
      // always has its first commit at baseEpoch 0: activeEpoch==0 therefore legitimately only
      // accepts baseEpoch==0. The old bypass (accepting any baseEpoch when activeEpoch==0)
      // let an inconsistent device fast-forward the counter (e.g. baseEpoch=5 -> activeEpoch=6)
      // and desynchronize everyone (H4).
      if (baseEpoch !== group.activeEpoch) {
        this.logger.warn(
          `[COMMIT][${traceId}] REJECT epoch_mismatch group=${groupId} baseEpoch=${baseEpoch} activeEpoch=${group.activeEpoch}`
        );
        return {
          accepted: false,
          currentEpoch: group.activeEpoch,
          reason: 'epoch_mismatch',
        };
      }

      // ADVANCE THE EPOCH AND PUBLISH ITS BASE IN ONE TRANSACTION.
      //
      // The base an external joiner builds on is the ONE thing the strict gate above cannot be
      // lenient about, and until 2026-08-26 it was minted by a SECOND client round-trip made after
      // this one returned. Nothing else ever mints one, so losing that call - a tab reload is
      // enough, and an external joiner reloads by construction - separated the two numbers for
      // good: every later external commit was refused, and a distribution group has no
      // peer-Welcome fallback to take instead. COMM-22 is that row (`docs/wiki/backlog.md`).
      //
      // THE WINDOW IS DELETED RATHER THAN NARROWED. The base travels inside the submission, and the
      // epoch it describes is written with it or neither is: the committing device is the only one
      // that can export a base for `baseEpoch + 1`, and it holds the tree exactly here. Its
      // authority is the commit the gate just accepted - a stronger proof of membership than any
      // roster row, which is why no separate check is owed. `putGroupInfo` stays monotonic, so a
      // late refresh from an older epoch still cannot walk the base backwards.
      //
      // Legacy clients send no `groupInfo`; for them this is the plain advance it always was, and
      // `republishStaleBase` on a holder remains their repair.
      const newBase = typeof body.groupInfo === 'string' && body.groupInfo ? body.groupInfo : null;
      // THE ADVANCE, THE BASE AND THE REPLAYABLE COMMIT LAND TOGETHER OR NOT AT ALL.
      //
      // The log row used to be written AFTER this transaction, best-effort, on the reasoning that
      // "a failure must not undo the accepted epoch advance" - while the comment above it claimed
      // it was stored "UNDER THE LOCK (atomic with the advance)". It was under the lock and outside
      // the transaction, and the two are not the same thing.
      //
      // That inversion cost group `7da231f8` its epoch 121 (measured on prod 2026-09-02, see
      // `docs/wiki/backlog.md`): the counter moved, no replayable commit was recorded, and the
      // UNIQUE `(groupId, baseEpoch)` index means NOTHING CAN EVER REFILL IT. The log stops being a
      // log the moment one row is optional, because a reader cannot tell a hole from an end.
      //
      // So the priority is reversed: the row that makes this advance survivable for every OTHER
      // device is not optional, and failing to write it fails the commit. The cost is one retry by
      // the committer, which `submitCommit` is already built for - it rolls the staged commit back
      // on a reject - against a loss that no later call can repair.
      await this.groupRepo.manager.transaction(async (m) => {
        await m.getRepository(Group).update({ id: groupId }, { activeEpoch: baseEpoch + 1 });
        if (newBase) {
          await this.putGroupInfo(groupId, newBase, baseEpoch + 1, m);
        }
        // Keyed by baseEpoch: only one commit can advance from a given epoch (linearization), so
        // ON CONFLICT DO NOTHING keeps an idempotent retry safe.
        await m
          .getRepository(MlsCommitLog)
          .createQueryBuilder()
          .insert()
          .values({
            groupId,
            baseEpoch,
            commit: commitProto,
            senderDeviceId: deviceId,
          })
          .orIgnore()
          .execute();
      });
      group.activeEpoch = baseEpoch + 1;
      if (newBase) {
        this.logger.log(
          `[COMMIT][${traceId}] base published with the commit group=${groupId} epoch=${group.activeEpoch}`
        );
      }

      // An external-commit join is the ONE path where the committing device may not be a member
      // yet: it never receives a Welcome, so nothing ever promotes its
      // `dm_device_group_memberships` row (the foreground `updateInvitationStatus` and the
      // background FCM Welcome both do). Recipient resolution filters on `status='active'`, so
      // without this promotion the freshly rejoined device stays invisible to routing: it receives
      // neither the history bundle it is about to solicit nor any subsequent live message, while
      // its own sends work - a silent one-way group. Checked first so the promotion (and its log
      // line) stays an event rather than a no-op on every ordinary commit.
      if (body.senderId) {
        const membership = await this.deviceGroupRepo.findOne({
          where: { deviceId, groupId },
        });
        if (membership?.status !== 'active') {
          await this.activateDeviceMembership(body.senderId, deviceId, groupId, {
            redeliverMissed: false,
          }).catch((e) =>
            this.logger.warn(
              `[COMMIT][${traceId}] membership activation failed group=${groupId} device=${deviceId}: ${String(e)}`
            )
          );
        }
      }

      // Fan out the commit to members. Kept inside the locked section so validate + store +
      // broadcast is a single atomic unit; delivery is fast (queued rows + Redis publish, FCM is
      // deferred). Best-effort: the commit-log is already the durable source of truth, so a device
      // that misses the realtime fan-out replays it via GET /mls/commits. [[C7]]
      await this.sendMessage({
        groupId,
        senderId: body.senderId,
        senderDeviceId: deviceId,
        proto: commitProto,
        isCommit: true,
        excludeDeviceIds: body.excludeDeviceIds,
      }).catch((e) =>
        this.logger.warn(
          `[COMMIT][${traceId}] commit fan-out failed group=${groupId}: ${String(e)}`
        )
      );

      this.logger.log(`[COMMIT][${traceId}] ACCEPT group=${groupId} newEpoch=${group.activeEpoch}`);

      return { accepted: true, newEpoch: group.activeEpoch };
    } finally {
      // Atomic release via Lua: avoids the GET->DEL race.
      const released = await this.redis.eval(
        `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
        1,
        lockKey,
        deviceId
      );
      if (released === 1) {
        this.logger.log(`[COMMIT][${traceId}] Lock released for group=${groupId}`);
      } else {
        this.logger.warn(
          `[COMMIT][${traceId}] Lock already expired or stolen for group=${groupId}`
        );
      }
    }
  }

  /**
   * Returns the ordered, CONTIGUOUS, replayable commits for `groupId` starting at `sinceEpoch`
   * (rung-1). Membership-gated by the caller.
   *
   * Two ways a replay cannot finish, and each is reported rather than left to be discovered:
   * `belowFloor` when `sinceEpoch` sits under the retained floor (older commits pruned), and
   * `gapAt` when an epoch inside the range was never recorded. In both cases the caller owes
   * rung-2 (re-Welcome); with `gapAt`, `commits` still carries the applicable prefix.
   */
  async getCommitsSince(
    groupId: string,
    sinceEpoch: number,
    requesterUserId: string
  ): Promise<CommitsSinceResult> {
    // Serve the commit-log ONLY to members of the group (the commits are ciphertext, but ordering
    // metadata still gates on membership). x-user-id is injected by the proxy after JWT validation.
    const membership = await this.groupMemberRepo.findOne({
      where: { groupId, userId: requesterUserId },
    });
    if (!membership) {
      throw new ForbiddenException(`User ${requesterUserId} is not a member of group ${groupId}`);
    }

    const group = await this.groupRepo.findOne({ where: { id: groupId } });
    const activeEpoch = group?.activeEpoch ?? 0;

    const rows = await this.commitLogRepo.find({
      where: { groupId, baseEpoch: MoreThanOrEqual(sinceEpoch) },
      order: { baseEpoch: 'ASC' },
    });

    // Below floor: the caller needs commits from `sinceEpoch`, but the oldest retained commit
    // starts LATER, so the intermediate ones were pruned and replay cannot fully catch up.
    const oldest = await this.commitLogRepo.findOne({
      where: { groupId },
      order: { baseEpoch: 'ASC' },
    });
    const belowFloor = sinceEpoch < activeEpoch && !!oldest && oldest.baseEpoch > sinceEpoch;

    // CONTIGUITY IS THE PROPERTY A REPLAY ACTUALLY NEEDS, and `belowFloor` only ever described the
    // START of the range. Commits apply in order, so everything past a missing epoch is unreachable:
    // walk up from `sinceEpoch`, keep the applicable prefix, and NAME the first epoch the log cannot
    // supply. Handing back the unreachable tail instead invites the caller to fail its way to the
    // same conclusion - it applies one commit, breaks on the next, reports `healed=false`, freezes
    // its outbox and waits out `STUCK_EPOCH_GAP_MS` before the watchdog escalates. The server knows
    // now, in the response it is already writing. Measured on prod 2026-09-02: group `7da231f8` ran
    // 0..129 with 121 absent for two days and every check passed (`docs/wiki/backlog.md`).
    const applicable: CommitLogEntry[] = [];
    let gapAt: number | undefined;
    let expected = sinceEpoch;
    for (const r of rows) {
      // `rows` is ascending and the UNIQUE `(groupId, baseEpoch)` index makes it distinct, so the
      // only way to miss `expected` is that nothing ever wrote it.
      if (r.baseEpoch > expected) {
        gapAt = expected;
        break;
      }
      applicable.push({ baseEpoch: r.baseEpoch, proto: r.commit });
      expected = r.baseEpoch + 1;
    }
    // The same hole seen from the other end: the log stops before the group does, so the last epochs
    // were never recorded rather than sitting behind a gap.
    if (gapAt === undefined && expected < activeEpoch) {
      gapAt = expected;
    }

    // PRUNING AND A HOLE ARE NOT THE SAME DEFECT, and only one of them accuses anybody: a log that
    // starts late was TRIMMED on purpose, one missing an epoch inside its own span was NEVER
    // WRITTEN. Both terminate rung 1 identically, so when `belowFloor` already carries the answer
    // the gap is dropped rather than reported - an `ERROR` naming a defect that does not exist is
    // precisely the line its reader learns to skip, and then misses the real one.
    if (belowFloor) {
      gapAt = undefined;
    }

    if (gapAt !== undefined) {
      // Not a warning about a slow path - an accusation. An unrefillable epoch is a defect in the
      // commit path that wrote it, and this is the only place that can see it.
      this.logger.error(
        `[COMMITS] group=${groupId} COMMIT LOG HOLE at epoch=${gapAt} ` +
          `(sinceEpoch=${sinceEpoch} activeEpoch=${activeEpoch} applicable=${applicable.length}) - ` +
          `replay cannot pass it, rung-2 owed`
      );
    }

    return {
      commits: applicable,
      activeEpoch,
      belowFloor,
      ...(gapAt !== undefined ? { gapAt } : {}),
    };
  }

  /**
   * Stores the latest GroupInfo for `groupId` (Phase 4 external-join base). Membership-gated. The
   * committer refreshes it after every accepted commit (a new group's first member-add is itself a
   * commit), so an authorized member lacking MLS state can self-join. STRICTLY monotonic: a write
   * whose `baseEpoch` is not above the stored one is ignored and reported as `stored: false` - a
   * late refresh must never regress the served base epoch (mirroring the write-if-newer discipline
   * of the commit-log and persistence layers), and an EQUAL epoch is a second creator claiming a
   * base that is already owned, which is the race {@link putGroupInfo} exists to settle.
   */
  async storeGroupInfo(
    groupId: string,
    requesterUserId: string,
    groupInfo: string,
    baseEpoch: number
  ): Promise<{ stored: boolean }> {
    const membership = await this.groupMemberRepo.findOne({
      where: { groupId, userId: requesterUserId },
    });
    if (!membership) {
      throw new ForbiddenException(`User ${requesterUserId} is not a member of group ${groupId}`);
    }
    return this.putGroupInfo(groupId, groupInfo, baseEpoch);
  }

  /**
   * The monotonic GroupInfo upsert with NO authorization of its own: whoever calls has already
   * decided who may write.
   *
   * TWO CALLERS DECIDE IT DIFFERENTLY, and neither can be expressed in the other's terms.
   * {@link storeGroupInfo} gates on a `dm_group_members` row - the roster of an ordinary
   * conversation. A community's Graine distribution group holds no such row by construction (it is
   * joined by external commit), and the roster that governs it is community membership, which lives
   * in social-service and nowhere here. So social-service authorizes and calls the internal route,
   * which lands here. Splitting the gate from the write is what keeps ONE monotonic rule for both.
   */
  async putGroupInfo(
    groupId: string,
    groupInfo: string,
    baseEpoch: number,
    manager?: EntityManager
  ): Promise<{ stored: boolean }> {
    // `manager` is passed by {@link validateCommit} ONLY, to write the base inside the very
    // transaction that advances the epoch it describes. Absent, this runs on its own connection,
    // which is what every other caller wants.
    const repo = manager ? manager.getRepository(MlsGroupInfo) : this.groupInfoRepo;
    // STRICTLY monotonic: an epoch already published is OWNED, and a second base for it loses.
    // `orIgnore` guards the concurrent-insert race; the WHERE guards the concurrent-update race.
    //
    // THE ELECTION BELOW USED TO DECIDE ONLY THE COLLIDING HALF OF THE RACE, and the other half is
    // the commoner one. Two devices that both find a scope uninitialised both create a tree under
    // the server's group id and both publish at epoch 0; only if their INSERTs collide does
    // `orIgnore` separate them. Serialized - the first insert committed before the second device
    // read - the second fell through to the UPDATE below, whose `<=` let epoch 0 REPLACE epoch 0,
    // and it was told `stored: true`. Both creators then believed they owned the group.
    //
    // Measured on production 2026-08-27, COMM-8, salon 0a47eb27 / group 19d12785, one second apart:
    //
    //   09:49:41  group-info epoch=0 stored=true   publisher=d82cd226:web-d82cd226
    //   09:49:41  group-info epoch=0 stored=true   publisher=d82cd226:web-d82cd226
    //
    // The creator whose base was replaced never learned it, never advanced past epoch 0 (`msg_epoch=0
    // group_epoch=0 err=ValidationError(InvalidSignature)` on the group's own first commit, then
    // `epoch gap [msg_epoch=4, group_epoch=0]` for the rest of the run), and minted the salon's only
    // Graine session against that orphan - sealing the seed into a tree no other member holds. The
    // repair did everything right and could do nothing: every roster device answered `absorbed 0/0`
    // and the asker concluded `has no reachable holder`. The salon's first message is unreadable for
    // good. Story in `CHANGELOG.md`.
    //
    // AN EQUAL EPOCH IS NEVER A LEGITIMATE REFRESH, which is what makes `>=` safe. Every republisher
    // carries a strictly newer epoch by construction: `validateCommit` writes the base for
    // `baseEpoch + 1` inside the transaction that advances to it, and `republishStaleBase` fires only
    // when the stored base is BEHIND the group and publishes from a tree at or past `activeEpoch`. So
    // equal means a second creator, and the only thing it needs is to be told.
    const existing = await repo.findOne({ where: { groupId } });
    if (existing && existing.baseEpoch >= baseEpoch) {
      return { stored: false };
    }
    if (!existing) {
      const inserted = await repo
        .createQueryBuilder()
        .insert()
        .values({ groupId, groupInfo, baseEpoch })
        .orIgnore()
        .execute();
      // REPORTED, NOT ASSUMED. `orIgnore` makes a lost race silent, and this branch used to answer
      // `stored: true` regardless - which is fine for a refresh and wrong for the one caller that
      // acts on it. Two clients finding a community's distribution group uninitialised BOTH create
      // an MLS group at epoch 0, and epoch 0 does not beat epoch 0, so the monotonic rule cannot
      // separate them: what separates them is who won the insert. The loser discards its group and
      // joins the winner's, which needs no election - but only if it is told it lost.
      // `ON CONFLICT DO NOTHING` returns no row on conflict, which is the signal.
      const won = Array.isArray(inserted.raw) && inserted.raw.length > 0;
      return { stored: won };
    }
    // `<`, MATCHING THE READ ABOVE. The read cannot be trusted on its own - another writer can land
    // between it and this - so the guard that actually decides has to carry the same rule, and a
    // `<=` here would reopen the hole under concurrency exactly as it was open under serialization.
    const advanced = await repo
      .createQueryBuilder()
      .update()
      .set({ groupInfo, baseEpoch, updatedAt: () => 'now()' })
      .where('"groupId" = :groupId AND "baseEpoch" < :baseEpoch', {
        groupId,
        baseEpoch,
      })
      .execute();
    // REPORTED, NOT ASSUMED - the same rule the insert branch already obeys. This used to answer
    // `stored: true` whatever the WHERE matched, so a write the guard had refused was indistinguishable
    // from one it accepted, and the one caller that acts on the answer would have kept a tree the
    // group had moved past.
    return { stored: (advanced.affected ?? 0) > 0 };
  }

  /**
   * Returns the latest stored GroupInfo for `groupId` so an authorized member can build an external
   * commit to (re)join. Membership-gated (the ratchet tree it carries is public group state, but we
   * still restrict it to roster members). Returns null when no GroupInfo has been stored yet (the
   * caller then falls back to a peer welcome_request).
   */
  async getGroupInfo(
    groupId: string,
    requesterUserId: string
  ): Promise<{ groupInfo: string; baseEpoch: number; activeEpoch: number } | null> {
    const membership = await this.groupMemberRepo.findOne({
      where: { groupId, userId: requesterUserId },
    });
    if (!membership) {
      throw new ForbiddenException(`User ${requesterUserId} is not a member of group ${groupId}`);
    }
    return this.readGroupInfo(groupId);
  }

  /**
   * The stored GroupInfo with NO authorization of its own - the read half of the split described on
   * {@link putGroupInfo}. Null when nothing has been published yet.
   *
   * `activeEpoch` IS SERVED BESIDE IT BECAUSE THE TWO CAN DISAGREE FOR EVER, AND ONLY THIS SIDE
   * KNOWS BOTH. The base is published by a follow-up call from the device whose commit was just
   * accepted; that call can be lost (offline, killed tab, refused refresh) and nothing else ever
   * mints one, so `dm_groups.activeEpoch` advances while `mls_group_info.baseEpoch` stays behind.
   * A joiner handed the stale base builds an external commit the strict gate is GUARANTEED to
   * refuse, learning by failing what this row could have told it - and for a distribution group,
   * which has no peer-Welcome fallback, that is a member permanently locked out of a salon they
   * are entitled to. Serving both numbers lets a joiner skip the doomed attempt and lets a HOLDER
   * (the only party able to export a fresh base) repair it on its next ordinary read.
   */
  async readGroupInfo(
    groupId: string
  ): Promise<{ groupInfo: string; baseEpoch: number; activeEpoch: number } | null> {
    const row = await this.groupInfoRepo.findOne({ where: { groupId } });
    if (!row) return null;
    const group = await this.groupRepo.findOne({
      where: { id: groupId },
      select: { id: true, activeEpoch: true },
    });
    const activeEpoch = group?.activeEpoch ?? row.baseEpoch;
    if (row.baseEpoch < activeEpoch) {
      // ACCUSING, NOT INFORMATIVE: every read of a stale base is a joiner that cannot get in until
      // a member republishes. Silent, this cost a private salon its second member on 2026-08-25.
      this.logger.warn(
        `[GROUP_INFO] STALE base group=${groupId} baseEpoch=${row.baseEpoch} activeEpoch=${activeEpoch}` +
          ` - the published external-join base is unusable and only a member holding the tree can refresh it`
      );
    }
    return { groupInfo: row.groupInfo, baseEpoch: row.baseEpoch, activeEpoch };
  }

  /**
   * Prunes the commit-log (hourly cron). Two bounds: an age window (~1 year - commits are tiny, a
   * long window keeps rung-1 replay covering almost every gap and minimises destructive rung-2
   * re-Welcomes) and a per-group size cap (safety against runaway growth on very active groups:
   * keep only the last {@link COMMIT_LOG_MAX_PER_GROUP} epochs behind each group's activeEpoch).
   */
  async pruneExpiredCommitLog(): Promise<number> {
    const cutoff = new Date(Date.now() - COMMIT_LOG_RETENTION_MS);
    const byAge = await this.commitLogRepo.delete({
      createdAt: LessThan(cutoff),
    });
    await this.commitLogRepo.query(
      `DELETE FROM mls_commit_log c USING dm_groups g
       WHERE c."groupId" = g.id AND c."baseEpoch" < g."activeEpoch" - $1`,
      [COMMIT_LOG_MAX_PER_GROUP]
    );
    const deleted = byAge.affected ?? 0;
    if (deleted > 0) {
      this.logger.log(`[CRON] pruneExpiredCommitLog: deleted ${deleted} aged commit(s)`);
    }
    return deleted;
  }

  /**
   * Delivers an MLS Welcome message and optional ratchet tree to a target device.
   * Verifies the sender is a member of the group, queues the welcome, performs
   * real-time delivery if the target is online, and updates DeviceGroupMembership status.
   */
  async sendWelcome(
    authUserIdRaw: string | undefined,
    body: SendWelcomeBody
  ): Promise<{ status: string }> {
    const traceId = this.makeTraceId('welcome-send');
    const targetDeviceId = sanitizeQueryValue(body.targetDeviceId, 'targetDeviceId');
    const targetUserId = sanitizeOptionalQueryValue(body.targetUserId, 'targetUserId');
    const senderUserId = sanitizeOptionalQueryValue(body.senderUserId, 'senderUserId') || 'system';
    const safeGroupId = sanitizeQueryValue(body.groupId, 'groupId');

    // Verify that the authenticated sender is a member of the group.
    // authUserIdRaw comes from the x-user-id header injected by the proxy after JWT validation.
    const authUserId = sanitizeOptionalQueryValue(authUserIdRaw, 'x-user-id');
    if (authUserId) {
      const membership = await this.groupMemberRepo.findOne({
        where: { groupId: safeGroupId, userId: authUserId },
      });
      if (!membership) {
        this.logger.warn(
          `[WELCOME][${traceId}] AUTHZ FAIL sender=${authUserId} not member of group=${safeGroupId}`
        );
        throw new ForbiddenException(`User ${authUserId} is not a member of group ${safeGroupId}`);
      }
    }

    this.logger.log(
      `[WELCOME][${traceId}] START group=${safeGroupId} sender=${senderUserId} target=${targetUserId ?? 'unknown'}:${targetDeviceId} payloadLen=${body.welcomePayload?.length ?? 0} ratchetTreeLen=${body.ratchetTreePayload?.length ?? 0}`
    );

    // Look up recipient device - include userId in the query when provided so the lookup
    // is unambiguous even if two users happen to share the same raw device ID string
    // (common in same-browser multi-tab testing).
    const query: Record<string, string> = { deviceId: targetDeviceId };
    if (targetUserId) {
      query.userId = targetUserId;
    }
    const deviceInfo = await this.keyPackageRepo.findOne({ where: query });

    if (!deviceInfo) {
      this.logger.error(
        `[WELCOME][${traceId}] Target device not found target=${targetUserId ?? 'unknown'}:${targetDeviceId}`
      );
      throw new Error(
        `Device ${targetDeviceId} (user: ${targetUserId ?? 'unknown'}) not found. Cannot deliver Welcome message.`
      );
    }

    const queuedWelcome = this.queuedMessageRepo.create({
      recipientId: deviceInfo.userId,
      deviceId: targetDeviceId,
      senderId: senderUserId,
      groupId: safeGroupId,
      proto: body.welcomePayload,
      isWelcome: true,
      ratchetTree: body.ratchetTreePayload,
      createdAt: new Date(),
    });
    // Same seam as the send: a Welcome for a group that ended between the target lookup and this
    // write is worse than an undeliverable message - the device that receives it asks for a group
    // nobody can hand it, on every reconnection. See {@link enqueueForLiveGroup}.
    await this.enqueueForLiveGroup([queuedWelcome], safeGroupId, 'WELCOME', traceId);
    this.logger.log(
      `[WELCOME][${traceId}] QUEUED id=${queuedWelcome.id} recipient=${deviceInfo.userId}:${targetDeviceId} group=${safeGroupId}`
    );

    // Real-time push via Gateway when the target device is currently online.
    const redisKey = `user:online:${deviceInfo.userId}:${targetDeviceId}`;
    const isOnline = await this.redis.exists(redisKey);
    this.logger.log(`[WELCOME][${traceId}] PRESENCE key=${redisKey} online=${!!isOnline}`);
    if (isOnline) {
      const ciphertext = Buffer.from(body.welcomePayload, 'base64');
      const envelope = JSON.stringify({
        recipientId: deviceInfo.userId,
        deviceId: targetDeviceId,
        senderId: senderUserId,
        senderDeviceId: '',
        groupId: safeGroupId,
        isWelcome: true,
        ratchetTree: body.ratchetTreePayload,
        proto: ciphertext.toString('base64'),
        // Without this id, a Welcome processed in realtime cannot be ACKed by the client:
        // the durable row survives and the next pull (e.g. restart) redelivers it, causing
        // a destructive NoMatchingKeyPackage reprocessing. Propagating it enables immediate
        // ACK -> queue deletion -> no redelivery.
        queuedMessageId: queuedWelcome.id,
      });
      this.logger.log(
        `[WELCOME][${traceId}] REALTIME_PUBLISH key=${redisKey} envelopeLen=${envelope.length}`
      );
      await this.redis.publish('chat:messages', envelope);
      this.logger.log(
        `[WELCOME][${traceId}] REALTIME_PUBLISHED key=${redisKey} queuedId=${queuedWelcome.id}`
      );
    } else {
      // Device offline (app killed): the realtime WS path can't reach it, so push
      // the Welcome over FCM. Without this the recipient is never woken for the
      // Welcome and stays unjoined - the subsequent message push then fails to
      // decrypt ("Groupe introuvable") and shows a generic "Nouveau message de X".
      // Routed by data.isWelcome=true to the Android background welcome receiver,
      // which joins the group; the queue row is reconciled idempotently on next
      // foreground pull (group already in WASM → ACK, no re-processing).
      this.logger.log(
        `[WELCOME][${traceId}] OFFLINE_PUSH key=${redisKey} queuedId=${queuedWelcome.id}`
      );
      await this.sendFcmForQueued(queuedWelcome, traceId, safeGroupId, senderUserId, true);
    }

    // Upsert DeviceGroupMembership to active.
    // INSERT ... ON CONFLICT DO UPDATE guarantees record creation even when no prior
    // invitation existed (bootstrap case: brand-new group, no pending record).
    // A plain UPDATE WHERE status='pending' would touch 0 rows in that case, leaving the
    // device without a record -> processPendingInvitations would incorrectly kick it.
    // `kickedAt: null` IS THE PROOF A KICK WAS FOLLOWED THROUGH. A Welcome in the queue means the
    // Add the kick promised actually landed, so the row stops being one the stranded report should
    // accuse - it is now an ordinary device owed a delivery. Left set, every successful
    // kick-and-re-add would be reported as a failed one for as long as the row stayed pending.
    // `skipUpdateIfNoValuesChanged` still holds: on a row already pending with no kick recorded,
    // this writes nothing.
    await this.deviceGroupRepo.upsert(
      {
        deviceId: targetDeviceId,
        groupId: safeGroupId,
        userId: deviceInfo.userId,
        status: 'pending' as const,
        kickedAt: null,
      },
      {
        conflictPaths: ['deviceId', 'groupId'],
        skipUpdateIfNoValuesChanged: true,
      }
    );

    // Device can now decrypt - add it to the routing set.
    await this.redis.sadd(`group:members:${safeGroupId}`, `${deviceInfo.userId}:${targetDeviceId}`);

    this.logger.log(
      `[WELCOME][${traceId}] DONE group=${safeGroupId} target=${deviceInfo.userId}:${targetDeviceId}`
    );

    return { status: 'queued' };
  }

  /**
   * Promotes a device membership to `active` and adds it to the Redis routing set.
   *
   * Used by the background PushSecret path (FCM1): a device that joins a group via a background
   * FCM Welcome never goes through the foreground `updateInvitationStatus` path.
   * Without this promotion, its `dm_device_group_memberships` row stays `pending`, so
   * recipient resolution (`status='active'` filter) EXCLUDES it and it never receives
   * subsequent messages in real time or via push (only through history catch-up).
   * Idempotent: upsert on the unique constraint (deviceId, groupId).
   *
   * `redeliverMissed` (default true) replays the messages sent during the pending window so the
   * device gets the notifications it missed. Callers where the device joined at the CURRENT epoch
   * with no prior membership (external-commit join) must pass false: forward secrecy means it
   * cannot decrypt anything sent before its join, so a replay would be up to 50 undecryptable
   * frames and as many generic pushes. Pre-join content reaches it through the history bundle.
   */
  async activateDeviceMembership(
    userId: string,
    deviceId: string,
    groupId: string,
    { redeliverMissed = true }: { redeliverMissed?: boolean } = {}
  ): Promise<void> {
    // A revoked or key-package-less device must never be routed to (WP-GHOST-1). This path is
    // reached by the commit fan-out - where the device activating itself is the COMMIT SENDER, so
    // without this a device its owner explicitly deleted would re-enrol itself in every group it
    // still holds MLS state for - and by the background push path. Both are best-effort seams, so
    // the refusal is logged rather than thrown: the caller has no user to tell.
    const addressable = await this.deviceAddressability(userId, deviceId);
    if (!addressable.ok) {
      this.logger.warn(
        `[MEMBERSHIP_ACTIVE] REFUSED group=${groupId} device=${userId}:${deviceId} reason=${addressable.reason}`
      );
      return;
    }

    // Read prior state BEFORE the upsert: missed-message redelivery (DF2) must only
    // happen on a genuine pending->active transition. activateDeviceMembership is also
    // called idempotently on every Welcome re-processing; re-delivering when the device
    // was already `active` would double notifications.
    const existing = await this.deviceGroupRepo.findOne({
      where: { deviceId, groupId },
    });
    const wasAlreadyActive = existing?.status === 'active';

    // `kickedAt: null`: the device is IN, so nothing is owed to it and no kick is outstanding.
    await this.deviceGroupRepo.upsert(
      { userId, deviceId, groupId, status: 'active' as const, kickedAt: null },
      { conflictPaths: ['deviceId', 'groupId'] }
    );
    // Immediate routing: add to Redis set without waiting for a cache rebuild.
    await this.redis.sadd(`group:members:${groupId}`, `${userId}:${deviceId}`).catch(() => {});
    this.logger.log(`[MEMBERSHIP_ACTIVE] group=${groupId} device=${userId}:${deviceId}`);

    if (!wasAlreadyActive && redeliverMissed) {
      // While the device was `pending`, recipient resolution (`status='active'` filter)
      // excluded it: no push notification was dispatched for messages sent during that
      // window. Now that it is active (meaning it processed its Welcome -> it can decrypt),
      // we re-deliver those messages to trigger the missing notification (DF2).
      // Best-effort, never blocking for activation.
      const pendingSinceMs = existing?.createdAt?.getTime();
      void this.redeliverMissedDuringActivationWindow(
        userId,
        deviceId,
        groupId,
        pendingSinceMs
      ).catch((e) =>
        this.logger.warn(
          `[ACTIVATION_REDELIVER] group=${groupId} device=${userId}:${deviceId} FAILED: ${e instanceof Error ? e.message : String(e)}`
        )
      );
    }
  }

  /**
   * Re-delivers to a device that just became `active` the visible application messages sent
   * during its activation window (when it was `pending`, thus excluded from recipients and
   * never notified). Source: the `history:{groupId}` stream, filtered on the `silent` field each
   * entry now carries: since 2026-08-12 the stream also holds mutations (reactions, edits,
   * deletions, read receipts), and re-notifying one would ring the user for a reaction. Welcome
   * and Commit are still absent from the stream entirely. Bounded by
   * {@link ACTIVATION_REDELIVER_WINDOW_MS} and
   * a message cap to never spam a device that stayed `pending` for a long time. The device's
   * own messages are skipped. Display idempotency: the client deduplicates by messageId
   * (a message already received via history catch-up is not re-displayed).
   */
  private async redeliverMissedDuringActivationWindow(
    userId: string,
    deviceId: string,
    groupId: string,
    pendingSinceMs?: number
  ): Promise<void> {
    const traceId = this.makeTraceId('reactivate');
    const MAX_COUNT = 50;
    // Window cap: a device that stays `pending` for a long time (zombie that eventually
    // activates) must not trigger an avalanche of notifications for old messages. Beyond
    // the window, it catches up via history (without notification, which is correct).
    const windowStartMs = Math.max(
      pendingSinceMs ?? 0,
      Date.now() - MessagingService.ACTIVATION_REDELIVER_WINDOW_MS
    );

    const historyKey = `history:${groupId}`;
    // Stream IDs are timestamped (`<ms>-<seq>`): bound the XRANGE from windowStartMs.
    const entries = await this.redis.xrange(
      historyKey,
      `${windowStartMs}`,
      '+',
      'COUNT',
      MAX_COUNT
    );
    if (!entries || entries.length === 0) return;

    let redelivered = 0;
    /** Every entry of this page that is owed to the device, built before anything is written. */
    const toRedeliver: QueuedMessage[] = [];
    for (const [, fields] of entries) {
      // fields = ['sender_id', <id>, 'content', <protoB64>, 'timestamp', <iso>, 'silent', '0'|'1']
      const map = new Map<string, string>();
      for (let i = 0; i + 1 < fields.length; i += 2) map.set(fields[i], fields[i + 1]);
      const senderId = map.get('sender_id') ?? '';
      const proto = map.get('content') ?? '';
      if (!proto || senderId === userId) continue; // no payload, or our own message
      // Entries written before the field existed are visible messages by construction, since the
      // stream held nothing else then - so an absent `silent` reads as '0'.
      if ((map.get('silent') ?? '0') === '1') continue; // a mutation: it must never re-notify

      toRedeliver.push(
        this.queuedMessageRepo.create({
          recipientId: userId,
          deviceId,
          senderId,
          groupId,
          isWelcome: false,
          isCommit: false,
          proto,
          createdAt: new Date(),
        })
      );
    }

    // THE WHOLE PAGE IN ONE UNIT OF WORK, for the reason {@link enqueueForLiveGroup} gives - a group
    // deleted while a device activates into it takes these rows with it, or they are never written.
    // Saving row by row inside the loop also took one transaction per entry and interleaved a push
    // with each; the pushes are I/O and have no business inside a transaction, so they follow.
    if (toRedeliver.length > 0) {
      const saved = await this.enqueueForLiveGroup(
        toRedeliver,
        groupId,
        'ACTIVATION_REDELIVER',
        traceId
      );
      for (const queued of saved) {
        await this.sendFcmForQueued(queued, traceId, groupId, queued.senderId ?? '', false);
        redelivered++;
      }
    }

    if (redelivered > 0) {
      this.logger.log(
        `[ACTIVATION_REDELIVER][${traceId}] group=${groupId} device=${userId}:${deviceId} redelivered=${redelivered}`
      );
    }
  }

  /**
   * Asks one online member to resend the history bundle to a device that self-joined `groupId` via
   * an external commit (Phase 4). Unlike a welcome_request the requester is already a healthy member,
   * so the responder only resends history (no re-add). Online-only and best-effort: if no member is
   * online the joiner simply retries later - missing pre-join history is not urgent, so there is no
   * durable FCM wake.
   */
  async notifyHistoryRequest(
    authUserIdRaw: string | undefined,
    body: NotifyHistoryRequestBody
  ): Promise<{ status: string; target?: string; excludedOnline?: number }> {
    const traceId = this.makeTraceId('history-req');
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const requesterUserId = sanitizeQueryValue(body.requesterUserId, 'requesterUserId');
    const requesterDeviceId = sanitizeQueryValue(body.requesterDeviceId, 'requesterDeviceId');
    this.assertRequesterMatchesCaller(authUserIdRaw, requesterUserId, traceId, 'HISTORY_REQ');

    // Members this requester has already heard from. Compared case-insensitively because the client
    // builds the key from its MLS identity (`digestIdentity`, which lower-cases the user) while the
    // membership set is stored as it was written - two spellings of one fact, and a mismatch here
    // would silently re-elect the member the requester just excluded.
    const rawExclude = (Array.isArray(body.exclude) ? body.exclude : []).filter(
      (k): k is string =>
        typeof k === 'string' && k.includes(':') && k.length <= MAX_MEMBER_KEY_LENGTH
    );
    // A KEY DROPPED HERE IS AN EXCLUSION THE CALLER BELIEVES IT MADE, so it is said rather than
    // filtered in silence - that silence is what let a 128-character cap discard every real member
    // key for months without one line anywhere saying so.
    const rawGiven = Array.isArray(body.exclude) ? body.exclude.length : 0;
    if (rawGiven > rawExclude.length) {
      this.logger.warn(
        `[HISTORY_REQ][${traceId}] ${rawGiven - rawExclude.length} exclusion(s) were unusable and dropped group=${groupId} requester=${requesterUserId}:${requesterDeviceId}`
      );
    }
    if (rawExclude.length > MAX_HISTORY_EXCLUSIONS) {
      // A chase excludes at most one member per step, so a list longer than any group's membership
      // is a client fault rather than a big conversation. Truncating silently would turn it into a
      // member elected twice and a chase that looks like it terminated on a proof it never had.
      this.logger.warn(
        `[HISTORY_REQ][${traceId}] exclude list truncated ${rawExclude.length} -> ${MAX_HISTORY_EXCLUSIONS} group=${groupId} requester=${requesterUserId}:${requesterDeviceId}`
      );
    }
    const excluded = new Set(
      rawExclude.slice(0, MAX_HISTORY_EXCLUSIONS).map((k) => k.toLowerCase())
    );

    let members: string[] = await this.redis.smembers(`group:members:${groupId}`);
    const senderKey = `${requesterUserId}:${requesterDeviceId}`;
    if (members.length === 0) {
      const dbMembers = await this.deviceGroupRepo.find({
        where: { groupId, status: 'active' as const },
      });
      if (dbMembers.length > 0) {
        members = dbMembers.map((m) => `${m.userId}:${m.deviceId}`);
        await this.redis.sadd(`group:members:${groupId}`, ...members);
      }
    }

    // The election and nothing else. WHAT the requester wants - a state key, a digest, a range of
    // older messages - travels inside MLS, where this service cannot read it, and the responder
    // waits for that frame rather than being told anything about it here. A `withDigest` boolean
    // used to ride along, to tell the responder whether waiting was pointless; every client states
    // its ask now, so waiting is always warranted and the flag said nothing.
    const notification = JSON.stringify({
      type: 'history_request',
      groupId,
      requesterUserId,
      requesterDeviceId,
    });

    // Forward to a RANDOM online member rather than always the first. A backgrounded Android holds
    // its WebSocket TCP open, so `user:online` can be true while the app cannot process the frame
    // (frozen-online). The requester re-solicits on a bounded backoff; randomizing the responder
    // each call lets those retries rotate past a frozen peer to a genuinely reachable one.
    for (let i = members.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [members[i], members[j]] = [members[j], members[i]];
    }

    // How many members were ONLINE and skipped only because the requester had already heard from
    // them. It is the whole point of the exclusion list: `no_peer_online` with a positive count
    // means *every reachable member has answered you*, which is the requester's termination proof,
    // and `no_peer_online` with zero means *nobody was there*, which is a different fact answered by
    // a different edge. A count rather than a second status, so the two are told apart by evidence
    // and not by prose.
    let excludedOnline = 0;

    for (const member of members) {
      if (member === senderKey) continue;
      const [memberUserId, memberDeviceId] = member.split(':');
      if (!memberUserId || !memberDeviceId) continue;
      const isOnline = await this.redis.exists(`user:online:${memberUserId}:${memberDeviceId}`);
      if (isOnline && excluded.has(member.toLowerCase())) {
        excludedOnline++;
        continue;
      }
      if (isOnline) {
        await this.redis.publish(
          'chat:messages',
          JSON.stringify({
            recipientId: memberUserId,
            deviceId: memberDeviceId,
            // isWelcomeRequest is the gateway's generic "relay this base64 JSON control frame to the
            // device" flag; the inner `type` (history_request) drives the client behaviour.
            proto: Buffer.from(notification).toString('base64'),
            isWelcomeRequest: true,
            groupId,
            senderId: requesterUserId,
            senderDeviceId: requesterDeviceId,
          })
        );
        this.logger.log(
          `[HISTORY_REQ][${traceId}] FORWARDED target=${member} group=${groupId} requester=${senderKey}`
        );
        return { status: 'forwarded', target: member };
      }
    }
    this.logger.log(
      `[HISTORY_REQ][${traceId}] NO_PEER_ONLINE group=${groupId} requester=${senderKey} excludedOnline=${excludedOnline}`
    );
    return { status: 'no_peer_online', excludedOnline };
  }

  /**
   * Tells a device, right now, that it has been revoked - so it wipes itself and signs out instead
   * of staying live until its next authentication.
   *
   * Deleting a device denylists it and purges its server-side footprint, but a device that is
   * ALREADY connected notices none of that: its socket stays open, its session stays valid, and
   * everything it still holds locally stays on it. For a device its owner has declared lost or
   * stolen, "it will find out next time it logs in" is the wrong answer to the question they asked.
   *
   * Sent over the gateway's generic control-frame path (`isWelcomeRequest` is that flag's name, and
   * the inner `type` is what drives the client), so this needs no change in the gateway at all.
   *
   * BEST-EFFORT, and deliberately not awaited into the delete's own result: the durable half of a
   * revocation is the denylist row, which is already written. This only makes it immediate. It is
   * still logged either way, because a signal nobody sees and nobody reports is indistinguishable
   * from one that was never sent.
   */
  async notifyDeviceRevoked(userId: string, deviceId: string): Promise<boolean> {
    const notification = JSON.stringify({
      type: 'device_revoked',
      userId,
      deviceId,
    });
    try {
      const receivers = await this.redis.publish(
        'chat:messages',
        JSON.stringify({
          recipientId: userId,
          deviceId,
          proto: Buffer.from(notification).toString('base64'),
          isWelcomeRequest: true,
          senderId: userId,
          senderDeviceId: deviceId,
        })
      );
      this.logger.log(
        `[DEVICE_REVOKED] signalled user=${userId} device=${deviceId} gatewaySubscribers=${receivers}`
      );
      return true;
    } catch (e) {
      this.logger.error(
        `[DEVICE_REVOKED] could not signal user=${userId} device=${deviceId} - it will find out at its next login`,
        e
      );
      return false;
    }
  }

  /**
   * Asks one online member to REPUBLISH this group's external-join base, and asks for nothing else.
   *
   * WHY A SIGNAL OF ITS OWN, AND NOT THE WELCOME REQUEST NEXT DOOR. A device that cannot join a
   * group by external commit has two very different problems, and until 2026-09-04 both were
   * answered with `welcome_request`:
   *
   *  - **no base is published** - only a member can mint one, and a Welcome is a fine way to be let
   *    in;
   *  - **the published base is STALE** - it names an epoch the group has left, so `join_by_external_commit`
   *    refuses it and NO retry can ever change that. Asking for a Welcome here is asking for the
   *    wrong favour: a Welcome MUTATES the tree, takes the group's add lock, and replays the
   *    duplicate-leaf race, when what is needed is a read-only publish that changes no epoch and
   *    takes no lock.
   *
   * **THE POPULATION IS REAL AND IT DOES NOT DRAIN ITSELF.** Measured on production 2026-09-04:
   * four of the forty-three groups holding a base were stale, every one of them by exactly ONE
   * epoch, two of them since 2026-08-30 - and three devices sat `pending` on those two, unable to
   * join for five days. A stale base is not a transient: only a member's next commit republishes
   * one, so a quiet conversation stays shut for ever.
   *
   * The election is the history request's, for the history request's reason: a backgrounded Android
   * holds its socket open, so `user:online` can be true for a device that will not process the
   * frame. Randomising lets the requester's retries rotate past it.
   *
   * **NOTHING IS STORED FOR AN OFFLINE MEMBER**, deliberately - unlike `welcome_request`, which
   * queues in `pending_welcome:` so a newly-online peer drains it. A base refresh is idempotent and
   * cheap, the requester re-asks on its own cadence as long as it still cannot join, and a queue of
   * requests to republish something that may already have been republished is a queue that says
   * nothing. `no_peer_online` is the honest answer, and it is the one this returns.
   */
  async notifyBaseRefreshRequest(
    authUserIdRaw: string | undefined,
    body: NotifyWelcomeRequestBody
  ): Promise<{ status: string; target?: string }> {
    const traceId = this.makeTraceId('base-refresh');
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const requesterUserId = sanitizeQueryValue(body.requesterUserId, 'requesterUserId');
    const requesterDeviceId = sanitizeQueryValue(body.requesterDeviceId, 'requesterDeviceId');
    this.assertRequesterMatchesCaller(authUserIdRaw, requesterUserId, traceId, 'BASE_REFRESH');

    let members: string[] = await this.redis.smembers(`group:members:${groupId}`);
    const senderKey = `${requesterUserId}:${requesterDeviceId}`;
    // The Redis routing set is a cache and is empty after a restart or a flush; the rows are the
    // truth. Without this a request lands on an empty member list and reports `no_peer_online`
    // about a group full of people.
    if (members.length === 0) {
      const dbMembers = await this.deviceGroupRepo.find({
        where: { groupId, status: 'active' as const },
      });
      if (dbMembers.length > 0) {
        members = dbMembers.map((m) => `${m.userId}:${m.deviceId}`);
        await this.redis.sadd(`group:members:${groupId}`, ...members);
      }
    }

    const notification = JSON.stringify({
      type: 'base_refresh_request',
      groupId,
      requesterUserId,
      requesterDeviceId,
    });

    for (let i = members.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [members[i], members[j]] = [members[j], members[i]];
    }

    for (const member of members) {
      if (member === senderKey) continue;
      const [memberUserId, memberDeviceId] = member.split(':');
      if (!memberUserId || !memberDeviceId) continue;
      if (!(await this.redis.exists(`user:online:${memberUserId}:${memberDeviceId}`))) continue;
      await this.redis.publish(
        'chat:messages',
        JSON.stringify({
          recipientId: memberUserId,
          deviceId: memberDeviceId,
          // `isWelcomeRequest` is the gateway's generic "relay this base64 JSON control frame"
          // flag; the inner `type` is what drives the client.
          proto: Buffer.from(notification).toString('base64'),
          isWelcomeRequest: true,
          groupId,
          senderId: requesterUserId,
          senderDeviceId: requesterDeviceId,
        })
      );
      this.logger.log(
        `[BASE_REFRESH][${traceId}] FORWARDED target=${member} group=${groupId} requester=${senderKey}`
      );
      return { status: 'forwarded', target: member };
    }

    // AT A LEVEL THAT ACCUSES, because this is a group nobody can enter right now. Its rate is what
    // says whether a stale base is a moment or a state.
    this.logger.warn(
      `[BASE_REFRESH][${traceId}] NO_PEER_ONLINE group=${groupId} requester=${senderKey} members=${members.length}` +
        ` - the published base stays stale and no device can external-join until a member returns`
    );
    return { status: 'no_peer_online' };
  }

  /**
   * Broadcasts a welcome_request signal to one online group member to trigger
   * a re-invite for the requesting device.  Falls back to the DB to repopulate
   * the Redis routing cache when the set is empty after a service restart.
   */
  async notifyWelcomeRequest(
    authUserIdRaw: string | undefined,
    body: NotifyWelcomeRequestBody
  ): Promise<{ status: string; target?: string }> {
    const traceId = this.makeTraceId('welcome-req');
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const requesterUserId = sanitizeQueryValue(body.requesterUserId, 'requesterUserId');
    const requesterDeviceId = sanitizeQueryValue(body.requesterDeviceId, 'requesterDeviceId');
    this.assertRequesterMatchesCaller(authUserIdRaw, requesterUserId, traceId, 'WELCOME_REQ');

    // Atomically pick one online group member that is not the requester.
    // Using a single server-side selection avoids the multi-connection race that
    // occurs when the gateway forwards the WS frame: each concurrent connection
    // from the requester's device would call forward_to_one_peer independently,
    // and since SMEMBERS returns an unordered set each call can pick a different
    // peer, causing multiple devices to concurrently commit an add for the same
    // invitation.
    let members: string[] = await this.redis.smembers(`group:members:${groupId}`);
    const senderKey = `${requesterUserId}:${requesterDeviceId}`;

    // Redis routing set is a cache: it can be empty after a service restart or
    // Redis flush even though active devices exist in the DB.
    // Fall back to the DB and repopulate the cache so routing is restored.
    if (members.length === 0) {
      this.logger.log(
        `[WELCOME_REQ][${traceId}] REDIS_EMPTY - falling back to DB for group=${groupId}`
      );
      const dbMembers = await this.deviceGroupRepo.find({
        where: { groupId, status: 'active' as const },
      });
      if (dbMembers.length > 0) {
        members = dbMembers.map((m) => `${m.userId}:${m.deviceId}`);
        await this.redis.sadd(`group:members:${groupId}`, ...members);
        this.logger.log(
          `[WELCOME_REQ][${traceId}] DB_FALLBACK found=${dbMembers.length} repopulated Redis cache`
        );
      }
    }

    this.logger.log(
      `[WELCOME_REQ][${traceId}] START group=${groupId} requester=${senderKey} members=${members.length}`
    );

    const notification = JSON.stringify({
      type: 'welcome_request',
      groupId,
      requesterUserId,
      requesterDeviceId,
    });

    for (const member of members) {
      if (member === senderKey) continue;
      const [memberUserId, memberDeviceId] = member.split(':');
      if (!memberUserId || !memberDeviceId) {
        this.logger.warn(
          `[WELCOME_REQ][${traceId}] Malformed group member entry='${member}' group=${groupId}`
        );
        continue;
      }
      const onlineKey = `user:online:${memberUserId}:${memberDeviceId}`;
      const isOnline = await this.redis.exists(onlineKey);
      this.logger.log(`[WELCOME_REQ][${traceId}] Candidate=${member} online=${!!isOnline}`);
      if (isOnline) {
        await this.redis.publish(
          'chat:messages',
          JSON.stringify({
            recipientId: memberUserId,
            deviceId: memberDeviceId,
            // Re-use the proto field as a JSON-encoded control payload so the
            // gateway can relay it as a plain text WS frame without extra decoding.
            proto: Buffer.from(notification).toString('base64'),
            isWelcomeRequest: true,
            groupId,
            senderId: requesterUserId,
            senderDeviceId: requesterDeviceId,
          })
        );
        this.logger.log(
          `[WELCOME_REQ][${traceId}] FORWARDED target=${member} group=${groupId} requester=${senderKey}`
        );

        // Drain any welcome_requests that were stored while no peer was online,
        // so this newly-online peer handles all pending invitees in one pass.
        const pendingSetKey = `pending_welcome:${groupId}`;
        const stored: string[] = await this.redis.smembers(pendingSetKey);
        let drained = 0;
        for (const storedKey of stored) {
          if (storedKey === senderKey) continue; // already forwarded above
          const [storedUserId, storedDeviceId] = storedKey.split(':');
          if (!storedUserId || !storedDeviceId) continue;
          await this.redis.publish(
            'chat:messages',
            JSON.stringify({
              recipientId: memberUserId,
              deviceId: memberDeviceId,
              proto: Buffer.from(
                JSON.stringify({
                  type: 'welcome_request',
                  groupId,
                  requesterUserId: storedUserId,
                  requesterDeviceId: storedDeviceId,
                })
              ).toString('base64'),
              isWelcomeRequest: true,
              groupId,
              senderId: storedUserId,
              senderDeviceId: storedDeviceId,
            })
          );
          drained++;
        }
        if (stored.length > 0) {
          await this.redis.del(pendingSetKey);
          this.logger.log(
            `[WELCOME_REQ][${traceId}] Drained ${drained} stored welcome_request(s) for group=${groupId}`
          );
        }

        return { status: 'forwarded', target: member };
      }
    }

    // No peer online - persist so the request is replayed when a peer connects.
    const pendingSetKey = `pending_welcome:${groupId}`;
    const pipeline = this.redis.pipeline();
    pipeline.sadd(pendingSetKey, senderKey);
    pipeline.expire(pendingSetKey, 86400); // 24 h TTL
    await pipeline.exec();

    // Also store per-member in pending_welcome_notify:{userId} so the Gateway can drain
    // signals as soon as a member reconnects, without waiting for the next welcome_request.
    // The format is the JSON that the Gateway will send directly to the WebSocket client.
    const notificationFrame = JSON.stringify({
      type: 'welcome_request',
      groupId,
      requesterUserId,
      requesterDeviceId,
    });
    const uniqueMemberUserIds = [
      ...new Set(
        members
          .filter((m) => m !== senderKey)
          .map((m) => m.split(':')[0])
          .filter(Boolean)
      ),
    ];
    if (uniqueMemberUserIds.length > 0) {
      const notifyPipeline = this.redis.pipeline();
      for (const memberUserId of uniqueMemberUserIds) {
        const notifyKey = `pending_welcome_notify:${memberUserId}`;
        notifyPipeline.rpush(notifyKey, notificationFrame);
        notifyPipeline.expire(notifyKey, 86400); // same 24 h TTL
      }
      await notifyPipeline.exec();
    }

    // Wake up offline peers via FCM so they reconnect and drain the pending request
    // without waiting for an organic reconnection.
    await this.sendFcmWelcomeRequestPending(groupId, members, senderKey, traceId);

    this.logger.log(
      `[WELCOME_REQ][${traceId}] NO_PEER_ONLINE group=${groupId} requester=${senderKey} - stored in Redis, FCM sent to peers`
    );
    return { status: 'no_peer_online' };
  }

  /**
   * Writes the queue rows for one send, refusing if the group stopped being a destination while the
   * send was in flight.
   *
   * THIS IS THE OVERLAP DELETED, NOT A REPAIR OF IT. `sendMessage` resolves its recipients from the
   * membership table and then saves, and `deleteGroup` writes the tombstone and sweeps everything
   * the group owns - including its queue - in one transaction. Nothing ordered the two, so a send
   * that read its recipients BEFORE the sweep and saved AFTER it wrote rows into a queue that had
   * just been emptied, for a group that no longer exists. Measured on the local estate 2026-09-05:
   *
   *     [SEND][send-bc9c9815] START group=7e931024...
   *     [DELETE_GROUP] 7e931024... soft-deleted, 14 row(s) purged: {"queuedMessages":4,...}
   *     [SEND][send-bc9c9815] QUEUED count=2
   *
   * Nine milliseconds, and the two rows are permanent: no device can decrypt or ACK a frame for a
   * tombstoned group, so `fetchMessages` drops them on every connection and nothing consumes them
   * before the 90-day reaper. Twenty `dropped 1 undeliverable message(s)` warnings in one
   * thirty-minute window came from those two rows. A race that heals cleanly is still a defect, and
   * this one does not heal - the drop filter is the witness, never the fix.
   *
   * THE SHARED ROW LOCK IS WHAT ORDERS THEM, and it orders them in both directions:
   *
   *   - The delete got there first: it holds the row exclusively (its own `UPDATE`), so this read
   *     BLOCKS until it commits and then sees `deletedAt` - the send is refused and writes nothing.
   *   - This send got there first: it holds the row shared, so the delete's `UPDATE` waits for this
   *     transaction to commit, and its sweep - which runs after that `UPDATE`, in the same
   *     transaction - then sees these rows and takes them with the group.
   *
   * There is no third interleaving, and no window in between: the liveness and the write are one
   * transaction, so no fact this reads can go stale before it is acted on. Both parties take
   * `dm_groups` first and in the same order, so the pair cannot deadlock, and `FOR SHARE` is
   * compatible with itself, so concurrent sends into the same group do not serialise.
   *
   * THE CLIENT ALREADY ASKS, AND THAT IS EXACTLY WHY THIS IS OWED HERE. `flushOne` reads
   * `getGroupMeta().deletedAt` and refuses before it sends - the trace above even carries its
   * `[GET_GROUP] found=true` one line before the START. A fact checked over a round trip is a fact
   * that can go stale inside it; only the writer can make the check and the write atomic.
   *
   * Refused rather than silently skipped: the sender is told its message is never going out, which
   * the outbox turns into a permanent failure rather than a ladder that spins. A send with no
   * `groupId` addresses no group and has nothing to check.
   */
  private async enqueueForLiveGroup(
    rows: QueuedMessage[],
    groupId: string | undefined,
    tag: string,
    traceId: string
  ): Promise<QueuedMessage[]> {
    if (!groupId) return this.queuedMessageRepo.save(rows);
    return this.queuedMessageRepo.manager.transaction(async (manager) => {
      const [group] = await manager.getRepository(Group).find({
        where: { id: groupId },
        select: { id: true, deletedAt: true },
        lock: { mode: 'pessimistic_read' },
      });
      if (!group || group.deletedAt) {
        this.logger.warn(
          `[${tag}][${traceId}] REJECT group_deleted group=${groupId} - ` +
            (group ? `tombstoned at ${group.deletedAt?.toISOString()}` : 'absent from dm_groups') +
            ` while this send was in flight, so its ${rows.length} row(s) would be undeliverable ` +
            `for ever - nothing queued`
        );
        throw new GoneException({ error: 'group_deleted', groupId });
      }
      return manager.getRepository(QueuedMessage).save(rows);
    });
  }

  /**
   * Among `groupIds`, identifies those with no remaining row in `dm_groups`
   * (neither active nor soft-delete tombstone) and purges their entire server residue through
   * {@link deleteGroupOwnedRows} - the one allowlist of what a group owns - plus the Redis keys.
   *
   * These groups result from an incomplete deletion: the row is gone but surviving data
   * causes a client-side recovery loop (welcome_request with no target) and an undecipherable
   * ghost history. Soft-deleted groups keep their tombstone row and are therefore never purged
   * here (the 90-day cron reclaims them, through that same function).
   *
   * No transaction here, and that is not an oversight: the group row is ALREADY gone, so there is
   * no window this could open. The reaper, which still has one to delete, does use one.
   *
   * PRESENCE AND DELIVERABILITY ARE TWO QUESTIONS, and this used to answer the first while its own
   * doc named the second - "still present in `dm_groups` (deliverable)". They differ by exactly the
   * tombstones, and a tombstone is not a destination: its members, keys and history are gone, so a
   * frame addressed to it can never be decrypted and never be ACKed, and a client handed one asks
   * for a Welcome no peer will answer - on every reconnection, for ever, because nothing in that
   * loop consumes the frame. `deletedAt` is a plain column rather than a `@DeleteDateColumn`, so
   * `find` returns tombstones and only naming them excludes them. Measured on prod 2026-08-21:
   * seven `queued_message` rows for W1's own device, addressed to a community distribution group
   * tombstoned five hours earlier, redelivered on every connection since.
   *
   * Both sets are returned, named, because the caller that filters frames has to tell the two
   * causes apart: an absent group is one this call has just repaired, a tombstoned one is residue a
   * delete path left behind and a defect at THAT path. A single set would make them one number.
   *
   * @returns `deliverable` - present in `dm_groups` AND not tombstoned, the only ids a frame may be
   *   handed to; `tombstoned` - present but soft-deleted, undeliverable and awaiting the reaper.
   */
  /**
   * Tombstoned groups already accused of holding queued rows, so the accusation is made once per
   * group per process rather than once per fetch - see the log line in {@link fetchMessages}.
   *
   * IN-PROCESS AND NOT DURABLE, on purpose. It answers "have I already said this here", which is a
   * different question from "is this still broken" and differs from it only in lifetime: a restart
   * re-announces whatever residue is still there, so using durable state here would silence the
   * trigger the day somebody wanted it again.
   */
  private readonly accusedTombstones = new Set<string>();

  async purgeOrphanGroups(
    groupIds: string[]
  ): Promise<{ deliverable: Set<string>; tombstoned: Set<string> }> {
    if (groupIds.length === 0) return { deliverable: new Set(), tombstoned: new Set() };

    const existing = await this.groupRepo.find({
      where: { id: In(groupIds) },
      select: { id: true, deletedAt: true },
    });
    const present = new Set(existing.map((g) => g.id));
    const deliverable = new Set(existing.filter((g) => !g.deletedAt).map((g) => g.id));
    const tombstoned = new Set(existing.filter((g) => g.deletedAt).map((g) => g.id));

    const orphaned = groupIds.filter((id) => !present.has(id));
    if (orphaned.length === 0) return { deliverable, tombstoned };

    const counts = await deleteGroupOwnedRows(this.groupRepo.manager, orphaned);
    await deleteGroupRedisKeys(this.redis, orphaned);

    this.logger.warn(
      `[ORPHAN_PURGE] purged ${orphaned.length} group(s) absent from dm_groups ` +
        `(${totalGroupOwnedRows(counts)} row(s): ${JSON.stringify(counts)}): ${orphaned.join(', ')}`
    );
    return { deliverable, tombstoned };
  }

  /**
   * Clamps history page size: full catch-up may read up to the stream MAXLEN;
   * incremental (`after` set) defaults to a smaller page.
   */
  private resolveHistoryLimit(after: string | undefined, limitRaw?: number): number {
    if (limitRaw !== undefined && Number.isFinite(limitRaw)) {
      return Math.min(Math.max(Math.trunc(limitRaw), 1), HISTORY_FULL_PAGE_LIMIT);
    }
    return after ? HISTORY_INCREMENTAL_DEFAULT_LIMIT : HISTORY_FULL_PAGE_LIMIT;
  }

  /** Maps Redis stream entries to the JSON shape expected by clients. */
  private mapHistoryEntries(entries: [string, string[]][]): Record<string, unknown>[] {
    return entries.map(([id, fields]) => {
      const msg: Record<string, unknown> = { id };
      for (let i = 0; i < fields.length; i += 2) {
        msg[fields[i]] = fields[i + 1];
      }
      return msg;
    });
  }

  /**
   * Enriches history entries with `sender_display_name` resolved from the `users` table.
   * Collects all unique `sender_id` values, batch-resolves their display names, and adds
   * `sender_display_name: string | null` to each entry. Best-effort: entries keep their
   * current shape on failure.
   */
  private async enrichHistoryWithDisplayNames(
    entries: Record<string, unknown>[]
  ): Promise<Record<string, unknown>[]> {
    if (entries.length === 0) return entries;
    const senderIds = [
      ...new Set(
        entries
          .map((e) => e['sender_id'])
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
      ),
    ];
    if (senderIds.length === 0) return entries;
    try {
      const nameMap = await resolveUserDisplayNamesBatch(this.groupRepo.manager, senderIds);
      for (const entry of entries) {
        const sid = typeof entry['sender_id'] === 'string' ? entry['sender_id'] : '';
        entry['sender_display_name'] = nameMap.get(sid) ?? null;
      }
    } catch (e) {
      this.logger.warn(`[HISTORY] display name resolution failed: ${String(e)}`);
      for (const entry of entries) {
        entry['sender_display_name'] = null;
      }
    }
    return entries;
  }

  /**
   * Keeps only a well-formed Redis stream id (`<ms>-<seq>`). Anything else is dropped rather than
   * rejected: a bad cursor is a client that has lost its place, and the honest answer is the
   * unbounded read it would have got with no cursor at all - not a 500 it cannot act on.
   */
  private sanitizeStreamId(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed && /^\d+-\d+$/.test(trimmed) ? trimmed : undefined;
  }

  /**
   * Reads one page from `history:{groupId}` (no auth — caller must gate access).
   *
   * `after` is an exclusive Redis stream ID (`(${after}` in XRANGE); `until` is an INCLUSIVE upper
   * bound, so a caller that passes back the `head` it was given walks exactly the rows that existed
   * when it started and never the ones appended since (see {@link HistoryBatchResponse.heads}).
   *
   * The head is read only when the caller has no bound yet - one `XREVRANGE ... COUNT 1` on the
   * first page of a walk, and nothing at all on the pages after it.
   */
  private async readHistoryStreamPage(
    groupId: string,
    after: string | undefined,
    limit: number,
    until?: string
  ): Promise<{ rows: Record<string, unknown>[]; head?: string }> {
    const streamKey = `history:${groupId}`;
    const startId = after ? `(${after}` : '-';
    const endId = until ?? '+';
    const entries = await this.redis.xrange(streamKey, startId, endId, 'COUNT', limit);
    const head = until
      ? until
      : ((await this.redis.xrevrange(streamKey, '+', '-', 'COUNT', 1))[0]?.[0] ?? undefined);
    this.logger.log(
      `[HISTORY] group=${groupId} after=${after ?? 'start'} until=${until ?? head ?? 'empty'} limit=${limit} entries=${entries.length}`
    );
    return { rows: this.mapHistoryEntries(entries), head };
  }

  /**
   * Returns group IDs the caller may read. Orphans are purged once per batch;
   * non-members are omitted (batch) or rejected (single-group).
   */
  private async authorizeHistoryGroups(
    groupIds: string[],
    headerUserId: string | undefined,
    headerGlobalAdmin: string | undefined,
    rejectForbidden: boolean
  ): Promise<Set<string>> {
    if (groupIds.length === 0) return new Set();

    // A DELETED GROUP HAS NO HISTORY TO SERVE: `deleteGroupOwnedRows` drops its `history:` stream
    // with the rest of what it owns, so a tombstone can only ever answer an empty page. Excluding
    // it here says so once instead of reading an absent stream per request. A client still holding
    // the conversation locally and asking for it is ORDINARY - hence no log line: the request is
    // not evidence of anything, unlike a queued frame (see fetchMessages).
    const { deliverable: deliverableIds } = await this.purgeOrphanGroups(groupIds);
    const deliverable = groupIds.filter((id) => deliverableIds.has(id));

    if (headerGlobalAdmin === 'true') {
      return new Set(deliverable);
    }

    const authUserId = sanitizeOptionalQueryValue(headerUserId, 'x-user-id');
    if (!authUserId) {
      throw new ForbiddenException('History requires authenticated user context');
    }

    if (deliverable.length === 0) {
      if (rejectForbidden && groupIds.length === 1) {
        return new Set();
      }
      return new Set();
    }

    const memberships = await this.groupMemberRepo.find({
      where: { userId: authUserId, groupId: In(deliverable) },
      select: { groupId: true },
    });
    const memberIds = new Set(memberships.map((m) => m.groupId));

    if (rejectForbidden && groupIds.length === 1) {
      const gid = groupIds[0];
      if (!deliverableIds.has(gid)) {
        return new Set();
      }
      if (!memberIds.has(gid)) {
        throw new ForbiddenException('Not a member of this group');
      }
    }

    return memberIds;
  }

  /**
   * Returns the Redis stream history for a group, with optional cursor-based
   * pagination via an afterStreamId parameter.
   * Enforces group membership for non-admin callers.
   */
  async getHistory(
    groupIdRaw: string,
    afterRaw: string | undefined,
    headerUserId: string | undefined,
    headerGlobalAdmin: string | undefined,
    limitRaw?: number,
    untilRaw?: string
  ): Promise<{ rows: Record<string, unknown>[]; head?: string }> {
    const groupId = sanitizeQueryValue(groupIdRaw, 'groupId');
    const after = this.sanitizeStreamId(afterRaw);
    const until = this.sanitizeStreamId(untilRaw);
    const limit = this.resolveHistoryLimit(after, limitRaw);

    const authorized = await this.authorizeHistoryGroups(
      [groupId],
      headerUserId,
      headerGlobalAdmin,
      true
    );
    if (!authorized.has(groupId)) {
      // NOT A WARNING, AND NOT "ORPHANED" EITHER, which is what this used to say. Two different
      // things land here and only one of them is a defect: a group with no row (already purged and
      // already WARNed about, with its evidence, by `purgeOrphanGroups`) and a group deleted whose
      // history went with it - which is a client still holding the conversation locally and asking
      // for it, the most ordinary request there is. Naming the first cause for both made a line
      // whose reader learns to skip it.
      this.logger.log(`[HISTORY] group=${groupId} not deliverable (absent or deleted) - empty`);
      return { rows: [] };
    }

    try {
      const { rows, head } = await this.readHistoryStreamPage(groupId, after, limit, until);
      return { rows: await this.enrichHistoryWithDisplayNames(rows), head };
    } catch (e) {
      this.logger.error(`[HISTORY] group=${groupId} error=${String(e)}`);
      throw new ServiceUnavailableException('History stream unavailable');
    }
  }

  /**
   * Fetches the first page of history for multiple groups in one round-trip.
   * Unauthorized or orphaned groups return an empty array (no error).
   */
  async getHistoryBatch(
    items: HistoryBatchRequestItem[],
    headerUserId: string | undefined,
    headerGlobalAdmin: string | undefined
  ): Promise<HistoryBatchResponse> {
    if (!Array.isArray(items)) {
      throw new BadRequestException('groups must be an array');
    }
    if (items.length > HISTORY_BATCH_MAX_GROUPS) {
      throw new BadRequestException(`At most ${HISTORY_BATCH_MAX_GROUPS} groups per batch`);
    }

    const normalized = items.map((item) => {
      // The limit is resolved from the SANITISED cursor: a dropped one means the read restarts from
      // the beginning, which is a full catch-up page, not the smaller incremental one.
      const after = this.sanitizeStreamId(item.after);
      return {
        groupId: sanitizeQueryValue(item.groupId, 'groupId'),
        after,
        until: this.sanitizeStreamId(item.until),
        limit: this.resolveHistoryLimit(after, item.limit),
      };
    });

    const groupIds = [...new Set(normalized.map((i) => i.groupId))];
    const authorized = await this.authorizeHistoryGroups(
      groupIds,
      headerUserId,
      headerGlobalAdmin,
      false
    );

    const histories: Record<string, Record<string, unknown>[]> = {};
    const heads: Record<string, string> = {};
    await Promise.all(
      normalized.map(async ({ groupId, after, until, limit }) => {
        if (!authorized.has(groupId)) {
          histories[groupId] = [];
          return;
        }
        try {
          const page = await this.readHistoryStreamPage(groupId, after, limit, until);
          histories[groupId] = page.rows;
          if (page.head) heads[groupId] = page.head;
        } catch (e) {
          this.logger.error(`[HISTORY_BATCH] group=${groupId} error=${String(e)}`);
          histories[groupId] = [];
        }
      })
    );

    // Batch-resolve sender display names across all groups in a single SQL round-trip.
    const allEntries = Object.values(histories).flat();
    await this.enrichHistoryWithDisplayNames(allEntries);

    this.logger.log(`[HISTORY_BATCH] groups=${normalized.length} authorized=${authorized.size}`);
    return { histories, heads };
  }

  /**
   * Fetches all queued (undelivered) messages for a specific device from the DB queue,
   * ordered by creation time ascending.  Enforces that the caller owns the userId.
   */
  async fetchMessages(
    userId: string,
    deviceId: string,
    headerUserId: string | undefined,
    headerGlobalAdmin: string | undefined,
    limit = 500,
    after?: string
  ): Promise<QueuedMessage[]> {
    const traceId = this.makeTraceId('fetch-msg');
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      safeUserId,
      'Cannot fetch messages for another user'
    );

    const safeLimit = Math.min(Math.max(limit, 1), 1000);

    this.logger.log(
      `[MSG_FETCH][${traceId}] START user=${safeUserId} device=${safeDeviceId} limit=${safeLimit} after=${after ?? 'none'}`
    );

    // Fill the page up to a BYTE budget, reading the table in small chunks.
    //
    // The row limit alone cannot bound a transfer: for a device whose frames carry media, 500 rows
    // meant 12 MB, and the client abandoned the request on its own per-page deadline having received
    // nothing - so nothing was ACKed, the queue never shrank, and every later attempt met the same
    // 12 MB. The chunked read is what keeps the SERVICE bounded too; see PENDING_PAGE_MAX_BYTES and
    // PENDING_FETCH_CHUNK_ROWS for why each number is what it is.
    const messages: QueuedMessage[] = [];
    let pageBytes = 0;
    let offset = 0;
    let cappedBy: 'bytes' | 'rows' | null = null;
    let done = false;

    while (!done) {
      const qb = this.queuedMessageRepo
        .createQueryBuilder('q')
        .where('q.recipientId = :userId', { userId: safeUserId })
        .andWhere('q.deviceId = :deviceId', { deviceId: safeDeviceId })
        .orderBy('q.createdAt', 'ASC')
        .skip(offset)
        .take(PENDING_FETCH_CHUNK_ROWS);

      if (after?.trim()) {
        qb.andWhere('q.createdAt > :after', { after: new Date(after) });
      }

      const chunk = await qb.getMany();
      if (chunk.length === 0) break;
      offset += chunk.length;

      for (const row of chunk) {
        const size = row.proto?.length ?? 0;
        const last = messages[messages.length - 1];
        const sameInstant = last !== undefined && +row.createdAt === +last.createdAt;

        // ALWAYS at least one row: a frame bigger than the whole budget must still be deliverable,
        // or it blocks its device's queue permanently - which is the failure being fixed, not a
        // smaller version of it. Hence `messages.length > 0` on both caps.
        if (cappedBy === null && messages.length > 0) {
          if (pageBytes + size > PENDING_PAGE_MAX_BYTES) cappedBy = 'bytes';
          else if (messages.length >= safeLimit) cappedBy = 'rows';
        }

        // A PAGE NEVER ENDS INSIDE A GROUP OF ROWS SHARING ONE `createdAt`. The client resumes with
        // `createdAt > <last row seen>`, which is strict - so splitting such a group drops the rest
        // of it from every later page, permanently, and the frame is never delivered at all.
        // `@CreateDateColumn` writes millisecond precision from the application, so collisions are
        // real rather than theoretical: one pair was present in the live queue when this was
        // written. Rows sharing the boundary instant are therefore taken even past the cap, which
        // is why a page can exceed its budget by one group and never by more.
        if (cappedBy !== null && !sameInstant) {
          done = true;
          break;
        }

        messages.push(row);
        pageBytes += size;
      }

      // A short chunk is the end of the queue; there is nothing left to read.
      if (chunk.length < PENDING_FETCH_CHUNK_ROWS) break;
    }

    if (cappedBy !== null) {
      this.logger.log(
        `[MSG_FETCH][${traceId}] page capped by ${cappedBy} at ${messages.length} row(s), ${pageBytes} byte(s) - the client pages again from the last createdAt`
      );
    }

    // Drop messages addressed to a group that can no longer receive them - absent from `dm_groups`
    // or tombstoned in it. Either way the client can neither decrypt nor ACK such a frame, so
    // handing it over starts a recovery loop (welcome_request with no target) that nothing
    // terminates: the frame stays queued and comes back on the next connection. purgeOrphanGroups
    // also purges the residue of the absent ones - see its doc.
    const groupIds = [
      ...new Set(messages.map((m) => m.groupId).filter((id): id is string => !!id)),
    ];
    const { deliverable: deliverableIds, tombstoned } = await this.purgeOrphanGroups(groupIds);
    const deliverable = messages.filter((m) => !m.groupId || deliverableIds.has(m.groupId));
    if (deliverable.length !== messages.length) {
      // THE TWO CAUSES ARE NAMED APART, because they accuse different code. An absent group is one
      // this fetch has just repaired. A QUEUED FRAME FOR A TOMBSTONED GROUP IS RESIDUE A DELETE PATH
      // LEFT: every path that ends a group sweeps `deleteGroupOwnedRows`, which takes the queue with
      // it, so this line is the visible end of one that did not - and it is not swept from here,
      // because a second collector would hide the first one's absence.
      //
      // ONCE PER GROUP PER PROCESS, because the residue is a STANDING FACT and not an event. Written
      // per fetch it was the loudest line on the server within minutes of shipping - 134 warnings in
      // one three-minute window, the same four group ids over and over, because every client asks on
      // every reconnection and the rows do not go away when they are read. A line its reader learns
      // to skip is the one that hides the next defect. Once is enough to be FOUND, which is the
      // line's whole job, and a restart re-announces whatever is still there, so nothing is lost.
      const leaked = groupIds.filter((id) => tombstoned.has(id) && !this.accusedTombstones.has(id));
      for (const id of leaked) this.accusedTombstones.add(id);
      this.logger.warn(
        `[MSG_FETCH][${traceId}] dropped ${messages.length - deliverable.length} undeliverable ` +
          `message(s)` +
          (leaked.length > 0
            ? ` - ${leaked.length} group(s) tombstoned in dm_groups and still holding queued rows, ` +
              `so the path that deleted them left residue: ${leaked.join(', ')}`
            : '')
      );
    }

    this.logger.log(
      `[MSG_FETCH][${traceId}] DONE user=${safeUserId} device=${safeDeviceId} count=${deliverable.length}`
    );
    return deliverable;
  }

  /**
   * Acknowledges (deletes) processed messages from the delivery queue by ID.
   * Enforces that the caller owns the userId and only deletes messages addressed
   * to the specified device.
   */
  async acknowledgeMessages(
    body: AckMessagesBody,
    headerUserId: string | undefined,
    headerGlobalAdmin: string | undefined
  ): Promise<{ status: string; count: number }> {
    const traceId = this.makeTraceId('ack');
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const safeMessageIds = sanitizeStringIdList(body.messageIds);
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      safeUserId,
      'Cannot acknowledge messages for another user'
    );

    this.logger.log(
      `[ACK][${traceId}] START user=${safeUserId} device=${safeDeviceId} requested=${safeMessageIds.length}`
    );

    if (safeMessageIds.length === 0) {
      this.logger.warn(
        `[ACK][${traceId}] IGNORE empty messageIds user=${safeUserId} device=${safeDeviceId}`
      );
      return { status: 'ignored', count: 0 };
    }

    // Delete only the messages the client has confirmed.
    const result = await this.queuedMessageRepo.delete({
      id: In(safeMessageIds),
      recipientId: safeUserId,
      deviceId: safeDeviceId, // Security: prevents a device from deleting another device's messages.
    });

    this.logger.log(
      `[ACK][${traceId}] DONE deleted=${result.affected || 0} user=${safeUserId} device=${safeDeviceId}`
    );

    return { status: 'deleted', count: result.affected || 0 };
  }

  /**
   * Sends a silent FCM data push to every registered device of each group member
   * (except the requester) to wake them up when a welcome_request is pending and
   * no peer was online to handle it.
   *
   * On reception, the Kotlin service reconnects the WebSocket; the normal
   * welcome-drain flow then forwards the pending welcome_request automatically.
   */
  private async sendFcmWelcomeRequestPending(
    groupId: string,
    members: string[],
    requesterKey: string,
    traceId: string
  ): Promise<void> {
    if (getApps().length === 0) return;

    const [requesterUserId, requesterDeviceId] = requesterKey.split(':');

    const uniqueUserIds = [
      ...new Set(
        members
          .filter((m) => m !== requesterKey)
          .map((m) => m.split(':')[0])
          .filter(Boolean)
      ),
    ];

    // Batch-load all tokens in a single query instead of one per user.
    if (uniqueUserIds.length === 0) return;
    const allTokens = await this.pushTokenRepo.find({
      where: { userId: In(uniqueUserIds) },
    });

    await Promise.all(
      allTokens.map(async (pt) => {
        try {
          await getMessaging().send({
            token: pt.token,
            data: {
              type: 'welcome_request_pending',
              groupId,
              requesterUserId: requesterUserId ?? '',
              requesterDeviceId: requesterDeviceId ?? '',
            },
            android: { priority: 'high', ttl: 3_600_000 }, // 1 h < 24 h Redis TTL
            apns: {
              payload: { aps: { contentAvailable: true } },
              headers: { 'apns-push-type': 'background', 'apns-priority': '5' },
            },
          });
          this.logger.log(
            `[WELCOME_REQ][${traceId}] FCM welcome_request_pending user=${pt.userId} device=${pt.deviceId}`
          );
        } catch (e) {
          if (this.isTerminalPushTokenError(e)) {
            await this.pushTokenRepo.delete({ id: pt.id });
            this.logger.warn(
              `[WELCOME_REQ][${traceId}] Deleted invalid push token user=${pt.userId} device=${pt.deviceId}`
            );
          }
          this.logger.warn(
            `[WELCOME_REQ][${traceId}] FCM failed user=${pt.userId} device=${pt.deviceId} err=${String(e)}`
          );
        }
      })
    );
  }

  /**
   * Sends a non-MLS push to every registered device of a user - the side-channel signals where the
   * server never sees the MLS plaintext: reactions, community channel messages and their silent
   * `channel_read` frames, posts, form reminders.
   *
   * THE ONLY IMPLEMENTATION. `InternalController.notifyUser` used to carry a second copy of this
   * loop without the `apns` block below, which cost every iPhone every community notification -
   * see that method's docstring. Anything that needs to push to a user calls this.
   *
   * Returns { sent, failed } - failure is non-fatal for the caller.
   */
  async sendPushToUser(
    userId: string,
    title: string,
    body: string,
    data: Record<string, string>
  ): Promise<{ sent: number; failed: number }> {
    if (getApps().length === 0) {
      // Not a quiet no-op: with Firebase uninitialised NOTHING notifies, on any platform, and the
      // caller's own log would still read as a success.
      this.logger.warn('[SOCIAL_PUSH] Firebase not initialized - nothing sent');
      return { sent: 0, failed: 0 };
    }

    const traceId = this.makeTraceId('social-push');
    const pushTokens = await this.pushTokenRepo.find({ where: { userId } });

    if (pushTokens.length === 0) {
      this.logger.log(`[SOCIAL_PUSH][${traceId}] No token for user=${userId}`);
      return { sent: 0, failed: 0 };
    }

    // iOS needs an explicit apns block: a data-only push never surfaces in the background
    // and never triggers the Notification Service Extension. FCM applies this block only to
    // iOS tokens (Android keeps consuming the data map below).
    const apnsRequest = buildInternalApnsRequest(title, body, data);

    let sent = 0;
    let failed = 0;
    for (const pt of pushTokens) {
      try {
        // Data-only -> onMessageReceived() fires even in the background.
        // Kotlin reads data["type"] to pick the channel and build the deepLink.
        await getMessaging().send({
          token: pt.token,
          data: { ...data, title, body },
          android: { priority: 'high' },
          apns: {
            payload: apnsRequest.payload,
            headers: {
              'apns-push-type': apnsRequest.pushType,
              'apns-priority': String(apnsRequest.priority),
            },
          },
        });
        sent++;
        this.logger.log(`[SOCIAL_PUSH][${traceId}] sent user=${userId} device=${pt.deviceId}`);
      } catch (e) {
        failed++;
        if (this.isTerminalPushTokenError(e)) {
          await this.pushTokenRepo.delete({ id: pt.id });
          this.logger.warn(
            `[SOCIAL_PUSH][${traceId}] deleted invalid token user=${userId} device=${pt.deviceId}`
          );
        }
        this.logger.warn(
          `[SOCIAL_PUSH][${traceId}] FCM failed user=${userId} device=${pt.deviceId} err=${String(e)}`
        );
      }
    }
    return { sent, failed };
  }
}
