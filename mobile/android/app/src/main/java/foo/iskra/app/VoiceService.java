package foo.iskra.app;

import android.Manifest;
import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Keeps Iskra running while you're in voice with the app in the background or the screen off: a foreground service
 * with an "In voice: lounge" notification and a Leave button. Started and stopped by the web app (IskraNativePlugin).
 */
public class VoiceService extends Service {
    static final String ACTION_START = "foo.iskra.app.VOICE_START";
    static final String ACTION_LEAVE = "foo.iskra.app.VOICE_LEAVE";
    static final String EXTRA_TITLE = "title";

    static void start(Context context, String title) {
        Intent intent = new Intent(context, VoiceService.class).setAction(ACTION_START).putExtra(EXTRA_TITLE, title);
        ContextCompat.startForegroundService(context, intent);
    }

    /** A new title (a channel renamed, a name loaded): the shown notification changes; the service isn't started again. */
    static void update(Context context, String title) {
        if (!running) {
            start(context, title);
            return;
        }
        if (Build.VERSION.SDK_INT >= 33
            && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        NotificationManagerCompat.from(context).notify(Notifications.VOICE_ID, notification(context, title));
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, VoiceService.class));
    }

    /** True while the service is in the foreground (its notification showing). */
    private static volatile boolean running;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_LEAVE.equals(intent.getAction())) {
            IskraNativePlugin.voiceEnded();
            stopForegroundAndSelf();
            return START_NOT_STICKY;
        }
        String title = intent != null ? intent.getStringExtra(EXTRA_TITLE) : null;
        try {
            ServiceCompat.startForeground(this, Notifications.VOICE_ID, notification(this, title), serviceType());
            running = true;
        } catch (RuntimeException e) {
            // Not allowed right now (Android 12+ background start, or no microphone permission yet): voice still works in front.
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    /** Microphone once the person allowed it (Android 14 requires that), else playback: listening keeps working. */
    private int serviceType() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return 0;
        boolean mic = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        return mic ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
    }

    private static Notification notification(Context context, String title) {
        Notifications.ensureChannels(context);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        Intent open = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent leave = PendingIntent.getService(context, 1, new Intent(context, VoiceService.class).setAction(ACTION_LEAVE), flags);
        return new NotificationCompat.Builder(context, Notifications.VOICE)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(Notifications.COLOR)
            .setContentTitle(context.getString(R.string.app_name))
            .setContentText(title == null ? "" : title)
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(PendingIntent.getActivity(context, 0, open, flags))
            .addAction(0, context.getString(R.string.voice_leave), leave)
            .build();
    }

    private void stopForegroundAndSelf() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        stopForegroundAndSelf();
    }

    /** Swiped out of Recents in a call: the call is gone with the web view, so the notification and audio state go too. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        IskraNativePlugin.voiceEnded();
        stopForegroundAndSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
