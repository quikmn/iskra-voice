using System.Collections.Concurrent;
using Iskra.Server.Push;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Runs the Welcome bot and the Birthdays bot's clock. Welcome greets people when they actually get in: right after
/// joining, after a moderator lets them in (approval invites), or after they agree to the rules (when the server asks).
/// A burst of joins (a raid, or a big invite drop) gets one "N people joined" line instead of N greetings. Checks every
/// second (BuiltinBots:TickMs; 0 turns the timer off, for tests that tick by hand).
/// </summary>
public sealed class BuiltinBotRuntime : BackgroundService
{
    public const string WelcomeId = "welcome";
    public const int MaxBatchNames = 10;
    /// <summary>A private welcome waits this long for its person to come online (approval: they may be away).</summary>
    public const long PrivateCardTtlMs = 15 * 60_000;

    private readonly World _world;
    private readonly Hub _hub;
    private readonly PushService _push;
    private readonly TimeProvider _time;
    private readonly ILogger<BuiltinBotRuntime> _log;
    private readonly long _tickMs;
    private readonly object _welcomeGate = new();
    private readonly List<string> _waiting = [];
    private long _lastWelcomeAt = long.MinValue / 2;
    private long _lastBirthdayCheck;
    private readonly ConcurrentDictionary<string, (long ChannelId, string Text, long Expires)> _cards = new(StringComparer.Ordinal);

    public BuiltinBotRuntime(World world, Hub hub, PushService push, TimeProvider time, IConfiguration config, ILogger<BuiltinBotRuntime> log)
    {
        _world = world;
        _hub = hub;
        _push = push;
        _time = time;
        _log = log;
        _tickMs = config.GetValue("BuiltinBots:TickMs", 1000L);
        WelcomeWindowMs = config.GetValue("BuiltinBots:WelcomeWindowMs", 60_000L);
        hub.BuiltinBots = this;
    }

    /// <summary>After one greeting, later joins within this long are gathered into one line.</summary>
    public long WelcomeWindowMs { get; }

    private long Now => _time.GetUtcNow().ToUnixTimeMilliseconds();

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        if (_tickMs <= 0) return;
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(_tickMs), _time);
        try
        {
            while (await timer.WaitForNextTickAsync(stopping)) Tick();
        }
        catch (OperationCanceledException) { }
    }

    /// <summary>One pass, at <paramref name="at"/> (tests) or now: gathered welcomes, private welcomes, birthdays (every 10 s).</summary>
    internal void Tick(DateTimeOffset? at = null, bool forceWelcome = false)
    {
        var when = at ?? _time.GetUtcNow();
        var now = when.ToUnixTimeMilliseconds();
        Safely("welcome", () => FlushWelcomes(now, forceWelcome));
        Safely("private welcome", () => DeliverCards(now));
        if (at is not null || now - _lastBirthdayCheck >= 10_000)
        {
            _lastBirthdayCheck = now;
            Safely("birthdays", () => BirthdayBot.Tick(_world.Store, _hub, _push, _time, when));
        }
    }

    private void Safely(string what, Action action)
    {
        try
        {
            action();
        }
        catch (Exception ex) when (ex is not OperationCanceledException and not ObjectDisposedException)
        {
            _log.Write(LogLevel.Warning, LogLine.BotIds.Contains(what) ? $"bot:{what}" : "srv", "BOT-110", "sched", "failed", ex, ("what", what));
        }
    }

    // ── Welcome ──────────────────────────────────────────────────────────────

    /// <summary>Someone became a member (joined, or was let in). Waits for the rules when the server asks for them.</summary>
    public void Joined(Member member)
    {
        Safely("welcome", () =>
        {
            var store = _world.Store;
            if (member.Role == Roles.Owner || store.IsBot(member.AccountKey)) return;
            if (MoreBuiltinBots.BotIfOn(store, WelcomeId) is null) return;
            if (RulesFeature.MustAgree(store, member)) store.AddWelcomePending(member.AccountKey, Now);
            else Welcome(member.AccountKey);
        });
    }

    /// <summary>Someone agreed to the rules: welcomed now if they were waiting to be.</summary>
    public void RulesAccepted(Member member) =>
        Safely("welcome", () =>
        {
            if (_world.Store.TakeWelcomePending(member.AccountKey)) Welcome(member.AccountKey);
        });

    private void Welcome(string accountKey)
    {
        var store = _world.Store;
        if (MoreBuiltinBots.BotIfOn(store, WelcomeId) is not { } bot) return;
        var config = MoreBuiltinBots.Config<WelcomeConfig>(store, WelcomeId);
        var now = Now;
        if (MoreBuiltinBots.PostChannel(store, bot, config.ChannelId, now) is not { } channel) return;
        if (config.PrivateMessage.Length > 0 && store.GetMember(accountKey) is { } member)
            _cards[accountKey] = (channel.Id, Fill(config.PrivateMessage, member), now + PrivateCardTtlMs);
        lock (_welcomeGate)
        {
            if (_waiting.Count > 0 || now - _lastWelcomeAt < WelcomeWindowMs)
            {
                if (!_waiting.Contains(accountKey)) _waiting.Add(accountKey);
                return;
            }
            _lastWelcomeAt = now;
        }
        PostWelcome(bot, channel, config, [accountKey], now);
    }

    /// <summary>Posts the people gathered since the last greeting, once the window has passed (or now, with <paramref name="force"/>).</summary>
    internal void FlushWelcomes(long now, bool force = false)
    {
        List<string> people;
        lock (_welcomeGate)
        {
            if (_waiting.Count == 0 || (!force && now - _lastWelcomeAt < WelcomeWindowMs)) return;
            people = [.. _waiting];
            _waiting.Clear();
            _lastWelcomeAt = now;
        }
        var store = _world.Store;
        if (MoreBuiltinBots.BotIfOn(store, WelcomeId) is not { } bot) return;
        var config = MoreBuiltinBots.Config<WelcomeConfig>(store, WelcomeId);
        if (MoreBuiltinBots.PostChannel(store, bot, config.ChannelId, now) is not { } channel) return;
        PostWelcome(bot, channel, config, people.Where(k => store.GetMember(k) is not null).ToList(), now);
    }

    private string Fill(string template, Member member) =>
        MoreBuiltinBots.Fill(template, $"<@{member.AccountKey}>", _world.Settings.Name, _world.Store.CountPeople());

    private void PostWelcome(Member bot, Channel channel, WelcomeConfig config, List<string> people, long now)
    {
        var store = _world.Store;
        if (people.Count == 0) return;
        var count = store.CountPeople();
        if (people.Count == 1)
        {
            if (store.GetMember(people[0]) is not { } member) return;
            var custom = config.Message.Length > 0;
            var text = custom ? Fill(config.Message, member) : $"👋 Welcome to {_world.Settings.Name}, <@{member.AccountKey}>!";
            MoreBuiltinBots.Post(store, _hub, null, bot, channel, text,
                MoreBuiltinBots.Reply(WelcomeId, "welcome", member.AccountKey, new { memberCount = count, text = custom ? text : null }), now);
            return;
        }
        var shown = people.Take(MaxBatchNames).ToList();
        var names = shown.Select(k => store.GetMember(k) is { } m ? store.DisplayName(m) : "someone").ToList();
        var more = people.Count - shown.Count;
        MoreBuiltinBots.Post(store, _hub, null, bot, channel,
            $"👋 {people.Count} people joined: {string.Join(", ", names)}{(more > 0 ? $" and {more} more" : "")}. Welcome!",
            MoreBuiltinBots.Reply(WelcomeId, "welcome.batch", people[0], new { count = people.Count, people = shown, memberCount = count }), now);
    }

    /// <summary>Private welcomes go to people once they're online (they're never stored), within <see cref="PrivateCardTtlMs"/>.</summary>
    internal void DeliverCards(long now)
    {
        if (_cards.IsEmpty) return;
        var store = _world.Store;
        var bot = MoreBuiltinBots.BotIfOn(store, WelcomeId);
        foreach (var (key, card) in _cards)
        {
            if (bot is null || card.Expires < now || store.GetMember(key) is null)
            {
                _cards.TryRemove(key, out _);
                continue;
            }
            if (!_hub.IsOnline(key)) continue;
            if (!_cards.TryRemove(key, out _)) continue;
            InteractionFeature.PrivateNote(_hub, now, bot.AccountKey, key, card.ChannelId, card.Text,
                MoreBuiltinBots.Reply(WelcomeId, "welcome.private", key, new { text = card.Text }));
        }
    }
}
