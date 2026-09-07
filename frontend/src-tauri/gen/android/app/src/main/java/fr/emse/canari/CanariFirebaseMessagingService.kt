package fr.emse.canari

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.net.Uri
import android.os.PowerManager
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.FileProvider
import androidx.core.graphics.drawable.IconCompat
import androidx.work.BackoffPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkRequest
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

// Local alias: avoids renaming PushContext across every method signature.
private typealias PushContext = MlsContextLoader.PushContext

class CanariFirebaseMessagingService : FirebaseMessagingService() {

    /**
     * An outbox mirror entry (cleartext AppMessage proto, base64). Declared as a nested class of
     * the outer class (not the companion object): Kotlin lifts companion FUNCTIONS to the class
     * name but NOT nested classes, so a companion-nested type is unreachable as
     * `CanariFirebaseMessagingService.OutboxMirrorEntry` from CanariNotificationActionReceiver.
     */
    internal data class OutboxMirrorEntry(
        val id: String,
        val groupId: String,
        val proto: String,
        val sentAt: Long,
        /** Silent send (no recipient notification): true for control events. */
        val silent: Boolean,
        /**
         * Append to the group's shared log. Independent of [silent], and true for every outbox
         * entry: a mutation sent from here must be as durable as one sent from the foreground, or
         * which path delivered it would decide whether an absent device can ever learn about it.
         */
        val durable: Boolean,
    )

    companion object {
        const val TAG = "CanariFCM"

        /**
         * The one thread on which every push that touches `mls.bin` runs. See
         * [runSerializedWithWakeLock] for what it replaced and why.
         *
         * It lives in the companion object because the FCM service object is recreated per
         * delivery: a lane held as an instance field would be a new lane per push, which is the
         * unbounded thread-per-push it exists to prevent, wearing a queue as a disguise.
         */
        private val MLS_PUSH_LANE: ExecutorService =
            Executors.newSingleThreadExecutor { r -> Thread(r, "canari-fcm-mls") }

        /** High-priority channel: DMs and group messages (sound + vibration). */
        const val CHANNEL_MESSAGES = "canari_messages"

        /** Normal-priority channel: reactions/comments on posts (silent). */
        const val CHANNEL_SOCIAL   = "canari_social"

        /** Normal-priority channel: form reminders (silent). */
        const val CHANNEL_FORMS    = "canari_forms"

        /** Max-priority channel: incoming call rings (WP-XP-5, ringtone + bypass-DND request). */
        const val CHANNEL_CALLS    = "canari_calls"

        /** High-priority channel: messages that @-mention the user (WP-XP-5, bypass-DND request). */
        const val CHANNEL_MENTIONS = "canari_mentions"

        const val PREFS_NAME    = "canari_prefs"
        const val KEY_FCM_TOKEN = "fcm_token"

        /** Notification quick actions (WP-XP-1): reply inline / mark as read from the shade. */
        const val ACTION_QUICK_REPLY = "fr.emse.canari.ACTION_QUICK_REPLY"
        const val ACTION_MARK_READ   = "fr.emse.canari.ACTION_MARK_READ"
        const val EXTRA_GROUP_ID     = "groupId"
        /**
         * The `sentAt` of the newest message the notification is about, in ms, as stated by its
         * SENDER. Carried in the action intents so "mark as read" and a quick reply can name the
         * instant they acknowledge without looking anything up - see
         * [CanariNotificationActionReceiver.sendReadWatermark] for why a lookup was wrong.
         */
        const val EXTRA_SENT_AT      = "sentAt"
        const val KEY_TEXT_REPLY     = "canari_quick_reply_text"

        /** Incoming-call ring (WP-XP-5): decline action + extras for the ring notification. */
        const val ACTION_CALL_DECLINE = "fr.emse.canari.ACTION_CALL_DECLINE"
        const val EXTRA_CALL_ID       = "callId"

        /**
         * Mirrors CALLS_ENABLED in frontend/src/lib/features.ts, which holds the whole calling
         * surface off until it has been run on hardware (rung 15 CALL / CALL-13). Duplicated
         * rather than read from the webview because this service handles pushes while no webview
         * exists. Flip both in the same commit, and restore USE_FULL_SCREEN_INTENT in
         * AndroidManifest.xml with them - Play gates that permission on the app being a calling
         * app, exactly as App Review gates the iOS `voip` background mode.
         */
        private const val CALLS_ENABLED = false

        /** A ring is abandoned after 60s (same order as the OS phone app). */
        private const val CALL_RING_TIMEOUT_MS = 60_000L

        /** Distinct ID range for ring notifications (stable per callId, far above the counters). */
        private const val CALL_NOTIF_ID_BASE = 700_000

        /**
         * callIds currently ringing. Dedupe between the two ring sources: the cleartext
         * `call_ring` push (fast path) and the decrypted MLS `call_invite` (fallback for
         * pre-WP-XP-5 callers) can both arrive for the same call.
         */
        private val activeCallRings = java.util.Collections.synchronizedSet(mutableSetOf<String>())

        // Starts at 10_000 to avoid overlapping the stable IDs (1000-9998) or the summary (9999).
        private val notificationIdCounter = java.util.concurrent.atomic.AtomicInteger(10_000)

        /** Avatar file cache validity duration: 24 hours. */
        private const val AVATAR_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000L

        /** Maximum number of entries kept in fcm_message_cache.ndjson. */
        private const val MAX_FCM_CACHE_ENTRIES = 50

        /** Lock protecting concurrent writes to fcm_message_cache.ndjson. */
        private val CACHE_LOCK = java.util.concurrent.locks.ReentrantLock()

        /**
         * Lock protecting getStableNotifId: the read-increment-write of the SharedPreferences
         * counter is not atomic, hence the race between parallel FCM threads.
         */
        private val NOTIF_ID_LOCK = Any()

        /** Android group key to bundle message notifications under a single line. */
        private const val GROUP_KEY_MESSAGES = "canari_messages_group"

        /** Reserved ID for the group summary notification (must not collide with getStableNotifId). */
        private const val GROUP_SUMMARY_ID   = 9999

        /** Reserved ID for the "messages pending sync" notification (messages channel -> auto-cleared on open). */
        private const val PENDING_SYNC_NOTIF_ID = 9998

        /** App-private cleartext mirror of the outbox (written by the TS) drained by the background send. */
        private const val OUTBOX_PENDING_FILE = "outbox_pending.ndjson"

        /** List of messageIds delivered in the background (read then cleared by the TS at login). */
        private const val OUTBOX_SENT_FILE = "outbox_sent.ndjson"

        /**
         * How many queued messages one drain takes on. The cap is on the ENCRYPT, deliberately:
         * encrypting consumes a ratchet generation whether or not the frame is ever POSTed, so
         * encrypting a backlog the drain has no time to deliver would run this sender's generation
         * far ahead of what the peer receives - eventually past OpenMLS's maximum forward distance,
         * which no retry can repair. Whatever is left over is not touched at all and is drained
         * next time (FCM, boot, or OutboxRetryWorker), so a backlog of any size converges across
         * successive drains. iOS twin: kCanariDrainMaxBatch.
         */
        private const val DRAIN_MAX_BATCH = 100

        /**
         * Wall-clock budget for the POST half of an outbox drain. A BroadcastReceiver holding
         * goAsync() is killed by the OS at 60 s whatever it is doing, and the drain also has to pay
         * for the token re-registration and the batch encrypt before it gets here. Exceeding it is
         * not an error - the remainder stays queued - but unlike the batch cap it does leave already
         * encrypted frames unsent, so it is the safety net for a slow network rather than the
         * normal exit. iOS twin: kCanariDrainPostBudgetMs.
         */
        private const val DRAIN_POST_BUDGET_MS = 35_000L

        /**
         * How many deliveries may accumulate before the mirror is rewritten. The mirror is the only
         * record of what is still owed, so between two rewrites a hard kill re-sends everything
         * already delivered - this bounds that window instead of letting it be the whole backlog.
         */
        private const val DRAIN_CHECKPOINT_EVERY = 25

        /**
         * The inline mention token a decrypted body carries: `@[` + 64 lowercase hex + `]`.
         *
         * Spelt once and used twice - to decide whether a message names ME (which chooses the
         * notification channel) and to render the tokens for a reader. It used to be spelt only as
         * the literal `"@[" + myUserId + "]"`, which answers the first question and cannot answer
         * the second at all.
         */
        private val MENTION_TOKEN = Regex("@\\[([0-9a-fA-F]{64})\\]")

        /** Maximum number of messages stacked in a per-conversation MessagingStyle notification. */
        private const val MAX_NOTIF_MESSAGES = 6

        /**
         * Number of decrypt retries when the 1st message of a new conversation arrives before
         * the concurrent Welcome push has joined the group (or while it holds MlsStateLock).
         * Avoids showing a generic "Nouveau message de X" fallback.
         */
        private const val WELCOME_RACE_RETRIES = 3

        /** Delay between two retries (the JNI process_welcome takes ~5s; give it time). */
        private const val WELCOME_RACE_RETRY_DELAY_MS = 1_800L

        /**
         * Cancels every displayed message notification (channel [CHANNEL_MESSAGES] + summary).
         * Called when the app comes to the foreground (MainActivity.onResume): opening the app clears
         * notifications for messages read here or elsewhere (visible part of the read-state sync).
         */
        fun cancelAllMessageNotifications(context: Context) {
            if (android.os.Build.VERSION.SDK_INT < 23) return
            try {
                val manager =
                    context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                for (sbn in manager.activeNotifications) {
                    val channelId =
                        if (android.os.Build.VERSION.SDK_INT >= 26) sbn.notification.channelId else null
                    // Only touch message notifications (leave social/forms alone; the mentions
                    // channel is a message tier so it clears on open too). Ring notifications
                    // are also cleared: once the app is open the in-app CallOverlay rings.
                    if (channelId == null || channelId == CHANNEL_MESSAGES ||
                        channelId == CHANNEL_MENTIONS || channelId == CHANNEL_CALLS
                    ) {
                        manager.cancel(sbn.id)
                    }
                }
                // Ring dedupe entries die with their notifications, so a re-ring can post again.
                activeCallRings.clear()
            } catch (e: Exception) {
                Log.w(TAG, "cancelAllMessageNotifications: ${e.message}")
            }
        }

        // --- Shared with CanariNotificationActionReceiver (quick reply / mark as read) ---------
        //
        // These take an explicit `context`/`service` instead of an implicit Service-as-Context
        // receiver so the notification-action BroadcastReceiver can reuse the exact same
        // outbox-drain and notification-cancel logic as the FCM service, with zero duplication.
        // `service` only backs the JNI-bound `nativeSendMessagesBackground` call (native code
        // never touches Context/Service framework state), so a bare `CanariFirebaseMessagingService()`
        // instance - never `attachBaseContext`-ed - is safe to pass there, but NOT as `context`.

        /**
         * Retrieves the push secret. `pending_push_secret.txt` WINS over the Keystore whenever it
         * exists, because it is newer by construction: `POST /mls/push/register` mints a fresh
         * secret on EVERY call and invalidates the previous one server-side, the WebView writes
         * that secret to the file (`store_push_secret`), and the only thing that ever moves the
         * file into the Keystore is [CanariApplication.processPendingPushSecret] - which runs once
         * per process, at `onCreate`, i.e. strictly BEFORE the registration that wrote the file.
         *
         * Reading the Keystore first therefore returned the PREVIOUS process's secret for the whole
         * life of a process, and the server answered 403 to every background send made from a
         * merely backgrounded app. A killed app hid it: FCM starts a fresh process, `onCreate`
         * migrates the file, and the Keystore is fresh again. That asymmetry is the whole of
         * "the notification quick reply is broken" (WP-NOTIF-1).
         *
         * The file is consumed here exactly as at startup - stored into the Keystore, zeroed over
         * its own byte length, deleted - so the two paths converge on one representation and the
         * file's presence never means anything but "newer than the Keystore".
         */
        internal fun retrievePushSecret(context: Context): String? {
            try {
                val file = File(MlsContextLoader.tauriDataDir(context), "pending_push_secret.txt")
                if (file.exists()) {
                    val rawBytes = file.readBytes()
                    val secret = rawBytes.toString(Charsets.UTF_8).trim()
                    if (secret.isNotEmpty()) {
                        PushSecretKeystore.store(context, secret)
                        file.writeBytes(ByteArray(rawBytes.size) { 0 })
                        file.delete()
                        Log.i(TAG, "retrievePushSecret: newer secret adopted from pending_push_secret.txt -> Keystore")
                        return secret
                    }
                    // An empty file is a half-written handoff, not an answer: leave it for the next
                    // reader and fall through to the Keystore rather than deleting a secret nobody
                    // has read yet.
                    Log.w(TAG, "retrievePushSecret: pending_push_secret.txt present but empty - falling through to the Keystore")
                }
            } catch (e: Exception) {
                Log.e(TAG, "retrievePushSecret: pending_push_secret.txt unreadable: ${e.message}")
            }

            val stored = PushSecretKeystore.retrieve(context)
            if (stored == null) {
                Log.e(TAG, "retrievePushSecret: no pending file and no Keystore entry - background send cannot authenticate")
            }
            return stored
        }

        /**
         * Builds the inline "Repondre" action (RemoteInput text field), routed to
         * [CanariNotificationActionReceiver]. Its PendingIntent MUST be mutable: RemoteInput writes
         * the typed text into the intent extras when the system delivers the broadcast, which
         * `FLAG_IMMUTABLE` would silently drop.
         *
         * [res] is the locale-resolved context and is passed in rather than derived: [appLocaleContext]
         * costs one `push_context.json` read per call and is meant to be resolved once per notification.
         */
        internal fun buildReplyAction(
            context: Context,
            res: Context,
            groupId: String,
            notifId: Int,
            sentAt: Long,
        ): NotificationCompat.Action {
            val remoteInput = RemoteInput.Builder(KEY_TEXT_REPLY)
                .setLabel(res.getString(R.string.notif_action_reply))
                .build()
            val intent = Intent(context, CanariNotificationActionReceiver::class.java).apply {
                action = ACTION_QUICK_REPLY
                putExtra(EXTRA_GROUP_ID, groupId)
                putExtra(EXTRA_SENT_AT, sentAt)
            }
            val pendingIntent = PendingIntent.getBroadcast(
                context, notifId, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
            )
            return NotificationCompat.Action.Builder(
                R.drawable.ic_notification, res.getString(R.string.notif_action_reply), pendingIntent
            ).addRemoteInput(remoteInput).setAllowGeneratedReplies(true).build()
        }

        /** Builds the "Marquer comme lu" action, routed to [CanariNotificationActionReceiver]. */
        internal fun buildMarkReadAction(
            context: Context,
            res: Context,
            groupId: String,
            notifId: Int,
            sentAt: Long,
        ): NotificationCompat.Action {
            val intent = Intent(context, CanariNotificationActionReceiver::class.java).apply {
                action = ACTION_MARK_READ
                putExtra(EXTRA_GROUP_ID, groupId)
                putExtra(EXTRA_SENT_AT, sentAt)
            }
            // A distinct requestId (notifId + 1) so this PendingIntent does not collide/merge with
            // the reply action's (same notifId would make FLAG_UPDATE_CURRENT overwrite one with
            // the other).
            val pendingIntent = PendingIntent.getBroadcast(
                context, notifId + 1, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            return NotificationCompat.Action.Builder(
                R.drawable.ic_notification, res.getString(R.string.notif_action_mark_read), pendingIntent
            ).build()
        }

        /**
         * Re-posts a conversation's notification after a quick reply failed to leave the device.
         *
         * Android consumes the RemoteInput the instant the action fires: it replaces the action row
         * with an indeterminate spinner and NEVER resolves it on its own. Leaving the notification
         * untouched - which is what the failure branch used to do, calling it "the immediate retry
         * affordance" - therefore leaves a notification reading "sending" forever, offering no retry
         * at all. The reply is NOT lost (it stays in `outbox_pending.ndjson`), so this must not
         * cancel the send; what it cancels is the spinner.
         *
         * Re-posting under the same id ends the spinner, restores both actions, and shows the typed
         * text as a pending message of the thread, so the shade states what is actually true.
         * `setOnlyAlertOnce` keeps it silent: nothing new arrived, only our own send failed.
         *
         * Best-effort by nature - if the notification is already gone there is nothing to correct.
         */
        internal fun repostReplyPending(
            context: Context,
            groupId: String,
            replyText: String,
            sentAt: Long,
        ) {
            try {
                val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                val notifId = getStableNotifId(context, groupId)
                val existing = manager.activeNotifications.firstOrNull { it.id == notifId }?.notification
                if (existing == null) {
                    Log.w(TAG, "repostReplyPending: no active notification for group=${groupId.take(8)} - spinner cannot be cleared")
                    return
                }
                val previous = NotificationCompat.MessagingStyle
                    .extractMessagingStyleFromNotification(existing)
                if (previous == null) {
                    Log.w(TAG, "repostReplyPending: no MessagingStyle on the notification for group=${groupId.take(8)}")
                    return
                }
                val res = appLocaleContext(context)
                val style = NotificationCompat.MessagingStyle(previous.user)
                previous.conversationTitle?.let {
                    style.conversationTitle = it
                    style.isGroupConversation = previous.isGroupConversation
                }
                previous.messages.takeLast(MAX_NOTIF_MESSAGES - 1).forEach { style.addMessage(it) }
                // Attributed to US, like the in-flight reply Android was drawing, so the thread
                // reads as the user's own pending message and not as a new incoming one.
                style.addMessage(
                    NotificationCompat.MessagingStyle.Message(
                        res.getString(R.string.notif_reply_pending, replyText),
                        System.currentTimeMillis(),
                        previous.user
                    )
                )
                val channel = if (android.os.Build.VERSION.SDK_INT >= 26) {
                    existing.channelId ?: CHANNEL_MESSAGES
                } else {
                    CHANNEL_MESSAGES
                }
                val builder = NotificationCompat.Builder(context, channel)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setStyle(style)
                    .setAutoCancel(true)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setContentIntent(existing.contentIntent)
                    .setGroup(GROUP_KEY_MESSAGES)
                    .setOnlyAlertOnce(true)
                if (groupId.isNotEmpty() && !groupId.startsWith("channel_")) {
                    builder.addAction(buildReplyAction(context, res, groupId, notifId, sentAt))
                    builder.addAction(buildMarkReadAction(context, res, groupId, notifId, sentAt))
                }
                manager.notify(notifId, builder.build())
                Log.i(TAG, "repostReplyPending: re-posted group=${groupId.take(8)} - spinner cleared, actions restored")
            } catch (e: Exception) {
                Log.e(TAG, "repostReplyPending: ${e.message}", e)
            }
        }

        /**
         * Returns a stable, unique notification ID for [groupId], persisted in
         * SharedPreferences. Avoids groupId.hashCode() collisions between conversations.
         */
        internal fun getStableNotifId(context: Context, groupId: String): Int =
            synchronized(NOTIF_ID_LOCK) {
                val prefs = context.getSharedPreferences("canari_notif_ids", Context.MODE_PRIVATE)
                val existing = prefs.getInt(groupId, -1)
                if (existing != -1) return@synchronized existing
                val next = prefs.getInt("__counter__", 1000)
                // commit() guarantees the counter is incremented before exiting the synchronized block.
                prefs.edit().putInt(groupId, next).putInt("__counter__", next + 1).commit()
                next
            }

        /**
         * Removes a conversation's notification (message read/sent from another device, or a
         * "mark as read" notification quick action). Never creates an ID: if no notification
         * exists for this group, does nothing. Also removes the group summary if no message
         * notification remains.
         */
        internal fun cancelConversationNotification(context: Context, groupId: String) {
            val prefs = context.getSharedPreferences("canari_notif_ids", Context.MODE_PRIVATE)
            val notifId = prefs.getInt(groupId, -1)
            if (notifId == -1) {
                Log.d(TAG, "cancelConversationNotification: no notif for group=${groupId.take(8)}")
                return
            }
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.cancel(notifId)
            Log.d(TAG, "cancelConversationNotification: notif removed group=${groupId.take(8)} id=$notifId")

            // Refresh the group summary + launcher badge (WP-XP-2): recompute the unread count and
            // drop the summary when no message notification remains.
            refreshBadgeSummary(context)
        }

        /**
         * Appends one entry to `fcm_message_cache.ndjson`, the cross-process file the app drains at
         * boot (`consumeFcmCache`). Bounded to [MAX_FCM_CACHE_ENTRIES] lines (read, truncate,
         * rewrite) so a long-closed app that received many pushes cannot grow it without limit.
         * Lives on the companion because two callers write it: the push path (an incoming message
         * decrypted while the app is dead) and the notification quick reply (an OUTGOING message
         * sent while the app is dead - see [CanariNotificationActionReceiver.handleReply]).
         */
        internal fun appendFcmCacheEntry(
            context: Context,
            entry: JSONObject,
            messageId: String,
            groupId: String,
        ) {
            try {
                val file = File(MlsContextLoader.tauriDataDir(context).also { it.mkdirs() }, "fcm_message_cache.ndjson")
                CACHE_LOCK.lock()
                try {
                    val existing = if (file.exists())
                        file.readLines().filter { it.isNotBlank() }
                    else emptyList()
                    val kept = if (existing.size >= MAX_FCM_CACHE_ENTRIES)
                        existing.drop(existing.size - MAX_FCM_CACHE_ENTRIES + 1)
                    else existing
                    file.writeText((kept + entry.toString()).joinToString("\n") + "\n")
                } finally {
                    CACHE_LOCK.unlock()
                }
                Log.d(TAG, "writeFcmCache: ✓ messageId=${messageId.take(8)} groupId=${groupId.take(8)}")
            } catch (e: Exception) {
                Log.w(TAG, "writeFcmCache: failed: ${e.message}")
            }
        }

        /**
         * Records a message this device SENT from a notification quick reply into the same cache,
         * so the app injects it into the conversation at next open.
         *
         * A quick reply is built and delivered entirely natively: it never becomes a TypeScript
         * outbox entry, and `reconcileOutboxSent` only DELETES entries. Without this, a reply that
         * peers received left no trace whatsoever on the device that sent it - which reads, from
         * the app, exactly like a reply that was never sent. `senderId` is OUR user id, which is
         * all the injection path needs to treat the row as our own (`mapStoredMessagesToChatMessages`
         * derives `isOwn` from it, so it also does not raise a phantom unread).
         *
         * `senderName` is deliberately left empty: it only ever labels a conversation the app has
         * never seen, and for a reply the conversation necessarily exists already.
         */
        internal fun writeSentMessageToCache(
            context: Context,
            groupId: String,
            selfUserId: String,
            messageId: String,
            text: String,
            sentAt: Long,
        ) {
            if (messageId.isEmpty() || selfUserId.isEmpty()) {
                Log.w(TAG, "writeSentMessageToCache: missing messageId/userId -> entry ignored")
                return
            }
            val entry = JSONObject().apply {
                put("groupId",    groupId)
                put("messageId",  messageId)
                put("senderId",   selfUserId)
                put("senderName", "")
                put("content",    text)
                put("timestamp",  sentAt)
                put("type",       "text")
            }
            appendFcmCacheEntry(context, entry, messageId, groupId)
        }

        /**
         * Records "this conversation is read up to `at`" in `read_watermarks.ndjson`, the
         * cross-process file the app merges at boot (`consumeNativeReadWatermarks`).
         *
         * THE FRAME IS NOT ENOUGH, and that is the whole reason this file exists. The
         * `read_watermark` control event queued alongside this call reaches PEERS and our own other
         * devices; nothing carries it to THIS device's database, whose conversation row draws the
         * badge. Without it the user acknowledged a conversation from the shade, opened the app and
         * found it unread - which looks exactly like the action having done nothing.
         *
         * ONE LINE PER CONVERSATION, keeping the larger `at`: the merge on the far side is `max`
         * anyway, so collapsing here bounds the file by the number of conversations instead of by a
         * ring-buffer cap that could drop the very entry it was written for.
         */
        internal fun appendReadWatermark(context: Context, groupId: String, at: Long) {
            if (groupId.isEmpty() || at <= 0L) {
                Log.w(TAG, "appendReadWatermark: group=${groupId.take(8)} at=$at -> nothing to record")
                return
            }
            try {
                val file = File(MlsContextLoader.tauriDataDir(context).also { it.mkdirs() }, "read_watermarks.ndjson")
                CACHE_LOCK.lock()
                try {
                    val byGroup = LinkedHashMap<String, Long>()
                    if (file.exists()) {
                        for (line in file.readLines()) {
                            if (line.isBlank()) continue
                            try {
                                val o = JSONObject(line)
                                val g = o.optString("groupId")
                                val a = o.optLong("at", 0L)
                                if (g.isNotEmpty() && a > 0L) byGroup[g] = maxOf(byGroup[g] ?: 0L, a)
                            } catch (e: Exception) {
                                Log.w(TAG, "appendReadWatermark: unparsable line dropped: ${e.message}")
                            }
                        }
                    }
                    byGroup[groupId] = maxOf(byGroup[groupId] ?: 0L, at)
                    file.writeText(
                        byGroup.entries.joinToString("\n") { (g, a) ->
                            JSONObject().apply { put("groupId", g); put("at", a) }.toString()
                        } + "\n"
                    )
                } finally {
                    CACHE_LOCK.unlock()
                }
                Log.d(TAG, "appendReadWatermark: group=${groupId.take(8)} at=$at recorded for the next boot")
            } catch (e: Exception) {
                Log.w(TAG, "appendReadWatermark: failed: ${e.message}")
            }
        }

        /** Stable ring-notification ID for a callId (distinct range, no counter collision). */
        private fun callNotifId(callId: String): Int =
            CALL_NOTIF_ID_BASE + (callId.hashCode() and 0xFFFF)

        /**
         * Shows the full-priority incoming-call notification (WP-XP-5): CallStyle on API 31+
         * (system call UI with Answer/Decline), classic high-priority notification with the same
         * actions below. Rings on the CHANNEL_CALLS ringtone channel, carries a full-screen
         * intent (shown immediately on a locked/idle device when the OS grants USE_FULL_SCREEN_INTENT)
         * and self-expires after [CALL_RING_TIMEOUT_MS]. Deduped per callId: the cleartext
         * `call_ring` push and the decrypted MLS `call_invite` may both arrive.
         */
        internal fun showIncomingCallNotification(
            context: Context,
            groupId: String,
            callId: String,
            callerName: String,
            groupName: String,
            hasVideo: Boolean,
        ) {
            // ONE choke point for both callers (cleartext call_ring push, decrypted MLS invite):
            // a peer on an older build can still ring this device, and a system call UI for a call
            // the webview will refuse to join is worse than no ring at all.
            if (!CALLS_ENABLED) {
                Log.d(TAG, "showIncomingCallNotification: calls disabled -> ignoring ring call=$callId")
                return
            }
            if (MainActivity.isInForeground) {
                Log.d(TAG, "showIncomingCallNotification: app foreground -> WS/CallOverlay rings, skip")
                return
            }
            if (!activeCallRings.add(callId)) {
                Log.d(TAG, "showIncomingCallNotification: already ringing call=$callId -> dedupe")
                return
            }
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            CanariApplication.ensureChannels(context, manager)
            val res = appLocaleContext(context)
            val notifId = callNotifId(callId)

            // Answer = deep link into the conversation with an accept marker: the frontend
            // auto-accepts the call once the user has unlocked (PIN) and the invite arrived via WS.
            val videoFlag = if (hasVideo) 1 else 0
            val answerIntent = Intent(context, MainActivity::class.java).apply {
                action = Intent.ACTION_VIEW
                setData(Uri.parse("fr.emse.canari://chat/$groupId?acceptCall=$callId&video=$videoFlag"))
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            val answerPending = PendingIntent.getActivity(
                context, notifId, answerIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val declineIntent = Intent(context, CanariNotificationActionReceiver::class.java).apply {
                action = ACTION_CALL_DECLINE
                putExtra(EXTRA_GROUP_ID, groupId)
                putExtra(EXTRA_CALL_ID, callId)
            }
            val declinePending = PendingIntent.getBroadcast(
                context, notifId + 1, declineIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val title = callerName.ifEmpty { res.getString(R.string.app_name) }
            val body = buildString {
                append(res.getString(if (hasVideo) R.string.notif_incoming_video_call else R.string.notif_incoming_call))
                if (groupName.isNotEmpty()) append(" - ").append(groupName)
            }
            val person = Person.Builder().setName(title).setImportant(true).build()

            val builder = NotificationCompat.Builder(context, CHANNEL_CALLS)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(body)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setOngoing(true)
                .setAutoCancel(false)
                .setTimeoutAfter(CALL_RING_TIMEOUT_MS)
                .setFullScreenIntent(answerPending, true)
                .setContentIntent(answerPending)
            if (android.os.Build.VERSION.SDK_INT >= 31) {
                builder.setStyle(
                    NotificationCompat.CallStyle.forIncomingCall(person, declinePending, answerPending)
                        .setIsVideo(hasVideo)
                )
            } else {
                builder
                    .addAction(
                        NotificationCompat.Action.Builder(
                            R.drawable.ic_notification,
                            res.getString(R.string.notif_action_decline_call),
                            declinePending
                        ).build()
                    )
                    .addAction(
                        NotificationCompat.Action.Builder(
                            R.drawable.ic_notification,
                            res.getString(R.string.notif_action_answer_call),
                            answerPending
                        ).build()
                    )
            }
            val notif = builder.build()
            // Loop the ringtone until the ring is answered, declined, cancelled or times out.
            notif.flags = notif.flags or android.app.Notification.FLAG_INSISTENT
            manager.notify(notifId, notif)
            Log.d(TAG, "showIncomingCallNotification: ringing call=$callId group=${groupId.take(8)} video=$hasVideo")

            // Belt-and-braces expiry: setTimeoutAfter is API 26+; also drop the dedupe entry.
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                cancelIncomingCallNotification(context, callId)
            }, CALL_RING_TIMEOUT_MS)
        }

        /** Stops an active ring (answered elsewhere, caller hung up, timeout, or user declined). */
        internal fun cancelIncomingCallNotification(context: Context, callId: String) {
            if (callId.isEmpty()) return
            if (!activeCallRings.remove(callId)) return
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.cancel(callNotifId(callId))
            Log.d(TAG, "cancelIncomingCallNotification: ring stopped call=$callId")
        }

        /**
         * Counts distinct unread conversations = active message notifications, excluding the group
         * summary and the pending-sync nudge. Backs the launcher app-icon badge (WP-XP-2).
         */
        internal fun countUnreadConversations(manager: NotificationManager): Int {
            if (android.os.Build.VERSION.SDK_INT < 23) return 0
            return try {
                manager.activeNotifications.count { sbn ->
                    sbn.id != GROUP_SUMMARY_ID && sbn.id != PENDING_SYNC_NOTIF_ID &&
                        (android.os.Build.VERSION.SDK_INT < 26 ||
                            sbn.notification.channelId == CHANNEL_MESSAGES ||
                            sbn.notification.channelId == CHANNEL_MENTIONS)
                }
            } catch (e: Exception) {
                Log.w(TAG, "countUnreadConversations: ${e.message}")
                0
            }
        }

        /**
         * (Re)builds the grouped-messages summary, carrying the unread-conversation count as its
         * badge number so the launcher app-icon badge mirrors the real unread count (WP-XP-2).
         * Cancels the summary entirely when nothing is unread. Called after every message
         * notification post or cancel (push receipt + read-state sync) - the single source of
         * truth for both the group summary and the badge.
         */
        internal fun refreshBadgeSummary(context: Context) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val count = countUnreadConversations(manager)
            if (count == 0) {
                manager.cancel(GROUP_SUMMARY_ID)
                return
            }
            // The summary is also mandatory on Android 7+ for grouping to work: without it, the
            // per-conversation notifications are not grouped.
            val summary = NotificationCompat.Builder(context, CHANNEL_MESSAGES)
                .setSmallIcon(R.drawable.ic_notification)
                .setGroup(GROUP_KEY_MESSAGES)
                .setGroupSummary(true)
                .setAutoCancel(true)
                .setNumber(count)
                .build()
            manager.notify(GROUP_SUMMARY_ID, summary)
            Log.d(TAG, "refreshBadgeSummary: badge=$count")
        }

        /**
         * Drains the outbox mirror: encrypts the WHOLE batch against one load of mls.bin (JNI under
         * MlsStateLock), then POSTs each ciphertext and marks the send. Rewrites the mirror with the
         * remaining entries and logs the delivered ids for TS reconciliation at login. Returns the
         * number of NOT-sent entries (group not joined yet, network, etc.).
         *
         * The encrypt half is one JNI call for the whole batch on purpose: per-message it was one
         * full CBOR decode and one full re-serialise of the entire MLS keystore EACH, i.e.
         * O(N x |mls.bin|) inside the 60 s goAsync() deadline, which is what ANRed the app after a
         * store update (WP-ANR-1). iOS twin: CanariDrainOutboxBackground in canari_push.mm.
         */
        internal fun drainOutboxBackground(
            context: Context,
            service: CanariFirebaseMessagingService,
            ctx: PushContext,
        ): Int {
            val entries = readOutboxMirror(context)
            if (entries.isEmpty()) return 0
            val secret = retrievePushSecret(context)
            if (secret == null) {
                Log.w(TAG, "drainOutboxBackground: pushSecret absent -> ${entries.size} message(s) remain queued")
                return entries.size
            }
            // Only this slice is encrypted, and only it can burn a generation. `deferred` is never
            // touched by this drain.
            val batch = entries.take(DRAIN_MAX_BATCH)
            val deferred = entries.drop(DRAIN_MAX_BATCH)
            Log.d(TAG, "drainOutboxBackground: ${entries.size} message(s) queued, taking ${batch.size}")
            val ciphertexts = encryptQueuedMessages(context, service, ctx, batch)
            if (ciphertexts == null) {
                Log.w(TAG, "drainOutboxBackground: batch encrypt failed -> ${entries.size} message(s) stay queued")
                return entries.size
            }
            val deadline = System.currentTimeMillis() + DRAIN_POST_BUDGET_MS
            val sentIds = mutableListOf<String>()
            val remaining = mutableListOf<OutboxMirrorEntry>()
            var checkpointed = 0
            var index = 0
            for (entry in batch) {
                index++
                if (System.currentTimeMillis() >= deadline) {
                    // Out of budget: everything not yet attempted goes back. The next drain
                    // continues from here - partial progress is kept, never discarded.
                    remaining.add(entry)
                    continue
                }
                val ciphertext = ciphertexts[entry.id]
                if (ciphertext == null) {
                    remaining.add(entry)
                    continue
                }
                if (sendQueuedMessagePush(ctx, secret, entry.groupId, ciphertext, entry.id, entry.silent, entry.durable)) {
                    sentIds.add(entry.id)
                    Log.d(TAG, "drainOutboxBackground: ✓ sent id=${entry.id.take(8)} group=${entry.groupId.take(8)}")
                } else {
                    remaining.add(entry)
                    Log.w(TAG, "drainOutboxBackground: POST failed id=${entry.id.take(8)} -> stays queued")
                }
                // Checkpoint: a hard kill (the OS enforcing the goAsync deadline) would otherwise
                // leave every delivered message still in the mirror, and the next drain would send
                // them all again. This bounds that duplicate window to DRAIN_CHECKPOINT_EVERY.
                if (sentIds.size - checkpointed >= DRAIN_CHECKPOINT_EVERY) {
                    appendOutboxSent(context, sentIds.subList(checkpointed, sentIds.size))
                    checkpointed = sentIds.size
                    rewriteOutboxMirror(context, remaining + batch.drop(index) + deferred)
                }
            }
            if (sentIds.size > checkpointed) appendOutboxSent(context, sentIds.subList(checkpointed, sentIds.size))
            val stillQueued = remaining + deferred
            rewriteOutboxMirror(context, stillQueued)
            Log.d(TAG, "drainOutboxBackground: ${sentIds.size} sent, ${stillQueued.size} remaining")
            return stillQueued.size
        }

        /**
         * Encrypts every pending message in ONE JNI call under MlsStateLock (the JNI loads mls.bin
         * once, advances the ratchet per entry, and rewrites mls.bin once - before returning any
         * ciphertext, so a frame is never handed out while its ratchet advance is not durable).
         *
         * Returns entry id -> ciphertext (base64) for the entries that encrypted; an entry missing
         * from the map failed on its own (typically the group is not joined on this device yet) and
         * stays queued. Returns null if the whole batch failed: state absent, lock unavailable, or
         * the save failed - in which case NOTHING may be posted.
         */
        private fun encryptQueuedMessages(
            context: Context,
            service: CanariFirebaseMessagingService,
            ctx: PushContext,
            entries: List<OutboxMirrorEntry>,
        ): Map<String, String>? {
            val lockAcquired = try {
                MlsStateLock.LOCK.tryLock(10, java.util.concurrent.TimeUnit.SECONDS)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                Log.e(TAG, "encryptQueuedMessages: interrupted during tryLock: ${e.message}")
                return null
            }
            if (!lockAcquired) {
                Log.w(TAG, "encryptQueuedMessages: MlsStateLock not acquired -> abort")
                return null
            }
            try {
                val stateBytes = MlsContextLoader.loadMlsState(context)
                if (stateBytes == null) {
                    Log.e(TAG, "encryptQueuedMessages: mls.bin absent -> abort")
                    return null
                }
                val filesDir = MlsContextLoader.tauriDataDir(context).also { it.mkdirs() }.absolutePath
                val payload = JSONArray()
                for (entry in entries) {
                    payload.put(
                        JSONObject()
                            .put("id", entry.id)
                            .put("groupId", entry.groupId)
                            .put("proto", entry.proto),
                    )
                }
                val jsonStr = service.nativeSendMessagesBackground(
                    filesDir, stateBytes, ctx.deviceKeyB64, ctx.userId, ctx.deviceId, payload.toString(),
                )
                val json = JSONObject(jsonStr)
                if (!json.optBoolean("ok", false)) {
                    Log.e(TAG, "encryptQueuedMessages: ok=false (${json.optString("error").take(120)})")
                    return null
                }
                val results = json.optJSONArray("results") ?: JSONArray()
                val out = mutableMapOf<String, String>()
                for (i in 0 until results.length()) {
                    val r = results.optJSONObject(i) ?: continue
                    val id = r.optString("id")
                    if (id.isEmpty()) continue
                    if (!r.optBoolean("ok", false)) {
                        Log.d(TAG, "encryptQueuedMessages: skipped id=${id.take(8)} (${r.optString("error").take(60)}) - group not joined yet?")
                        continue
                    }
                    r.optString("ciphertext").takeIf { it.isNotEmpty() }?.let { out[id] = it }
                }
                return out
            } catch (e: Exception) {
                Log.e(TAG, "encryptQueuedMessages: exception: ${e.message}")
                return null
            } finally {
                MlsStateLock.LOCK.unlock()
            }
        }

        /** POSTs the ciphertext of a pending message to the PushSecret endpoint. Returns true if delivered. */
        private fun sendQueuedMessagePush(
            ctx: PushContext,
            secret: String,
            groupId: String,
            ciphertextB64: String,
            messageId: String,
            silent: Boolean,
            durable: Boolean,
        ): Boolean {
            return try {
                val url = URL("${ctx.baseUrl}/api/mls/push/send")
                val body = JSONObject().apply {
                    put("userId", ctx.userId)
                    put("deviceId", ctx.deviceId)
                    put("groupId", groupId)
                    put("proto", ciphertextB64)
                    put("messageId", messageId)
                    put("silent", silent)
                    put("durable", durable)
                }.toString()
                val conn = (url.openConnection() as HttpURLConnection).apply {
                    connectTimeout = 10_000
                    readTimeout    = 10_000
                    requestMethod  = "POST"
                    doOutput       = true
                    setRequestProperty("Authorization", "PushSecret $secret")
                    setRequestProperty("Content-Type", "application/json")
                }
                try {
                    conn.outputStream.use { it.write(body.toByteArray()) }
                    val code = conn.responseCode
                    Log.d(TAG, "sendQueuedMessagePush: HTTP $code group=${groupId.take(8)} msg=${messageId.take(8)}")
                    code == 200 || code == 201
                } finally {
                    conn.disconnect()
                }
            } catch (e: Exception) {
                Log.e(TAG, "sendQueuedMessagePush: exception: ${e.message}")
                false
            }
        }

        /** Reads the cleartext outbox mirror written by the TS. Returns [] if absent/unreadable. */
        internal fun readOutboxMirror(context: Context): List<OutboxMirrorEntry> {
            return try {
                val file = File(MlsContextLoader.tauriDataDir(context), OUTBOX_PENDING_FILE)
                if (!file.exists()) return emptyList()
                file.readLines().filter { it.isNotBlank() }.mapNotNull { line ->
                    try {
                        val o = JSONObject(line)
                        val id = o.optString("id")
                        val groupId = o.optString("groupId")
                        val proto = o.optString("proto")
                        if (id.isEmpty() || groupId.isEmpty() || proto.isEmpty()) null
                        // `durable` defaults to true: every entry the outbox mirrors carries
                        // conversation state, so a mirror file written before the field existed
                        // must not be read as a batch of frames nobody may ever recover.
                        else OutboxMirrorEntry(
                            id,
                            groupId,
                            proto,
                            o.optLong("sentAt", 0L),
                            o.optBoolean("silent", false),
                            o.optBoolean("durable", true),
                        )
                    } catch (e: Exception) {
                        null
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "readOutboxMirror: ${e.message}")
                emptyList()
            }
        }

        /** Rewrites the outbox mirror with the remaining entries (deletes the file if empty). */
        internal fun rewriteOutboxMirror(context: Context, remaining: List<OutboxMirrorEntry>) {
            try {
                val file = File(MlsContextLoader.tauriDataDir(context).also { it.mkdirs() }, OUTBOX_PENDING_FILE)
                if (remaining.isEmpty()) {
                    if (file.exists()) file.delete()
                    return
                }
                val body = remaining.joinToString("\n") { e ->
                    JSONObject().apply {
                        put("id", e.id)
                        put("groupId", e.groupId)
                        put("proto", e.proto)
                        put("sentAt", e.sentAt)
                        put("silent", e.silent)
                        put("durable", e.durable)
                    }.toString()
                }
                file.writeText(body + "\n")
            } catch (e: Exception) {
                Log.w(TAG, "rewriteOutboxMirror: ${e.message}")
            }
        }

        /**
         * Pushes the current FCM token to the backend via PushSecret (FCM2). Best-effort, never
         * blocking. Does NOT regenerate the pushSecret (unlike foreground /register): only the
         * token changes. Companion (not instance) so [CanariBootReceiver] can re-register the
         * token at device boot / app update without a Service instance (WP-XP-4).
         */
        internal fun refreshTokenOnBackend(ctx: PushContext, secret: String, token: String) {
            try {
                val url = URL("${ctx.baseUrl}/api/mls/push/refresh-token")
                val body = JSONObject().apply {
                    put("userId", ctx.userId)
                    put("deviceId", ctx.deviceId)
                    put("token", token)
                }.toString()
                val conn = (url.openConnection() as HttpURLConnection).apply {
                    connectTimeout = 5_000
                    readTimeout    = 5_000
                    requestMethod  = "POST"
                    doOutput       = true
                    setRequestProperty("Authorization", "PushSecret $secret")
                    setRequestProperty("Content-Type", "application/json")
                }
                try {
                    conn.outputStream.use { it.write(body.toByteArray()) }
                    Log.d(TAG, "refreshTokenOnBackend: HTTP ${conn.responseCode}")
                } finally {
                    conn.disconnect()
                }
            } catch (e: Exception) {
                Log.w(TAG, "refreshTokenOnBackend: exception: ${e.message}")
            }
        }

        /** Appends the delivered messageIds to the reconciliation log read by the TS at login. */
        private fun appendOutboxSent(context: Context, ids: List<String>) {
            try {
                val file = File(MlsContextLoader.tauriDataDir(context).also { it.mkdirs() }, OUTBOX_SENT_FILE)
                val existing = if (file.exists()) file.readText() else ""
                file.writeText(existing + ids.joinToString("\n") + "\n")
            } catch (e: Exception) {
                Log.w(TAG, "appendOutboxSent: ${e.message}")
            }
        }

        /**
         * Soft notification inviting the user to open the app to flush the outbox (safety net of
         * the background send). Stable ID + messages channel: it clears itself when the app opens
         * (cancelAllMessageNotifications in MainActivity.onResume), for this reason or another.
         *
         * THE ONLY COPY. It takes an explicit [context] rather than the Service-as-Context, so
         * workers and receivers that have no Service - [OutboxRetryWorker] calls it after a failed
         * drain retry, without waiting for the 3-attempt threshold - and the service itself both
         * reach the same body. It used to exist twice, verbatim, which is two chances to update the
         * wording and one certainty of forgetting.
         */
        internal fun showPendingSyncNotification(context: Context) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            CanariApplication.ensureChannels(context, manager)
            val res = appLocaleContext(context)
            val tapIntent = Intent(context, MainActivity::class.java).apply {
                action = Intent.ACTION_MAIN
                addCategory(Intent.CATEGORY_LAUNCHER)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            val pendingIntent = PendingIntent.getActivity(
                context, PENDING_SYNC_NOTIF_ID, tapIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val body = res.getString(R.string.notif_outbox_pending_body)
            val notif = NotificationCompat.Builder(context, CHANNEL_MESSAGES)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(res.getString(R.string.app_name))
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(pendingIntent)
                .build()
            manager.notify(PENDING_SYNC_NOTIF_ID, notif)
            Log.d(TAG, "showPendingSyncNotification: nudge shown (id=$PENDING_SYNC_NOTIF_ID)")
        }
    }

    // ─── Key-based JNI variants (always used, PIN never stored in push_context.json) ───
    // The 32-byte device key (base64) from push_context.json replaces the PIN string
    // for all background MLS decryption. The PIN is never stored on the filesystem.

    /** Decrypts an MLS message using the pre-derived device key (base64). */
    external fun nativeDecryptMessageWithKey(
        stateBytes: ByteArray,
        keyB64: String,
        userId: String,
        deviceId: String,
        groupId: String,
        ciphertext: ByteArray
    ): String

    /** Key-based variant of [nativeGroupEpoch]. */
    external fun nativeGroupEpochWithKey(
        stateBytes: ByteArray,
        keyB64: String,
        userId: String,
        deviceId: String,
        groupId: String
    ): Long

    /** Key-based variant of [nativeDecryptMessageWithCommits]. */
    external fun nativeDecryptMessageWithCommitsWithKey(
        stateBytes: ByteArray,
        keyB64: String,
        userId: String,
        deviceId: String,
        groupId: String,
        commitsJson: String,
        ciphertext: ByteArray
    ): String

    // Decrypts a community-channel push sealed under a Graine session (AES-256-GCM, not MLS).
    // `seedB64` is the session's 32-byte seed from graine_seeds.json; `sessionId` + `messageIndex`
    // name which message key to derive from it (HKDF, in Rust, the one copy shared by all three
    // platforms). Nonce and ciphertext||tag are base64. Returns the same JSON shape as
    // nativeDecryptMessage, or {"ok":false} on failure. No state file involved.
    external fun nativeDecryptGraineMessage(
        seedB64: String,
        sessionId: String,
        messageIndex: Int,
        nonceB64: String,
        ciphertextB64: String
    ): String

    // Decrypts an end-to-end-encrypted media blob (AES-256-GCM) for a notification thumbnail
    // (WP-XP-3). keyB64/ivB64 are the base64 CEK (32B) + IV (12B) from the decrypted MediaMsg;
    // `ciphertext` is the downloaded ciphertext||tag. Returns the plaintext image bytes, or an EMPTY
    // array on any failure (caller then shows the text-only notification).
    external fun nativeDecryptMedia(
        keyB64: String,
        ivB64: String,
        ciphertext: ByteArray
    ): ByteArray

    /**
     * Creates an MLS Welcome package for [keyPackageB64] in group [groupId].
     * Saves the updated MLS state to {filesDir}/mls.bin.
     * Returns JSON: {"ok":true,"welcome":"<b64>","ratchetTree":"<b64>|null","commit":"<b64>"}
     * or {"ok":false,"error":"..."}.
     */
    external fun nativeCreateWelcomeBackground(
        filesDir: String,
        stateBytes: ByteArray,
        keyB64: String,
        userId: String,
        deviceId: String,
        groupId: String,
        keyPackageB64: String,
    ): String

    /**
     * Applies a received MLS Welcome (RECEIVER side): joins the group and writes
     * {filesDir}/mls.bin. Lets a device join a new group while the app is closed, so the
     * 1st message of a conversation is decryptable by FCM without opening the app.
     * Returns true on success.
     */
    external fun nativeProcessWelcomeBackground(
        filesDir: String,
        stateBytes: ByteArray,
        keyB64: String,
        userId: String,
        deviceId: String,
        welcomeB64: String,
        ratchetTreeB64: String,
    ): Boolean

    /**
     * Encrypts a BATCH of pending outgoing messages (text/reply) against the live epoch, loading
     * {filesDir}/mls.bin once and persisting it once - see encryptQueuedMessages for why the drain
     * is a batch (WP-ANR-1).
     *
     * `entriesJson` is `[{"id":"..","groupId":"..","proto":"<b64>"}, ..]`, each `proto` being the
     * cleartext AppMessage proto built on the TS side at compose time. Returns JSON:
     * {"ok":true,"results":[{"id":..,"ok":true,"ciphertext":"<b64>"}|{"id":..,"ok":false,"error":..}]}
     * or {"ok":false,...} when the whole batch failed (state absent, save failed).
     */
    external fun nativeSendMessagesBackground(
        filesDir: String,
        stateBytes: ByteArray,
        keyB64: String,
        userId: String,
        deviceId: String,
        entriesJson: String,
    ): String

    /**
     * Builds a plaintext `AppMessage` text proto (base64) for a notification quick-reply, without
     * touching MLS state - see [CanariNotificationActionReceiver]. Returns "" on failure.
     */
    external fun nativeBuildTextMessageProto(messageId: String, sentAt: Long, content: String): String

    /**
     * Builds a plaintext `AppMessage` read-receipt (system) proto (base64) for the "mark as read"
     * quick action and for a quick reply, which means the same thing. `at` is the SENDER's
     * `sentAt` for the message the notification is about, never this device's clock: watermarks
     * merge by `max` across devices, so a fast clock would mark future messages read permanently
     * and unfixably. Returns "" only if the JVM could not allocate the string.
     */
    external fun nativeBuildReadWatermarkProto(at: Long): String

    /** Structured result of the MLS decryption, extracted from the JSON returned by Rust. */
    data class DecryptedMessage(
        val text: String,
        val messageId: String,
        val sentAt: Long,
        val type: String,                 // "text" | "reply" | "media" | "call_invite" | "call_control" | ...
        val replyTo: JSONObject?,
        val mediaKind: String?,           // "image" | "video" | "audio" | "file" | null
        // Media reference + CEK (WP-XP-3), populated only for `type == "media"`. Used to download and
        // AES-256-GCM-decrypt the blob for a notification thumbnail. Empty for non-media messages.
        val mediaId: String? = null,
        val mediaKey: String? = null,     // base64 32-byte CEK
        val mediaIv: String? = null,      // base64 12-byte GCM IV
        val mimeType: String? = null,
        // Call signaling (WP-XP-5), populated only for `type == "call_invite" | "call_control"`.
        val callId: String? = null,
        val callEnded: Boolean = false,
        val hasVideo: Boolean = false,
    )

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Log.i(TAG, "onNewToken: new FCM token received")
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putString(KEY_FCM_TOKEN, token).apply()
        try {
            val dataDir = MlsContextLoader.tauriDataDir(this).also { it.mkdirs() }
            File(dataDir, "fcm_token.txt").writeText(token)
        } catch (e: Exception) {
            Log.w(TAG, "onNewToken: unable to write fcm_token.txt: ${e.message}")
        }
        // FCM2: push the new token to the backend WITHOUT waiting for the next foreground open.
        // A token rotated while the app is killed would stay stale server-side (push to a dead
        // token) until reopen. Best-effort via PushSecret; if the context/secret is missing (device
        // not enrolled yet), the foreground will register the token at the next startup.
        runWithWakeLock("fcm_token_refresh", 15_000L) {
            val ctx = MlsContextLoader.loadPushContext(this)
            val secret = retrievePushSecret(this)
            if (ctx == null || secret == null) {
                Log.d(TAG, "onNewToken: context/secret absent -> backend refresh deferred to foreground")
                return@runWithWakeLock
            }
            refreshTokenOnBackend(ctx, secret, token)
        }
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)
        val data = remoteMessage.data
        Log.d(TAG, "onMessageReceived: type=${data["type"]} action=${data["action"]} groupId=${data["groupId"]} queuedMessageId=${data["queuedMessageId"]} hasInlineProto=${!data["proto"].isNullOrEmpty()}")

        val msgType = data["type"]

        // A REACTION RIDES ON `social` WITHOUT BEING ONE. Its wire type stays `social` on purpose:
        // minClientVersion is 0.13.0 and the store rollout has not reached devices, so an unknown
        // `type` would fall through this whole chain into the MLS decrypt ladder on every phone that
        // predates this change - noise, for a push carrying no ciphertext. The discriminator is a
        // separate field, and everything below asks THIS rather than msgType.
        // See notify-reaction in chat-delivery-service, and docs/wiki/legacy-compatibility.md.
        val isReaction = msgType == "social" && data["reaction"] == "true"

        // Ring-end (WP-XP-5), handled BEFORE the foreground guard: a stale ringing notification
        // must be cleared even when the app is foreground (the user may have opened the app by
        // hand while the ring notification was still up).
        if (msgType == "call_ring_end") {
            Log.d(TAG, "call_ring_end: call=${data["callId"]} reason=${data["reason"]}")
            cancelIncomingCallNotification(this, data["callId"] ?: "")
            return
        }

        // --- Foreground guard: a single MLS engine writes mls.bin at a time --------------
        // When the app is in the foreground, the Tauri MLS engine (WebView/Rust, in-memory state)
        // already handles everything via WebSocket and persists mls.bin. Letting the background JNI
        // path (FCM/Worker) process in parallel would clobber mls.bin: these are TWO distinct engines
        // sharing the same file with no common lock (MlsStateLock only covers FCM<->Worker).
        // Observed result: lost KeyPackages (n_secrets drops back to 1), epoch gaps, UseAfterEviction.
        // So we let the foreground handle it; the background only acts when the app is closed/backgrounded.
        // Pure notifications (social/form_reminder) do not touch mls.bin -> not concerned.
        //
        // A REACTION IS EXCLUDED FROM THAT EXEMPTION, deliberately. It touches no mls.bin either, so
        // the reason above does not cover it - but it is drawn INTO the conversation's own
        // notification, and posting one over a conversation you are reading is noise: the bubble on
        // screen already carries the reaction, delivered by the WebSocket. It is therefore suppressed
        // exactly like a message, which is what `showNotification` would do on its own anyway.
        val showsWhileForeground = msgType == "form_reminder" || (msgType == "social" && !isReaction)
        if (MainActivity.isInForeground && !showsWhileForeground) {
            Log.d(TAG, "App in foreground -> MLS handled by the foreground (WS), skip background processing")
            return
        }

        // Incoming-call ring (WP-XP-5): cleartext fan-out from POST /api/calls/ring. No MLS
        // involved - instant CallStyle ring, no Argon2/decrypt latency. Foreground already
        // returned above (WS/CallOverlay rings there).
        if (msgType == "call_ring") {
            val groupId = data["groupId"] ?: ""
            val callId = data["callId"] ?: ""
            val callerName = data["callerName"]?.takeIf { it.isNotEmpty() }
                ?: data["senderName"] ?: ""
            if (groupId.isEmpty() || callId.isEmpty()) {
                Log.e(TAG, "call_ring: missing groupId/callId -> abort")
                return
            }
            showIncomingCallNotification(
                this, groupId, callId, callerName,
                data["groupName"] ?: "", data["hasVideo"] == "true",
            )
            return
        }
        // Pending welcome request: an offline peer needs to be added to a group.
        // We handle it directly in the background (JNI + HTTP PushSecret) without opening the WebView.
        if (msgType == "welcome_request_pending") {
            val groupId       = data["groupId"] ?: ""
            val requesterUser = data["requesterUserId"] ?: ""
            val requesterDev  = data["requesterDeviceId"] ?: ""
            Log.d(TAG, "welcome_request_pending -> groupId=$groupId requester=$requesterUser:$requesterDev - full background processing")
            if (groupId.isEmpty() || requesterUser.isEmpty() || requesterDev.isEmpty()) {
                Log.e(TAG, "welcome_request_pending: missing fields -> abort")
                return
            }
            runSerializedWithWakeLock("welcome_bg", 90_000L) {
                processWelcomeRequestBackground(groupId, requesterUser, requesterDev)
            }
            return
        }

        // MLS Welcome package received: we JOIN the group in the background (JNI) so that the
        // 1st message of a conversation started while the app was closed is decryptable by FCM,
        // without waiting for the app to open. The ratchet tree is never in the FCM payload ->
        // it is fetched via fetch-proto.
        if (data["isWelcome"] == "true") {
            val groupId = data["groupId"] ?: ""
            val queuedMessageId = data["queuedMessageId"]
            val inlineProto = data["proto"]?.takeIf { it.isNotEmpty() }
            Log.d(TAG, "isWelcome=true -> groupId=$groupId qId=$queuedMessageId - background join")
            if (groupId.isEmpty()) {
                Log.e(TAG, "isWelcome: missing groupId -> abort")
                return
            }
            runSerializedWithWakeLock("welcome_join", 90_000L) {
                processReceivedWelcomeBackground(groupId, queuedMessageId, inlineProto)
            }
            return
        }

        // A reaction to one of MY messages. It arrives typed `social` for the reason given at the
        // top, and leaves through the MESSAGE path, which is where everything it needs already is.
        if (isReaction) {
            runWithWakeLock("fcm_reaction") { handleReactionNotification(data) }
            return
        }

        // Social notifications and form reminders: no MLS decryption
        if (msgType == "social" || msgType == "form_reminder") {
            val composed = composeServerNotification(data)
            val title    = composed?.first  ?: data["title"] ?: getString(R.string.app_name)
            val body     = composed?.second ?: data["body"]  ?: ""
            // explicit deepLink (message reactions) > deepLink built from postId/formId
            val postId   = data["postId"] ?: ""
            val formId   = data["formId"] ?: ""
            val deepLink = when {
                data["deepLink"]?.isNotEmpty() == true -> data["deepLink"]!!
                postId.isNotEmpty()                    -> "fr.emse.canari://post/$postId"
                formId.isNotEmpty()                    -> "fr.emse.canari://form/$formId"
                else                                   -> "fr.emse.canari://posts"
            }
            val channel = if (msgType == "form_reminder") CHANNEL_FORMS else CHANNEL_SOCIAL
            Log.d(TAG, "showSimpleNotification: type=$msgType channel=$channel title=$title deepLink=$deepLink")
            showSimpleNotification(title, body, deepLink, channel)
            return
        }

        // Community (channel) encrypted message: AES-256-GCM under a Graine message key, derived
        // from the seed mirrored in graine_seeds.json.
        // Not MLS: no mls.bin, no MlsStateLock - decryption is stateless and read-only.
        if (msgType == "channel") {
            Log.d(TAG, "type=channel → groupId=${data["channelId"]} - background channel notification")
            runWithWakeLock("fcm_channel") {
                handleChannelMessage(data)
            }
            return
        }

        // Channel read on another of my devices: clear this device's notification for that channel
        // (cross-device read-state sync, channel counterpart of the MLS silent-receipt path below).
        // The reading device is in the foreground and already returned above; only background
        // sibling devices reach here. No decryption, no state - pure notification cancellation.
        if (msgType == "channel_read") {
            val channelId = data["channelId"] ?: ""
            if (channelId.isNotEmpty()) {
                Log.d(TAG, "type=channel_read → clearing notification for channel=$channelId")
                cancelConversationNotification(this, "channel_$channelId")
            }
            return
        }

        // Background MLS sync: decrypts and updates the state without a visible notification
        if (data["action"] == "process_queue") {
            Log.d(TAG, "action=process_queue → enqueue MlsBackgroundWorker")
            val workRequest = OneTimeWorkRequestBuilder<MlsBackgroundWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(
                    BackoffPolicy.EXPONENTIAL,
                    WorkRequest.MIN_BACKOFF_MILLIS,
                    TimeUnit.MILLISECONDS
                )
                .build()
            enqueueWorkerIfHealthy(workRequest)
            if (!data.containsKey("groupId")) {
                Log.d(TAG, "process_queue without groupId -> silent sync, no notification")
                return
            }
        }

        // Encrypted MLS message: decrypted on the serialized MLS lane (max 60s per push).
        // Non-blocking for FCM: onMessageReceived returns immediately.
        val silent = data["silent"] == "true"
        runSerializedWithWakeLock("fcm_decrypt") {
            val groupId         = data["groupId"] ?: ""
            val groupName       = data["groupName"]?.takeIf { it.isNotEmpty() } ?: ""
            val senderName      = data["senderName"]?.takeIf { it.isNotEmpty() } ?: ""
            val senderId        = data["senderId"] ?: ""
            val queuedMessageId = data["queuedMessageId"]
            val inlineProto     = data["proto"]?.takeIf { it.isNotEmpty() }

            Log.d(TAG, "thread: groupId=$groupId senderName=$senderName silent=$silent inlineProto=${inlineProto != null}")

            // CROSS-DEVICE DISMISSAL, BEFORE ANY DECRYPTION.
            //
            // A silent push whose senderId is my own userId means I just read (or sent in) this
            // conversation from ANOTHER device, so this device's notification for it must go. That
            // decision needs `groupId`, `senderId` and `silent` - three CLEARTEXT data fields - and
            // nothing from the plaintext. It used to sit after the decrypt ladder, behind
            // `if (decrypted == null && silent) return`, so the dismissal was silently conditional
            // on being able to decrypt the receipt: exactly the case where the app has been killed
            // and is behind. Measured on device 2026-08-06 (NOTIF-4): the receipt arrived at
            // 23:33:31 tagged `senderName=<owner> silent=true`, the decrypt gave up 16 s later
            // with "Silent push decryption failed -> returning silently", and the notification
            // stayed on screen. Doing it here also spares those 16 s.
            //
            // The decrypt still runs afterwards - it is what advances the MLS state - it just no
            // longer gates the dismissal.
            if (silent && groupId.isNotEmpty() && senderId.isNotEmpty()) {
                val myUserId = MlsContextLoader.loadPushContext(this)?.userId
                if (senderId.equals(myUserId, ignoreCase = true)) {
                    Log.d(TAG, "FCM silent from self -> cancelling notification for group=${groupId.take(8)}")
                    cancelConversationNotification(this, groupId)
                }
            }

            var decrypted = tryDecrypt(queuedMessageId, groupId, inlineProto)
            if (decrypted == null && !queuedMessageId.isNullOrEmpty()) {
                val locality = groupLocality(groupId)
                Log.d(TAG, "tryDecrypt failed group=${groupId.take(8)} locality=$locality")
                if (locality == GroupLocality.UNKNOWN) {
                    // NOTHING WAS ESTABLISHED, SO NOTHING IS RETRIED HERE. Both recoveries below
                    // are answers to a diagnosis, and there is none: the commit catch-up costs a
                    // fetch and a state load to close an epoch gap nobody saw, and the Welcome race
                    // waits on a join that is probably not happening. The push falls through to the
                    // WorkManager fallback, which is where work with no deadline belongs.
                    Log.d(TAG, "locality unknown group=${groupId.take(8)} -> leaving it to the worker")
                } else if (locality == GroupLocality.LOCAL) {
                    // The group exists locally: the only plausible reason for a direct failure is an
                    // epoch gap (a commit arrived while the app was closed). Catch-up FIRST, before
                    // any expensive Welcome-race loop that cannot help a group that is already joined.
                    decrypted = tryDecryptWithCommitCatchup(queuedMessageId, groupId, inlineProto)
                } else {
                    // GroupLocality.ABSENT - the epoch query ran and the group is genuinely not
                    // joined here. Welcome/message race: the concurrent Welcome push may be joining
                    // the group when this message arrives. We retry briefly so the 1st message of a
                    // new conversation produces a real notification instead of a generic fallback,
                    // rather than showing then correcting the notification.
                    var raceAttempt = 0
                    while (decrypted == null && raceAttempt < WELCOME_RACE_RETRIES) {
                        raceAttempt++
                        try {
                            Thread.sleep(WELCOME_RACE_RETRY_DELAY_MS)
                        } catch (e: InterruptedException) {
                            Thread.currentThread().interrupt()
                            break
                        }
                        Log.d(TAG, "tryDecrypt retry $raceAttempt/$WELCOME_RACE_RETRIES (group-join race) group=${groupId.take(8)}")
                        decrypted = tryDecrypt(queuedMessageId, groupId, inlineProto)
                    }
                    // The group may have appeared during the race (a Welcome queued ahead of this
                    // one on the MLS lane). Last-resort catch-up before falling back to the worker.
                    if (decrypted == null && groupLocality(groupId) == GroupLocality.LOCAL) {
                        Log.d(TAG, "group appeared during welcome-race, attempting catch-up group=${groupId.take(8)}")
                        decrypted = tryDecryptWithCommitCatchup(queuedMessageId, groupId, inlineProto)
                    }
                }
            }

            // Call signaling over MLS (WP-XP-5). Invite -> ring (fallback for pre-WP-XP-5 callers
            // that did not hit POST /api/calls/ring; deduped per callId with the cleartext ring).
            // Control (answer/ICE/hangup/answered) -> never a message notification; hangup/answered
            // additionally stops an active ring.
            if (decrypted?.type == "call_invite") {
                showIncomingCallNotification(
                    this, groupId, decrypted.callId ?: "mls-$groupId",
                    senderName, groupName, decrypted.hasVideo,
                )
                return@runSerializedWithWakeLock
            }
            if (decrypted?.type == "call_control") {
                if (decrypted.callEnded) cancelIncomingCallNotification(this, decrypted.callId ?: "")
                Log.d(TAG, "call_control: suppressed (ended=${decrypted.callEnded})")
                return@runSerializedWithWakeLock
            }

            if (decrypted == null && silent) {
                // Silent push: no notification must be shown. Do not log the misleading worker/fallback
                // messages that are only meaningful for visible pushes.
                Log.d(TAG, "Silent push decryption failed group=${groupId.take(8)} -> returning silently")
                return@runSerializedWithWakeLock
            }

            // Read once and used twice below: to render the mention tokens the decrypted body
            // carries, and to decide whether one of them names ME (which chooses the channel).
            val myUserId = MlsContextLoader.loadPushContext(this)?.userId
            val body: String = decrypted?.text?.let {
                renderMentions(it, myUserId, appLocaleContext(this))
            }
                ?: run {
                    // Insufficient catch-up (no commit, below the floor, or group not joined yet):
                    // enqueue the worker to retry on the next cycle.
                    if (!queuedMessageId.isNullOrEmpty()) {
                        val workRequest = OneTimeWorkRequestBuilder<MlsBackgroundWorker>()
                            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, WorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
                            .build()
                        enqueueWorkerIfHealthy(workRequest)
                        Log.w(TAG, "Decryption failed -> MlsBackgroundWorker enqueued")
                    }
                    buildFallbackText(appLocaleContext(this), senderName)
                        .also { Log.w(TAG, "Fallback notification: $it") }
                }

            if (silent) {
                // The self-read dismissal already happened above, on the cleartext fields, whether
                // or not this frame decrypted. All that is left here is to state that a silent push
                // shows nothing.
                Log.d(TAG, "FCM silent -> MLS state updated, no notification shown")
                return@runSerializedWithWakeLock
            }

            if (decrypted != null) {
                writeFcmCache(groupId, senderId, senderName, decrypted)
            }

            val avatarBitmap = if (senderId.isNotEmpty()) fetchAvatar(senderId) else null
            val largeIcon    = avatarBitmap ?: generateInitialsBitmap(senderName)
            // Rich media thumbnail (WP-XP-3): for an image/GIF message, download + decrypt the blob and
            // attach it inline. null for text/video/audio -> plain text notification.
            val media = decrypted?.let { fetchAndDecryptMedia(it) }
            // @-mention of me (WP-XP-5): decrypted text carries inline `@[uuid]` tokens; when one
            // targets my own userId the notification is posted on the higher-tier mentions channel
            // (bypass-DND request) instead of the regular messages channel.
            val mentionsMe = myUserId != null &&
                decrypted?.text?.contains("@[$myUserId]", ignoreCase = true) == true
            val channel = if (mentionsMe) CHANNEL_MENTIONS else CHANNEL_MESSAGES
            Log.d(TAG, "showNotification: groupId=$groupId senderName=$senderName body=${body.take(60)} hasAvatar=${avatarBitmap != null} hasMedia=${media != null} mentionsMe=$mentionsMe")
            showNotification(
                senderName, groupName, body, largeIcon, groupId, media?.first, media?.second,
                channel, sentAt = decrypted?.sentAt ?: 0L,
            )

            // Woken by this incoming message: try to send our own pending outgoing messages
            // (text/reply/control), without waiting for a Welcome push or a reopen. Since the
            // foreground guard (C1) is inactive in the background, writing mls.bin is allowed.
            // No-op if the outbox is empty. Notify if any remain (safety net).
            MlsContextLoader.loadPushContext(this)?.let { drainCtx ->
                val remaining = drainOutboxBackground(this, this, drainCtx)
                maybeNotifyPendingSync(remaining)
            }
        }
    }

    // --- Helpers ---------------------------------------------------------------

    /**
     * Enqueues a [MlsBackgroundWorker] only if the persistent failure flag is not set.
     * If the flag is set, the worker will not be enqueued until the user opens the app
     * (which calls [MlsBackgroundWorker.resetFailureFlag] from [MainActivity.onResume]).
     */
    private fun enqueueWorkerIfHealthy(workRequest: androidx.work.WorkRequest) {
        val failed = getSharedPreferences(MlsBackgroundWorker.PREFS_WORKER, Context.MODE_PRIVATE)
            .getBoolean(MlsBackgroundWorker.KEY_FAILED, false)
        if (failed) {
            Log.w(TAG, "enqueueWorkerIfHealthy: worker in persistent failure state -> ignored")
            return
        }
        WorkManager.getInstance(this).enqueue(workRequest)
    }

    /**
     * Starts a new named thread holding a partial WakeLock for at most [timeoutMs] ms.
     * WakeLock tag: `"canari:<name>"`. Thread name: `"canari-<name>"` (visible in crash logs).
     *
     * ONLY FOR WORK THAT DOES NOT TOUCH mls.bin. Anything that does must go through
     * [runSerializedWithWakeLock] - see the herd it caused.
     */
    private fun runWithWakeLock(name: String, timeoutMs: Long = 60_000L, block: () -> Unit) {
        Thread(null, {
            val wl = (getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "canari:$name")
            wl.acquire(timeoutMs)
            try {
                block()
            } finally {
                if (wl.isHeld) wl.release()
            }
        }, "canari-$name").start()
    }

    /**
     * The same, but QUEUED behind every other push that touches the MLS state.
     *
     * A push used to get a thread of its own, which is fine for one push and pathological for a
     * backlog: they all reach for the single [MlsStateLock], each waits its 5 s, each that wins
     * reads the whole 1.6 MB `mls.bin`, and each that loses retries. Measured on device with a
     * backlog behind it (2026-08-11): 97 lock timeouts, 60 retries and 11 full state loads from a
     * handful of messages - roughly 485 thread-seconds spent WAITING - after which Android ended
     * the argument itself:
     *
     *     ActivityManager: Killing 22636:fr.emse.canari (adj 905):
     *       excessive cpu 10090 during 300076 dur=1263194 limit=2
     *
     * A killed process delivers no notifications and drains no outbox, so the cost of the herd is
     * not the CPU, it is the app going silent.
     *
     * Serialising is not a throttle and there is no delay in it: the work was already serial,
     * because the lock made it serial. All this removes is the contention around it - one thread
     * does the same work in the same order, and `onMessageReceived` still returns immediately.
     * The WakeLock is taken when the task STARTS rather than when it is queued, so a task waiting
     * its turn does not hold the CPU awake for the ones ahead of it.
     */
    private fun runSerializedWithWakeLock(name: String, timeoutMs: Long = 60_000L, block: () -> Unit) {
        MLS_PUSH_LANE.execute {
            val wl = (getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "canari:$name")
            wl.acquire(timeoutMs)
            try {
                block()
            } catch (e: Throwable) {
                // A task that dies must not take the lane with it: the executor would keep running,
                // but this is the only place the failure is visible at all.
                Log.e(TAG, "$name: uncaught in the MLS push lane: ${e.message}", e)
            } finally {
                if (wl.isHeld) wl.release()
            }
        }
    }

    /**
     * Promotes this device's membership to 'active' server-side via PushSecret (FCM1).
     * Called after a successful background Welcome join: without it, the device stays 'pending'
     * and the recipient resolution (status='active') excludes it from message routing.
     * Best-effort, never blocking.
     */
    private fun markMembershipActive(ctx: PushContext, secret: String, groupId: String) {
        try {
            val url = URL("${ctx.baseUrl}/api/mls/push/membership-active")
            val body = JSONObject().apply {
                put("userId", ctx.userId)
                put("deviceId", ctx.deviceId)
                put("groupId", groupId)
            }.toString()
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 5_000
                readTimeout    = 5_000
                requestMethod  = "POST"
                doOutput       = true
                setRequestProperty("Authorization", "PushSecret $secret")
                setRequestProperty("Content-Type", "application/json")
            }
            try {
                conn.outputStream.use { it.write(body.toByteArray()) }
                Log.d(TAG, "markMembershipActive: HTTP ${conn.responseCode} group=$groupId")
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.w(TAG, "markMembershipActive: exception: ${e.message}")
        }
    }

    // --- Background Welcome request processing ---------------------------------

    /**
     * Handles a `welcome_request_pending` received via FCM when the app is killed.
     * Sequence: acquire the Redis lock -> fetch the key package -> create the Welcome
     * via JNI -> send Welcome+commit to the backend -> release the lock.
     *
     * [MlsStateLock] is held ONLY during the JNI (mls.bin read + mls.bin write) so as not to
     * block the FCM decrypt threads during the HTTP calls and the Redis retries (which can sleep
     * 2s x 2 = 4s). Before this refactoring, MlsStateLock was held for the whole duration (~30s),
     * making tryDecrypt time out systematically.
     */
    private fun processWelcomeRequestBackground(
        groupId: String,
        requesterUserId: String,
        requesterDeviceId: String,
    ) {
        // File loads (read-only, outside the lock)
        val ctx = MlsContextLoader.loadPushContext(this)
        if (ctx == null) {
            Log.e(TAG, "processWelcomeRequestBackground: push_context.json absent -> abort")
            return
        }
        val secret = retrievePushSecret(this)
        if (secret == null) {
            Log.e(TAG, "processWelcomeRequestBackground: pushSecret absent -> abort")
            return
        }

        // 1. Acquire the Redis add-lock (HTTP + retries) - outside MlsStateLock
        var lockAcquired = false
        for (attempt in 0..2) {
            lockAcquired = acquireAddLock(ctx, secret, groupId)
            if (lockAcquired) break
            Log.w(TAG, "processWelcomeRequestBackground: Redis lock not acquired (attempt ${attempt + 1}/3)")
            if (attempt < 2) Thread.sleep(2_000)
        }
        if (!lockAcquired) {
            Log.w(TAG, "processWelcomeRequestBackground: unable to acquire the lock for group=$groupId -> abort")
            return
        }
        Log.d(TAG, "processWelcomeRequestBackground: Redis lock acquired for group=$groupId")

        try {
            // 2. Fetch the requester's key package (HTTP) - outside MlsStateLock
            val keyPackage = fetchKeyPackage(ctx, secret, requesterUserId, requesterDeviceId)
            if (keyPackage == null) {
                Log.e(TAG, "processWelcomeRequestBackground: keyPackage not found for $requesterUserId:$requesterDeviceId -> abort")
                return
            }
            Log.d(TAG, "processWelcomeRequestBackground: keyPackage fetched (${keyPackage.length} chars)")

            // 3. Create the Welcome via Rust JNI - MlsStateLock only here
            //    (mls.bin read + Argon2 decryption + add_member + mls.bin write ~5-8s).
            // tryLock may throw InterruptedException if the FCM thread is interrupted by Android.
            val jniLockAcquired = try {
                MlsStateLock.LOCK.tryLock(10, java.util.concurrent.TimeUnit.SECONDS)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                Log.e(TAG, "processWelcomeRequestBackground: thread interrupted during tryLock: ${e.message}")
                return
            }
            if (!jniLockAcquired) {
                Log.w(TAG, "processWelcomeRequestBackground: MlsStateLock not acquired -> abort")
                return
            }
            val result: JSONObject
            try {
                val stateBytes = MlsContextLoader.loadMlsState(this)
                if (stateBytes == null) {
                    Log.e(TAG, "processWelcomeRequestBackground: mls.bin absent -> abort")
                    return
                }
                val filesDir = MlsContextLoader.tauriDataDir(this).also { it.mkdirs() }.absolutePath
                val jsonStr = nativeCreateWelcomeBackground(
                    filesDir, stateBytes, ctx.deviceKeyB64, ctx.userId, ctx.deviceId,
                    groupId, keyPackage,
                )
                result = JSONObject(jsonStr)
            } finally {
                MlsStateLock.LOCK.unlock()
            }

            if (!result.optBoolean("ok", false)) {
                Log.e(TAG, "processWelcomeRequestBackground: nativeCreateWelcomeBackground failed: ${result.optString("error")}")
                return
            }
            val welcomePayload  = result.getString("welcome")
            val ratchetTree     = result.optString("ratchetTree").takeIf { it.isNotEmpty() && it != "null" }
            val commitPayload   = result.getString("commit")
            // Base epoch before the add: the backend validates it (validateCommit) to keep its
            // activeEpoch counter in sync with the real epoch, otherwise foreground commits are
            // wrongly rejected (C6). -1 if absent (old JNI) -> the backend skips validation.
            val baseEpoch       = result.optLong("baseEpoch", -1L)
            Log.d(TAG, "processWelcomeRequestBackground: Welcome created, commit=${commitPayload.take(16)}… baseEpoch=$baseEpoch")

            // 4. Send Welcome + commit to the backend (HTTP) - outside MlsStateLock
            val sent = sendWelcomeAndCommit(
                ctx, secret, groupId,
                requesterUserId, requesterDeviceId,
                welcomePayload, ratchetTree, commitPayload, baseEpoch,
            )
            if (sent) {
                Log.d(TAG, "processWelcomeRequestBackground: ✓ Welcome sent for group=$groupId target=$requesterUserId:$requesterDeviceId")
            } else {
                Log.e(TAG, "processWelcomeRequestBackground: sendWelcomeAndCommit failed for group=$groupId")
            }
        } finally {
            // 5. Release the Redis lock in all cases
            releaseAddLock(ctx, secret, groupId)
            Log.d(TAG, "processWelcomeRequestBackground: Redis lock released for group=$groupId")
            // 6. Opportunistic: this device may also have pending messages - try to send them
            //    now that the app is awake, and notify if any remain.
            val remaining = drainOutboxBackground(this, this, ctx)
            maybeNotifyPendingSync(remaining)
        }
    }

    /** Acquires the Redis add-lock via the PushSecret endpoint. Returns true if acquired. */
    private fun acquireAddLock(ctx: PushContext, secret: String, groupId: String): Boolean {
        return try {
            val url = URL("${ctx.baseUrl}/api/mls/push/acquire-add-lock")
            val body = JSONObject().apply {
                put("userId", ctx.userId)
                put("deviceId", ctx.deviceId)
                put("groupId", groupId)
            }.toString()
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 5_000
                readTimeout    = 5_000
                requestMethod  = "POST"
                doOutput       = true
                setRequestProperty("Authorization", "PushSecret $secret")
                setRequestProperty("Content-Type", "application/json")
            }
            try {
                conn.outputStream.use { it.write(body.toByteArray()) }
                val code = conn.responseCode
                val text = conn.inputStream.bufferedReader().use { it.readText() }
                Log.d(TAG, "acquireAddLock: HTTP $code group=$groupId")
                if (code == 201) JSONObject(text).optBoolean("acquired", false) else false
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.e(TAG, "acquireAddLock: exception: ${e.message}")
            false
        }
    }

    /** Releases the Redis add-lock via the PushSecret endpoint. */
    private fun releaseAddLock(ctx: PushContext, secret: String, groupId: String) {
        try {
            val url  = URL("${ctx.baseUrl}/api/mls/push/release-add-lock")
            val body = JSONObject().apply {
                put("userId", ctx.userId)
                put("deviceId", ctx.deviceId)
                put("groupId", groupId)
            }.toString()
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 5_000
                readTimeout    = 5_000
                requestMethod  = "DELETE"
                doOutput       = true
                setRequestProperty("Authorization", "PushSecret $secret")
                setRequestProperty("Content-Type", "application/json")
            }
            try {
                conn.outputStream.use { it.write(body.toByteArray()) }
                val code = conn.responseCode
                Log.d(TAG, "releaseAddLock: HTTP $code group=$groupId")
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.e(TAG, "releaseAddLock: exception: ${e.message}")
        }
    }

    /**
     * Fetches the MLS KeyPackage (base64) of a target device via the PushSecret endpoint.
     * Returns null on failure.
     */
    private fun fetchKeyPackage(
        ctx: PushContext,
        secret: String,
        targetUserId: String,
        targetDeviceId: String,
    ): String? {
        return try {
            val url = URL(
                "${ctx.baseUrl}/api/mls/push/key-package" +
                "?requesterId=${java.net.URLEncoder.encode(ctx.userId, "UTF-8")}" +
                "&deviceId=${java.net.URLEncoder.encode(ctx.deviceId, "UTF-8")}" +
                "&targetUserId=${java.net.URLEncoder.encode(targetUserId, "UTF-8")}" +
                "&targetDeviceId=${java.net.URLEncoder.encode(targetDeviceId, "UTF-8")}"
            )
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 5_000
                readTimeout    = 5_000
                requestMethod  = "GET"
                setRequestProperty("Authorization", "PushSecret $secret")
            }
            try {
                val code = conn.responseCode
                if (code != 200) {
                    Log.e(TAG, "fetchKeyPackage: HTTP $code target=$targetUserId:$targetDeviceId")
                    null
                } else {
                    val text = conn.inputStream.bufferedReader().use { it.readText() }
                    JSONObject(text).optString("keyPackage").takeIf { it.isNotEmpty() }
                }
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.e(TAG, "fetchKeyPackage: exception: ${e.message}")
            null
        }
    }

    /**
     * Sends the Welcome to the target device and broadcasts the commit to all group members.
     * Returns true if the HTTP call succeeded (HTTP 201).
     */
    private fun sendWelcomeAndCommit(
        ctx: PushContext,
        secret: String,
        groupId: String,
        targetUserId: String,
        targetDeviceId: String,
        welcomePayload: String,
        ratchetTree: String?,
        commitPayload: String,
        baseEpoch: Long,
    ): Boolean {
        return try {
            val url = URL("${ctx.baseUrl}/api/mls/push/send-welcome-and-commit")
            val body = JSONObject().apply {
                put("userId", ctx.userId)
                put("deviceId", ctx.deviceId)
                put("groupId", groupId)
                put("targetUserId", targetUserId)
                put("targetDeviceId", targetDeviceId)
                put("welcomePayload", welcomePayload)
                put("ratchetTreePayload", if (ratchetTree != null) ratchetTree else JSONObject.NULL)
                put("commitPayload", commitPayload)
                if (baseEpoch >= 0) put("baseEpoch", baseEpoch)
            }.toString()
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 10_000
                readTimeout    = 10_000
                requestMethod  = "POST"
                doOutput       = true
                setRequestProperty("Authorization", "PushSecret $secret")
                setRequestProperty("Content-Type", "application/json")
            }
            try {
                conn.outputStream.use { it.write(body.toByteArray()) }
                val code = conn.responseCode
                Log.d(TAG, "sendWelcomeAndCommit: HTTP $code group=$groupId target=$targetUserId:$targetDeviceId")
                code == 201
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.e(TAG, "sendWelcomeAndCommit: exception: ${e.message}")
            false
        }
    }

    // --- MLS decryption --------------------------------------------------------

    /**
     * Attempts to decrypt an MLS message in exclusive mode (MLS_LOCK).
     * The lock is acquired ONLY for mls.bin access and the JNI Argon2 - never
     * during the HTTP calls (fetchProtoFromBackend), so as not to block the other
     * FCM threads for the 5-11s a slow network fetch can take.
     */
    /**
     * Has the foreground MLS engine taken over since this push was accepted for processing?
     *
     * THE GUARD IN `onMessageReceived` IS EVALUATED ONCE, AND THE WORK IT GUARDS RUNS FOR MINUTES.
     * That is the whole defect. Five pushes land in the same second when the radios come back; they
     * are processed one at a time behind [MlsStateLock], and each costs an Argon2 round trip - on a
     * Mi 9T, roughly thirty seconds each. The user opens the app somewhere inside that queue, the
     * WebView engine reconnects its WebSocket and drains the same frames, and every remaining push
     * in the backlog then decrypts against a ratchet the foreground has already advanced.
     *
     * MEASURED, NOT REASONED (NOTIF-10, 2026-09-07 02:09-02:10). All five pushes arrive at
     * 02:09:28. At 02:10:07 the service logs `showNotification: app in foreground -> notification
     * suppressed`, so the foreground had arrived - and the very next push still went into the JNI
     * and came back `SecretReuseError` at 02:10:13. The guard had said yes forty seconds earlier.
     *
     * SO IT IS RE-ASKED HERE, WHICH IS WHERE THE DECISION ACTUALLY IS: under the lock, immediately
     * before the state is read and rewritten, and after every wait that could have let the world
     * change (the proto fetch is up to 11 s, the lock up to 5 s). Two engines with no shared lock
     * writing one `mls.bin` is what the guard exists to prevent, and its own comment lists the
     * price: lost KeyPackages, epoch gaps, `UseAfterEviction`.
     *
     * RETURNING null IS NOT A LOSS. The foreground engine has the frame - that is the premise of
     * this check - and the WorkManager fallback is where work with no deadline belongs.
     */
    private fun foregroundTookOver(where: String): Boolean {
        if (!MainActivity.isInForeground) return false
        Log.d(TAG, "$where: foreground took over while this push waited -> yielding the MLS state to it")
        return true
    }

    private fun tryDecrypt(
        queuedMessageId: String?,
        groupId: String,
        inlineProto: String?,
    ): DecryptedMessage? {
        if (queuedMessageId == null) {
            Log.w(TAG, "tryDecrypt: queuedMessageId absent -> abort")
            return null
        }

        // Load the push context (file read) before the lock - read-only, thread-safe.
        val ctx = MlsContextLoader.loadPushContext(this)
        if (ctx == null) {
            Log.e(TAG, "tryDecrypt: push_context.json absent or invalid -> abort")
            return null
        }

        // Fetch the proto BEFORE acquiring MlsStateLock: fetchProtoFromBackend can take
        // up to ~11s (2 attempts x 5s timeout + 1s sleep). Holding the lock during that
        // time would block tryDecrypt on the other threads for the whole duration.
        val protoB64: String = inlineProto
            ?: fetchProtoFromBackend(queuedMessageId, ctx)
                .also { if (it == null) Log.e(TAG, "tryDecrypt: fetchProtoFromBackend failed") }
            ?: return null

        // Acquire the lock only for mls.bin + Argon2/JNI (~3-5s max).
        // tryLock may throw InterruptedException if the thread is interrupted by Android
        // under memory pressure. We restore the interrupt flag so as not to swallow it.
        val lockAcquired = try {
            MlsStateLock.LOCK.tryLock(5, java.util.concurrent.TimeUnit.SECONDS)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            Log.e(TAG, "tryDecrypt: thread interrupted during tryLock MlsStateLock: ${e.message}")
            return null
        }
        if (!lockAcquired) {
            Log.w(TAG, "tryDecrypt: MlsStateLock not acquired after 5s -> abort (another thread is decrypting)")
            return null
        }
        try {
            if (foregroundTookOver("tryDecrypt")) return null
            val stateBytes = MlsContextLoader.loadMlsState(this)
            if (stateBytes == null) {
                Log.e(TAG, "tryDecrypt: mls.bin absent -> abort")
                return null
            }
            Log.d(TAG, "tryDecrypt: MLS state loaded (${stateBytes.size} bytes), userId=${ctx.userId} deviceId=${ctx.deviceId}")
            return decryptProto(
                stateBytes, ctx.userId, ctx.deviceId, groupId, protoB64,
                deviceKeyB64 = ctx.deviceKeyB64,
            )
        } finally {
            MlsStateLock.LOCK.unlock()
        }
    }

    private fun fetchProtoFromBackend(queuedMessageId: String, ctx: PushContext): String? {
        val secret = retrievePushSecret(this)
        if (secret == null) {
            Log.e(TAG, "fetchProtoFromBackend: pushSecret absent")
            return null
        }
        var lastException: Exception? = null
        repeat(2) { attempt ->
            try {
                val result = doFetchProto(queuedMessageId, ctx, secret)
                if (result != null) return result
            } catch (e: Exception) {
                lastException = e
                if (attempt == 0) Thread.sleep(1_000)
            }
        }
        Log.e(TAG, "fetchProtoFromBackend: failed after 2 attempts: ${lastException?.message}")
        return null
    }

    private fun doFetchProto(queuedMessageId: String, ctx: PushContext, secret: String): String? {
        val url = URL(
            "${ctx.baseUrl}/api/mls/push/fetch-proto" +
                "?messageId=${java.net.URLEncoder.encode(queuedMessageId, "UTF-8")}" +
                "&userId=${java.net.URLEncoder.encode(ctx.userId, "UTF-8")}" +
                "&deviceId=${java.net.URLEncoder.encode(ctx.deviceId, "UTF-8")}"
        )
        Log.d(TAG, "doFetchProto: GET $url")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            connectTimeout = 5_000
            readTimeout    = 5_000
            requestMethod  = "GET"
            setRequestProperty("Authorization", "PushSecret $secret")
        }
        try {
            val code = conn.responseCode
            if (code != 200) {
                Log.e(TAG, "doFetchProto: HTTP $code")
                return null
            }
            val text = conn.inputStream.bufferedReader().use { it.readText() }
            val proto = JSONObject(text).optString("proto").takeIf { it.isNotEmpty() }
            Log.d(TAG, "doFetchProto: proto received=${proto != null} (${proto?.length ?: 0} chars)")
            return proto
        } finally {
            conn.disconnect()
        }
    }

    // --- Background processing of a received Welcome (receiver side) -----------

    /**
     * Joins a group via a Welcome received in the background, then enqueues the worker to
     * drain any already-queued messages. MlsStateLock is held only during the JNI
     * (mls.bin read + Argon2 + mls.bin write), never during the HTTP calls.
     */
    private fun processReceivedWelcomeBackground(
        groupId: String,
        queuedMessageId: String?,
        inlineProto: String?,
    ) {
        val ctx = MlsContextLoader.loadPushContext(this)
        if (ctx == null) {
            Log.e(TAG, "processReceivedWelcomeBackground: push_context.json absent -> abort")
            return
        }

        // Welcome + ratchet tree: the ratchet tree is never included in the FCM push,
        // so we always fetch it via fetch-proto (which also returns the proto).
        var welcomeB64 = inlineProto
        var ratchetTreeB64 = ""
        if (queuedMessageId != null) {
            val secret = retrievePushSecret(this)
            if (secret != null) {
                val bundle = fetchWelcomeBundle(queuedMessageId, ctx, secret)
                if (bundle != null) {
                    if (welcomeB64.isNullOrEmpty()) welcomeB64 = bundle.first
                    ratchetTreeB64 = bundle.second
                }
            }
        }
        if (welcomeB64.isNullOrEmpty()) {
            Log.e(TAG, "processReceivedWelcomeBackground: Welcome bytes not found -> abort")
            return
        }

        val jniLockAcquired = try {
            MlsStateLock.LOCK.tryLock(10, java.util.concurrent.TimeUnit.SECONDS)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            Log.e(TAG, "processReceivedWelcomeBackground: interrupted during tryLock: ${e.message}")
            return
        }
        if (!jniLockAcquired) {
            Log.w(TAG, "processReceivedWelcomeBackground: MlsStateLock not acquired -> abort")
            return
        }
        val joined: Boolean
        try {
            val stateBytes = MlsContextLoader.loadMlsState(this)
            if (stateBytes == null) {
                Log.e(TAG, "processReceivedWelcomeBackground: mls.bin absent -> abort")
                return
            }
            val filesDir = MlsContextLoader.tauriDataDir(this).also { it.mkdirs() }.absolutePath
            joined = nativeProcessWelcomeBackground(
                filesDir, stateBytes, ctx.deviceKeyB64, ctx.userId, ctx.deviceId, welcomeB64!!, ratchetTreeB64,
            )
        } finally {
            MlsStateLock.LOCK.unlock()
        }

        if (joined) {
            Log.d(TAG, "processReceivedWelcomeBackground: ✓ group joined group=$groupId")
            // FCM1: promote the membership to 'active' server-side. The JNI join does not go through
            // the foreground path (updateInvitationStatus), so without this call the device stays
            // 'pending' and is never routed as a recipient of subsequent messages (neither real-time
            // nor push). PushSecret because the app may be killed (no JWT). Best-effort.
            retrievePushSecret(this)?.let { markMembershipActive(ctx, it, groupId) }
            // The group now exists: drain the queue to process the pending messages.
            val workRequest = OneTimeWorkRequestBuilder<MlsBackgroundWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, WorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
                .build()
            enqueueWorkerIfHealthy(workRequest)
        } else {
            Log.e(TAG, "processReceivedWelcomeBackground: join failed group=$groupId")
        }

        // The group may have just been joined: try to send the pending outgoing messages,
        // and notify the user if any remain (safety net of the background send).
        val remaining = drainOutboxBackground(this, this, ctx)
        maybeNotifyPendingSync(remaining)
    }

    /** Fetches the (proto, ratchetTree) pair of a queued Welcome via the PushSecret endpoint. */
    private fun fetchWelcomeBundle(
        queuedMessageId: String,
        ctx: PushContext,
        secret: String,
    ): Pair<String, String>? {
        return try {
            val url = URL(
                "${ctx.baseUrl}/api/mls/push/fetch-proto" +
                    "?messageId=${java.net.URLEncoder.encode(queuedMessageId, "UTF-8")}" +
                    "&userId=${java.net.URLEncoder.encode(ctx.userId, "UTF-8")}" +
                    "&deviceId=${java.net.URLEncoder.encode(ctx.deviceId, "UTF-8")}"
            )
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 5_000
                readTimeout    = 5_000
                requestMethod  = "GET"
                setRequestProperty("Authorization", "PushSecret $secret")
            }
            try {
                val code = conn.responseCode
                if (code != 200) {
                    Log.e(TAG, "fetchWelcomeBundle: HTTP $code")
                    null
                } else {
                    val text = conn.inputStream.bufferedReader().use { it.readText() }
                    val json = JSONObject(text)
                    Pair(json.optString("proto"), json.optString("ratchetTree"))
                }
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.e(TAG, "fetchWelcomeBundle: exception: ${e.message}")
            null
        }
    }

    // --- Background outbox send (outgoing messages, app killed) ----------------
    //
    // Relocated to top-level `internal` functions below the class (see OutboxMirrorEntry /
    // drainOutboxBackground / readOutboxMirror / etc. near the end of this file): they take an
    // explicit `context: Context` instead of the implicit Service-as-Context, so
    // CanariNotificationActionReceiver (quick reply / mark as read) can reuse them without
    // duplicating the outbox-drain logic.

    /** Shows the "messages pending" nudge if sends remain queued and the app is closed. */
    private fun maybeNotifyPendingSync(remaining: Int) {
        if (remaining <= 0) return
        if (MainActivity.isInForeground) return
        showPendingSyncNotification(this)
        // WP-XP-8: schedule automatic background retry via WorkManager
        OutboxRetryWorker.enqueueIfHealthy(this)
    }

    /** Parses the JSON returned by nativeDecryptMessageWithKey and returns a structured DecryptedMessage. */
    private fun decryptProto(
        stateBytes: ByteArray,
        userId: String,
        deviceId: String,
        groupId: String,
        protoB64: String,
        deviceKeyB64: String? = null,
    ): DecryptedMessage? {
        return try {
            val cipherBytes = Base64.decode(protoB64, Base64.DEFAULT)
            val keyB64 = deviceKeyB64?.takeIf { it.isNotEmpty() } ?: return null
            val jsonStr = nativeDecryptMessageWithKey(stateBytes, keyB64, userId, deviceId, groupId, cipherBytes)
            val json = JSONObject(jsonStr)
            if (!json.optBoolean("ok", false)) {
                Log.w(TAG, "decryptProto: ok=false -> decryption failed")
                return null
            }
            val type = json.optString("type", "text")
            // Call signaling (WP-XP-5) legitimately has an empty text ("call_control"); every
            // other type without text is unrenderable -> null (generic fallback path).
            val isCall = type == "call_invite" || type == "call_control"
            val text = json.optString("text").takeIf { it.isNotEmpty() || isCall } ?: return null
            Log.d(TAG, "decryptProto: success type=$type -> \"${text.take(60)}\"")
            DecryptedMessage(
                text      = text.take(200),
                messageId = json.optString("messageId"),
                sentAt    = json.optLong("sentAt", System.currentTimeMillis()),
                type      = type,
                replyTo   = json.optJSONObject("replyTo"),
                mediaKind = json.optString("mediaKind").takeIf { it.isNotEmpty() },
                mediaId   = json.optString("mediaId").takeIf { it.isNotEmpty() },
                mediaKey  = json.optString("mediaKey").takeIf { it.isNotEmpty() },
                mediaIv   = json.optString("mediaIv").takeIf { it.isNotEmpty() },
                mimeType  = json.optString("mimeType").takeIf { it.isNotEmpty() },
                callId    = json.optString("callId").takeIf { it.isNotEmpty() },
                callEnded = json.optBoolean("callEnded", false),
                hasVideo  = json.optBoolean("hasVideo", false),
            )
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "decryptProto: native library not loaded: ${e.message}")
            null
        } catch (e: Exception) {
            Log.e(TAG, "decryptProto: exception: ${e.message}")
            null
        }
    }

    /**
     * Read-only in-memory commit catch-up for a push whose epoch is AHEAD of the persisted mls.bin.
     *
     * A device added to the group advanced the epoch via a commit; a never-opened mobile only ran the
     * read-only [decryptProto] (which discards commits), so it stays behind and the newcomer's first
     * message fails as an epoch gap. Here we read the current epoch, fetch the missing ordered commits
     * (PushSecret), and apply them in memory to decrypt this message - producing a real notification
     * instead of a generic fallback. NEVER persists mls.bin; the foreground commit-log replay catches
     * the durable state up on next open. Returns null (caller falls back) when no commits are
     * available or the message still cannot be decrypted.
     */
    private fun tryDecryptWithCommitCatchup(
        queuedMessageId: String?,
        groupId: String,
        inlineProto: String?,
    ): DecryptedMessage? {
        if (queuedMessageId.isNullOrEmpty() || groupId.isEmpty()) return null
        val ctx = MlsContextLoader.loadPushContext(this) ?: return null
        val secret = retrievePushSecret(this) ?: return null

        // Fetch the ciphertext (outside the lock, as tryDecrypt does).
        val protoB64: String = inlineProto ?: fetchProtoFromBackend(queuedMessageId, ctx) ?: return null
        val cipherBytes = try {
            Base64.decode(protoB64, Base64.DEFAULT)
        } catch (e: Exception) {
            Log.e(TAG, "catchup: proto base64 invalid: ${e.message}"); return null
        }

        // 1) Read the current epoch (brief lock: mls.bin + Argon2 via JNI).
        val epoch = withMlsStateLock(5) {
            val stateBytes = MlsContextLoader.loadMlsState(this) ?: return@withMlsStateLock -1L
            if (ctx.deviceKeyB64.isNotEmpty()) {
                nativeGroupEpochWithKey(stateBytes, ctx.deviceKeyB64, ctx.userId, ctx.deviceId, groupId)
            } else {
                return@withMlsStateLock -1L
            }
        } ?: return null
        if (epoch < 0) {
            Log.w(TAG, "catchup: epoch unknown for group=$groupId -> abort")
            return null
        }

        // 2) Fetch the ordered commits since our epoch (outside the lock: HTTP).
        val commitsJson = fetchCommitsFromBackend(groupId, epoch, ctx, secret)
        if (commitsJson == null || commitsJson == "[]") {
            Log.d(TAG, "catchup: no commit to catch up (epoch=$epoch) -> fallback")
            return null
        }

        // 3) Apply the commits in memory and decrypt (brief lock: mls.bin + Argon2 via JNI).
        //
        // RE-ASKED HERE FOR THE REASON `foregroundTookOver` GIVES, and this path waits longer than
        // the plain one before it gets here: an epoch read under the lock, then an HTTP fetch of
        // every commit since. It is also the path that APPLIES commits, so it moves the state
        // furthest - which makes it the worst one to run beside a live foreground engine.
        return withMlsStateLock(5) {
            if (foregroundTookOver("catchup")) return@withMlsStateLock null
            val stateBytes = MlsContextLoader.loadMlsState(this) ?: return@withMlsStateLock null
            decryptProtoWithCommits(
                stateBytes, ctx.userId, ctx.deviceId, groupId, commitsJson, cipherBytes,
                deviceKeyB64 = ctx.deviceKeyB64,
            )
        }
    }

    /** Runs [block] holding [MlsStateLock] for up to [timeoutSec]s; returns null if not acquired. */
    private fun <T> withMlsStateLock(timeoutSec: Long, block: () -> T): T? {
        val acquired = try {
            MlsStateLock.LOCK.tryLock(timeoutSec, java.util.concurrent.TimeUnit.SECONDS)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            Log.e(TAG, "withMlsStateLock: interrupted: ${e.message}")
            return null
        }
        if (!acquired) {
            Log.w(TAG, "withMlsStateLock: lock not acquired after ${timeoutSec}s")
            return null
        }
        return try {
            block()
        } finally {
            MlsStateLock.LOCK.unlock()
        }
    }

    /**
     * Whether [groupId] is joined in the local MLS state - or whether that could not be established.
     *
     * [UNKNOWN] IS NOT [ABSENT], AND COLLAPSING THEM SENT EVERY RECOVERY DOWN THE WRONG BRANCH.
     * This returned a plain Boolean, and every way of failing to reach the state - lock not
     * acquired, `mls.bin` unreadable, device key missing, JNI not loaded - came back as `false`,
     * which the caller reads as "the group is not joined here". So a device that had been in a
     * conversation for months answered "not mine" whenever another thread happened to hold the
     * lock, and the message was handed to the Welcome-race retry loop: three more attempts, each
     * re-entering the same contended lock, for a group that was never racing a Welcome at all.
     * Measured on device 2026-08-11: twenty `local=false` verdicts from ten epoch queries - half
     * the answers were given by a timeout, about the main DM.
     */
    private enum class GroupLocality { LOCAL, ABSENT, UNKNOWN }

    /**
     * Loads push_context + mls.bin, acquires MlsStateLock for up to 5 s and asks
     * nativeGroupEpochWithKey; an epoch >= 0 means the group is joined locally. Every path that did
     * not get as far as an epoch answers [GroupLocality.UNKNOWN].
     */
    private fun groupLocality(groupId: String): GroupLocality {
        if (groupId.isEmpty()) return GroupLocality.ABSENT
        val ctx = MlsContextLoader.loadPushContext(this)
        if (ctx == null) {
            Log.w(TAG, "groupLocality: push context absent group=${groupId.take(8)} -> UNKNOWN")
            return GroupLocality.UNKNOWN
        }
        val locality = withMlsStateLock(5) {
            val stateBytes = MlsContextLoader.loadMlsState(this)
            if (stateBytes == null) {
                Log.w(TAG, "groupLocality: mls.bin unreadable group=${groupId.take(8)} -> UNKNOWN")
                return@withMlsStateLock GroupLocality.UNKNOWN
            }
            if (ctx.deviceKeyB64.isEmpty()) {
                Log.w(TAG, "groupLocality: device key absent group=${groupId.take(8)} -> UNKNOWN")
                return@withMlsStateLock GroupLocality.UNKNOWN
            }
            try {
                val epoch = nativeGroupEpochWithKey(stateBytes, ctx.deviceKeyB64, ctx.userId, ctx.deviceId, groupId)
                Log.d(TAG, "groupLocality: epoch=$epoch group=${groupId.take(8)}")
                if (epoch >= 0) GroupLocality.LOCAL else GroupLocality.ABSENT
            } catch (e: UnsatisfiedLinkError) {
                Log.e(TAG, "groupLocality: native library not loaded: ${e.message}")
                GroupLocality.UNKNOWN
            } catch (e: Exception) {
                Log.e(TAG, "groupLocality: exception: ${e.message}")
                GroupLocality.UNKNOWN
            }
        }
        // `withMlsStateLock` returns null on a timeout, and that is the case this whole enum exists
        // for: it says nothing about the group, only about the lock.
        if (locality == null) {
            Log.w(TAG, "groupLocality: MlsStateLock not acquired group=${groupId.take(8)} -> UNKNOWN")
            return GroupLocality.UNKNOWN
        }
        return locality
    }

    /** Parses the JSON from nativeDecryptMessageWithCommitsWithKey into a DecryptedMessage (mirror of decryptProto). */
    private fun decryptProtoWithCommits(
        stateBytes: ByteArray,
        userId: String,
        deviceId: String,
        groupId: String,
        commitsJson: String,
        cipherBytes: ByteArray,
        deviceKeyB64: String? = null,
    ): DecryptedMessage? {
        return try {
            val keyB64 = deviceKeyB64?.takeIf { it.isNotEmpty() } ?: return null
            val jsonStr = nativeDecryptMessageWithCommitsWithKey(stateBytes, keyB64, userId, deviceId, groupId, commitsJson, cipherBytes)
            val json = JSONObject(jsonStr)
            if (!json.optBoolean("ok", false)) {
                Log.w(TAG, "decryptProtoWithCommits: ok=false -> catch-up insufficient")
                return null
            }
            val text = json.optString("text").takeIf { it.isNotEmpty() } ?: return null
            Log.d(TAG, "decryptProtoWithCommits: success after catch-up -> \"${text.take(60)}\"")
            DecryptedMessage(
                text      = text.take(200),
                messageId = json.optString("messageId"),
                sentAt    = json.optLong("sentAt", System.currentTimeMillis()),
                type      = json.optString("type", "text"),
                replyTo   = json.optJSONObject("replyTo"),
                mediaKind = json.optString("mediaKind").takeIf { it.isNotEmpty() },
                mediaId   = json.optString("mediaId").takeIf { it.isNotEmpty() },
                mediaKey  = json.optString("mediaKey").takeIf { it.isNotEmpty() },
                mediaIv   = json.optString("mediaIv").takeIf { it.isNotEmpty() },
                mimeType  = json.optString("mimeType").takeIf { it.isNotEmpty() },
            )
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "decryptProtoWithCommits: native library not loaded: ${e.message}"); null
        } catch (e: Exception) {
            Log.e(TAG, "decryptProtoWithCommits: exception: ${e.message}"); null
        }
    }

    /**
     * Fetches the ordered replayable commits for [groupId] with baseEpoch >= [sinceEpoch] via the
     * PushSecret endpoint, and returns them as a JSON array of base64 commit strings
     * (`["b64",...]`, the shape nativeDecryptMessageWithCommits expects), or null on failure.
     */
    private fun fetchCommitsFromBackend(
        groupId: String,
        sinceEpoch: Long,
        ctx: PushContext,
        secret: String,
    ): String? {
        return try {
            val url = URL("${ctx.baseUrl}/api/mls/push/commits")
            val payload = JSONObject().apply {
                put("userId", ctx.userId)
                put("deviceId", ctx.deviceId)
                put("groupId", groupId)
                put("sinceEpoch", sinceEpoch)
            }.toString()
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 5_000
                readTimeout    = 5_000
                requestMethod  = "POST"
                doOutput       = true
                setRequestProperty("Authorization", "PushSecret $secret")
                setRequestProperty("Content-Type", "application/json")
            }
            try {
                conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
                val code = conn.responseCode
                if (code != 200 && code != 201) {
                    Log.e(TAG, "fetchCommitsFromBackend: HTTP $code")
                    return null
                }
                val text = conn.inputStream.bufferedReader().use { it.readText() }
                val commits = JSONObject(text).optJSONArray("commits") ?: return "[]"
                // Keep only the ordered base64 commit protos - the shape the native catch-up expects.
                val protos = JSONArray()
                for (i in 0 until commits.length()) {
                    val proto = commits.optJSONObject(i)?.optString("proto")
                    if (!proto.isNullOrEmpty()) protos.put(proto)
                }
                Log.d(TAG, "fetchCommitsFromBackend: ${protos.length()} commit(s) since epoch=$sinceEpoch")
                protos.toString()
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.w(TAG, "fetchCommitsFromBackend: exception: ${e.message}")
            null
        }
    }

    /**
     * Writes an entry to fcm_message_cache.ndjson so the app can
     * pre-inject the message into IndexedDB at boot (before the MLS sync).
     * The file is bounded to [MAX_FCM_CACHE_ENTRIES] lines to avoid unbounded
     * growth when the app stays closed for a long time and receives many notifications.
     */
    private fun writeFcmCache(
        groupId: String,
        senderId: String,
        senderName: String,
        msg: DecryptedMessage,
    ) {
        if (msg.messageId.isEmpty()) {
            Log.w(TAG, "writeFcmCache: messageId empty -> entry ignored")
            return
        }
        val entry = JSONObject().apply {
            put("groupId",    groupId)
            put("messageId",  msg.messageId)
            put("senderId",   senderId)
            put("senderName", senderName)
            put("content",    msg.text)
            put("timestamp",  msg.sentAt)
            put("type",       msg.type)
            msg.replyTo?.let { put("replyTo", it) }
            msg.mediaKind?.let { put("mediaKind", it) }
        }
        appendFcmCacheEntry(this, entry, msg.messageId, groupId)
    }

    // --- Avatar ----------------------------------------------------------------

    /** Cache file for a userId's avatar (filesystem-safe name). */
    private fun avatarCacheFile(userId: String): File {
        val safeId = userId.replace(Regex("[^a-zA-Z0-9_-]"), "_").take(40)
        return File(filesDir, "avatar_$safeId.jpg")
    }

    /**
     * Edge length Android draws a notification large icon at, on THIS screen's density.
     *
     * Read from the platform instead of guessed: `notification_large_icon_width` is the dimension
     * the framework itself scales a large icon down to, so it is the smallest decode that costs
     * nothing visible - and it is the fact that spares us decoding an avatar at its upload
     * resolution only to discover how big it was. The initials disc keeps its own 96 px, which
     * `initialsFallback.test.ts` pins against the two Apple copies; this is the avatar branch.
     */
    private val notificationIconSizePx: Int by lazy {
        resources.getDimensionPixelSize(android.R.dimen.notification_large_icon_width)
    }

    /**
     * Decodes an avatar no larger than the icon it becomes.
     *
     * THE RESOLUTION ON THE WIRE IS NOT OURS TO BOUND. The bytes come from MiGallery, through
     * core-service, through `/api/mls/push/avatar` - and no hop in that chain carries a size
     * parameter, so what arrives is whatever its owner uploaded. Decoding it whole allocated
     * width*height*4 bytes here and again in [circleCrop], inside the FCM service process, where
     * running out of memory does not soften the icon: it loses the NOTIFICATION.
     *
     * Two passes. `inJustDecodeBounds` reads the header only and allocates no pixels; then
     * `inSampleSize` - which the decoder honours in powers of two ONLY - takes the decode down to
     * the smallest power of two still at or above [target]. [circleCrop] covers the remaining
     * factor of under two, so the sampling never has to land exactly.
     *
     * @param target Edge length in pixels the icon is drawn at.
     * @param decode Runs ONE decode pass under the given options. The same lambda serves a file
     *   and a byte array, which is why neither call site carries a copy of this.
     */
    private fun decodeSampled(target: Int, decode: (BitmapFactory.Options) -> Bitmap?): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        decode(bounds)
        val shortest = minOf(bounds.outWidth, bounds.outHeight)
        if (shortest <= 0) {
            // The decoder reports -1 on bytes it cannot read at all. Saying so is the point: the
            // caller only sees a null, which is indistinguishable from "this user has no avatar".
            Log.w(TAG, "decodeSampled: unreadable image header (${bounds.outWidth}x${bounds.outHeight})")
            return null
        }
        var sample = 1
        while (shortest / (sample * 2) >= target) sample *= 2
        Log.d(TAG, "decodeSampled: ${bounds.outWidth}x${bounds.outHeight} -> inSampleSize=$sample, target=$target")
        return decode(BitmapFactory.Options().apply { inSampleSize = sample })
    }

    /**
     * Downloads the sender's avatar, with a 24h file cache.
     * The cache avoids the HTTP request when the app is in the background and
     * the network is slow or PushSecretKeystore.retrieve() is unstable.
     */
    private fun fetchAvatar(userId: String): Bitmap? {
        val target = notificationIconSizePx
        // 1. Read the file cache if recent (< 24h) - no need for the Keystore or the network
        val cacheFile = avatarCacheFile(userId)
        val now = System.currentTimeMillis()
        if (cacheFile.exists() && (now - cacheFile.lastModified()) < AVATAR_CACHE_MAX_AGE_MS) {
            decodeSampled(target) { BitmapFactory.decodeFile(cacheFile.absolutePath, it) }?.let { bmp ->
                Log.d(TAG, "fetchAvatar: from cache for ${userId.take(8)}")
                return circleCrop(bmp, target)
            }
        }

        // 2. HTTP fetch (app in foreground or cache expired)
        val ctx    = MlsContextLoader.loadPushContext(this) ?: return null
        val secret = retrievePushSecret(this) ?: return null
        return try {
            val url = URL(
                "${ctx.baseUrl}/api/mls/push/avatar/${java.net.URLEncoder.encode(userId, "UTF-8")}" +
                "?requesterId=${java.net.URLEncoder.encode(ctx.userId, "UTF-8")}" +
                "&deviceId=${java.net.URLEncoder.encode(ctx.deviceId, "UTF-8")}"
            )
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 5_000
                readTimeout    = 5_000
                requestMethod  = "GET"
                setRequestProperty("Authorization", "PushSecret $secret")
                instanceFollowRedirects = true
            }
            try {
                val code = conn.responseCode
                if (code == 200) {
                    val bytes = conn.inputStream.readBytes()
                    // Save to cache for the next notifications
                    try {
                        cacheFile.writeBytes(bytes)
                        Log.d(TAG, "fetchAvatar: avatar cached for ${userId.take(8)}")
                    } catch (e: Exception) {
                        Log.w(TAG, "fetchAvatar: unable to save the cache: ${e.message}")
                    }
                    decodeSampled(target) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size, it) }
                        ?.let { circleCrop(it, target) }
                } else {
                    // 401/403 is NOT "this user has no avatar": it is our push secret being
                    // rejected, and the same credential guards the media proxy and the
                    // ciphertext fetch that a message falls back to - so a silent 403 here is
                    // the visible tip of something that costs a MESSAGE elsewhere. It used to be
                    // logged at debug level alongside the ordinary misses, which is how it went
                    // unnoticed until a user remarked the picture was missing (WP-DIRECTBOOT-1).
                    if (code == 401 || code == 403) {
                        Log.e(TAG, "fetchAvatar: HTTP $code - push secret REJECTED, background auth is broken in this process")
                    } else {
                        Log.d(TAG, "fetchAvatar: HTTP $code for $userId -> initials fallback")
                    }
                    null
                }
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.d(TAG, "fetchAvatar: ${e.message} -> initials fallback")
            null
        }
    }

    /**
     * Downloads and decrypts an image/GIF message blob for a rich notification thumbnail (WP-XP-3).
     *
     * The media service only stores opaque AES-256-GCM ciphertext; the CEK/IV live in the
     * MLS-decrypted [DecryptedMessage] (never on the server). We fetch the ciphertext by mediaId via
     * the PushSecret-authed proxy (the app may be killed -> no user JWT), decrypt it natively so the
     * plaintext never transits Kotlin as a decryptable payload, and expose it as a FileProvider
     * content Uri for `MessagingStyle.Message.setData`. Returns (contentUri, mimeType) or null on any
     * failure (caller then shows the text-only notification). Only images/GIF are handled - the 2 MB
     * proxy cap keeps videos out.
     */
    private fun fetchAndDecryptMedia(decrypted: DecryptedMessage): Pair<Uri, String>? {
        if (decrypted.mediaKind != "image") return null
        val mediaId = decrypted.mediaId ?: return null
        val keyB64 = decrypted.mediaKey ?: return null
        val ivB64 = decrypted.mediaIv ?: return null
        val ctx = MlsContextLoader.loadPushContext(this) ?: return null
        val secret = retrievePushSecret(this) ?: return null

        return try {
            val url = URL(
                "${ctx.baseUrl}/api/mls/push/media/${java.net.URLEncoder.encode(mediaId, "UTF-8")}" +
                    "?requesterId=${java.net.URLEncoder.encode(ctx.userId, "UTF-8")}" +
                    "&deviceId=${java.net.URLEncoder.encode(ctx.deviceId, "UTF-8")}"
            )
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 5_000
                readTimeout = 5_000
                requestMethod = "GET"
                setRequestProperty("Authorization", "PushSecret $secret")
                instanceFollowRedirects = true
            }
            val ciphertext = try {
                val code = conn.responseCode
                if (code != 200) {
                    Log.d(TAG, "fetchAndDecryptMedia: HTTP $code for ${mediaId.take(8)} -> text only")
                    return null
                }
                conn.inputStream.readBytes()
            } finally {
                conn.disconnect()
            }

            val plaintext = nativeDecryptMedia(keyB64, ivB64, ciphertext)
            if (plaintext.isEmpty()) {
                Log.w(TAG, "fetchAndDecryptMedia: native decrypt returned empty -> text only")
                return null
            }

            // Persist the decrypted image under the FileProvider-mapped cache dir (cache-path "tauri/")
            // and hand back a content Uri. Keyed by messageId so re-posts of the same conversation's
            // stacked notification reuse a stable file. A best-effort sweep bounds disk growth.
            val mediaDir = File(cacheDir, "tauri/notif_media").also { it.mkdirs() }
            pruneNotifMediaCache(mediaDir)
            val ext = mimeToExtension(decrypted.mimeType)
            val safeName = (decrypted.messageId.ifEmpty { mediaId }).replace(Regex("[^A-Za-z0-9_-]"), "_")
            val file = File(mediaDir, "$safeName.$ext")
            file.writeBytes(plaintext)
            val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
            Log.d(TAG, "fetchAndDecryptMedia: thumbnail ready ${mediaId.take(8)} (${plaintext.size}B)")
            Pair(uri, decrypted.mimeType ?: "image/jpeg")
        } catch (e: Exception) {
            Log.d(TAG, "fetchAndDecryptMedia: ${e.message} -> text only")
            null
        }
    }

    /** Maps a media MIME type to a file extension for the decrypted-thumbnail cache file. */
    private fun mimeToExtension(mime: String?): String = when (mime) {
        "image/png" -> "png"
        "image/gif" -> "gif"
        "image/webp" -> "webp"
        else -> "jpg"
    }

    /** Deletes notification-thumbnail cache files older than 24h to bound disk usage. */
    private fun pruneNotifMediaCache(dir: File) {
        val cutoff = System.currentTimeMillis() - AVATAR_CACHE_MAX_AGE_MS
        dir.listFiles()?.forEach { f ->
            if (f.lastModified() < cutoff) runCatching { f.delete() }
        }
    }

    /**
     * Crops a bitmap into a circle at a FIXED edge length (for the notification icon).
     *
     * The size is a PARAMETER, where it used to be the source's own shortest edge. An avatar
     * arrives at whatever resolution its owner uploaded (see [decodeSampled]), and taking the
     * output size from the source carried that resolution into a SECOND ARGB_8888 allocation - so
     * a 3000x3000 photo cost its 36 MB twice over, for an icon drawn at
     * [notificationIconSizePx]. The centre square is scaled onto the whole target, which is the
     * framing the previous unscaled draw already produced.
     */
    private fun circleCrop(src: Bitmap, target: Int): Bitmap {
        val edge   = minOf(src.width, src.height)
        val output = Bitmap.createBitmap(target, target, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(output)
        // FILTER_BITMAP_FLAG is new and load-bearing now that the draw SCALES: without it the
        // downscale is nearest-neighbour and a face comes out visibly aliased.
        val paint  = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        canvas.drawCircle(target / 2f, target / 2f, target / 2f, paint)
        paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
        val left = (src.width - edge) / 2
        val top  = (src.height - edge) / 2
        canvas.drawBitmap(
            src,
            Rect(left, top, left + edge, top + edge),
            Rect(0, 0, target, target),
            paint
        )
        src.recycle()
        return output
    }

    /** Generates a circular bitmap with the first letter of the name (fallback when no avatar). */
    private fun generateInitialsBitmap(name: String): Bitmap {
        val size   = 96
        val bmp    = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        val paint  = Paint(Paint.ANTI_ALIAS_FLAG)
        paint.color = android.graphics.Color.parseColor("#6366f1")
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
        paint.color     = android.graphics.Color.WHITE
        paint.textSize  = size * 0.4f
        paint.textAlign = Paint.Align.CENTER
        val fm = paint.fontMetrics
        canvas.drawText(
            name.firstOrNull()?.uppercaseChar()?.toString() ?: "?",
            size / 2f, size / 2f - (fm.ascent + fm.descent) / 2f, paint
        )
        return bmp
    }

    // --- Notification display --------------------------------------------------
    //
    // getStableNotifId / cancelConversationNotification live in the companion object above
    // (shared with CanariNotificationActionReceiver).

    /**
     * Shows (or updates) a notification for an MLS message (DM or group).
     * A single stable ID per conversation: each new message overwrites the previous
     * notification instead of stacking a new one.
     * Suppressed if the app is in the foreground: the WebSocket already delivered the message to the UI.
     */
    private fun showNotification(
        senderName: String,
        groupName: String,
        body: String,
        largeIcon: Bitmap,
        groupId: String,
        mediaUri: Uri? = null,
        mediaMime: String? = null,
        channel: String = CHANNEL_MESSAGES,
        /**
         * Offer reply and mark-as-read. False for a REACTION: both actions answer "there is a
         * message here for you", and neither means anything against a reaction - replying to one
         * is nonsense and there is nothing of it to mark read. Everything else this function does
         * is exactly what a reaction wants, which is why this is a parameter and not a second path.
         */
        quickActions: Boolean = true,
        /**
         * The SENDER's `sentAt` for the message this notification is about, in ms. Handed to the
         * quick actions so acknowledging the conversation from the shade names an instant taken
         * from the messages themselves. 0 when unknown, which the actions read as "say nothing".
         */
        sentAt: Long = 0L,
    ) {
        if (MainActivity.isInForeground) {
            Log.d(TAG, "showNotification: app in foreground -> notification suppressed (groupId=${groupId.take(8)})")
            return
        }
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureNotificationChannels(manager)
        val res = appLocaleContext(this)

        val isGroup = groupName.isNotEmpty() && groupName != senderName

        // Stable ID per conversation: notify() with the same ID updates the existing notification
        val notifId = if (groupId.isNotEmpty()) getStableNotifId(this, groupId) else 0

        val tapIntent = Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            setData(android.net.Uri.parse("fr.emse.canari://chat/$groupId"))
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, notifId, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // MessagingStyle: successive messages of the same conversation STACK instead of
        // replacing each other. We rebuild the style from the active notification (if present),
        // bounding the history to MAX_NOTIF_MESSAGES to avoid unbounded growth.
        val senderPerson = Person.Builder()
            .setName(senderName.ifEmpty { res.getString(R.string.app_name) })
            .setIcon(IconCompat.createWithBitmap(largeIcon))
            .build()
        // Our own Person carries our avatar too: Android attributes the inline reply to it while
        // the reply is in flight, so leaving it iconless is a blank face on the only message in
        // that thread the user actually wrote. Same 24h file cache as the sender's avatar, so this
        // costs one request a day at most, and an unresolvable avatar simply stays iconless.
        val selfAvatar = MlsContextLoader.loadUserId(this)?.let { fetchAvatar(it) }
        val selfPerson = Person.Builder()
            .setName(res.getString(R.string.notif_sender_self))
            .apply { selfAvatar?.let { setIcon(IconCompat.createWithBitmap(it)) } }
            .build()

        val existingNotif = try {
            manager.activeNotifications.firstOrNull { it.id == notifId }?.notification
        } catch (e: Exception) {
            Log.w(TAG, "showNotification: activeNotifications unavailable: ${e.message}")
            null
        }

        val style = NotificationCompat.MessagingStyle(selfPerson)
        if (isGroup) {
            style.conversationTitle = groupName
            style.isGroupConversation = true
        }
        // Re-inject the previous (bounded) messages, then add the new one.
        existingNotif
            ?.let { NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(it) }
            ?.messages
            ?.takeLast(MAX_NOTIF_MESSAGES - 1)
            ?.forEach { style.addMessage(it) }
        // Rich media (WP-XP-3): attach the decrypted image inline via setData so it renders as a
        // thumbnail while keeping the conversation's MessagingStyle stacking. NotificationManager
        // grants the system read access to the FileProvider content Uri carried in the notification.
        val newMessage = NotificationCompat.MessagingStyle.Message(
            body, System.currentTimeMillis(), senderPerson
        )
        if (mediaUri != null && mediaMime != null) {
            newMessage.setData(mediaMime, mediaUri)
        }
        style.addMessage(newMessage)

        // Channel switch (WP-XP-5): a posted notification cannot move channels in place, so when
        // a mention upgrades (or a plain message downgrades) this conversation's channel, cancel
        // the old post first - the rebuilt MessagingStyle above already carries its history.
        if (existingNotif != null && android.os.Build.VERSION.SDK_INT >= 26 &&
            existingNotif.channelId != channel
        ) {
            manager.cancel(notifId)
        }

        val notifBuilder = NotificationCompat.Builder(this, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setStyle(style)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pendingIntent)
            .setLargeIcon(largeIcon)
            .setGroup(GROUP_KEY_MESSAGES)

        // Quick actions (WP-XP-1): MLS-only (DM/group), never on a channel_ conversation - channels
        // are server-authoritative and do not go through the MLS outbox (see outbox.ts isChannelConversationId).
        if (quickActions && groupId.isNotEmpty() && !groupId.startsWith("channel_")) {
            notifBuilder.addAction(buildReplyAction(this, res, groupId, notifId, sentAt))
            notifBuilder.addAction(buildMarkReadAction(this, res, groupId, notifId, sentAt))
        }

        val notif = notifBuilder.build()

        Log.d(TAG, "showNotification: notifId=$notifId messages=${style.messages.size} group=$isGroup")
        manager.notify(notifId, notif)

        // Rebuild the group summary and refresh the launcher badge count (WP-XP-2) now that this
        // conversation's notification is active.
        refreshBadgeSummary(this)
    }

    /**
     * Shows a simple notification (social or form) without MLS decryption.
     * The channel is chosen according to the notification type.
     */
    private fun showSimpleNotification(title: String, body: String, deepLink: String, channel: String) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureNotificationChannels(manager)
        val notifId     = notificationIdCounter.incrementAndGet()
        val tapIntent   = Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            setData(android.net.Uri.parse(deepLink))
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, notifId, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(pendingIntent)
            .build()
        manager.notify(notifId, notification)
    }

    // --- Reaction push -----------------------------------------------------------

    /**
     * Draws a reaction to one of MY messages into that conversation's own notification.
     *
     * THE PUSH CARRIES NO MESSAGE TEXT, and cannot: the recipient is the message's author, so this
     * device already holds it. It used to carry 80 characters of the decrypted message, composed by
     * the reacting client into a sentence by the server - which put conversation plaintext through
     * our server, Google and Apple on every reaction. What arrives now is an id, an emoji and who
     * reacted.
     *
     * The sentence is therefore built HERE, from `strings.xml`. A server cannot: it has no locale
     * for the recipient, so any sentence it composes is French for everyone.
     *
     * AND IT IS RESOLVED AGAINST THE APP'S LANGUAGE, NOT THE PHONE'S. A plain `getString` reads
     * `values-en/` or `values/` according to the OS locale, which is a different setting from the
     * Français/English choice made inside Canari - an app set to English on a French phone wrote
     * French notifications. The choice is mirrored into `push_context.json` while the app is open
     * (see `set_push_context_locale`), and read back here through a configured Context so the
     * translations stay in the one place translators look at.
     *
     * It goes out through `showNotification` rather than `showSimpleNotification`, and that single
     * choice is the whole fix. The message path already has the stable per-conversation id (so a
     * reaction updates the conversation's notification instead of stacking a new one for ever), the
     * avatar, the MessagingStyle bundling, the badge, the clear-on-open sweep and the cross-device
     * dismissal. The `social` path has none of them, which is why reactions could never be dismissed.
     * Only the two quick actions are dropped - see `quickActions`.
     *
     * The conversation NAME is not available and is not guessed: it is end-to-end encrypted, so the
     * server cannot send it. `groupName` is left empty, which renders the reaction as a message from
     * its author - correct in a DM, and in a group it costs the conversation title on that one
     * notification until the next real message rebuilds it.
     */
    /**
     * Writes a server-sent notification's sentence HERE, in the language chosen inside Canari.
     *
     * The services are the only layer that cannot know the reader's language - no header carries it
     * and no column stores it - so since 2026-08-19 they send a `contentKey` from a closed set plus
     * the two pieces that are not translatable: who acted, and one fragment whose meaning is fixed
     * per key. This is what the message-reaction push always did; it is now the rule.
     *
     * Returns null for a payload with no `contentKey`, which only a server predating that change
     * can send - so the caller falls back to the French/English `title`/`body` that server also
     * sends, and LOGS it: after the shim is removed, reaching that branch means the payload lost a
     * field rather than that an old client is being kind to.
     *
     * An unknown key returns null too. Inventing a sentence for a key this build does not know
     * would be worse than the server's own wording, which at least says something true.
     */
    private fun composeServerNotification(data: Map<String, String>): Pair<String, String>? {
        val key = data["contentKey"]
        if (key.isNullOrEmpty()) {
            Log.w(TAG, "server push with no contentKey - falling back to its own wording")
            return null
        }
        val res = appLocaleContext(this).resources
        val actor = data["actorName"] ?: ""
        val arg = data["contentArg"] ?: ""
        return when (key) {
            "social_mention" -> Pair(
                res.getString(R.string.notif_social_mention_title, actor),
                arg.ifEmpty { res.getString(R.string.notif_social_mention_body) }
            )
            "social_reply" -> Pair(
                res.getString(R.string.notif_social_reply_title, actor),
                arg.ifEmpty { res.getString(R.string.notif_social_reply_body) }
            )
            "social_comment" -> Pair(
                res.getString(R.string.notif_social_comment_title, actor),
                arg.ifEmpty { res.getString(R.string.notif_social_comment_body) }
            )
            "social_reaction" -> Pair(
                res.getString(R.string.notif_social_reaction_title),
                res.getString(R.string.notif_social_reaction_body, actor, arg)
            )
            "form_opening_soon" -> Pair(
                res.getString(R.string.notif_form_opening_soon_title),
                res.getString(R.string.notif_form_opening_soon_body)
            )
            "form_open" -> Pair(
                res.getString(R.string.notif_form_open_title),
                res.getString(R.string.notif_form_open_body)
            )
            else -> {
                Log.w(TAG, "unknown contentKey=$key - using the server's own wording")
                null
            }
        }
    }

    private fun handleReactionNotification(data: Map<String, String>) {
        val groupId = data["groupId"] ?: ""
        val emoji = data["emoji"] ?: ""
        val actorId = data["senderId"] ?: ""
        val actorName = data["title"] ?: getString(R.string.app_name)

        if (groupId.isEmpty()) {
            // Without it there is no conversation to attach to and no stable id to reuse, so the
            // notification would be exactly the unremovable stray this change removes.
            Log.w(TAG, "reaction push without groupId - dropped, nothing to attach it to")
            return
        }

        Log.d(TAG, "reaction: group=${groupId.take(8)} actor=${actorId.take(8)} emoji=$emoji")
        val largeIcon = (if (actorId.isNotEmpty()) fetchAvatar(actorId) else null)
            ?: generateInitialsBitmap(actorName)

        showNotification(
            senderName = actorName,
            groupName = "",
            body = appLocaleContext(this).getString(R.string.notif_reaction_body, emoji),
            largeIcon = largeIcon,
            groupId = groupId,
            channel = CHANNEL_MESSAGES,
            quickActions = false,
        )
    }

    // --- Channel (community) message push --------------------------------------

    /**
     * Decrypts a channel-message push and shows a notification. The Graine seed named by
     * `senderSessionId` is read from the app-private `graine_seeds.json` mirror (written by the
     * foreground); the message key is derived from it at `messageIndex` and the inline ciphertext is
     * AES-256-GCM-decrypted natively, so the plaintext never transits FCM. Falls back to a generic
     * body when the seed is missing (session never mirrored, or older than the mirror's bound) or
     * the ciphertext was too large to inline (omitted server-side).
     *
     * An `@` OF ME IS TOLD, NOT INFERRED. The MLS path scans the decrypted text for `@[<myUserId>]`
     * because the server cannot read it; a channel message carries a cleartext `mentionedUserIds`
     * from the sender, so the server computes `mentioned` per recipient - the same fact it already
     * uses to honour the `mentions` notification level. Reading it here is what puts a salon mention
     * on [CHANNEL_MENTIONS] (IMPORTANCE_HIGH, bypass-DND) instead of the ordinary messages channel,
     * and it is the only answer that still works when the ciphertext was too large to inline and
     * there is no text to scan.
     */
    private fun handleChannelMessage(data: Map<String, String>) {
        val res         = appLocaleContext(this)
        val channelId   = data["channelId"] ?: ""
        val channelName = data["channelName"]?.takeIf { it.isNotEmpty() }
            ?: res.getString(R.string.notif_channel_unnamed)
        val workspaceName = data["workspaceName"]?.takeIf { it.isNotEmpty() } ?: ""
        val sessionId   = data["senderSessionId"] ?: ""
        val messageIndex = data["messageIndex"]?.toIntOrNull()
        val ciphertext  = data["ciphertext"]?.takeIf { it.isNotEmpty() }
        val nonce       = data["nonce"]?.takeIf { it.isNotEmpty() }
        val senderId    = data["senderId"] ?: ""
        val mentionsMe  = data["mentioned"] == "true"
        if (channelId.isEmpty()) {
            Log.e(TAG, "handleChannelMessage: channelId missing -> abort")
            return
        }
        // The app addresses channels as `channel_<uuid>`; use it for the deep link + stable notif id.
        val conversationId = "channel_$channelId"

        // A message index of 0 is the first message of every session, so the guard is on `null`
        // (absent or unparsable) and never on falsiness.
        val seedB64 = if (ciphertext != null && nonce != null && messageIndex != null)
            lookupGraineSeed(channelId, sessionId) else null
        // Read once: the only id this device can name in a mention token is its own.
        val myUserId = MlsContextLoader.loadPushContext(this)?.userId
        val body: String = if (seedB64 != null && ciphertext != null && nonce != null && messageIndex != null) {
            try {
                val json = JSONObject(
                    nativeDecryptGraineMessage(seedB64, sessionId, messageIndex, nonce, ciphertext)
                )
                if (json.optBoolean("ok", false)) {
                    // RENDERED, NOT PRINTED. The decrypted text carries `@[<64 hex>]` tokens; taking
                    // it raw put a hex blob in the banner - see `renderMentions`. The truncation is
                    // applied AFTER, so a token near the 200-character edge cannot be cut in half.
                    json.optString("text").takeIf { it.isNotEmpty() }
                        ?.let { renderMentions(it, myUserId, res).take(200) }
                        ?: buildChannelFallbackText(res, channelName)
                } else {
                    Log.w(TAG, "handleChannelMessage: decrypt ok=false channel=$channelId")
                    buildChannelFallbackText(res, channelName)
                }
            } catch (e: Exception) {
                Log.e(TAG, "handleChannelMessage: decrypt exception: ${e.message}")
                buildChannelFallbackText(res, channelName)
            }
        } else {
            Log.d(TAG, "handleChannelMessage: no seed/ciphertext -> generic notification channel=$channelId session=$sessionId")
            buildChannelFallbackText(res, channelName)
        }

        val avatarBitmap = if (senderId.isNotEmpty()) fetchAvatar(senderId) else null
        val largeIcon    = avatarBitmap ?: generateInitialsBitmap(channelName)
        val title = buildChannelPushTitle(workspaceName, channelName)
        Log.d(TAG, "handleChannelMessage: showNotification title=$title body=${body.take(60)} mentionsMe=$mentionsMe")
        showNotification(
            // `senderName` IS the title here: with `groupName` empty, MessagingStyle sets no
            // conversation title and the Person's name is what the banner shows. A salon has no
            // human sender to name anyway - the server sends only `senderId`, for the avatar.
            senderName = title,
            groupName  = "",
            body       = body,
            largeIcon  = largeIcon,
            groupId    = conversationId,
            channel    = if (mentionsMe) CHANNEL_MENTIONS else CHANNEL_MESSAGES,
        )
    }

    /**
     * Looks up a Graine session's raw seed (base64) in `graine_seeds.json`, or null.
     *
     * The mirror is BOUNDED - the newest sessions per channel only - so a miss on an old session is
     * expected and not a fault: the notification degrades to the generic body, which is the correct
     * outcome and the same one an oversized ciphertext already produces.
     */
    private fun lookupGraineSeed(channelId: String, sessionId: String): String? {
        if (sessionId.isEmpty()) return null
        return try {
            val file = File(MlsContextLoader.tauriDataDir(this), "graine_seeds.json")
            if (!file.exists()) {
                Log.w(TAG, "lookupGraineSeed: graine_seeds.json absent")
                return null
            }
            JSONObject(file.readText())
                .optJSONObject(channelId)
                ?.optJSONObject(sessionId)
                ?.optString("seed")
                ?.takeIf { it.isNotEmpty() }
        } catch (e: Exception) {
            Log.e(TAG, "lookupGraineSeed: ${e.message}")
            null
        }
    }

    /**
     * Title of a salon notification: `<Communaute> - #<salon>`.
     *
     * The community is named because a salon name alone is ambiguous across communities - two of
     * them may both have a `#general`. It DEGRADES to `#<salon>` when the server could not name the
     * workspace, which is what the title was before `workspaceName` travelled.
     * Three other surfaces spell the same format (the social-service APNs alert title, the iOS
     * extension, `canari_push.mm`); `channelPushFields.test.ts` holds the four together.
     */
    private fun buildChannelPushTitle(workspaceName: String, channelName: String): String =
        if (workspaceName.isNotEmpty()) "$workspaceName - #$channelName" else "#$channelName"

    /** Generic channel notification body used when the message cannot be decrypted. */
    /**
     * Replaces the `@[<64 hex>]` mention tokens a decrypted body carries with something readable.
     *
     * WHAT IT IS FOR. A mention is stored as a TOKEN, not a name: the web splits it and renders a
     * chip carrying the display name, and every consumer that forgot to do so printed the raw id.
     * The notification path was one - measured on 2026-09-05 by COMM-14, whose tray body came back
     * `@[f7a9bb80...5d8ce1]  COMM14-mtnq7c2dlh3-tagged` - and it is the worst place for it, because a
     * mention is exactly what posts on the high-priority `CHANNEL_MENTIONS` channel.
     *
     * WHY IT DOES NOT RESOLVE NAMES. This runs in a push handler with no name directory: the only
     * thing the push path can fetch is an avatar, by id, over `PushSecret`. Adding a name lookup
     * would put a network round trip per token on the path that has to post a banner in seconds, and
     * would still fail offline. So it renders the one id this device knows for certain - its own -
     * and states plainly that it does not know the others, rather than showing a hex blob and
     * calling it a name. That matches the web, whose own unresolved-name label is a WORD.
     *
     * The double space the old body showed is gone with it: a token is replaced by its label, and
     * the run of whitespace that used to sit between `]` and the text is collapsed.
     *
     * @param text the decrypted message body, possibly carrying tokens
     * @param myUserId this device's user id, or null when the push context could not be read
     * @param res the (locale-aware) context the strings are read from
     */
    private fun renderMentions(text: String, myUserId: String?, res: Context): String {
        if (!text.contains("@[")) return text
        val me = myUserId?.lowercase()
        return MENTION_TOKEN.replace(text) { m ->
            val id = m.groupValues[1].lowercase()
            val label = if (me != null && id == me) res.getString(R.string.notif_mention_you)
                        else res.getString(R.string.notif_mention_someone)
            "@" + label
        }.replace(Regex("[ \t]{2,}"), " ")
    }

    private fun buildChannelFallbackText(res: Context, channelName: String): String =
        res.getString(R.string.notif_channel_new_message, channelName)

    /** Fallback text used when MLS decryption fails (group not yet initialized). */
    private fun buildFallbackText(res: Context, senderName: String): String =
        if (senderName.isNotEmpty()) res.getString(R.string.notif_new_message_from, senderName)
        else res.getString(R.string.notif_new_message_generic)

    private fun ensureNotificationChannels(manager: NotificationManager) =
        CanariApplication.ensureChannels(this, manager)
}
