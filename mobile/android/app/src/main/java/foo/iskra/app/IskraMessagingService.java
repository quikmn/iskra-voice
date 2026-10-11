package foo.iskra.app;

import android.util.Base64;
import androidx.annotation.NonNull;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * Pushes from the Iskra push relay (FCM data messages, relay/): `e` is the server's encrypted Web Push body, `k` says
 * whether it rings. Decrypted here with this install's key, then shown as the notification.
 */
public class IskraMessagingService extends FirebaseMessagingService {
    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> data = message.getData();
        String encrypted = data.get("e");
        long now = System.currentTimeMillis();
        PushPayload payload = PushPayload.generic(now);
        PushKeys keys = PushKeys.load(this);
        if (encrypted != null && keys != null) {
            try {
                byte[] plain = WebPushCrypto.decrypt(Base64.decode(encrypted, Base64.DEFAULT), keys.privateKey, keys.publicKey, keys.auth);
                payload = PushPayload.parse(new String(plain, StandardCharsets.UTF_8), now);
            } catch (Exception e) {
                // Not for this install's key: the generic notification.
            }
        }
        if (payload.valid && "call".equals(payload.kind) && "call".equals(data.get("k"))) Notifications.showCall(this, payload);
        else Notifications.showMessage(this, payload);
    }

    @Override
    public void onNewToken(@NonNull String token) {
        IskraNativePlugin.tokenChanged();
    }
}
