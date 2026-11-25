import EventKit
import Foundation

/// A server's scheduled events in the phone's own calendar (EventKit), for IskraNative's calendar methods.
/// Only events this app added are read, changed or deleted: their `url` starts with "iskra://event/".
/// Everything except `access` runs on `queue`, one call at a time.
enum PhoneCalendar {
    static let denied = "calendar_denied"
    static let gone = "calendar_gone"
    static let failed = "calendar_failed"

    /** A failure the page is told about by its code only. */
    struct Failure: Error {
        let code: String
    }

    /** What calendarSave takes. */
    struct Event {
        var calendarId: String
        var eventId: String?
        var ref: String
        var title: String
        var description: String
        var location: String
        var startMs: Double
        var endMs: Double
        var timeZone: String
        var rrule: String?
    }

    static let queue = DispatchQueue(label: "foo.iskra.app.calendar")
    /** Every event of ours has a url that starts with this. */
    private static let marker = "iskra://event/"
    /** One store for the app: the one that asked for access also sees the calendars afterwards. */
    private static let store = EKEventStore()

    /** Full access: write-only access can't find an event again to change or delete it. */
    static var granted: Bool {
        let status = EKEventStore.authorizationStatus(for: .event)
        if #available(iOS 17.0, *) { return status == .fullAccess }
        return status == .authorized
    }

    /** Whether the app may read and write calendars. Only `ask` shows the system's question, and only while it's undecided. */
    static func access(ask: Bool, done: @escaping (Bool) -> Void) {
        if granted || !ask {
            done(granted)
            return
        }
        guard EKEventStore.authorizationStatus(for: .event) == .notDetermined else {
            done(false)
            return
        }
        if #available(iOS 17.0, *) {
            store.requestFullAccessToEvents { _, _ in done(granted) }
        } else {
            store.requestAccess(to: .event) { _, _ in done(granted) }
        }
    }

    /** The calendars events can be added to. */
    static func list() throws -> [[String: Any]] {
        guard granted else { throw Failure(code: denied) }
        let primary = store.defaultCalendarForNewEvents?.calendarIdentifier
        return store.calendars(for: .event).filter { $0.allowsContentModifications }.map { calendar -> [String: Any] in
            [
                "id": calendar.calendarIdentifier,
                "name": calendar.title,
                "account": calendar.source?.title ?? "",
                "primary": calendar.calendarIdentifier == primary,
            ]
        }
    }

    /**
     * Adds the event to the calendar, or changes the one with `eventId` in place when it still exists and is ours.
     * Answers with the event's identifier (it can change when the event moves to another calendar).
     */
    static func save(_ input: Event) throws -> String {
        guard granted else { throw Failure(code: denied) }
        guard let calendar = store.calendar(withIdentifier: input.calendarId), calendar.allowsContentModifications else {
            throw Failure(code: gone)
        }
        guard input.ref.hasPrefix(marker), let url = URL(string: input.ref), input.endMs >= input.startMs,
              let zone = TimeZone(identifier: input.timeZone) else {
            throw Failure(code: failed)
        }
        var rule: EKRecurrenceRule?
        if let text = input.rrule, !text.isEmpty {
            guard let parsed = recurrence(text) else { throw Failure(code: failed) }
            rule = parsed
        }

        // An event that is gone, or one that isn't ours, is left alone and a new one is added.
        let event: EKEvent
        if let id = input.eventId, !id.isEmpty, let found = store.event(withIdentifier: id), isOurs(found) {
            event = found
        } else {
            event = EKEvent(eventStore: store)
        }
        event.calendar = calendar
        event.title = input.title
        event.notes = input.description.isEmpty ? nil : input.description
        event.location = input.location.isEmpty ? nil : input.location
        event.isAllDay = false
        event.timeZone = zone
        event.startDate = Date(timeIntervalSince1970: input.startMs / 1000)
        event.endDate = Date(timeIntervalSince1970: input.endMs / 1000)
        event.url = url
        // No alarms of ours: the calendar's own defaults apply where iOS adds them.
        event.recurrenceRules = rule.map { [$0] }
        do {
            try store.save(event, span: .futureEvents, commit: true)
        } catch {
            store.reset()
            throw Failure(code: failed)
        }
        guard let saved = event.eventIdentifier else { throw Failure(code: failed) }
        return saved
    }

    /** Deletes the ones that still exist and are ours (a repeating event with all its occurrences). Answers how many. */
    static func delete(_ eventIds: [String]) throws -> Int {
        guard granted else { throw Failure(code: denied) }
        var deleted = 0
        for id in eventIds where !id.isEmpty {
            guard let event = store.event(withIdentifier: id), isOurs(event) else { continue }
            do {
                try store.remove(event, span: .futureEvents, commit: true)
                deleted += 1
            } catch {
                store.reset()
            }
        }
        return deleted
    }

    private static func isOurs(_ event: EKEvent) -> Bool {
        event.url?.absoluteString.hasPrefix(marker) == true
    }

    /**
     * An RFC 5545 rule as the page sends it: "FREQ=DAILY|WEEKLY|MONTHLY", optionally ";INTERVAL=n" and
     * ";UNTIL=yyyyMMddTHHmmssZ" (UTC). Nil for anything else.
     */
    private static func recurrence(_ text: String) -> EKRecurrenceRule? {
        var frequency: EKRecurrenceFrequency?
        var interval = 1
        var end: EKRecurrenceEnd?
        for part in text.split(separator: ";") {
            let pair = part.split(separator: "=", maxSplits: 1).map(String.init)
            guard pair.count == 2 else { return nil }
            switch pair[0] {
            case "FREQ":
                switch pair[1] {
                case "DAILY": frequency = .daily
                case "WEEKLY": frequency = .weekly
                case "MONTHLY": frequency = .monthly
                default: return nil
                }
            case "INTERVAL":
                guard let n = Int(pair[1]), n >= 1, n <= 999 else { return nil }
                interval = n
            case "UNTIL":
                let format = DateFormatter()
                format.locale = Locale(identifier: "en_US_POSIX")
                format.timeZone = TimeZone(identifier: "UTC")
                format.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
                guard let until = format.date(from: pair[1]) else { return nil }
                end = EKRecurrenceEnd(end: until)
            default:
                return nil
            }
        }
        guard let frequency else { return nil }
        return EKRecurrenceRule(recurrenceWith: frequency, interval: interval, end: end)
    }
}
