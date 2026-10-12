using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>Polls: a message with a question and 2–10 options. One vote per account, closed at expiry or by the author/an admin.</summary>
public static class PollFeature
{
    public const int MaxQuestion = 300;
    public const int MaxOption = 55;
    public const int MinOptions = 2;
    public const int MaxOptions = 10;
    public const long MinDurationMs = 60_000;
    public const long MaxDurationMs = 14L * 24 * 60 * 60 * 1000;

    public static void Register(Router router)
    {
        router.Add("poll.create", Create);
        router.Add("poll.vote", Vote);
        router.Add("poll.end", End);
    }

    /// <summary>How a poll looks on the wire, with who voted for what (polls aren't anonymous).</summary>
    public static object? View(Store store, long messageId)
    {
        var poll = store.GetPoll(messageId);
        if (poll is null) return null;
        var votes = store.PollVotes(messageId, poll.Options.Length);
        return new
        {
            question = poll.Question,
            options = poll.Options.Select((text, i) => new { text, votes = votes[i] }),
            multi = poll.Multi,
            expiresAt = poll.ExpiresAt,
            closedAt = poll.ClosedAt,
        };
    }

    private static object Create(Session s, Member me, Body body)
    {
        var channel = ChatFeature.ReadableChannel(s, me, body.Long("channelId"));
        if (channel.Kind != "text") throw RequestException.BadRequest("You can't post polls in that channel.");
        E2eeChannelFeature.RefusePlaintext(s.World.Store, channel, "Polls");
        if (!Permissions.CanWrite(me, channel)) throw RequestException.Forbidden("You can't send messages in this channel.");

        var question = Text.Normalize(body.String("question", MaxQuestion * 2), MaxQuestion, allowNewlines: false)
            ?? throw RequestException.BadRequest($"The question must be 1–{MaxQuestion} characters.");
        var raw = body.OptionalStringArray("options", MaxOptions, MaxOption * 2);
        var options = raw.Select(o => Text.Normalize(o, MaxOption, allowNewlines: false)
            ?? throw RequestException.BadRequest($"Each answer must be 1–{MaxOption} characters.")).ToArray();
        if (options.Length < MinOptions) throw RequestException.BadRequest($"A poll needs {MinOptions}–{MaxOptions} answers.");
        if (options.Distinct(StringComparer.OrdinalIgnoreCase).Count() != options.Length)
            throw RequestException.BadRequest("Answers must be different from each other.");

        var multi = body.OptionalBool("multi") ?? false;
        var duration = body.OptionalLong("durationMs", MinDurationMs, MaxDurationMs);
        AutoModFeature.Check(s, me, channel, string.Join('\n', [question, .. options]), "poll");
        ModerationFeature.CheckSlowmode(s, me, channel);
        var (message, _) = s.World.Store.AddPoll(channel.Id, me.AccountKey, question, options, multi, s.Now + duration, s.Now);

        var view = MessageViews.Public(s.World.Store, message);
        s.Hub.BroadcastToReaders(channel, Frames.Event("chat.message", new { message = view }));
        return new { message = view };
    }

    private static (Message, Channel, Poll) Find(Session s, Member me, Body body)
    {
        var message = s.World.Store.GetMessage(body.Long("id")) ?? throw RequestException.NotFound("Poll");
        var channel = ChatFeature.ReadableChannel(s, me, message.ChannelId);
        var poll = s.World.Store.GetPoll(message.Id) ?? throw RequestException.NotFound("Poll");
        return (message, channel, poll);
    }

    private static object? Vote(Session s, Member me, Body body)
    {
        var (message, channel, poll) = Find(s, me, body);
        if (poll.IsClosed(s.Now)) throw RequestException.BadRequest("This poll has ended.");

        var element = body.Element("options");
        if (element.ValueKind != JsonValueKind.Array || element.GetArrayLength() > MaxOptions)
            throw RequestException.BadRequest("'options' must be a list of answer numbers.");
        var choices = new SortedSet<int>();
        foreach (var item in element.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Number || !item.TryGetInt32(out var index) || index < 0 || index >= poll.Options.Length)
                throw RequestException.BadRequest("That answer doesn't exist.");
            if (!choices.Add(index)) throw RequestException.BadRequest("Each answer can only be picked once.");
        }
        if (!poll.Multi && choices.Count > 1) throw RequestException.BadRequest("This poll allows only one answer.");

        s.World.Store.SetVote(message.Id, me.AccountKey, choices, s.Now);
        Publish(s.Hub, s.World.Store, channel, message.Id);
        return null;
    }

    private static object? End(Session s, Member me, Body body)
    {
        var (message, channel, poll) = Find(s, me, body);
        var author = s.World.Store.GetMember(message.AuthorKey);
        if (!Permissions.CanDeleteMessage(me, message, author)) throw RequestException.Forbidden("Only the author or an admin can end this poll.");
        if (poll.IsClosed(s.Now)) return null;
        if (s.World.Store.ClosePoll(message.Id, s.Now)) Publish(s.Hub, s.World.Store, channel, message.Id);
        return null;
    }

    internal static void Publish(Hub hub, Store store, Channel channel, long messageId) =>
        hub.BroadcastToReaders(channel, Frames.Event("poll.updated", new { id = messageId, channelId = channel.Id, poll = View(store, messageId) }));
}

/// <summary>Closes polls when their time runs out, so everyone sees the final results.</summary>
public sealed class PollCloser(World world, Hub hub, TimeProvider time, ILogger<PollCloser> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1), time);
        try
        {
            while (await timer.WaitForNextTickAsync(stopping)) CloseExpired();
        }
        catch (OperationCanceledException) { }
    }

    internal void CloseExpired()
    {
        try
        {
            foreach (var poll in world.Store.ExpiredPolls(time.GetUtcNow().ToUnixTimeMilliseconds()))
            {
                if (!world.Store.ClosePoll(poll.MessageId, poll.ExpiresAt!.Value)) continue;
                var channelId = world.Store.GetMessage(poll.MessageId)?.ChannelId;
                if (channelId is { } id && world.Store.GetChannel(id) is { } channel) PollFeature.Publish(hub, world.Store, channel, poll.MessageId);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogWarning(ex, "Closing expired polls failed");
        }
    }
}
