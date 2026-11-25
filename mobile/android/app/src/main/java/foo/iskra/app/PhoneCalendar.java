package foo.iskra.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract.Calendars;
import android.provider.CalendarContract.Events;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.util.List;
import java.util.regex.Pattern;

/**
 * A server's scheduled events in the phone's own calendar (CalendarContract), for IskraNativePlugin's calendar methods.
 * Only events this app added are read, changed or deleted: they carry the app's package in CUSTOM_APP_PACKAGE and
 * "iskra://event/…" in CUSTOM_APP_URI. Every method here talks to the calendar provider, so none runs on the main thread.
 */
final class PhoneCalendar {
    static final String DENIED = "calendar_denied";
    static final String GONE = "calendar_gone";
    static final String FAILED = "calendar_failed";

    /** Every event of ours has a CUSTOM_APP_URI that starts with this. */
    private static final String MARKER = "iskra://event/";
    /** The recurrence rules the page sends (RFC 5545, without "RRULE:"). */
    private static final Pattern RRULE = Pattern.compile("FREQ=(DAILY|WEEKLY|MONTHLY)(;INTERVAL=[1-9][0-9]{0,2})?(;UNTIL=[0-9]{8}T[0-9]{6}Z)?");

    private PhoneCalendar() {}

    /** A failure the page is told about by its code only. */
    static final class Failure extends Exception {
        final String code;

        Failure(String code) {
            super(code);
            this.code = code;
        }
    }

    /** What calendarSave takes. */
    static final class Event {
        String calendarId;
        String eventId;
        String ref;
        String title;
        String description;
        String location;
        double startMs;
        double endMs;
        String timeZone;
        String rrule;
    }

    /** Both permissions: changing or deleting an event later needs to read it first. */
    static boolean allowed(Context context) {
        return ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED
            && ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_CALENDAR) == PackageManager.PERMISSION_GRANTED;
    }

    /** The calendars events can be added to (contributor access or more), local ones included. */
    static JSArray list(Context context) throws Failure {
        requireAccess(context);
        try {
            String[] columns = { Calendars._ID, Calendars.CALENDAR_DISPLAY_NAME, Calendars.ACCOUNT_NAME, Calendars.IS_PRIMARY,
                Calendars.CALENDAR_ACCESS_LEVEL, Calendars.VISIBLE };
            JSArray list = new JSArray();
            boolean anyPrimary = false;
            // Where no calendar is marked primary: the first visible one the person owns.
            int fallback = -1;
            try (Cursor rows = context.getContentResolver().query(Calendars.CONTENT_URI, columns, writable(), null, Calendars._ID + " ASC")) {
                if (rows == null) throw new Failure(FAILED);
                while (rows.moveToNext()) {
                    boolean primary = !rows.isNull(3) && rows.getInt(3) == 1;
                    if (primary) anyPrimary = true;
                    if (fallback < 0 && rows.getInt(4) >= Calendars.CAL_ACCESS_OWNER && rows.getInt(5) == 1) fallback = list.length();
                    JSObject item = new JSObject();
                    item.put("id", Long.toString(rows.getLong(0)));
                    item.put("name", text(rows.getString(1)));
                    item.put("account", text(rows.getString(2)));
                    item.put("primary", primary);
                    list.put(item);
                }
            }
            if (!anyPrimary && fallback >= 0) list.getJSONObject(fallback).put("primary", true);
            return list;
        } catch (Failure failure) {
            throw failure;
        } catch (SecurityException denied) {
            throw new Failure(DENIED);
        } catch (Exception other) {
            throw new Failure(FAILED);
        }
    }

    /**
     * Adds the event to the calendar, or changes the one with eventId in place when it still exists and is ours.
     * Answers with the event's id (a new one when it had to be added again).
     */
    static String save(Context context, Event event) throws Failure {
        requireAccess(context);
        try {
            long calendarId = id(event.calendarId);
            if (calendarId < 0 || !isWritable(context, calendarId)) throw new Failure(GONE);
            if (event.ref == null || !event.ref.startsWith(MARKER)) throw new Failure(FAILED);
            if (Double.isNaN(event.startMs) || Double.isNaN(event.endMs) || event.endMs < event.startMs) throw new Failure(FAILED);
            boolean recurring = event.rrule != null && !event.rrule.isEmpty();
            if (recurring && !RRULE.matcher(event.rrule).matches()) throw new Failure(FAILED);
            long start = (long) event.startMs;
            long end = (long) event.endMs;

            ContentValues values = new ContentValues();
            values.put(Events.TITLE, text(event.title));
            values.put(Events.DESCRIPTION, text(event.description));
            values.put(Events.EVENT_LOCATION, text(event.location));
            values.put(Events.DTSTART, start);
            values.put(Events.EVENT_TIMEZONE, event.timeZone == null || event.timeZone.isEmpty() ? "UTC" : event.timeZone);
            // A repeating event has a start and a duration, a single one a start and an end. The unused ones are set
            // to null, so an update that changes the kind doesn't leave both.
            if (recurring) {
                values.put(Events.DURATION, "PT" + ((end - start) / 1000) + "S");
                values.put(Events.RRULE, event.rrule);
                values.putNull(Events.DTEND);
            } else {
                values.put(Events.DTEND, end);
                values.putNull(Events.DURATION);
                values.putNull(Events.RRULE);
            }
            values.put(Events.CUSTOM_APP_PACKAGE, context.getPackageName());
            values.put(Events.CUSTOM_APP_URI, event.ref);

            ContentResolver resolver = context.getContentResolver();
            long existing = id(event.eventId);
            // -1: the event is gone or isn't ours, so a new one is added and the old one (if any) is left alone.
            long inCalendar = existing < 0 ? -1 : calendarOfOurs(context, existing);
            if (inCalendar == calendarId) {
                if (resolver.update(eventUri(existing), values, null, null) > 0) return Long.toString(existing);
            } else if (inCalendar >= 0) {
                // An event can't be moved to another calendar: it's deleted there and added here.
                resolver.delete(eventUri(existing), null, null);
            }
            values.put(Events.CALENDAR_ID, calendarId);
            // No reminder of ours: the calendar's own defaults apply where it adds them.
            values.put(Events.HAS_ALARM, 0);
            Uri added = resolver.insert(Events.CONTENT_URI, values);
            if (added == null) throw new Failure(FAILED);
            return Long.toString(ContentUris.parseId(added));
        } catch (Failure failure) {
            throw failure;
        } catch (SecurityException denied) {
            throw new Failure(DENIED);
        } catch (Exception other) {
            throw new Failure(FAILED);
        }
    }

    /** Deletes the ones that still exist and are ours (a repeating event with all its occurrences). Answers how many. */
    static int delete(Context context, List<String> eventIds) throws Failure {
        requireAccess(context);
        int deleted = 0;
        try {
            for (String eventId : eventIds) {
                long existing = id(eventId);
                if (existing < 0 || calendarOfOurs(context, existing) < 0) continue;
                if (context.getContentResolver().delete(eventUri(existing), null, null) > 0) deleted++;
            }
        } catch (SecurityException denied) {
            throw new Failure(DENIED);
        } catch (Exception other) {
            throw new Failure(FAILED);
        }
        return deleted;
    }

    private static void requireAccess(Context context) throws Failure {
        if (!allowed(context)) throw new Failure(DENIED);
    }

    private static String writable() {
        return Calendars.CALENDAR_ACCESS_LEVEL + " >= " + Calendars.CAL_ACCESS_CONTRIBUTOR + " AND " + Calendars.DELETED + " = 0";
    }

    private static boolean isWritable(Context context, long calendarId) {
        String where = Calendars._ID + " = ? AND " + writable();
        try (Cursor rows = context.getContentResolver().query(Calendars.CONTENT_URI, new String[] { Calendars._ID }, where,
            new String[] { Long.toString(calendarId) }, null)) {
            return rows != null && rows.moveToFirst();
        }
    }

    /** The calendar the event is in, when it exists and carries our marker; -1 otherwise. Reads nothing else of it. */
    private static long calendarOfOurs(Context context, long eventId) {
        String[] columns = { Events.CALENDAR_ID, Events.CUSTOM_APP_PACKAGE, Events.CUSTOM_APP_URI, Events.DELETED };
        try (Cursor rows = context.getContentResolver().query(eventUri(eventId), columns, null, null, null)) {
            if (rows == null || !rows.moveToFirst()) return -1;
            // Deleted in a synced calendar: the row stays until the next sync.
            if (!rows.isNull(3) && rows.getInt(3) != 0) return -1;
            String owner = rows.getString(1);
            String ref = rows.getString(2);
            if (!context.getPackageName().equals(owner) || ref == null || !ref.startsWith(MARKER)) return -1;
            return rows.getLong(0);
        }
    }

    private static Uri eventUri(long eventId) {
        return ContentUris.withAppendedId(Events.CONTENT_URI, eventId);
    }

    /** A calendar or event id as the provider has it; -1 for anything that isn't one. */
    private static long id(String value) {
        if (value == null || value.isEmpty() || value.length() > 18) return -1;
        for (int i = 0; i < value.length(); i++) if (value.charAt(i) < '0' || value.charAt(i) > '9') return -1;
        return Long.parseLong(value);
    }

    private static String text(String value) {
        return value == null ? "" : value;
    }
}
