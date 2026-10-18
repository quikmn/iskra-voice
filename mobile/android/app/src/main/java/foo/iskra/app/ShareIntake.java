package foo.iskra.app;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * "Share to Iskra" from other apps (ACTION_SEND / ACTION_SEND_MULTIPLE): the text and copies of the files, in the app's
 * cache folder, where the web view reads them (http://localhost/_capacitor_file_/…). Nothing is sent from here: the
 * page shows a picker and sends through its normal paths (client/src/state/shareIn.ts).
 */
final class ShareIntake {
    /** A message's attachment limit (PROTOCOL.md, chat.send). */
    static final int MAX_FILES = 10;
    /** Above every server's default upload limit (512 MB); the page checks the chosen server's own limit. */
    static final long MAX_FILE_BYTES = 1024L * 1024 * 1024;
    /** A message's text limit. */
    static final int MAX_TEXT = 4000;
    static final String HANDLED = "foo.iskra.app.shareHandled";

    private ShareIntake() {}

    static boolean isShare(Intent intent) {
        if (intent == null || intent.getBooleanExtra(HANDLED, false)) return false;
        // Opened again from the recents list: Android hands back the original share. It was handled then.
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return false;
        String action = intent.getAction();
        return Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action);
    }

    static File folder(Context context) {
        return new File(context.getCacheDir(), "shared");
    }

    static void clear(Context context) {
        File dir = folder(context);
        File[] files = dir.listFiles();
        if (files != null) for (File f : files) f.delete();
        dir.delete();
    }

    /** Reads the share (on a background thread: copying can take a while). Null when there's nothing usable. */
    static JSObject read(Context context, Intent intent, String localUrl) {
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        Set<Uri> uris = new LinkedHashSet<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Uri> list = Build.VERSION.SDK_INT >= 33
                ? intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class)
                : intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        } else {
            Uri one = Build.VERSION.SDK_INT >= 33 ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class) : intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (one != null) uris.add(one);
        }
        // Some apps put the files only in the ClipData (that's where the read grant is).
        ClipData clip = intent.getClipData();
        if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) {
            Uri uri = clip.getItemAt(i).getUri();
            if (uri != null) uris.add(uri);
        }

        clear(context);
        File dir = folder(context);
        dir.mkdirs();
        JSArray files = new JSArray();
        int skipped = 0;
        int n = 0;
        for (Uri uri : uris) {
            if (n >= MAX_FILES || !allowed(context, uri)) {
                skipped++;
                continue;
            }
            try {
                JSObject file = copy(context, uri, intent.getType(), new File(dir, (n + 1) + "-" + System.nanoTime()), localUrl);
                if (file == null) skipped++;
                else {
                    files.put(file);
                    n++;
                }
            } catch (IOException | RuntimeException e) {
                skipped++;
            }
        }

        JSObject share = new JSObject();
        share.put("id", Long.toString(System.currentTimeMillis()));
        if (text != null && text.length() > 0) share.put("text", limit(text.toString(), MAX_TEXT));
        if (subject != null && !subject.isEmpty()) share.put("subject", limit(subject, 200));
        share.put("files", files);
        share.put("skipped", skipped);
        if (files.length() == 0 && text == null && skipped == 0) return null;
        return share;
    }

    /**
     * Only content:// from other apps. Never file:// or our own providers: a share must not be able to pick files out of
     * the app's private folders (keys, the web view's storage) and post them.
     */
    private static boolean allowed(Context context, Uri uri) {
        if (!ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) return false;
        String authority = uri.getAuthority();
        if (authority == null) return false;
        ProviderInfo provider = context.getPackageManager().resolveContentProvider(authority, 0);
        return provider == null || !context.getPackageName().equals(provider.packageName);
    }

    private static JSObject copy(Context context, Uri uri, String intentType, File target, String localUrl) throws IOException {
        ContentResolver resolver = context.getContentResolver();
        String name = null;
        long declared = -1;
        try (Cursor c = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int si = c.getColumnIndex(OpenableColumns.SIZE);
                if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni);
                if (si >= 0 && !c.isNull(si)) declared = c.getLong(si);
            }
        } catch (RuntimeException e) {
            // Some providers don't answer queries; the copy below still works.
        }
        if (declared > MAX_FILE_BYTES) return null;
        String type = resolver.getType(uri);
        if (type == null || type.isEmpty() || type.endsWith("/*")) type = intentType != null && !intentType.endsWith("/*") ? intentType : null;
        if (name == null || name.trim().isEmpty()) name = uri.getLastPathSegment();
        name = cleanName(name, type);
        if (type == null) {
            int dot = name.lastIndexOf('.');
            String ext = dot >= 0 ? name.substring(dot + 1).toLowerCase() : "";
            type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        }
        if (type == null) type = "application/octet-stream";

        long size = 0;
        try (InputStream in = resolver.openInputStream(uri); OutputStream out = new FileOutputStream(target)) {
            if (in == null) return null;
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) > 0) {
                size += read;
                if (size > MAX_FILE_BYTES) break;
                out.write(buffer, 0, read);
            }
        }
        if (size > MAX_FILE_BYTES) {
            target.delete();
            return null;
        }
        JSObject file = new JSObject();
        file.put("name", name);
        file.put("type", type);
        file.put("size", size);
        file.put("url", localUrl + com.getcapacitor.Bridge.CAPACITOR_FILE_START + target.getAbsolutePath());
        return file;
    }

    /** A plain file name: no folders or control characters, not too long. */
    static String cleanName(String name, String type) {
        String cleaned = name == null ? "" : name.replaceAll("[\\x00-\\x1f\\x7f/\\\\:]+", "_").trim();
        if (cleaned.startsWith(".")) cleaned = cleaned.replaceFirst("^\\.+", "");
        if (cleaned.length() > 120) cleaned = cleaned.substring(cleaned.length() - 120);
        if (cleaned.isEmpty()) {
            String ext = type == null ? null : MimeTypeMap.getSingleton().getExtensionFromMimeType(type);
            cleaned = ext == null ? "file" : "file." + ext;
        }
        return cleaned;
    }

    private static String limit(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max);
    }
}
