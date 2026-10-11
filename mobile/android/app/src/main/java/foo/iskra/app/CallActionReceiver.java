package foo.iskra.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** "Decline" on a ringing call notification: dismisses it, and tells the app if it's running so the caller hears it. */
public class CallActionReceiver extends BroadcastReceiver {
    static final String ACTION_DECLINE = "foo.iskra.app.DECLINE_CALL";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION_DECLINE.equals(intent.getAction())) return;
        Notifications.cancelCall(context, intent.getStringExtra(Notifications.EXTRA_NOTIFICATION));
        IskraNativePlugin.callAction(
            "decline",
            intent.getStringExtra(Notifications.EXTRA_SERVER),
            intent.getStringExtra(Notifications.EXTRA_PEER),
            intent.getStringExtra(Notifications.EXTRA_GROUP)
        );
    }
}
