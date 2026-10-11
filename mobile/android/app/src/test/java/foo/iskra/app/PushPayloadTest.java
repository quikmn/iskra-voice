package foo.iskra.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class PushPayloadTest {
    private static final String SERVER = "S".repeat(43);
    private static final String PEER = "P".repeat(43);
    private static final String GROUP = "g".repeat(22);

    private static String json(String extra) {
        return "{\"v\":1,\"server\":\"" + SERVER + "\",\"serverName\":\"Hangout\",\"title\":\"Alex in #general\",\"body\":\"hi\",\"tag\":\"c:5\",\"at\":1000" + extra + "}";
    }

    @Test
    public void routesLikeTheServiceWorker() {
        assertEquals("/open/" + SERVER + "/c/5", PushPayload.parse(json(",\"kind\":\"mention\",\"channelId\":5"), 0).route);
        assertEquals("/open/" + SERVER + "/dm/" + PEER, PushPayload.parse(json(",\"kind\":\"dm\",\"peer\":\"" + PEER + "\""), 0).route);
        assertEquals("/open/" + SERVER + "/g/" + GROUP, PushPayload.parse(json(",\"kind\":\"group\",\"group\":\"" + GROUP + "\""), 0).route);
        assertEquals("/open/" + SERVER + "/dm/" + PEER, PushPayload.parse(json(",\"kind\":\"call\",\"peer\":\"" + PEER + "\""), 0).route);
        assertEquals("/open/" + SERVER, PushPayload.parse(json(",\"kind\":\"event\""), 0).route);
        assertEquals("/open/" + SERVER, PushPayload.parse(json(",\"kind\":\"dm\",\"peer\":\"../../x\""), 0).route);
    }

    @Test
    public void readsTheNotification() {
        PushPayload p = PushPayload.parse(json(",\"kind\":\"call\",\"from\":\"Alex\",\"peer\":\"" + PEER + "\""), 0);
        assertTrue(p.valid);
        assertEquals("Alex in #general", p.title);
        assertEquals("hi", p.body);
        assertEquals("Hangout", p.serverName);
        assertEquals("Alex", p.caller());
        assertEquals(SERVER + ":c:5", p.notificationTag());
        assertEquals(1000, p.at);
        assertEquals(PEER, p.peer);
        assertNull(p.group);
        assertEquals("Alex in #general", PushPayload.parse(json(""), 0).caller());
        assertEquals(120, PushPayload.parse(json("").replace("Alex in #general", "x".repeat(500)), 0).title.length());
    }

    @Test
    public void anythingElseIsGeneric() {
        for (String bad : new String[] {"", "nope", "[]", "{\"v\":2}", json("").replace(SERVER, "short"), json("").replace("Alex in #general", "")}) {
            PushPayload p = PushPayload.parse(bad, 42);
            assertFalse(bad, p.valid);
            assertEquals("/", p.route);
            assertEquals(42, p.at);
        }
    }
}
