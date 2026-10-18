package foo.iskra.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** The app's own bridge to the web client (client/src/platform/native.ts, "IskraNative"): voice in the background, shares in. */
@CapacitorPlugin(
    name = "IskraNative",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class IskraNativePlugin extends Plugin {
    private static IskraNativePlugin instance;
    private AudioFocusRequest focus;
    private final ExecutorService shareReader = Executors.newSingleThreadExecutor();
    /** The newest share, ready for the page (taken once by takeShare). */
    private JSObject pendingShare;
    private int shareGeneration;
    /** The id of the newest share read (its files are the ones in the cache folder). */
    private String lastShareId;

    @Override
    public void load() {
        instance = this;
        Notifications.ensureChannels(getContext());
        // Started by a share (a cold start): the page asks for it with takeShare once it's up.
        if (getActivity() != null) receiveShare(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        receiveShare(intent);
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
        shareReader.shutdown();
    }

    // ── Shares from other apps (ShareIntake) ─────────────────────────────────

    private void receiveShare(Intent intent) {
        if (!ShareIntake.isShare(intent)) return;
        intent.putExtra(ShareIntake.HANDLED, true);
        final int generation;
        synchronized (this) {
            generation = ++shareGeneration;
            pendingShare = null;
        }
        final String localUrl = getBridge().getLocalUrl();
        shareReader.execute(() -> {
            JSObject share = ShareIntake.read(getContext(), intent, localUrl);
            synchronized (this) {
                if (generation != shareGeneration || share == null) return;
                pendingShare = share;
                lastShareId = share.getString("id");
            }
            notifyListeners("shareReceived", new JSObject());
        });
    }

    @PluginMethod
    public void takeShare(PluginCall call) {
        JSObject result = new JSObject();
        synchronized (this) {
            result.put("share", pendingShare);
            pendingShare = null;
        }
        call.resolve(result);
    }

    /** Sent or cancelled: the copies go (unless a newer share has replaced them). */
    @PluginMethod
    public void shareDone(PluginCall call) {
        String id = call.getString("id", "");
        shareReader.execute(() -> {
            synchronized (this) {
                if (pendingShare != null || lastShareId == null || !lastShareId.equals(id)) return;
            }
            ShareIntake.clear(getContext());
        });
        call.resolve();
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
