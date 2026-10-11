package foo.iskra.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.SecureRandom;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;

/**
 * This install's Web Push keys: a P-256 key pair and a 16-byte auth secret, like a browser's push subscription.
 * Kept in the app's private storage (backups are off for the app); servers get the public half and the auth secret.
 */
final class PushKeys {
    private static final String FILE = "iskra.push";
    private static final int FLAGS = Base64.NO_WRAP | Base64.NO_PADDING | Base64.URL_SAFE;

    final ECPrivateKey privateKey;
    final byte[] publicKey;
    final byte[] auth;

    private PushKeys(ECPrivateKey privateKey, byte[] publicKey, byte[] auth) {
        this.privateKey = privateKey;
        this.publicKey = publicKey;
        this.auth = auth;
    }

    String p256dh() {
        return Base64.encodeToString(publicKey, FLAGS);
    }

    String authSecret() {
        return Base64.encodeToString(auth, FLAGS);
    }

    /** The saved keys, or null before the app first registered for push. */
    static synchronized PushKeys load(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
        String d = prefs.getString("d", null);
        String pub = prefs.getString("pub", null);
        String auth = prefs.getString("auth", null);
        if (d == null || pub == null || auth == null) return null;
        try {
            return new PushKeys(WebPushCrypto.privateKey(Base64.decode(d, FLAGS)), Base64.decode(pub, FLAGS), Base64.decode(auth, FLAGS));
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            return null;
        }
    }

    static synchronized PushKeys loadOrCreate(Context context) throws GeneralSecurityException {
        PushKeys existing = load(context);
        if (existing != null) return existing;
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair pair = generator.generateKeyPair();
        byte[] auth = new byte[16];
        new SecureRandom().nextBytes(auth);
        ECPrivateKey privateKey = (ECPrivateKey) pair.getPrivate();
        byte[] publicKey = WebPushCrypto.encode((ECPublicKey) pair.getPublic());
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
            .edit()
            .putString("d", Base64.encodeToString(WebPushCrypto.encode(privateKey), FLAGS))
            .putString("pub", Base64.encodeToString(publicKey, FLAGS))
            .putString("auth", Base64.encodeToString(auth, FLAGS))
            .commit();
        return new PushKeys(privateKey, publicKey, auth);
    }
}
