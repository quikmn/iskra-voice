package foo.iskra.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;

/** The app's notifications: messages, ringing calls, and the "In voice" one that keeps voice alive in the background. */
final class Notifications {
    static final String MESSAGES = "messages";
    static final String CALLS = "calls";
    static final String VOICE = "voice";
    static final int VOICE_ID = 1;
    static final String CALL_TAG = "iskra.call";
    /** Brand blue, for the small icon's tint. */
    static final int COLOR = 0xFF4C7DFF;

    static final String EXTRA_ROUTE = "iskra.route";
    static final String EXTRA_CALL_ACTION = "iskra.callAction";
    static final String EXTRA_SERVER = "iskra.server";
    static final String EXTRA_PEER = "iskra.peer";
    static final String EXTRA_GROUP = "iskra.group";
    static final String EXTRA_NOTIFICATION = "iskra.notification";
    /** The activity may show over the lock screen (a ringing call's full-screen intent). */
    static final String EXTRA_CALL_SCREEN = "iskra.callScreen";

    private Notifications() {}

    static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel messages = new NotificationChannel(MESSAGES, context.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH);
        messages.setShowBadge(true);
        NotificationChannel calls = new NotificationChannel(CALLS, context.getString(R.string.channel_calls), NotificationManager.IMPORTANCE_HIGH);
        calls.setSound(
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
            new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
        );
        calls.enableVibration(true);
        calls.setLockscreenVisibility(NotificationCompat.VISIBILITY_PUBLIC);
        NotificationChannel voice = new NotificationChannel(VOICE, context.getString(R.string.channel_voice), NotificationManager.IMPORTANCE_LOW);
        voice.setShowBadge(false);
        manager.createNotificationChannel(messages);
        manager.createNotificationChannel(calls);
        manager.createNotificationChannel(voice);
    }

    private static int flags() {
        return PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
    }

    /** Opens the app (at a route, or with a call answered). */
    static PendingIntent openApp(Context context, int requestCode, String route, String callAction, PushPayload payload, boolean callScreen) {
        Intent intent = new Intent(context, MainActivity.class)
            .setAction(Intent.ACTION_VIEW)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (route != null) intent.putExtra(EXTRA_ROUTE, route);
        if (callAction != null && payload != null) {
            intent.putExtra(EXTRA_CALL_ACTION, callAction)
                .putExtra(EXTRA_SERVER, payload.server)
                .putExtra(EXTRA_PEER, payload.peer)
                .putExtra(EXTRA_GROUP, payload.group)
                .putExtra(EXTRA_NOTIFICATION, payload.notificationTag());
        }
        if (callScreen) intent.putExtra(EXTRA_CALL_SCREEN, true);
        return PendingIntent.getActivity(context, requestCode, intent, flags());
    }

    static void showMessage(Context context, PushPayload payload) {
        ensureChannels(context);
        String tag = payload.notificationTag();
        int id = tag.hashCode();
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(COLOR)
            .setContentTitle(payload.title)
            .setContentText(payload.body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(payload.body))
            .setWhen(payload.at)
            .setShowWhen(true)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(openApp(context, id, payload.route, null, null, false));
        if (!payload.serverName.isEmpty()) builder.setSubText(payload.serverName);
        if (!payload.server.isEmpty()) builder.setGroup(payload.server);
        notify(context, tag, id, builder);
    }

    /** A ringing call: full screen on a locked phone, heads-up otherwise, with Answer and Decline. */
    static void showCall(Context context, PushPayload payload) {
        ensureChannels(context);
        String tag = payload.notificationTag();
        int id = tag.hashCode();
        Person caller = new Person.Builder().setName(payload.caller()).setImportant(true).build();
        PendingIntent answer = openApp(context, id + 1, payload.route, "answer", payload, true);
        Intent declineIntent = new Intent(context, CallActionReceiver.class)
            .setAction(CallActionReceiver.ACTION_DECLINE)
            .putExtra(EXTRA_SERVER, payload.server)
            .putExtra(EXTRA_PEER, payload.peer)
            .putExtra(EXTRA_GROUP, payload.group)
            .putExtra(EXTRA_NOTIFICATION, tag);
        PendingIntent decline = PendingIntent.getBroadcast(context, id + 2, declineIntent, flags());
        PendingIntent fullScreen = openApp(context, id + 3, payload.route, null, null, true);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(COLOR)
            .setContentTitle(payload.title)
            .setContentText(payload.serverName.isEmpty() ? payload.body : payload.serverName)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(true)
            .setTimeoutAfter(45_000) // the server stops ringing after 45 s
            .setContentIntent(fullScreen)
            .setFullScreenIntent(fullScreen, true);
        notify(context, CALL_TAG + ":" + tag, id, builder);
    }

    static void cancelCall(Context context, String tag) {
        if (tag != null) NotificationManagerCompat.from(context).cancel(CALL_TAG + ":" + tag, tag.hashCode());
    }

    private static void notify(Context context, String tag, int id, NotificationCompat.Builder builder) {
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        if (!manager.areNotificationsEnabled()) return;
        try {
            manager.notify(tag, id, builder.build());
        } catch (SecurityException e) {
            // Notification permission withdrawn meanwhile.
        }
    }
}
