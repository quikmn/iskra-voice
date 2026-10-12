package foo.iskra.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;

/** The app's one notification: "In voice", which keeps voice alive in the background. */
final class Notifications {
    static final String VOICE = "voice";
    static final int VOICE_ID = 1;
    /** Brand blue, for the small icon's tint. */
    static final int COLOR = 0xFF4C7DFF;

    private Notifications() {}

    static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel voice = new NotificationChannel(VOICE, context.getString(R.string.channel_voice), NotificationManager.IMPORTANCE_LOW);
        voice.setShowBadge(false);
        manager.createNotificationChannel(voice);
        // Earlier versions had push notifications for messages and calls.
        manager.deleteNotificationChannel("messages");
        manager.deleteNotificationChannel("calls");
    }
}
