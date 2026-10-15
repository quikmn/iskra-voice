using Iskra.Server.Features;
using Iskra.Server.Protocol;
using Iskra.Server.Storage;

namespace Iskra.Server.Templates;

/// <summary>
/// A template's starting content (format 3): channel topics, messages posted once as the server (webhook-style, author
/// <see cref="ContentAuthor"/>, shown under the server's name) and docs pages. Plain Markdown text, rendered by the apps
/// like any message or page; mentions never ping. Added only where a channel has none yet, so applying twice adds nothing.
/// </summary>
public static partial class ServerTemplates
{
    public const string ContentWebhookId = "template";
    public const string ContentAuthor = WebhookFeature.AuthorPrefix + ContentWebhookId;
    public const int MaxMessagesPerChannel = 10;
    public const int MaxMessages = 100;
    public const int MaxPagesPerChannel = 20;
    public const int MaxPages = 50;

    private static (string? Topic, TemplateMessage[] Messages, TemplatePage[] Pages) CheckContent(TemplateChannel c, string kind, string where, Func<string, string> fail)
    {
        string? topic = null;
        if (c.Topic is { } rawTopic && rawTopic.Trim().Length > 0)
            topic = ChannelFeature.CleanTopic(rawTopic) ?? fail($"{where}: 'topic' can be up to {ChannelFeature.MaxTopicLength} characters, on one line.");

        if (c.Messages.Length > 0 && kind != "text") fail($"{where}: only text channels can have 'messages'.");
        if (c.Messages.Length > MaxMessagesPerChannel) fail($"{where}: at most {MaxMessagesPerChannel} messages per channel.");
        var messages = c.Messages.Select((m, i) =>
        {
            if (m is null) fail($"{where}: message {i + 1} must be an object, like {{ \"text\": \"Hello!\" }}.");
            var text = Sessions.Text.Normalize(m!.Text, ChatFeature.MaxMessageLength, allowNewlines: true)
                ?? fail($"{where}: message {i + 1} must be 1–{ChatFeature.MaxMessageLength} characters, with no invisible control characters.");
            return new TemplateMessage { Text = text, Pin = m.Pin };
        }).ToArray();
        if (messages.Count(m => m.Pin) > PinFeature.MaxPins) fail($"{where}: at most {PinFeature.MaxPins} pinned messages.");

        if (c.Pages.Length > 0 && kind != "docs") fail($"{where}: only docs channels can have 'pages'.");
        if (c.Pages.Length > MaxPagesPerChannel) fail($"{where}: at most {MaxPagesPerChannel} pages per channel.");
        var pages = c.Pages.Select((p, i) =>
        {
            if (p is null) fail($"{where}: page {i + 1} must be an object, like {{ \"title\": \"Welcome\", \"text\": \"...\" }}.");
            var title = Sessions.Text.Normalize(p!.Title, DocsFeature.MaxTitleLength, allowNewlines: false)
                ?? fail($"{where}: page {i + 1} needs a 'title' of 1–{DocsFeature.MaxTitleLength} characters.");
            string text;
            try
            {
                text = DocsFeature.CleanText(p.Text);
            }
            catch (RequestException)
            {
                text = fail($"{where}: page '{title}' can be up to {DocsFeature.MaxPageBytes / 1024} KB of text.");
            }
            return new TemplatePage { Title = title, Text = text, StartHere = p.StartHere };
        }).ToArray();
        if (pages.Select(p => p.Title.ToLowerInvariant()).Distinct().Count() != pages.Length) fail($"{where}: two pages have the same title.");
        return (topic, messages, pages);
    }

    private static void CheckContentTotals(TemplateChannel[] channels, Func<string, string> fail)
    {
        if (channels.Sum(c => c.Messages.Length) > MaxMessages) fail($"at most {MaxMessages} messages in all.");
        if (channels.Sum(c => c.Pages.Length) > MaxPages) fail($"at most {MaxPages} pages in all.");
        if (channels.Sum(c => c.Pages.Count(p => p.StartHere)) > 1) fail("only one page can be the 'startHere' page.");
    }

    /// <summary>
    /// A channel's starting content, where it has none yet: the topic if it has none, the messages if the template never
    /// posted there, pages whose titles it doesn't have, and a disappearing timer if none was ever set. <paramref name="channel"/> is null for a channel a dry run
    /// would create. Never posts into an end-to-end encrypted channel or one with disappearing messages.
    /// </summary>
    internal static void AddContent(World world, Channel? channel, TemplateChannel c, bool apply, List<string> plan, long now)
    {
        var store = world.Store;
        var label = c.Kind is "text" or "forum" ? $"#{c.Name}" : c.Name;
        if (c.Topic is { Length: > 0 } topic && (channel is null || store.Topic(channel.Id).Length == 0))
        {
            plan.Add($"topic for {label}");
            if (apply && channel is not null) store.SetTopic(channel.Id, topic);
        }

        if (c.Messages.Length > 0 && (channel is null || !store.HasMessageFrom(channel.Id, ContentAuthor)))
        {
            if (channel is not null && store.GetE2ee(channel.Id) is not null)
                plan.Add($"(skipped) messages in {label}: it's end-to-end encrypted");
            else if (channel is not null && store.ChannelTimer(channel.Id) is not null)
                plan.Add($"(skipped) messages in {label}: it has disappearing messages");
            else
            {
                plan.Add(c.Messages.Length == 1 ? $"1 message in {label}" : $"{c.Messages.Length} messages in {label}");
                if (apply && channel is not null)
                {
                    var name = Sessions.Names.Normalize(world.Settings.Name) ?? "Iskra";
                    foreach (var m in c.Messages)
                    {
                        var text = WebhookPayload.SanitizeMentions(m.Text, MentionRules.None, key => store.GetMember(key)?.Name);
                        // A webhook-style message (as the bug inbox posts), signed with the server's name.
                        var message = store.AddBugReportMessage(channel.Id, ContentAuthor, ContentWebhookId, name, text, "[]", [], now++);
                        if (m.Pin && store.PinCount(channel.Id) < PinFeature.MaxPins) store.AddPin(message.Id, channel.Id, ContentAuthor, now);
                    }
                }
            }
        }

        if (c.Pages.Length > 0)
        {
            var have = channel is null ? [] : store.DocPages(channel.Id).Select(p => p.Title).ToHashSet(StringComparer.OrdinalIgnoreCase);
            foreach (var page in c.Pages.Where(p => !have.Contains(p.Title)))
            {
                if (channel is not null && store.DocPageCount(channel.Id) >= DocsFeature.MaxPagesPerChannel)
                {
                    plan.Add($"(skipped) page \"{page.Title}\" in {label}: it has {DocsFeature.MaxPagesPerChannel} pages");
                    continue;
                }
                var home = page.StartHere && store.DocHome() is null;
                plan.Add(home ? $"page \"{page.Title}\" in {label} (the Start here page)" : $"page \"{page.Title}\" in {label}");
                if (!apply || channel is null) continue;
                var created = store.CreateDocPage(channel.Id, null, page.Title, page.Text, [], ContentAuthor, now);
                if (home) store.SetDocHome(created.Id);
            }
        }

        // Last, so the messages above never get the timer.
        if (c.Disappear > 0 && (channel is null || store.ChannelTimer(channel.Id) is null))
        {
            plan.Add($"disappearing messages in {label} ({DisappearLabel(c.Disappear)})");
            if (apply && channel is not null) store.SetChannelTimer(channel.Id, c.Disappear, ContentAuthor, now);
        }
    }

    private static string DisappearLabel(int seconds) => seconds switch
    {
        < 3600 => $"{seconds / 60} min",
        < 86400 => $"{seconds / 3600} h",
        < 604800 => seconds == 86400 ? "1 day" : $"{seconds / 86400} days",
        _ => seconds == 604800 ? "1 week" : $"{seconds / 604800} weeks",
    };
}
