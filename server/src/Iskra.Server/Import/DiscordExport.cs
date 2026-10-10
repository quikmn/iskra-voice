using System.Text.Json;

namespace Iskra.Server.Import;

// The parts of a DiscordChatExporter JSON export (2.x) the import uses. Everything else is skipped.
// Shape: { guild, channel, dateRange, exportedAt, messages: [...], messageCount }.

public sealed class DceGuild
{
    public string? Id { get; set; }
    public string? Name { get; set; }
}

public sealed class DceChannel
{
    public string? Id { get; set; }
    /// <summary>GuildTextChat, GuildNewsChat, GuildPublicThread, GuildPrivateThread, GuildVoiceChat, DirectTextChat, ...</summary>
    public string? Type { get; set; }
    /// <summary>The Discord category; for threads, the parent channel (the exporter's original schema predates threads).</summary>
    public string? CategoryId { get; set; }
    public string? Category { get; set; }
    public string? Name { get; set; }
    public string? Topic { get; set; }

    public bool IsThread => Type is "GuildPublicThread" or "GuildPrivateThread" or "GuildNewsThread";
}

public sealed class DceUser
{
    public string? Id { get; set; }
    public string? Name { get; set; }
    public string? Nickname { get; set; }
    public bool IsBot { get; set; }
    /// <summary>A Discord CDN URL, or a path to the downloaded file when the export was made with media.</summary>
    public string? AvatarUrl { get; set; }
}

public sealed class DceAttachment
{
    public string? Id { get; set; }
    public string? Url { get; set; }
    public string? FileName { get; set; }
    public long FileSizeBytes { get; set; }
}

public sealed class DceEmoji
{
    public string? Id { get; set; }
    public string? Name { get; set; }
}

public sealed class DceReaction
{
    public DceEmoji? Emoji { get; set; }
    public long Count { get; set; }
}

public sealed class DceEmbed
{
    public string? Title { get; set; }
    public string? Url { get; set; }
    public string? Description { get; set; }
}

public sealed class DceSticker
{
    public string? Name { get; set; }
}

public sealed class DceReference
{
    public string? MessageId { get; set; }
    public string? ChannelId { get; set; }
}

public sealed class DceForwarded
{
    public string? Content { get; set; }
    public List<DceAttachment>? Attachments { get; set; }
}

public sealed class DceMessage
{
    public string? Id { get; set; }
    public string? Type { get; set; }
    public string? Timestamp { get; set; }
    public string? TimestampEdited { get; set; }
    public bool IsPinned { get; set; }
    public string? Content { get; set; }
    public DceUser? Author { get; set; }
    public List<DceAttachment>? Attachments { get; set; }
    public List<DceEmbed>? Embeds { get; set; }
    public List<DceSticker>? Stickers { get; set; }
    public List<DceReaction>? Reactions { get; set; }
    public DceReference? Reference { get; set; }
    public DceForwarded? ForwardedMessage { get; set; }
}

/// <summary>
/// Reads an export without loading it whole: the reader walks the top-level object and hands over one message at a
/// time, so a multi-gigabyte channel needs only a small buffer. Any single value over <see cref="MaxValueBytes"/> is refused.
/// </summary>
public sealed class DceReader(Stream stream)
{
    public const int MaxValueBytes = 16 * 1024 * 1024;

    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNameCaseInsensitive = true,
        NumberHandling = System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString,
        MaxDepth = 64,
    };

    private byte[] _buffer = new byte[256 * 1024];
    private int _start;
    private int _end;
    private bool _final;
    private bool _first = true;
    private JsonReaderState _state = new(new JsonReaderOptions { MaxDepth = 64 });

    public DceGuild? Guild { get; private set; }
    public DceChannel? Channel { get; private set; }

    /// <summary>
    /// Reads the export. <paramref name="onMessage"/> gets each message (or null when <paramref name="parseMessages"/>
    /// is false: counting only); returning false stops early. Throws <see cref="InvalidDataException"/> for anything malformed.
    /// </summary>
    public void Read(Func<DceMessage?, bool> onMessage, bool parseMessages = true)
    {
        // 0: before the root object, 1: in the root object, 2: in "messages", 3: done.
        var phase = 0;
        try
        {
            while (phase != 3)
            {
                var reader = new Utf8JsonReader(_buffer.AsSpan(_start, _end - _start), _final, _state);
                var needMore = Step(ref reader, ref phase, onMessage, parseMessages);
                _start += (int)reader.BytesConsumed;
                _state = reader.CurrentState;
                if (!needMore) continue;
                if (_final) throw new InvalidDataException("The export ends too early.");
                Fill();
            }
        }
        catch (JsonException ex)
        {
            throw new InvalidDataException($"This isn't valid JSON ({ex.Message}).", ex);
        }
    }

    /// <summary>Processes complete tokens. Returns true when it needs more bytes (the reader is rewound to a safe point).</summary>
    private bool Step(ref Utf8JsonReader reader, ref int phase, Func<DceMessage?, bool> onMessage, bool parseMessages)
    {
        while (true)
        {
            var checkpoint = reader;
            if (!reader.Read())
            {
                reader = checkpoint;
                return true;
            }
            switch (phase)
            {
                case 0:
                    if (reader.TokenType != JsonTokenType.StartObject) throw new InvalidDataException("This isn't a DiscordChatExporter JSON export.");
                    phase = 1;
                    break;

                case 1:
                    if (reader.TokenType == JsonTokenType.EndObject)
                    {
                        phase = 3;
                        return false;
                    }
                    if (reader.TokenType != JsonTokenType.PropertyName) throw new InvalidDataException("Unexpected JSON.");
                    var name = reader.GetString();
                    if (!reader.Read())
                    {
                        reader = checkpoint;
                        return true;
                    }
                    if (name == "messages" && reader.TokenType == JsonTokenType.StartArray)
                    {
                        phase = 2;
                        break;
                    }
                    if (!Complete(reader))
                    {
                        reader = checkpoint;
                        return true;
                    }
                    if (name == "guild" && reader.TokenType == JsonTokenType.StartObject) Guild = JsonSerializer.Deserialize<DceGuild>(ref reader, Options);
                    else if (name == "channel" && reader.TokenType == JsonTokenType.StartObject) Channel = JsonSerializer.Deserialize<DceChannel>(ref reader, Options);
                    else reader.TrySkip();
                    break;

                case 2:
                    if (reader.TokenType == JsonTokenType.EndArray)
                    {
                        phase = 1;
                        break;
                    }
                    if (reader.TokenType != JsonTokenType.StartObject) throw new InvalidDataException("Unexpected JSON in messages.");
                    if (!Complete(reader))
                    {
                        reader = checkpoint;
                        return true;
                    }
                    DceMessage? message = null;
                    if (parseMessages) message = JsonSerializer.Deserialize<DceMessage>(ref reader, Options);
                    else reader.TrySkip();
                    if (!onMessage(message))
                    {
                        phase = 3;
                        return false;
                    }
                    break;
            }
        }
    }

    /// <summary>Whether the value starting at the reader's token is all in the buffer.</summary>
    private static bool Complete(Utf8JsonReader reader)
    {
        if (reader.TokenType is not (JsonTokenType.StartObject or JsonTokenType.StartArray)) return true;
        return reader.TrySkip();
    }

    private void Fill()
    {
        if (_start > 0)
        {
            Buffer.BlockCopy(_buffer, _start, _buffer, 0, _end - _start);
            _end -= _start;
            _start = 0;
        }
        if (_end == _buffer.Length)
        {
            if (_buffer.Length >= MaxValueBytes) throw new InvalidDataException("A message in the export is too large.");
            Array.Resize(ref _buffer, Math.Min(_buffer.Length * 2, MaxValueBytes));
        }
        var read = stream.Read(_buffer, _end, _buffer.Length - _end);
        if (read == 0) _final = true;
        _end += read;
        if (_first && _end >= 3)
        {
            _first = false;
            if (_buffer[0] == 0xEF && _buffer[1] == 0xBB && _buffer[2] == 0xBF) _start = 3; // UTF-8 byte order mark
        }
        else if (_final) _first = false;
    }
}
