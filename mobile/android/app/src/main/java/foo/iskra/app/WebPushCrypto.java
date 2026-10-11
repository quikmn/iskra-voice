package foo.iskra.app;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPrivateKeySpec;
import java.security.spec.ECPublicKeySpec;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Web Push message decryption (RFC 8291, "aes128gcm" from RFC 8188) with the platform's ECDH, HMAC-SHA-256 and
 * AES-GCM. The Iskra server encrypts each push to this app's own P-256 key exactly as it does for a browser; the
 * push relay, Google and Apple only ever carry the ciphertext.
 */
final class WebPushCrypto {
    private static final int SALT = 16;
    private static final int HEADER = SALT + 4 + 1;
    private static final int POINT = 65;

    private WebPushCrypto() {}

    static ECParameterSpec p256() throws GeneralSecurityException {
        AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
        parameters.init(new ECGenParameterSpec("secp256r1"));
        return parameters.getParameterSpec(ECParameterSpec.class);
    }

    static ECPrivateKey privateKey(byte[] d) throws GeneralSecurityException {
        return (ECPrivateKey) KeyFactory.getInstance("EC").generatePrivate(new ECPrivateKeySpec(new BigInteger(1, d), p256()));
    }

    static ECPublicKey publicKey(byte[] point) throws GeneralSecurityException {
        if (point.length != POINT || point[0] != 4) throw new GeneralSecurityException("not an uncompressed P-256 point");
        ECPoint w = new ECPoint(new BigInteger(1, Arrays.copyOfRange(point, 1, 33)), new BigInteger(1, Arrays.copyOfRange(point, 33, 65)));
        return (ECPublicKey) KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(w, p256()));
    }

    /** The uncompressed point (0x04 || x || y) of a public key. */
    static byte[] encode(ECPublicKey key) {
        byte[] out = new byte[POINT];
        out[0] = 4;
        copyUnsigned(key.getW().getAffineX(), out, 1);
        copyUnsigned(key.getW().getAffineY(), out, 33);
        return out;
    }

    /** A private key's scalar as 32 bytes. */
    static byte[] encode(ECPrivateKey key) {
        byte[] out = new byte[32];
        copyUnsigned(key.getS(), out, 0);
        return out;
    }

    private static void copyUnsigned(BigInteger value, byte[] out, int offset) {
        byte[] bytes = value.toByteArray();
        int start = Math.max(0, bytes.length - 32);
        int length = bytes.length - start;
        System.arraycopy(bytes, start, out, offset + 32 - length, length);
    }

    /** Decrypts one push message. Throws for anything that isn't a valid single-record aes128gcm message for us. */
    static byte[] decrypt(byte[] message, ECPrivateKey uaPrivate, byte[] uaPublic, byte[] authSecret) throws GeneralSecurityException {
        if (message.length < HEADER + POINT + 17) throw new GeneralSecurityException("too short");
        byte[] salt = Arrays.copyOfRange(message, 0, SALT);
        int recordSize = ByteBuffer.wrap(message, SALT, 4).getInt();
        int idLength = message[SALT + 4] & 0xff;
        if (idLength != POINT) throw new GeneralSecurityException("unexpected key id");
        byte[] asPublic = Arrays.copyOfRange(message, HEADER, HEADER + POINT);
        byte[] ciphertext = Arrays.copyOfRange(message, HEADER + POINT, message.length);
        if (recordSize < 18 || ciphertext.length > recordSize) throw new GeneralSecurityException("one record only");

        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(uaPrivate);
        agreement.doPhase(publicKey(asPublic), true);
        byte[] ecdhSecret = agreement.generateSecret();

        // RFC 8291 section 3.4: IKM from the ECDH secret and the auth secret, then RFC 8188's key and nonce.
        byte[] prkKey = hmac(authSecret, ecdhSecret);
        byte[] keyInfo = concat("WebPush: info".getBytes(StandardCharsets.US_ASCII), new byte[] {0}, uaPublic, asPublic, new byte[] {1});
        byte[] ikm = hmac(prkKey, keyInfo);
        byte[] prk = hmac(salt, ikm);
        byte[] cek = Arrays.copyOf(hmac(prk, concat("Content-Encoding: aes128gcm".getBytes(StandardCharsets.US_ASCII), new byte[] {0, 1})), 16);
        byte[] nonce = Arrays.copyOf(hmac(prk, concat("Content-Encoding: nonce".getBytes(StandardCharsets.US_ASCII), new byte[] {0, 1})), 12);

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(cek, "AES"), new GCMParameterSpec(128, nonce));
        byte[] padded = cipher.doFinal(ciphertext);
        int end = padded.length - 1;
        while (end >= 0 && padded[end] == 0) end--;
        if (end < 0 || padded[end] != 2) throw new GeneralSecurityException("bad padding");
        return Arrays.copyOf(padded, end);
    }

    private static byte[] hmac(byte[] key, byte[] data) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return mac.doFinal(data);
    }

    private static byte[] concat(byte[]... parts) {
        int length = 0;
        for (byte[] part : parts) length += part.length;
        byte[] out = new byte[length];
        int offset = 0;
        for (byte[] part : parts) {
            System.arraycopy(part, 0, out, offset, part.length);
            offset += part.length;
        }
        return out;
    }
}
