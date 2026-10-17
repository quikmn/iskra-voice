using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Iskra.Server.Crypto;
using Iskra.Server.Files;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// The public page at <c>GET /</c> for browsers (anything else still gets the JSON the apps read). Server-rendered HTML,
/// everything user-written HTML-encoded, no scripts at all, nothing loaded from anywhere but this server. While the owner
/// hasn't turned it on it shows nothing about the server: only that it's an Iskra server, and where to get Iskra.
/// </summary>
public static class LandingPage
{
    /// <summary>The longest rules text the page shows; longer rules are cut at a word.</summary>
    public const int RulesSummaryLength = 800;

    /// <summary>Iskra's own links, the same as <c>LINKS.website</c> and <c>LINKS.releases</c> in client/src/links.ts (a test keeps them in step).</summary>
    public const string Website = "https://iskra.foo";
    public const string Releases = "https://github.com/quikmn/iskra-voice/releases";
    public const string DefaultAppUrl = "https://app.iskra.foo";

    /// <summary>A browser asking for a page (a navigation), not an app's <c>fetch</c> (which accepts anything).</summary>
    public static bool WantsHtml(HttpRequest request) =>
        request.Headers.Accept.Any(v => v is not null && v.Contains("text/html", StringComparison.OrdinalIgnoreCase));

    public static IResult Serve(HttpContext context, World world, Hub hub)
    {
        var headers = context.Response.Headers;
        var client = BugInbox.LimitKey(context.Connection.RemoteIpAddress).ToString();
        if (!hub.Limits.TryTake("landing:" + client, "landing.page"))
        {
            headers.RetryAfter = "10";
            return Results.Text("Too many requests. Try again in a moment.", statusCode: StatusCodes.Status429TooManyRequests);
        }
        var store = world.Store;
        var settings = store.Landing();
        var language = Language(context.Request.Headers.AcceptLanguage.ToString());
        var html = settings.Enabled
            ? Public(world, hub, settings, language, Origin(context.Request), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
            : Generic(world, language);

        headers.ContentSecurityPolicy = Policy;
        headers["Permissions-Policy"] = ProfilePages.PermissionsPolicy;
        headers["Cross-Origin-Opener-Policy"] = "same-origin";
        headers["X-DNS-Prefetch-Control"] = "off";
        headers.CacheControl = "no-store";
        headers.Vary = "Accept, Accept-Language";
        headers.ContentLanguage = language;
        if (!(settings.Enabled && settings.Indexable)) headers["X-Robots-Tag"] = "noindex, nofollow";
        return Results.Content(html, "text/html; charset=utf-8");
    }

    // ── Language ─────────────────────────────────────────────────────────────

    /// <summary>"sv" or "en", by the browser's Accept-Language (highest q first); English when neither is asked for.</summary>
    public static string Language(string acceptLanguage)
    {
        var best = ("en", -1.0);
        var order = 0;
        foreach (var part in acceptLanguage.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (order++ > 20) break;
            var pieces = part.Split(';', StringSplitOptions.TrimEntries);
            var tag = pieces[0].ToLowerInvariant();
            var q = 1.0;
            foreach (var p in pieces.Skip(1))
                if (p.StartsWith("q=", StringComparison.OrdinalIgnoreCase)
                    && double.TryParse(p[2..], NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed)) q = parsed;
            var lang = tag == "sv" || tag.StartsWith("sv-", StringComparison.Ordinal) ? "sv"
                : tag == "en" || tag.StartsWith("en-", StringComparison.Ordinal) ? "en" : null;
            if (lang is not null && q > 0 && q > best.Item2) best = (lang, q);
        }
        return best.Item1;
    }

    private static readonly Dictionary<string, Dictionary<string, string>> Strings = new()
    {
        ["en"] = new()
        {
            ["genericTitle"] = "Iskra server",
            ["genericHeading"] = "This is an Iskra server",
            ["genericLead"] = "Iskra is a free voice and text app for friend groups. Got an invite link? Open it to join.",
            ["download"] = "Download Iskra",
            ["webApp"] = "Open Iskra in your browser",
            ["joinInBrowser"] = "Join in your browser",
            ["openDesktop"] = "Open in the Iskra app",
            ["approve"] = "A moderator lets you in once you've asked to join.",
            ["paused"] = "This server isn't taking new members right now. Try again later.",
            ["noInvite"] = "To join, ask someone here for an invite.",
            ["member"] = "1 member",
            ["members"] = "{0} members",
            ["membersAbout"] = "About {0} members",
            ["online"] = "{0} online",
            ["onlineAbout"] = "about {0} online",
            ["rules"] = "Rules",
            ["footer"] = "Free, self-hosted voice and text chat.",
            ["whatIs"] = "What is Iskra?",
            ["allDownloads"] = "All downloads",
            ["iconAlt"] = "Server icon",
        },
        ["sv"] = new()
        {
            ["genericTitle"] = "Iskra-server",
            ["genericHeading"] = "Det här är en Iskra-server",
            ["genericLead"] = "Iskra är en gratis app för röst- och textchatt för kompisgäng. Har du fått en inbjudningslänk? Öppna den för att gå med.",
            ["download"] = "Ladda ner Iskra",
            ["webApp"] = "Öppna Iskra i webbläsaren",
            ["joinInBrowser"] = "Gå med i webbläsaren",
            ["openDesktop"] = "Öppna i Iskra-appen",
            ["approve"] = "En moderator släpper in dig när du har bett om att få gå med.",
            ["paused"] = "Servern tar inte emot nya medlemmar just nu. Försök igen senare.",
            ["noInvite"] = "Be någon här om en inbjudan för att gå med.",
            ["member"] = "1 medlem",
            ["members"] = "{0} medlemmar",
            ["membersAbout"] = "Ungefär {0} medlemmar",
            ["online"] = "{0} online",
            ["onlineAbout"] = "ungefär {0} online",
            ["rules"] = "Regler",
            ["footer"] = "Gratis röst- och textchatt som du kör själv.",
            ["whatIs"] = "Vad är Iskra?",
            ["allDownloads"] = "Alla nedladdningar",
            ["iconAlt"] = "Serverikon",
        },
    };

    private static string T(string language, string key) => Strings[language][key];

    // ── Content ──────────────────────────────────────────────────────────────

    /// <summary>A rough number, so the page doesn't tell exactly who comes and goes: exact below 10, then rounded down.</summary>
    public static (int Value, bool Exact) Approximate(int n) =>
        n < 10 ? (Math.Max(n, 0), true)
        : n < 100 ? (n / 5 * 5, false)
        : n < 1000 ? (n / 10 * 10, false)
        : (n / 100 * 100, false);

    /// <summary>The start of the rules, cut at a word with an ellipsis when longer than <see cref="RulesSummaryLength"/>.</summary>
    public static string RulesSummary(string rules)
    {
        rules = rules.Trim();
        if (rules.Length <= RulesSummaryLength) return rules;
        var cut = rules[..RulesSummaryLength];
        var space = cut.LastIndexOfAny([' ', '\n']);
        if (space > RulesSummaryLength / 2) cut = cut[..space];
        if (char.IsHighSurrogate(cut[^1])) cut = cut[..^1];
        return cut.TrimEnd() + "…";
    }

    /// <summary>HTML-encodes text for an element or a quoted attribute: the five special characters, nothing else (UTF-8 page).</summary>
    public static string E(string text)
    {
        var sb = new StringBuilder(text.Length + 16);
        foreach (var c in text)
        {
            sb.Append(c switch
            {
                '&' => "&amp;",
                '<' => "&lt;",
                '>' => "&gt;",
                '"' => "&quot;",
                '\'' => "&#39;",
                _ => c.ToString(),
            });
        }
        return sb.ToString();
    }

    /// <summary>This request's own origin when its Host looks like one; null otherwise.</summary>
    private static string? Origin(HttpRequest request)
    {
        var host = request.Host;
        if (!host.HasValue || host.Value.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '.' or '-' or ':' or '[' or ']'))) return null;
        return $"{(request.IsHttps ? "https" : "http")}://{host.Value}";
    }

    private static string AppUrl(World world) =>
        Uri.TryCreate(world.Settings.AppUrl, UriKind.Absolute, out var app) && app.Scheme is "https" or "http"
            ? app.GetLeftPart(UriPartial.Path).TrimEnd('/') : DefaultAppUrl;

    /// <summary>The token of an invite link (PROTOCOL.md "Invite links"), with the server's address as people reach it.</summary>
    private static string InviteToken(World world, string serverUrl, string code) =>
        $"{Ed25519.ToB64u(Encoding.UTF8.GetBytes(serverUrl))}.{Ed25519.ToB64u(world.ServerPublicKey)}.{code}";

    private static string Generic(World world, string language)
    {
        var body = new StringBuilder();
        body.Append("<main class=\"card generic\">");
        body.Append("<div class=\"head\">").Append(Logo).Append("<h1>").Append(E(T(language, "genericHeading"))).Append("</h1></div>");
        body.Append("<p class=\"lead\">").Append(E(T(language, "genericLead"))).Append("</p>");
        body.Append("<div class=\"actions\">");
        body.Append("<a class=\"button primary\" href=\"").Append(E(Website + "/#download")).Append("\">").Append(E(T(language, "download"))).Append("</a>");
        body.Append("<a class=\"button\" href=\"").Append(E(AppUrl(world))).Append("\">").Append(E(T(language, "webApp"))).Append("</a>");
        body.Append("</div></main>");
        return Document(language, T(language, "genericTitle"), body.ToString(), indexable: false, icon: false);
    }

    private static string Public(World world, Hub hub, LandingSettings settings, string language, string? origin, long now)
    {
        var store = world.Store;
        var name = world.Settings.Name;
        var body = new StringBuilder();
        body.Append("<main class=\"card\" data-page=\"public\">");
        if (store.GetServerImage(ServerImageFeature.Banner) is { } banner)
            body.Append("<img class=\"banner\" src=\"").Append(E(Uploads.UrlOf(banner))).Append("\" alt=\"\">");
        var stamp = ServerImageFeature.IconVersion(store);
        body.Append("<div class=\"head\">");
        if (stamp is not null)
            body.Append("<img class=\"icon\" src=\"/icon?v=").Append(E(stamp)).Append("\" alt=\"").Append(E(T(language, "iconAlt"))).Append("\" width=\"72\" height=\"72\">");
        else body.Append(Logo);
        body.Append("<h1>").Append(E(name)).Append("</h1></div>");

        if (settings.Description.Length > 0) body.Append("<p class=\"description\">").Append(E(settings.Description)).Append("</p>");

        if (settings.ShowCounts)
        {
            var (members, membersExact) = Approximate(store.CountPeople());
            var online = hub.OnlineMembers().Keys.Count(k => !store.IsBot(k) && !PresenceFeature.Invisible(store, k));
            var (shown, onlineExact) = Approximate(online);
            body.Append("<p class=\"counts\" data-counts>")
                .Append(E(string.Format(CultureInfo.InvariantCulture, T(language, !membersExact ? "membersAbout" : members == 1 ? "member" : "members"), members)))
                .Append(" · ")
                .Append(E(string.Format(CultureInfo.InvariantCulture, T(language, onlineExact ? "online" : "onlineAbout"), shown)))
                .Append("</p>");
        }

        body.Append("<div class=\"actions\">");
        var invite = LandingFeature.UsableInvite(store, settings.InviteCode, now);
        if (invite is not null && store.JoinSettings().InvitesPaused)
            body.Append("<p class=\"note\" data-paused>").Append(E(T(language, "paused"))).Append("</p>");
        else if (invite is not null)
        {
            var serverUrl = (world.InternetUrl ?? world.Settings.PublicUrl ?? origin ?? world.Settings.EffectivePublicUrl).TrimEnd('/');
            var token = InviteToken(world, serverUrl, invite.Code);
            body.Append("<a class=\"button primary\" data-join href=\"").Append(E($"{AppUrl(world)}/#/join/{token}")).Append("\">")
                .Append(E(T(language, "joinInBrowser"))).Append("</a>");
            body.Append("<a class=\"button\" data-open-app href=\"").Append(E($"iskra://join/{token}")).Append("\">")
                .Append(E(T(language, "openDesktop"))).Append("</a>");
            if (invite.Approve) body.Append("<p class=\"note\">").Append(E(T(language, "approve"))).Append("</p>");
        }
        else body.Append("<p class=\"note\">").Append(E(T(language, "noInvite"))).Append("</p>");
        body.Append("</div>");

        if (settings.ShowRules && store.Rules() is { Text.Length: > 0 } rules)
        {
            body.Append("<details class=\"rules\"><summary>").Append(E(T(language, "rules"))).Append("</summary><p data-rules>")
                .Append(E(RulesSummary(rules.Text))).Append("</p></details>");
        }
        body.Append("</main>");
        return Document(language, name, body.ToString(), settings.Indexable, icon: stamp is not null);
    }

    private static string Document(string language, string title, string main, bool indexable, bool icon)
    {
        var page = new StringBuilder();
        page.Append("<!doctype html><html lang=\"").Append(language).Append("\"><head><meta charset=\"utf-8\">");
        page.Append("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">");
        page.Append("<meta name=\"color-scheme\" content=\"dark light\"><meta name=\"referrer\" content=\"no-referrer\">");
        page.Append("<meta name=\"robots\" content=\"").Append(indexable ? "index, follow" : "noindex, nofollow").Append("\">");
        if (icon) page.Append("<link rel=\"icon\" href=\"/icon\">");
        page.Append("<title>").Append(E(title)).Append("</title><style>").Append(Css).Append("</style></head><body>");
        page.Append(main);
        page.Append("<footer><p>").Append(E(T(language, "footer"))).Append("</p><nav>");
        page.Append("<a href=\"").Append(E(Website)).Append("\">").Append(E(T(language, "whatIs"))).Append("</a>");
        page.Append("<a href=\"").Append(E(Website + "/#download")).Append("\">").Append(E(T(language, "download"))).Append("</a>");
        page.Append("<a href=\"").Append(E(Releases)).Append("\">").Append(E(T(language, "allDownloads"))).Append("</a>");
        page.Append("</nav></footer></body></html>");
        return page.ToString();
    }

    // ── Look ─────────────────────────────────────────────────────────────────

    /// <summary>Iskra's bolt, inline (nothing to fetch).</summary>
    private const string Logo =
        "<svg class=\"logo\" width=\"64\" height=\"64\" viewBox=\"0 0 256 256\" aria-hidden=\"true\"><defs><linearGradient id=\"bolt\" x1=\"60\" y1=\"28\" x2=\"196\" y2=\"228\" gradientUnits=\"userSpaceOnUse\"><stop offset=\"0%\" stop-color=\"#7c6fff\"/><stop offset=\"100%\" stop-color=\"#00cfff\"/></linearGradient></defs><path d=\"M129 28L33 148h88l-18 80 120-144H129L145 28z\" fill=\"url(#bolt)\"/></svg>";

    /// <summary>
    /// The app's colours (client/src/styles.css), dark by default and light when the system asks for it. Line endings are
    /// always LF: browsers hash the stylesheet after turning CRLF into LF, and this file may be checked out with CRLF.
    /// </summary>
    private static readonly string Css = """
        :root{--bg:#0b0b14;--surface:#141424;--surface-2:#1b1b30;--border:rgba(120,100,255,.18);--accent:#695bff;--accent-strong:#5a4bf0;--text:#e2e2f0;--text-2:#b4b4cc;--muted:#8484a8;--amber:#fbbf24;--glow:rgba(105,91,255,.18)}
        @media (prefers-color-scheme:light){:root{--bg:#f4f4fa;--surface:#ffffff;--surface-2:#eeeef8;--border:rgba(60,50,160,.16);--accent:#5a4bf0;--accent-strong:#4a3be0;--text:#1c1c2e;--text-2:#3c3c58;--muted:#5c5c78;--amber:#9a6700;--glow:rgba(105,91,255,.12)}}
        *{box-sizing:border-box}
        html{-webkit-text-size-adjust:100%}
        body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;padding:32px 16px;background:radial-gradient(ellipse at 50% 0%,var(--glow),transparent 60%),var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
        .card{width:100%;max-width:560px;background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:hidden;padding:0 0 24px;box-shadow:0 12px 40px rgba(0,0,0,.25)}
        .card>*:not(.banner){margin-left:24px;margin-right:24px}
        .banner{display:block;width:100%;aspect-ratio:3/1;object-fit:cover;background:var(--surface-2)}
        .head{display:flex;align-items:center;gap:16px;margin-top:24px}
        .icon{width:72px;height:72px;border-radius:20px;object-fit:cover;flex:none;background:var(--surface-2)}
        .banner+.head .icon{margin-top:-48px;border:4px solid var(--surface);width:88px;height:88px;border-radius:24px}
        .logo{flex:none;width:56px;height:56px}
        h1{margin:0;font-size:1.6rem;line-height:1.2;overflow-wrap:anywhere}
        .lead,.description{color:var(--text-2);margin:16px 0 0;white-space:pre-line;overflow-wrap:anywhere}
        .counts{color:var(--muted);margin:12px 0 0;font-size:.95rem}
        .actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}
        .button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 18px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);font-weight:600;text-decoration:none}
        .button:hover{border-color:var(--accent)}
        .button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
        .button.primary:hover{background:var(--accent-strong)}
        .button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
        .note{margin:0;color:var(--text-2);flex-basis:100%}
        [data-paused]{color:var(--amber)}
        .rules{margin-top:20px;border-top:1px solid var(--border);padding-top:12px}
        .rules summary{cursor:pointer;font-weight:600}
        .rules p{margin:8px 0 0;color:var(--text-2);white-space:pre-line;overflow-wrap:anywhere}
        footer{text-align:center;color:var(--muted);font-size:.9rem}
        footer p{margin:0 0 6px}
        footer nav{display:flex;flex-wrap:wrap;justify-content:center;gap:6px 16px}
        footer a{color:var(--text-2)}
        @media (max-width:480px){.card>*:not(.banner){margin-left:16px;margin-right:16px}.actions .button{flex:1 1 100%}h1{font-size:1.35rem}}
        """.ReplaceLineEndings("\n");

    /// <summary>No scripts, the one inline stylesheet by its hash, pictures from this server only, never framed.</summary>
    public static readonly string Policy =
        $"default-src 'none'; style-src 'sha256-{Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(Css)))}'; img-src 'self'; " +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
}
