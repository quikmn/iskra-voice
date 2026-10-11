package foo.iskra.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

/**
 * The app's own bridge to the web client (client/src/platform/native.ts, "IskraNative"): native push registration
 * (FCM token + this install's Web Push keys), notification taps and call buttons, and voice in the background.
 */
@CapacitorPlugin(
    name = "IskraNative",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class IskraNativePlugin extends Plugin {
    private static IskraNativePlugin instance;
    private AudioFocusRequest focus;

    @Override
    public void load() {
        instance = this;
        Notifications.ensureChannels(getContext());
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
    }

    // ── Push ────────────────────────────────────────────────────────────────

    private String permission() {
        if (NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) return "granted";
        if (Build.VERSION.SDK_INT >= 33) {
            PermissionState state = getPermissionState("notifications");
            if (state == PermissionState.PROMPT || state == PermissionState.PROMPT_WITH_RATIONALE) return "prompt";
        }
        return "denied";
    }

    @PluginMethod
    public void pushPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("permission", permission());
        call.resolve(result);
    }

    @PluginMethod
    public void pushRegister(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterNotificationPermission");
            return;
        }
        register(call);
    }

    @PermissionCallback
    private void afterNotificationPermission(PluginCall call) {
        register(call); // the web app reads the permission afterwards
    }

    private void register(PluginCall call) {
        if (FirebaseApp.getApps(getContext()).isEmpty()) {
            call.reject("This build of the app has no push setup.");
            return;
        }
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
            if (!task.isSuccessful() || task.getResult() == null) {
                call.reject("Couldn't get a push token from Google Play services.");
                return;
            }
            try {
                PushKeys keys = PushKeys.loadOrCreate(getContext());
                JSObject result = new JSObject();
                result.put("platform", "android");
                result.put("token", task.getResult());
                result.put("p256dh", keys.p256dh());
                result.put("auth", keys.authSecret());
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Couldn't make push keys.");
            }
        });
    }

    static void tokenChanged() {
        IskraNativePlugin plugin = instance;
        if (plugin != null) plugin.notifyListeners("pushToken", new JSObject());
    }

    /** A notification tap or call button that opened MainActivity. */
    static void handleIntent(Context context, Intent intent) {
        String route = intent.getStringExtra(Notifications.EXTRA_ROUTE);
        String action = intent.getStringExtra(Notifications.EXTRA_CALL_ACTION);
        if (action != null) {
            Notifications.cancelCall(context, intent.getStringExtra(Notifications.EXTRA_NOTIFICATION));
            callAction(action, intent.getStringExtra(Notifications.EXTRA_SERVER), intent.getStringExtra(Notifications.EXTRA_PEER), intent.getStringExtra(Notifications.EXTRA_GROUP));
        }
        IskraNativePlugin plugin = instance;
        if (route != null && plugin != null) {
            JSObject data = new JSObject();
            data.put("route", route);
            plugin.notifyListeners("pushOpened", data, true);
        }
        // Handled once: a later recreation of the activity mustn't open it again.
        intent.removeExtra(Notifications.EXTRA_ROUTE);
        intent.removeExtra(Notifications.EXTRA_CALL_ACTION);
    }

    static void callAction(String action, String server, String peer, String group) {
        IskraNativePlugin plugin = instance;
        if (plugin == null || server == null) return;
        JSObject data = new JSObject();
        data.put("action", action);
        data.put("server", server);
        if (peer != null) data.put("peer", peer);
        if (group != null) data.put("group", group);
        plugin.notifyListeners("callAction", data, true);
    }

    // ── Voice in the background ─────────────────────────────────────────────

    @PluginMethod
    public void voiceStart(PluginCall call) {
        VoiceService.start(getContext(), call.getString("title", ""));
        requestFocus();
        call.resolve();
    }

    @PluginMethod
    public void voiceUpdate(PluginCall call) {
        VoiceService.start(getContext(), call.getString("title", ""));
        call.resolve();
    }

    @PluginMethod
    public void voiceStop(PluginCall call) {
        VoiceService.stop(getContext());
        abandonFocus();
        call.resolve();
    }

    static void voiceEnded() {
        IskraNativePlugin plugin = instance;
        if (plugin == null) return;
        plugin.abandonFocus();
        plugin.notifyListeners("voiceEnded", new JSObject());
    }

    /** Other apps duck or pause while you talk (music, videos). */
    private void requestFocus() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || focus != null) return;
        AudioManager audio = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setOnAudioFocusChangeListener(change -> {})
            .build();
        audio.requestAudioFocus(focus);
    }

    private void abandonFocus() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || focus == null) return;
        ((AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE)).abandonAudioFocusRequest(focus);
        focus = null;
    }
}
