namespace Iskra.Server.Storage;

/// <summary>Someone whose messages were imported (shown by name, never a real account here).</summary>
public sealed record ImportedAuthor(string AuthorKey, string Source, string Name, string? AvatarFile, bool Bot);

/// <summary>What an imported message carries beyond a normal one: reaction counts and files that weren't in the export.</summary>
public sealed record ImportedPost(long MessageId, string Source, string OriginalId, string? Reactions, string? Missing);

/// <summary>One message to import. <see cref="ReplyTo"/> is the original (source) id of the message it answers.</summary>
public sealed record ImportRow(string OriginalId, string AuthorKey, string Text, long CreatedAt, long? EditedAt, string[] Attachments,
    string? ReplyTo, string? Reactions, string? Missing, bool Pinned);

public sealed partial class Store
{
    private const string ImportMigration = """
        CREATE TABLE imported_authors (
            author_key  TEXT PRIMARY KEY,
            source      TEXT NOT NULL,
            name        TEXT NOT NULL,
            avatar_file TEXT,
            bot         INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE imported_messages (
            message_id  INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            source      TEXT NOT NULL,
            original_id TEXT NOT NULL,
            reactions   TEXT,
            missing     TEXT
        );
        CREATE TABLE imported_channels (
            channel_id  INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
            source      TEXT NOT NULL,
            original_id TEXT NOT NULL,
            category    TEXT,
            guild       TEXT,
            imported_at INTEGER NOT NULL
        );
        """;

    public void UpsertImportedAuthor(ImportedAuthor a) =>
        Exec("""
            INSERT INTO imported_authors (author_key, source, name, avatar_file, bot) VALUES ($k, $src, $name, $avatar, $bot)
            ON CONFLICT(author_key) DO UPDATE SET name = excluded.name, avatar_file = COALESCE(excluded.avatar_file, avatar_file), bot = excluded.bot;
            """, ("$k", a.AuthorKey), ("$src", a.Source), ("$name", a.Name), ("$avatar", a.AvatarFile), ("$bot", a.Bot ? 1 : 0));

    public ImportedAuthor? GetImportedAuthor(string authorKey) =>
        Query("SELECT author_key, source, name, avatar_file, bot FROM imported_authors WHERE author_key = $k;",
            r => new ImportedAuthor(r.GetString(0), r.GetString(1), r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3), r.GetInt32(4) != 0),
            ("$k", authorKey)).FirstOrDefault();

    public ImportedPost? GetImportedPost(long messageId) =>
        Query("SELECT message_id, source, original_id, reactions, missing FROM imported_messages WHERE message_id = $m;",
            r => new ImportedPost(r.GetInt64(0), r.GetString(1), r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3), r.IsDBNull(4) ? null : r.GetString(4)),
            ("$m", messageId)).FirstOrDefault();

    public void MarkImportedChannel(long channelId, string source, string originalId, string? category, string? guild, long now) =>
        Exec("""
            INSERT OR REPLACE INTO imported_channels (channel_id, source, original_id, category, guild, imported_at)
            VALUES ($ch, $src, $orig, $cat, $guild, $now);
            """, ("$ch", channelId), ("$src", source), ("$orig", originalId), ("$cat", category), ("$guild", guild), ("$now", now));

    /// <summary>The source category an imported channel came from (e.g. its Discord category), if any.</summary>
    public string? ImportedCategory(long channelId) =>
        Scalar("SELECT category FROM imported_channels WHERE channel_id = $ch;", ("$ch", channelId)) as string;

    /// <summary>
    /// Stores a batch of imported messages in one transaction, oldest first. <paramref name="ids"/> maps source ids to
    /// (message id, channel id); it's read for replies and pins and filled in as messages are added.
    /// Replies to messages in other channels, or not imported, become plain messages. Returns the new message ids.
    /// </summary>
    public List<long> ImportMessages(long channelId, string source, IReadOnlyList<ImportRow> rows, Dictionary<string, (long Id, long Channel)> ids,
        string pinnedBy, int maxPins)
    {
        lock (_gate)
        {
            Exec("BEGIN IMMEDIATE;");
            try
            {
                var added = new List<long>(rows.Count);
                var pins = Convert.ToInt32(Scalar("SELECT COUNT(*) FROM pins WHERE channel_id = $ch;", ("$ch", channelId)));
                foreach (var row in rows)
                {
                    long? replyTo = row.ReplyTo is { } r && ids.TryGetValue(r, out var target) && target.Channel == channelId ? target.Id : null;
                    var id = Convert.ToInt64(Scalar("""
                        INSERT INTO messages (channel_id, author_key, text, created_at, edited_at, attachments, reply_to)
                        VALUES ($ch, $author, $text, $at, $edited, $att, $reply) RETURNING id;
                        """, ("$ch", channelId), ("$author", row.AuthorKey), ("$text", row.Text), ("$at", row.CreatedAt), ("$edited", row.EditedAt),
                        ("$att", row.Attachments.Length == 0 ? null : System.Text.Json.JsonSerializer.Serialize(row.Attachments)), ("$reply", replyTo)));
                    Exec("INSERT INTO imported_messages (message_id, source, original_id, reactions, missing) VALUES ($m, $src, $orig, $re, $miss);",
                        ("$m", id), ("$src", source), ("$orig", row.OriginalId), ("$re", row.Reactions), ("$miss", row.Missing));
                    if (row.Pinned && pins < maxPins)
                    {
                        Exec("INSERT INTO pins (message_id, channel_id, pinned_by, pinned_at) VALUES ($m, $ch, $by, $at);",
                            ("$m", id), ("$ch", channelId), ("$by", pinnedBy), ("$at", row.CreatedAt));
                        pins++;
                    }
                    ids[row.OriginalId] = (id, channelId);
                    added.Add(id);
                }
                Exec("COMMIT;");
                return added;
            }
            catch
            {
                Exec("ROLLBACK;");
                throw;
            }
        }
    }

    /// <summary>The first owner, if the server has one (imports from the command line pin on their behalf).</summary>
    public string? OwnerKey() => Scalar("SELECT account_key FROM members WHERE role = 'owner' ORDER BY joined_at LIMIT 1;") as string;

    public bool ChannelNameTaken(string name) =>
        Scalar("SELECT 1 FROM channels WHERE parent_id IS NULL AND name = $n;", ("$n", name)) is not null;
}
