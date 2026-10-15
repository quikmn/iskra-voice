namespace Iskra.Server.Storage;

/// <summary>
/// Ids that never come back. Channels, categories and a few other tables use a plain INTEGER PRIMARY KEY, where SQLite
/// hands out MAX(id) + 1: delete the newest channel and the next one got its id, and a device that had cached the old
/// channel showed its messages in the new one. Each such table now keeps a floor (the highest id it ever gave out) and
/// every insert takes the next id above it, like AUTOINCREMENT, without rebuilding tables that others point at.
/// </summary>
public sealed partial class Store
{
    /// <summary>Tables whose ids are handed out above their floor.</summary>
    internal static readonly string[] FlooredTables = ["channels", "categories", "doc_pages", "events", "forum_tags", "team_splits"];

    /// <summary>SQL for the next id of a floored table (inside its INSERT, under the write lock).</summary>
    private static string NextId(string table) =>
        $"(SELECT MAX(COALESCE((SELECT MAX(id) FROM {table}), 0), COALESCE((SELECT floor FROM id_floors WHERE name = '{table}'), 0)) + 1)";

    // Existing worlds: start each floor at the highest id still mentioned anywhere, so ids deleted before this
    // version (still named in settings, reports, reminders, webhooks or the audit log) don't come back either.
    private const string IdFloorsMigration = """
        CREATE TABLE id_floors (
            name    TEXT PRIMARY KEY,
            floor   INTEGER NOT NULL
        );
        INSERT INTO id_floors (name, floor) VALUES ('channels', MAX(
            (SELECT COALESCE(MAX(id), 0) FROM channels),
            (SELECT COALESCE(MAX(channel_id), 0) FROM messages),
            (SELECT COALESCE(MAX(channel_id), 0) FROM notify_settings),
            (SELECT COALESCE(MAX(channel_id), 0) FROM pins),
            (SELECT COALESCE(MAX(channel_id), 0) FROM reminders),
            (SELECT COALESCE(MAX(channel_id), 0) FROM scheduled_messages),
            (SELECT COALESCE(MAX(channel_id), 0) FROM inbox_items),
            (SELECT COALESCE(MAX(channel_id), 0) FROM reports),
            (SELECT COALESCE(MAX(source_channel), 0) FROM message_forwards),
            (SELECT COALESCE(MAX(channel_id), 0) FROM team_splits),
            (SELECT COALESCE(MAX(CAST(j.value AS INTEGER)), 0) FROM outgoing_webhooks w, json_each(w.channels) j WHERE json_valid(w.channels)),
            (SELECT COALESCE(MAX(CAST(j.value AS INTEGER)), 0) FROM automod a, json_each(a.config, '$.exemptChannels') j WHERE json_valid(a.config)),
            (SELECT COALESCE(MAX(CAST(json_extract(config, '$.alertChannelId') AS INTEGER)), 0) FROM automod WHERE json_valid(config)),
            (SELECT COALESCE(MAX(CAST(json_extract(details, '$.channelId') AS INTEGER)), 0) FROM audit_log
                WHERE action LIKE 'channel.%' AND json_valid(details))));
        INSERT INTO id_floors (name, floor) SELECT 'categories', COALESCE(MAX(id), 0) FROM categories;
        INSERT INTO id_floors (name, floor) SELECT 'doc_pages', COALESCE(MAX(id), 0) FROM doc_pages;
        INSERT INTO id_floors (name, floor) SELECT 'events', COALESCE(MAX(id), 0) FROM events;
        INSERT INTO id_floors (name, floor) SELECT 'forum_tags', COALESCE(MAX(id), 0) FROM forum_tags;
        INSERT INTO id_floors (name, floor) SELECT 'team_splits', COALESCE(MAX(id), 0) FROM team_splits;
        CREATE TRIGGER id_floor_channels AFTER INSERT ON channels BEGIN
            UPDATE id_floors SET floor = MAX(floor, new.id) WHERE name = 'channels';
        END;
        CREATE TRIGGER id_floor_categories AFTER INSERT ON categories BEGIN
            UPDATE id_floors SET floor = MAX(floor, new.id) WHERE name = 'categories';
        END;
        CREATE TRIGGER id_floor_doc_pages AFTER INSERT ON doc_pages BEGIN
            UPDATE id_floors SET floor = MAX(floor, new.id) WHERE name = 'doc_pages';
        END;
        CREATE TRIGGER id_floor_events AFTER INSERT ON events BEGIN
            UPDATE id_floors SET floor = MAX(floor, new.id) WHERE name = 'events';
        END;
        CREATE TRIGGER id_floor_forum_tags AFTER INSERT ON forum_tags BEGIN
            UPDATE id_floors SET floor = MAX(floor, new.id) WHERE name = 'forum_tags';
        END;
        CREATE TRIGGER id_floor_team_splits AFTER INSERT ON team_splits BEGIN
            UPDATE id_floors SET floor = MAX(floor, new.id) WHERE name = 'team_splits';
        END;

        -- What names a channel without a foreign key goes with it (or forgets it), so nothing of a deleted channel
        -- can reach a later one. A scheduled message for it is not sent anywhere else.
        CREATE TRIGGER channel_gone_cleanup AFTER DELETE ON channels BEGIN
            DELETE FROM scheduled_messages WHERE kind = 'channel' AND channel_id = old.id;
            DELETE FROM inbox_items WHERE channel_id = old.id;
            DELETE FROM pins WHERE channel_id = old.id;
            UPDATE reminders SET channel_id = NULL WHERE channel_id = old.id;
            UPDATE outgoing_webhooks
                SET channels = (SELECT json_group_array(j.value) FROM json_each(outgoing_webhooks.channels) j WHERE j.value <> old.id)
                WHERE json_valid(channels) AND EXISTS (SELECT 1 FROM json_each(outgoing_webhooks.channels) j WHERE j.value = old.id);
            UPDATE automod
                SET config = json_set(config, '$.exemptChannels',
                    json((SELECT json_group_array(j.value) FROM json_each(automod.config, '$.exemptChannels') j WHERE j.value <> old.id)))
                WHERE json_valid(config) AND EXISTS (SELECT 1 FROM json_each(automod.config, '$.exemptChannels') j WHERE j.value = old.id);
            UPDATE automod SET config = json_set(config, '$.alertChannelId', json('null'))
                WHERE json_valid(config) AND json_extract(config, '$.alertChannelId') = old.id;
        END;

        -- Leftovers on existing worlds: anything still keyed by a channel that no longer exists.
        DELETE FROM messages WHERE channel_id NOT IN (SELECT id FROM channels);
        DELETE FROM channels WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM channels);
        DELETE FROM notify_settings WHERE channel_id <> 0 AND channel_id NOT IN (SELECT id FROM channels);
        DELETE FROM scheduled_messages WHERE kind = 'channel' AND channel_id NOT IN (SELECT id FROM channels);
        DELETE FROM inbox_items WHERE channel_id NOT IN (SELECT id FROM channels);
        DELETE FROM pins WHERE channel_id NOT IN (SELECT id FROM channels);
        UPDATE reminders SET channel_id = NULL WHERE channel_id NOT IN (SELECT id FROM channels);
        DELETE FROM channel_overrides WHERE channel_id NOT IN (SELECT id FROM channels);
        DELETE FROM channel_slowmode WHERE channel_id NOT IN (SELECT id FROM channels);
        DELETE FROM channel_topics WHERE channel_id NOT IN (SELECT id FROM channels);
        DELETE FROM channel_disappear WHERE channel_id NOT IN (SELECT id FROM channels);
        DELETE FROM voice_limits WHERE channel_id NOT IN (SELECT id FROM channels);
        DELETE FROM voice_hifi WHERE channel_id NOT IN (SELECT id FROM channels);
        DELETE FROM e2ee_channels WHERE channel_id NOT IN (SELECT id FROM channels);
        DELETE FROM e2ee_changes WHERE channel_id NOT IN (SELECT id FROM channels);
        DELETE FROM e2ee_keys WHERE channel_id NOT IN (SELECT id FROM channels);
        DELETE FROM threads WHERE channel_id NOT IN (SELECT id FROM channels);
        DELETE FROM forum_posts WHERE thread_id NOT IN (SELECT id FROM channels) OR forum_id NOT IN (SELECT id FROM channels);
        DELETE FROM forum_tags WHERE channel_id NOT IN (SELECT id FROM channels);
        DELETE FROM doc_pages WHERE channel_id NOT IN (SELECT id FROM channels);
        DELETE FROM webhooks WHERE channel_id NOT IN (SELECT id FROM channels);
        DELETE FROM imported_channels WHERE channel_id NOT IN (SELECT id FROM channels);
        DELETE FROM stage_moderators WHERE channel_id NOT IN (SELECT id FROM channels);
        DELETE FROM team_channels WHERE channel_id NOT IN (SELECT id FROM channels);
        DELETE FROM wb_boards WHERE channel_id NOT IN (SELECT id FROM channels);
        DELETE FROM wb_batches WHERE channel_id NOT IN (SELECT id FROM channels);
        DELETE FROM wb_files WHERE channel_id NOT IN (SELECT id FROM channels);
        UPDATE afk_settings SET channel_id = NULL WHERE channel_id NOT IN (SELECT id FROM channels);
        UPDATE bug_inbox SET channel_id = NULL WHERE channel_id NOT IN (SELECT id FROM channels);
        UPDATE events SET channel_id = NULL WHERE channel_id NOT IN (SELECT id FROM channels);
        UPDATE lfg_posts SET voice_channel_id = NULL WHERE voice_channel_id NOT IN (SELECT id FROM channels);
        UPDATE channels SET category_id = NULL WHERE category_id NOT IN (SELECT id FROM categories);
        UPDATE outgoing_webhooks
            SET channels = (SELECT json_group_array(j.value) FROM json_each(outgoing_webhooks.channels) j WHERE j.value IN (SELECT id FROM channels))
            WHERE json_valid(channels);
        UPDATE automod
            SET config = json_set(config, '$.exemptChannels',
                json((SELECT json_group_array(j.value) FROM json_each(automod.config, '$.exemptChannels') j WHERE j.value IN (SELECT id FROM channels))))
            WHERE json_valid(config) AND json_type(config, '$.exemptChannels') = 'array';
        UPDATE automod SET config = json_set(config, '$.alertChannelId', json('null'))
            WHERE json_valid(config) AND json_type(config, '$.alertChannelId') = 'integer'
                AND json_extract(config, '$.alertChannelId') NOT IN (SELECT id FROM channels);
        INSERT INTO messages_fts (messages_fts) VALUES ('rebuild');
        """;

    private long _channelDeletions;

    /// <summary>Goes up whenever channels are deleted, so caches of settings that name channels (AutoMod, outgoing webhooks) reload.</summary>
    public long ChannelDeletions => Interlocked.Read(ref _channelDeletions);

    private void ChannelsDeleted() => Interlocked.Increment(ref _channelDeletions);
}
