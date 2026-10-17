using System.Collections.Concurrent;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// "Download my data": everything this server keeps about one account, as a zip (data.json and README.txt) behind a
/// short-lived link. End-to-end encrypted DMs and group messages are listed without their (unreadable) content.
/// Files are written to the world's exports/ folder, which backups leave out, and deleted when the link expires.
/// </summary>
public sealed class DataExports(TimeProvider time, ILogger<DataExports> log)
{
    public static readonly TimeSpan LinkLifetime = TimeSpan.FromMinutes(10);
    public const string FolderName = "exports";

    private sealed record Made(string Path, string FileName, DateTimeOffset Expires);

    private readonly ConcurrentDictionary<string, Made> _made = new();
    private readonly SemaphoreSlim _busy = new(1, 1);

    public sealed record Result(string Token, string FileName, long Size, long ExpiresAt);

    /// <summary>Null when another export is being made right now.</summary>
    public async Task<Result?> CreateAsync(World world, string accountKey, string requester, long now)
    {
        if (!await _busy.WaitAsync(0)) return null;
        try
        {
            Expire();
            var folder = Path.Combine(world.Path, FolderName);
            AtomicFile.CreatePrivateDirectory(folder);
            var token = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(32));
            var path = Path.Combine(folder, $"{Guid.NewGuid():N}.zip");
            await Task.Run(() => Write(world, accountKey, requester, now, path));
            var fileName = $"iskra-data-{DateTimeOffset.FromUnixTimeMilliseconds(now):yyyy-MM-dd}.zip";
            var expires = time.GetUtcNow() + LinkLifetime;
            _made[token] = new Made(path, fileName, expires);
            return new Result(token, fileName, new FileInfo(path).Length, expires.ToUnixTimeMilliseconds());
        }
        finally
        {
            _busy.Release();
        }
    }

    /// <summary>GET /export/{token}: the zip as a download (any number of times until the link expires), or 404.</summary>
    public IResult Serve(HttpContext context, string token)
    {
        Files.Uploads.AllowCors(context);
        Expire();
        if (!_made.TryGetValue(token, out var made) || !File.Exists(made.Path)) return Results.NotFound();
        context.Response.Headers.XContentTypeOptions = "nosniff";
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.ContentSecurityPolicy = "default-src 'none'; sandbox";
        return Results.File(made.Path, "application/zip", made.FileName);
    }

    /// <summary>Deletes expired exports (also called by the RetentionSweeper).</summary>
    public void Expire()
    {
        var now = time.GetUtcNow();
        foreach (var (token, made) in _made)
        {
            if (made.Expires > now || !_made.TryRemove(token, out _)) continue;
            try { File.Delete(made.Path); }
            catch (IOException ex) { log.LogInformation("Couldn't delete an expired export yet: {Message}", ex.Message); }
        }
    }

    /// <summary>Leftovers from before a restart: their links are gone with the process.</summary>
    public static void CleanUp(World world)
    {
        var folder = Path.Combine(world.Path, FolderName);
        if (!Directory.Exists(folder)) return;
        foreach (var file in Directory.EnumerateFiles(folder))
            try { File.Delete(file); } catch (IOException) { }
    }

    internal static void Write(World world, string accountKey, string requester, long now, string path)
    {
        using var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write);
        using var zip = new ZipArchive(file, ZipArchiveMode.Create);
        using (var entry = zip.CreateEntry("data.json", CompressionLevel.Optimal).Open())
        using (var json = new Utf8JsonWriter(entry, new JsonWriterOptions { Indented = true }))
            WriteJson(world, accountKey, requester, now, json);
        using (var readme = new StreamWriter(zip.CreateEntry("README.txt").Open()))
            readme.Write(Readme);
    }

    private static void WriteJson(World world, string accountKey, string requester, long now, Utf8JsonWriter json)
    {
        var store = world.Store;
        // Earlier keys of the same account (after "Replace account key") count as the same person.
        var keys = KeyFeature.ChainTo(store, accountKey).Select(r => r.Rotation.OldKey).Append(accountKey).Distinct().ToList();
        var k = ("$keys", (object?)JsonSerializer.Serialize(keys));
        const string Mine = "IN (SELECT value FROM json_each($keys))";

        json.WriteStartObject();
        json.WriteString("format", "iskra-data-export/v1");
        json.WriteNumber("exportedAt", now);
        json.WriteString("accountKey", accountKey);
        json.WriteStartArray("earlierKeys");
        foreach (var old in keys.Where(x => x != accountKey)) json.WriteStringValue(old);
        json.WriteEndArray();
        if (requester != accountKey) json.WriteString("exportedBy", requester);
        json.WriteStartObject("server");
        json.WriteString("name", world.Settings.Name);
        json.WriteString("key", Ed25519.ToB64u(world.ServerPublicKey));
        json.WriteEndObject();

        void Section(string name, string sql)
        {
            json.WritePropertyName(name);
            store.WriteRows(json, sql, k);
        }

        Section("membership", $"SELECT account_key, name, role, joined_at FROM members WHERE account_key {Mine};");
        // Asked to join through an approval invite (JoinFeature): the invite only by its tail, never the whole code.
        Section("joinRequest", $"SELECT account_key, name, substr(invite_code, -6) AS invite_tail, role, requested_at, declined_at FROM join_requests WHERE account_key {Mine};");
        Section("nickname", $"SELECT account_key, nick FROM nicknames WHERE account_key {Mine};");
        Section("serverAvatar", $"SELECT account_key, file_id, set_at FROM member_avatars WHERE account_key {Mine};");
        Section("customRoles", $"SELECT mr.account_key, r.id, r.name FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.account_key {Mine};");
        Section("profile", $"SELECT account_key, bio, pronouns, accent, avatar_file FROM profiles WHERE account_key {Mine};");
        Section("profilePage", $"SELECT account_key, page_id, html, updated_at FROM profile_pages WHERE account_key {Mine};");
        Section("profileStamp", $"SELECT account_key, updated_at, by FROM profile_stamps WHERE account_key {Mine};");
        Section("presence", $"SELECT account_key, status, emoji, text, expires_at, updated_at FROM presence WHERE account_key {Mine};");
        Section("syncedSettings", $"SELECT account_key, name, data, updated_at FROM account_prefs WHERE account_key {Mine};");
        Section("notificationSettings", $"SELECT account_key, channel_id, level, muted_until FROM notify_settings WHERE account_key {Mine};");
        Section("alertSettings", $"SELECT account_key, words, follows, quiet, quiet_since, updated_at FROM alert_settings WHERE account_key {Mine};");
        Section("rulesAccepted", $"SELECT account_key, version, at FROM rules_accepted WHERE account_key {Mine};");
        // Notes you wrote as a moderator are yours; notes about you are the moderators' (like reports about you).
        Section("moderatorNotesWritten", $"SELECT id, account_key AS about, text, created_at FROM mod_notes WHERE author_key {Mine} ORDER BY id;");
        Section("departure", $"SELECT account_key, name, reason, at FROM departures WHERE account_key {Mine};");
        Section("devices", $"SELECT account_key, device_key, name, platform, created, last_seen FROM devices WHERE account_key {Mine};");
        Section("removedDevices", $"SELECT account_key, device_key, revoked_at FROM device_revocations WHERE account_key {Mine};");
        Section("pushSubscriptions", $"SELECT account_key, device_key, created_at, updated_at FROM push_subscriptions WHERE account_key {Mine};");
        Section("blockList", $"SELECT account_key, blocked_key, blocked, at FROM blocks WHERE account_key {Mine};");
        Section("keyRotations", $"SELECT old_key, new_key, rotated_at, applied_at, contested_at, resolved_at FROM account_rotations WHERE old_key {Mine} OR new_key {Mine};");
        Section("accountDeletion", $"SELECT account_key, deleted_at, messages, applied_at FROM account_deletions WHERE account_key {Mine};");
        Section("messages", $"""
            SELECT m.id, m.channel_id, c.name AS channel_name, m.author_key, m.text, m.created_at, m.edited_at, m.attachments, m.reply_to
            FROM messages m LEFT JOIN channels c ON c.id = m.channel_id WHERE m.author_key {Mine} ORDER BY m.id;
            """);
        // Encrypted channels: the server only has ciphertext, so only which channel, when, which key version and how big.
        Section("encryptedChannelMessages", $"""
            SELECT m.id, m.channel_id, c.name AS channel_name, e.version, length(e.envelope) AS envelope_bytes, m.created_at, m.edited_at
            FROM messages m JOIN e2ee_messages e ON e.message_id = m.id LEFT JOIN channels c ON c.id = m.channel_id
            WHERE m.author_key {Mine} ORDER BY m.id;
            """);
        Section("encryptedChannels", $"""
            SELECT e.channel_id, c.name AS channel_name, e.version, x.version AS changed_at_version, x.created_at
            FROM e2ee_changes x JOIN e2ee_channels e ON e.channel_id = x.channel_id LEFT JOIN channels c ON c.id = e.channel_id
            WHERE x.by_key {Mine} ORDER BY x.channel_id, x.version;
            """);
        Section("editHistory", $"""
            SELECT e.message_id, e.text, e.written_at FROM message_edits e JOIN messages m ON m.id = e.message_id
            WHERE m.author_key {Mine} ORDER BY e.id;
            """);
        Section("docsPages", $"""
            SELECT p.id, p.channel_id, c.name AS channel_name, p.title, p.created_by, p.created_at, p.updated_by, p.updated_at
            FROM doc_pages p LEFT JOIN channels c ON c.id = p.channel_id WHERE p.created_by {Mine} OR p.updated_by {Mine} ORDER BY p.id;
            """);
        Section("docsRevisions", $"""
            SELECT r.page_id, p.title AS page_title, r.version, r.title, r.text, r.author, r.created_at, r.restored_from
            FROM doc_revisions r LEFT JOIN doc_pages p ON p.id = r.page_id WHERE r.author {Mine} ORDER BY r.page_id, r.version;
            """);
        // Whiteboards: batches not yet folded into a snapshot (folded ones keep no author). Encrypted ones only by size.
        Section("whiteboardBatches", $"""
            SELECT b.channel_id, c.name AS channel_name, b.seq, b.created_at, CASE WHEN b.version IS NULL THEN b.data END AS ops,
                b.version, length(b.data) AS bytes
            FROM wb_batches b LEFT JOIN channels c ON c.id = b.channel_id WHERE b.author {Mine} ORDER BY b.channel_id, b.seq;
            """);
        Section("reactions", $"SELECT message_id, account_key, emoji, created_at FROM reactions WHERE account_key {Mine} ORDER BY created_at;");
        Section("botCommandsUsed", $"SELECT message_id, interaction_id, user_key, command FROM bot_interaction_messages WHERE user_key {Mine} ORDER BY message_id;");
        Section("pollVotes", $"SELECT message_id, account_key, option, created_at FROM poll_votes WHERE account_key {Mine};");
        Section("eventInterest", $"SELECT event_id, account_key, created_at FROM event_interest WHERE account_key {Mine};");
        Section("lfgJoined", $"SELECT message_id, account_key, joined_at FROM lfg_members WHERE account_key {Mine} ORDER BY joined_at;");
        Section("lfgNotify", $"SELECT account_key, created_at FROM lfg_notify WHERE account_key {Mine};");
        Section("teamSplitsStarted", $"SELECT id, channel_id, game, created_by, created_at FROM team_splits WHERE created_by {Mine};");
        Section("uploads", $"SELECT id, name, size, type, sha256, uploader, created_at FROM files WHERE uploader {Mine} ORDER BY created_at;");
        Section("directMessages", $"SELECT id, from_key, to_key, created_at FROM dms WHERE from_key {Mine} OR to_key {Mine} ORDER BY id;");
        Section("botDmSetting", $"SELECT account_key, allow, at FROM bot_dm_prefs WHERE account_key {Mine};");
        Section("botConversations", $"SELECT bot_key, account_key, person_wrote, started_at FROM bot_dm_peers WHERE account_key {Mine} OR bot_key {Mine};");
        Section("groups", $"SELECT group_id, account_key FROM group_members WHERE account_key {Mine};");
        Section("groupMessagesSent", $"SELECT id, group_id, from_key, created_at FROM group_messages WHERE from_key {Mine} ORDER BY id;");
        Section("disappearingTimers", $"""
            SELECT 'channel' AS scope, CAST(channel_id AS TEXT) AS target, seconds, set_by, set_at FROM channel_disappear WHERE set_by {Mine}
            UNION ALL SELECT 'dm', first_key || ' ' || second_key, seconds, set_by, set_at FROM dm_disappear WHERE first_key {Mine} OR second_key {Mine}
            UNION ALL SELECT 'group', group_id, seconds, set_by, set_at FROM group_disappear
                WHERE group_id IN (SELECT group_id FROM group_members WHERE account_key {Mine}) OR set_by {Mine};
            """);
        // Reminders' data is sealed by your devices (what they're about and your note); the server only knows the rest.
        Section("reminders", $"SELECT id, account_key, due_at, channel_id, message_id, data, created_at, fired_at FROM reminders WHERE account_key {Mine} ORDER BY id;");
        // Built-in bots' answers to your commands (dice rolls, poll hints, reminder confirmations): what they meant, as JSON.
        Section("builtinBotAnswers", $"""
            SELECT r.message_id, m.channel_id, m.created_at, r.reply FROM builtin_replies r JOIN messages m ON m.id = r.message_id
            WHERE json_extract(r.reply, '$.for') {Mine} ORDER BY r.message_id;
            """);
        // Encrypted scheduled DMs and group messages are left out (the server can't read them); channel ones include their text.
        Section("scheduledMessages", $"""
            SELECT id, account_key, kind, channel_id, peer_key, group_id, text, reply_to, send_at, created_at, status, error
            FROM scheduled_messages WHERE account_key {Mine} ORDER BY id;
            """);
        Section("inbox", $"SELECT account_key, message_id, channel_id, kind, created_at FROM inbox_items WHERE account_key {Mine} ORDER BY message_id;");
        Section("invitesCreated", $"SELECT created_by, created_at, expires_at, max_uses, uses, role, revoked FROM invites WHERE created_by {Mine};");
        Section("outgoingWebhooksCreated", $"SELECT id, name, url, events, created_by, created_at FROM outgoing_webhooks WHERE created_by {Mine};");
        Section("serverImagesSet", $"SELECT kind, file_id, set_by, set_at FROM server_images WHERE set_by {Mine};");
        Section("timeouts", $"SELECT account_key, until, reason, at FROM timeouts WHERE account_key {Mine};");
        Section("bans", $"SELECT account_key, reason, banned_at FROM bans WHERE account_key {Mine};");
        Section("reportsMade", $"""
            SELECT id, at, kind, reason, note, target_key, target_name, message_id, channel_name, status, outcome, resolved_at
            FROM reports WHERE reporter_key {Mine} ORDER BY id;
            """);
        // Who reported you stays private (their own data); what was reported and the outcome don't.
        Section("reportsAboutYou", $"SELECT id, at, kind, reason, message_id, channel_name, status, outcome, resolved_at FROM reports WHERE target_key {Mine} ORDER BY id;");
        Section("auditLog", $"SELECT id, at, action, actor, actor_name, target, target_name, reason, details FROM audit_log WHERE actor {Mine} OR target {Mine} ORDER BY id;");
        Section("securityLog", $"SELECT id, at, event, account_key, ip, details FROM security_log WHERE account_key {Mine} ORDER BY id;");
        json.WriteEndObject();
    }

    private const string Readme = """
        Your data from an Iskra server
        ==============================

        data.json holds everything this server keeps about your account, by section:

        - membership, nickname, customRoles, profile, profilePage, presence: who you are on this server.
        - joinRequest: if you asked to join through an invite that needs a moderator's approval and they haven't decided
          (or turned you away in the last day): your name, the last characters of the invite, its role, when you asked.
        - syncedSettings, notificationSettings, rulesAccepted, blockList: your settings as the server keeps them.
        - alertSettings: alert words and follows (people and roles, per channel) you asked this server to watch for while
          Iskra is closed (only if you turned that on), and your quiet hours (days, times and time zone; only where your
          notifications while Iskra is closed are on; quiet_since: when the quiet stretch now running began, for the
          summary when it ends).
        - devices, removedDevices, pushSubscriptions, keyRotations, accountDeletion: your account's keys and devices
          (public keys only: your private keys never leave your devices).
        - messages, editHistory, reactions, pollVotes, eventInterest, uploads, invitesCreated: what you wrote and shared in server
          channels (editHistory: earlier versions of your edited messages).
          Uploaded files are listed by name, size and type; open them in the app or ask the owner for a full backup.
        - encryptedChannelMessages, encryptedChannels: messages in end-to-end encrypted channels are listed without their
          (unreadable) content: channel, time, key version and size. encryptedChannels lists the membership changes your
          app signed there. Their content is on your devices.
        - docsPages, docsRevisions: docs pages you made or last edited, and every saved version of a page you wrote
          (older versions may have gone: the server keeps 50 per page).
        - whiteboardBatches: changes you drew on whiteboards that the server hasn't folded into the board's snapshot yet
          (encrypted boards only by channel, time, key version and size). Folded changes keep no author.
        - directMessages, groups, groupMessagesSent: your direct messages and group chats are end-to-end encrypted, so the
          server only knows who wrote to whom and when. Their content is on your devices: in the app, use
          Settings -> Privacy & data -> Download data on this device.
        - disappearingTimers: disappearing message timers you set, and the ones of your DMs and groups (scope, which
          conversation, seconds, who set it and when). Messages that disappeared are gone from the server and aren't listed.
        - reminders, scheduledMessages, inbox: your reminders (what each is about is sealed by your devices: "data"), messages
          waiting to be sent later (encrypted DMs and group messages only by time and recipient), and messages that mentioned you.
          Reminders set with the built-in Reminders bot (/remind) aren't sealed: their "data" starts with "bot." and holds the note.
        - builtinBotAnswers: what the built-in bots (Dice, Polls, Reminders) answered to your commands.
        - timeouts, bans, reportsMade, reportsAboutYou, auditLog, securityLog: moderation and security records about you.
          Reports about you don't say who made them.

        Times are milliseconds since 1970-01-01 UTC. Account keys are base64url Ed25519 public keys.
        Questions about this data go to whoever runs this server.
        """;
}
