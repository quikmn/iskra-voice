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

    static void stop(Context context) {
        context.stopService(new Intent(context, VoiceService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_LEAVE.equals(intent.getAction())) {
            IskraNativePlugin.voiceEnded();
            stopForegroundAndSelf();
            return START_NOT_STICKY;
        }
        String title = intent != null ? intent.getStringExtra(EXTRA_TITLE) : null;
        try {
            ServiceCompat.startForeground(this, Notifications.VOICE_ID, notification(title == null ? "" : title), serviceType());
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

    private Notification notification(String title) {
        Notifications.ensureChannels(this);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent leave = PendingIntent.getService(this, 1, new Intent(this, VoiceService.class).setAction(ACTION_LEAVE), flags);
        return new NotificationCompat.Builder(this, Notifications.VOICE)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(Notifications.COLOR)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(title)
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(PendingIntent.getActivity(this, 0, open, flags))
            .addAction(0, getString(R.string.voice_leave), leave)
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

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
