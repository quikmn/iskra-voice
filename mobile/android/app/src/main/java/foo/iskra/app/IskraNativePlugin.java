package foo.iskra.app;

import android.Manifest;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/** The app's own bridge to the web client (client/src/platform/native.ts, "IskraNative"): voice in the background. */
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

    // ── Voice in the background ─────────────────────────────────────────────

    @PluginMethod
    public void voiceStart(PluginCall call) {
        // Android 13+: asked once, so the "In voice" notification (with its Leave button) shows. Voice works either way.
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") == PermissionState.PROMPT) {
            requestPermissionForAlias("notifications", call, "afterNotificationPermission");
            return;
        }
        startVoice(call);
    }

    @PermissionCallback
    private void afterNotificationPermission(PluginCall call) {
        startVoice(call);
    }

    private void startVoice(PluginCall call) {
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
