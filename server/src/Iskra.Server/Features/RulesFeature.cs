using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Server rules and a welcome message. When agreeing is required, members who haven't agreed to the current version can
/// read but not write, react or join voice (answered with <c>rules_required</c>). The owner and bots never need to agree.
/// </summary>
public static class RulesFeature
{
    public const int MaxTextLength = 6000;
    public const int MaxWelcomeLength = 500;

    /// <summary>What needs agreeing first: the same things a timeout stops, plus a few more ways to take part.</summary>
    private static readonly HashSet<string> NeedsAgreement =
    [
        "chat.send", "chat.edit", "chat.react", "chat.typing", "chat.pin", "chat.forward", "upload.begin",
        "thread.create", "thread.update", "poll.create", "poll.vote", "poll.end",
        "voice.join", "sound.play", "call.start", "call.accept", "stage.hand", "stage.start",
        "forum.post.create", "forum.post.update", "event.create", "event.update", "event.interest",
        "watch.start", "watch.control", "watch.chat", "invite.create",
    ];

    public static void Register(Router router)
    {
        router.Add("rules.get", (s, me, _) => new { rules = View(s.World.Store, me, counts: Permissions.IsAdmin(me)) });
        router.Add("rules.update", Update);
        router.Add("rules.accept", Accept);
    }

    /// <summary>True while this member still has to agree before taking part.</summary>
    public static bool MustAgree(Store store, Member member) => MustAgree(store, store.Rules(), member);

    private static bool MustAgree(Store store, ServerRules? rules, Member member) =>
        rules is { Required: true } && member.Role != Roles.Owner && !store.IsBot(member.AccountKey)
        && store.AcceptedRulesVersion(member.AccountKey) < rules.Version;

    /// <summary>The router asks before every request.</summary>
    internal static RequestException? Gate(Session s, Member me, string type) =>
        NeedsAgreement.Contains(type) && MustAgree(s.World.Store, me)
            ? new RequestException("rules_required", "Agree to the server rules first.")
            : null;

    /// <summary>The rules as this member sees them (admins can also get how many members agreed).</summary>
    public static object View(Store store, Member member, bool counts = false)
    {
        var rules = store.Rules();
        var version = rules?.Version ?? 0;
        return new
        {
            text = rules?.Text ?? "",
            welcome = rules?.Welcome ?? "",
            required = rules?.Required ?? false,
            version,
            updatedAt = rules?.UpdatedAt,
            mustAgree = MustAgree(store, rules, member),
            agreedVersion = store.AcceptedRulesVersion(member.AccountKey),
            agreed = counts ? store.RulesAgreedCount(version) : (int?)null,
            members = counts ? store.AllMembers().Count(m => m.Role != Roles.Owner && !store.IsBot(m.AccountKey)) : (int?)null,
        };
    }

    private static string Field(Body body, string name, int max, string fallback)
    {
        if (!body.Has(name)) return fallback;
        var raw = body.OptionalString(name, max * 2) ?? "";
        if (raw.Trim().Length == 0) return "";
        return Text.Normalize(raw, max, allowNewlines: true)
            ?? throw RequestException.BadRequest($"'{name}' can be up to {max} characters, without control characters.");
    }

    private static object Update(Session s, Member me, Body body)
    {
        if (!Permissions.IsAdmin(me)) throw RequestException.Forbidden("Only admins can change the server rules.");
        var store = s.World.Store;
        var old = store.Rules();
        var text = Field(body, "text", MaxTextLength, old?.Text ?? "");
        var welcome = Field(body, "welcome", MaxWelcomeLength, old?.Welcome ?? "");
        var required = body.OptionalBool("required") ?? old?.Required ?? false;
        var reaccept = required && (body.OptionalBool("reaccept") ?? false);
        if (required && text.Length == 0) throw RequestException.BadRequest("Write the rules before asking people to agree to them.");

        var version = old?.Version ?? 0;
        var turningOn = required && old is not { Required: true };
        if (reaccept) version++; // everyone agrees again (or, turning on, everyone already here too)
        else if (turningOn)
        {
            // Only people who join from now on have to agree.
            version = Math.Max(version, 1);
            store.AcceptRulesForAllMembers(version, s.Now);
        }
        store.SaveRules(new ServerRules(text, welcome, required, version, s.Now, me.AccountKey));
        if (required) store.AcceptRules(me.AccountKey, version, s.Now); // whoever writes them agrees to them

        Audit.Record(s, "rules.update", details: new { required, reaccept, version, textChanged = text != (old?.Text ?? "") });
        foreach (var session in s.Hub.Sessions)
        {
            if (session.CurrentMember() is { } member) session.Send(Frames.Event("rules", new { rules = View(store, member) }));
        }
        return new { rules = View(store, me, counts: true) };
    }

    private static object Accept(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var version = body.OptionalLong("version", min: 0, max: int.MaxValue) ?? throw RequestException.BadRequest("'version' is required.");
        var rules = store.Rules();
        if (rules is not { Required: true }) throw RequestException.BadRequest("This server doesn't ask you to agree to rules.");
        if (version != rules.Version) throw new RequestException("conflict", "The rules just changed. Have a look at them again.");
        store.AcceptRules(me.AccountKey, rules.Version, s.Now);
        var view = View(store, me);
        s.Hub.SendToAccount(me.AccountKey, Frames.Event("rules", new { rules = view }));
        return new { rules = view };
    }
}
