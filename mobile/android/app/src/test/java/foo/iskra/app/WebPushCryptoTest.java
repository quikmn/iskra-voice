package foo.iskra.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.interfaces.ECPrivateKey;
import java.util.Base64;
import org.junit.Test;

public class WebPushCryptoTest {
    private static byte[] b64u(String s) {
        return Base64.getUrlDecoder().decode(s);
    }

    // RFC 8291, appendix A.
    private static final byte[] UA_PRIVATE = b64u("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94");
    private static final byte[] UA_PUBLIC = b64u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
    private static final byte[] AUTH = b64u("BTBZMqHH6r4Tts7J_aSIgg");
    private static final byte[] MESSAGE = b64u(
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");

    @Test
    public void decryptsTheRfcExample() throws GeneralSecurityException {
        byte[] plain = WebPushCrypto.decrypt(MESSAGE, WebPushCrypto.privateKey(UA_PRIVATE), UA_PUBLIC, AUTH);
        assertEquals("When I grow up, I want to be a watermelon", new String(plain, StandardCharsets.UTF_8));
    }

    @Test
    public void keysRoundTrip() throws GeneralSecurityException {
        ECPrivateKey key = WebPushCrypto.privateKey(UA_PRIVATE);
        assertArrayEquals(UA_PRIVATE, WebPushCrypto.encode(key));
        assertArrayEquals(UA_PUBLIC, WebPushCrypto.encode(WebPushCrypto.publicKey(UA_PUBLIC)));
    }

    @Test
    public void refusesTamperedOrForeignMessages() throws GeneralSecurityException {
        ECPrivateKey key = WebPushCrypto.privateKey(UA_PRIVATE);
        byte[] tampered = MESSAGE.clone();
        tampered[tampered.length - 1] ^= 1;
        assertThrows(GeneralSecurityException.class, () -> WebPushCrypto.decrypt(tampered, key, UA_PUBLIC, AUTH));
        byte[] otherAuth = AUTH.clone();
        otherAuth[0] ^= 1;
        assertThrows(GeneralSecurityException.class, () -> WebPushCrypto.decrypt(MESSAGE, key, UA_PUBLIC, otherAuth));
        assertThrows(GeneralSecurityException.class, () -> WebPushCrypto.decrypt(new byte[40], key, UA_PUBLIC, AUTH));
    }
}
