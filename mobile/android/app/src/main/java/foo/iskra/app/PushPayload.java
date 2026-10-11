package foo.iskra.app;

import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * A decrypted Iskra push (PROTOCOL.md, "Push notifications"): what the notification says and where a tap goes.
 * The same rules as the web app's service worker (client/public/push-sw.js).
 */
final class PushPayload {
    private static final Pattern KEY = Pattern.compile("^[A-Za-z0-9_-]{43}$");
    private static final Pattern GROUP = Pattern.compile("^[A-Za-z0-9_-]{22}$");

    final boolean valid;
    final String kind;
    final String server;
    final String serverName;
    final String title;
    final String body;
    final String tag;
    final String from;
    final String peer;
    final String group;
    final long at;
    /** The app route a tap opens ("/open/<server>/..."), as the web client's parseOpenRoute reads it. */
    final String route;

    private PushPayload(boolean valid, String kind, String server, String serverName, String title, String body, String tag,
                        String from, String peer, String group, long at, String route) {
        this.valid = valid;
        this.kind = kind;
        this.server = server;
        this.serverName = serverName;
        this.title = title;
        this.body = body;
        this.tag = tag;
        this.from = from;
        this.peer = peer;
        this.group = group;
        this.at = at;
        this.route = route;
    }

    /** Shown when a push can't be read (it shouldn't happen: only the right server can push through the relay). */
    static PushPayload generic(long now) {
        return new PushPayload(false, "note", "", "", "Iskra", "You have new activity.", "iskra", "", null, null, now, "/");
    }

    static PushPayload parse(String json, long now) {
        try {
            JSONObject o = new JSONObject(json);
            String server = o.optString("server", "");
            String title = o.optString("title", "");
            if (o.optInt("v") != 1 || !KEY.matcher(server).matches() || title.isEmpty()) return generic(now);
            String kind = o.optString("kind", "");
            String peer = o.optString("peer", "");
            String group = o.optString("group", "");
            long channelId = o.optLong("channelId", 0);
            boolean hasPeer = KEY.matcher(peer).matches();
            boolean hasGroup = GROUP.matcher(group).matches();
            long at = o.optLong("at", now);
            return new PushPayload(
                true,
                kind,
                server,
                clip(o.optString("serverName", ""), 100),
                clip(title, 120),
                clip(o.optString("body", ""), 300),
                clip(o.optString("tag", ""), 80),
                clip(o.optString("from", ""), 100),
                hasPeer ? peer : null,
                hasGroup ? group : null,
                at > 0 ? at : now,
                route(server, kind, hasPeer ? peer : null, hasGroup ? group : null, channelId)
            );
        } catch (JSONException e) {
            return generic(now);
        }
    }

    static String route(String server, String kind, String peer, String group, long channelId) {
        String base = "/open/" + server;
        if (group != null) return base + "/g/" + group;
        if ("dm".equals(kind) && peer != null) return base + "/dm/" + peer;
        if (channelId > 0 && channelId <= 9007199254740991L) return base + "/c/" + channelId;
        if (peer != null) return base + "/dm/" + peer;
        return base;
    }

    /** The name a call notification shows: the sender, or the title when an older server didn't send one. */
    String caller() {
        return from.isEmpty() ? title : from;
    }

    /** Pushes about the same conversation replace each other. */
    String notificationTag() {
        return server + ":" + tag;
    }

    private static String clip(String value, int max) {
        return value.length() <= max ? value : value.substring(0, max);
    }
}
