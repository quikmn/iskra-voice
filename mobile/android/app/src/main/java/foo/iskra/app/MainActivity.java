package foo.iskra.app;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(IskraNativePlugin.class);
        super.onCreate(savedInstanceState);
        handle(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handle(intent);
    }

    private boolean overLockScreen;

    private void handle(Intent intent) {
        if (intent == null) return;
        // A ringing call opens over the lock screen (only until the app leaves the screen: never chats over a locked phone).
        if (intent.getBooleanExtra(Notifications.EXTRA_CALL_SCREEN, false) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
            overLockScreen = true;
        }
        intent.removeExtra(Notifications.EXTRA_CALL_SCREEN);
        IskraNativePlugin.handleIntent(this, intent);
    }

    @Override
    public void onStop() {
        super.onStop();
        if (overLockScreen && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(false);
            setTurnScreenOn(false);
            overLockScreen = false;
        }
    }
}
