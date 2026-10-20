package foo.iskra.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowManager;
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
    /** In voice, sound plays on the speaker (like the iPhone app) unless the person picked the earpiece; a headset wins. */
    private boolean speakerWanted = true;
    private AudioDeviceCallback deviceWatch;
    private AudioManager.OnModeChangedListener modeWatch;
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
        speakerWanted = true;
        watchRoute();
        applyRoute();
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
        releaseRoute();
        setKeepAwake(false);
        call.resolve();
    }

    /** The screen stays on while your camera is on in a call: a locked phone stops the camera (and a work profile's
     * screen-lock timeout would lock it mid-call). */
    @PluginMethod
    public void keepAwake(PluginCall call) {
        setKeepAwake(call.getBoolean("on", false));
        call.resolve();
    }

    private void setKeepAwake(boolean on) {
        if (getActivity() == null) return;
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    /** Speaker or earpiece (the call screen's button). Answers whether a headset is in, which then plays instead. */
    @PluginMethod
    public void voiceSpeaker(PluginCall call) {
        speakerWanted = call.getBoolean("on", true);
        applyRoute();
        JSObject result = new JSObject();
        result.put("headset", headsetIn());
        call.resolve(result);
    }

    static void voiceEnded() {
        IskraNativePlugin plugin = instance;
        if (plugin == null) return;
        plugin.abandonFocus();
        plugin.releaseRoute();
        plugin.setKeepAwake(false);
        plugin.notifyListeners("voiceEnded", new JSObject());
    }

    // ── Speaker or earpiece ──────────────────────────────────────────────────
    // A call's audio plays on the earpiece by default on Android; the web view can't choose an output itself.

    private AudioManager audioManager() {
        return (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    private static boolean isHeadset(int type) {
        return type == AudioDeviceInfo.TYPE_WIRED_HEADSET || type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
            || type == AudioDeviceInfo.TYPE_USB_HEADSET || type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
            || type == AudioDeviceInfo.TYPE_HEARING_AID
            || type == AudioDeviceInfo.TYPE_BLE_HEADSET;
    }

    private boolean headsetIn() {
        for (AudioDeviceInfo device : audioManager().getDevices(AudioManager.GET_DEVICES_OUTPUTS)) if (isHeadset(device.getType())) return true;
        return false;
    }

    private void applyRoute() {
        AudioManager audio = audioManager();
        boolean headset = headsetIn();
        if (Build.VERSION.SDK_INT >= 31) {
            // A headset: Android's own choice (it picks the headset).
            if (headset) {
                audio.clearCommunicationDevice();
                return;
            }
            int want = speakerWanted ? AudioDeviceInfo.TYPE_BUILTIN_SPEAKER : AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
            for (AudioDeviceInfo device : audio.getAvailableCommunicationDevices()) {
                if (device.getType() == want) {
                    audio.setCommunicationDevice(device);
                    return;
                }
            }
        } else {
            audio.setSpeakerphoneOn(speakerWanted && !headset);
        }
    }

    /** A headset plugged in or out, or the web view's call audio starting: the choice is applied again. */
    private void watchRoute() {
        AudioManager audio = audioManager();
        if (deviceWatch == null) {
            deviceWatch = new AudioDeviceCallback() {
                @Override
                public void onAudioDevicesAdded(AudioDeviceInfo[] added) { routeChanged(); }

                @Override
                public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) { routeChanged(); }
            };
            audio.registerAudioDeviceCallback(deviceWatch, new Handler(Looper.getMainLooper()));
        }
        if (Build.VERSION.SDK_INT >= 31 && modeWatch == null) {
            modeWatch = mode -> applyRoute();
            audio.addOnModeChangedListener(getContext().getMainExecutor(), modeWatch);
        }
    }

    private void routeChanged() {
        applyRoute();
        JSObject data = new JSObject();
        data.put("headset", headsetIn());
        notifyListeners("voiceRoute", data);
    }

    private void releaseRoute() {
        AudioManager audio = audioManager();
        if (deviceWatch != null) audio.unregisterAudioDeviceCallback(deviceWatch);
        deviceWatch = null;
        if (Build.VERSION.SDK_INT >= 31) {
            if (modeWatch != null) audio.removeOnModeChangedListener(modeWatch);
            modeWatch = null;
            audio.clearCommunicationDevice();
        } else {
            audio.setSpeakerphoneOn(false);
        }
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
