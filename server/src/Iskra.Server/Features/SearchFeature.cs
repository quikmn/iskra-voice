using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Message search (SQLite FTS5) and loading history around a message, so search results, pins and
/// reply quotes can all jump to a message. Only channels the requester can read right now are searched.
/// </summary>
public static class SearchFeature
{
    public const int MaxQueryLength = 200;
    public const int MaxTerms = 10;
    public const int MaxTermLength = 64;
    public const int MaxResults = 50;

    public static void Register(Router router)
    {
        router.Add("search", Search);
    }

    /// <summary>Plain words; quotes and FTS operators are just text. Pieces without a letter or digit are dropped.</summary>
    internal static List<string> Terms(string? query)
    {
        if (query is null || query.Trim().Length == 0) return [];
        var text = Text.Normalize(query, MaxQueryLength, allowNewlines: false)
            ?? throw RequestException.BadRequest($"Searches must be up to {MaxQueryLength} characters.");
        var terms = text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
            .Where(t => t.Any(char.IsLetterOrDigit))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (terms.Count > MaxTerms) throw RequestException.BadRequest($"Use at most {MaxTerms} words.");
        if (terms.Any(t => t.Length > MaxTermLength)) throw RequestException.BadRequest("One of those words is too long.");
        return terms;
    }

    private static object Search(Session s, Member me, Body body)
    {
        var terms = Terms(body.OptionalString("query", MaxQueryLength * 2));
        var author = body.OptionalString("author", 64);
        var has = body.OptionalStringArray("has", 2, 8);
        if (has.Any(h => h is not ("file" or "link"))) throw RequestException.BadRequest("'has' can be file or link.");
        var before = body.OptionalLong("before", min: 0);
        var after = body.OptionalLong("after", min: 0);
        var cursor = body.OptionalLong("cursor", min: 1);
        var limit = (int)(body.OptionalLong("limit", min: 1, max: MaxResults) ?? 25);
        if (terms.Count == 0 && author is null && has.Length == 0 && before is null && after is null)
            throw RequestException.BadRequest("Type something to search for.");

        // What the requester may read right now; nothing else is ever looked at.
        var readable = s.World.Store.AllConversations().Where(c => Permissions.CanRead(me, c)).Select(c => c.Id).ToHashSet();
        if (body.OptionalLong("channelId") is { } channelId)
        {
            var channel = ChatFeature.ReadableChannel(s, me, channelId);
            // A channel includes its threads.
            var scope = s.World.Store.ThreadIds(channel.Id).Append(channel.Id);
            readable.IntersectWith(scope);
        }

        var (hits, total) = s.World.Store.Search(new SearchQuery(terms, readable, author, has.Contains("file"), has.Contains("link"),
            before, after, cursor, limit));
        var threads = hits.Select(h => h.Message.ChannelId).Distinct()
            .Select(s.World.Store.GetThread).OfType<ThreadInfo>().Select(ThreadFeature.View);
        return new
        {
            results = hits.Select(h => new
            {
                message = MessageViews.Public(s.World.Store, h.Message),
                matches = h.Matches.Select(m => new[] { m.Start, m.Length }),
            }),
            total,
            hasMore = hits.Count == limit,
            threads,
        };
    }

    /// <summary>chat.history with "around": the messages surrounding one message, for jumping to it.</summary>
    internal static object Around(Session s, Channel channel, long messageId, int limit)
    {
        var window = s.World.Store.HistoryAround(channel.Id, messageId, limit) ?? throw RequestException.NotFound("Message");
        return new
        {
            messages = window.Messages.Select(m => MessageViews.Public(s.World.Store, m)),
            hasMore = window.HasOlder,
            hasNewer = window.HasNewer,
        };
    }
}
