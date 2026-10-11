using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Docs channels: a small wiki. Pages (with one level of sub-pages) written in the app's Markdown, saved with
/// optimistic concurrency (every save names the version it started from; a newer one answers <c>conflict</c>),
/// full revision history with restore, search, and one server-wide "Start here" page.
/// Reading follows the channel's read access, editing its write access (by default trusted and above).
/// </summary>
public static partial class DocsFeature
{
    public const int MaxTitleLength = 100;
    /// <summary>Page text, in UTF-8 bytes. Bigger than a socket frame, so long pages are sent as an upload (<c>file</c>).</summary>
    public const int MaxPageBytes = 100 * 1024;
    public const int MaxPagesPerChannel = 500;
    public const int MaxSearchResults = 25;

    [GeneratedRegex("/files/([A-Za-z0-9_-]{16,64})")]
    private static partial Regex FileLink();

    public static void Register(Router router)
    {
        router.Add("docs.pages", List);
        router.Add("docs.page.get", Get);
        router.Add("docs.page.create", Create);
        router.Add("docs.page.save", Save);
        router.Add("docs.page.move", Move);
        router.Add("docs.page.delete", Delete);
        router.Add("docs.page.history", History);
        router.Add("docs.page.restore", Restore);
        router.Add("docs.home.get", (s, me, _) => new { home = HomeView(s.World.Store, me) });
        router.Add("docs.home.set", SetHome);
        router.Add("docs.search", Search);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    public static object View(DocPage p) => new
    {
        id = p.Id, channelId = p.ChannelId, parentId = p.ParentId, title = p.Title, position = p.Position, version = p.Version,
        createdBy = p.CreatedBy, createdAt = p.CreatedAt, updatedBy = p.UpdatedBy, updatedAt = p.UpdatedAt, size = p.Size,
    };

    private static object FullView(DocPage p) => new
    {
        id = p.Id, channelId = p.ChannelId, parentId = p.ParentId, title = p.Title, position = p.Position, version = p.Version,
        createdBy = p.CreatedBy, createdAt = p.CreatedAt, updatedBy = p.UpdatedBy, updatedAt = p.UpdatedAt, size = p.Size,
        text = p.Text ?? "",
    };

    private static object RevisionView(DocRevision r) => new
    {
        version = r.Version, title = r.Title, author = r.Author, createdAt = r.CreatedAt, restoredFrom = r.RestoredFrom, size = r.Size,
    };

    /// <summary>The "Start here" page as this member sees it: null unless they can read its channel.</summary>
    public static object? HomeView(Store store, Member member)
    {
        if (store.DocHome() is not { } id || store.GetDocPage(id) is not { } page) return null;
        if (store.GetChannel(page.ChannelId) is not { Kind: "docs" } channel || !Permissions.CanRead(member, channel)) return null;
        return new { pageId = page.Id, channelId = page.ChannelId, title = page.Title };
    }

    private static void BroadcastHome(Session s)
    {
        foreach (var session in s.Hub.Sessions)
        {
            if (session.CurrentMember() is { } member) session.Send(Frames.Event("docs.home", new { home = HomeView(s.World.Store, member) }));
        }
    }

    private static void Updated(Session s, Channel channel, DocPage page) =>
        s.Hub.BroadcastToReaders(channel, Frames.Event("docs.page.updated", new { page = View(page) }));

    // ── Lookups and checks ───────────────────────────────────────────────────

    private static Channel ReadableDocs(Session s, Member me, long id)
    {
        var channel = ChatFeature.ReadableChannel(s, me, id);
        return channel.Kind == "docs" ? channel : throw RequestException.BadRequest("That isn't a docs channel.");
    }

    /// <summary>A page the member can read (with its channel); anything else is not found.</summary>
    private static (DocPage Page, Channel Channel) ReadablePage(Session s, Member me, long id, bool withText = false)
    {
        var page = s.World.Store.GetDocPage(id, withText) ?? throw RequestException.NotFound("Page");
        if (s.World.Store.GetChannel(page.ChannelId) is not { Kind: "docs" } channel || !Permissions.CanRead(me, channel))
            throw RequestException.NotFound("Page");
        return (page, channel);
    }

    private static void RequireWriter(Member me, Channel channel)
    {
        if (!Permissions.CanWrite(me, channel)) throw RequestException.Forbidden("You can't edit pages in this channel.");
    }

    private static string Title(string raw) =>
        Text.Normalize(raw, MaxTitleLength, allowNewlines: false)
        ?? throw RequestException.BadRequest($"Page titles must be 1–{MaxTitleLength} characters.");

    /// <summary>
    /// Page text as stored: line endings made "\n", control and invisible formatting characters (such as bidi overrides)
    /// removed rather than refused (pasted text often has some), NFC, no trailing whitespace. At most <see cref="MaxPageBytes"/>.
    /// </summary>
    internal static string CleanText(string raw)
    {
        var text = new StringBuilder(raw.Length);
        var s = raw.Replace("\r\n", "\n").Replace('\r', '\n');
        foreach (var c in s)
        {
            if (c is '\n' or '\t' or '‍') { text.Append(c); continue; }
            var category = char.GetUnicodeCategory(c);
            if (category is UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator) text.Append('\n');
            else if (category is not (UnicodeCategory.Control or UnicodeCategory.Format)) text.Append(c);
        }
        var cleaned = text.ToString();
        try { cleaned = cleaned.Normalize(NormalizationForm.FormC); }
        catch (ArgumentException) { throw RequestException.BadRequest("Pages must be valid text."); }
        cleaned = cleaned.TrimEnd();
        if (Encoding.UTF8.GetByteCount(cleaned) > MaxPageBytes) throw RequestException.BadRequest($"Pages can be up to {MaxPageBytes / 1024} KB.");
        return cleaned;
    }

    /// <summary>The page text from <c>text</c>, or from <c>file</c> (your own upload of UTF-8 text) for long pages. Null if neither.</summary>
    private static string? BodyText(Session s, Member me, Body body)
    {
        if (body.Has("file"))
        {
            if (body.Has("text")) throw RequestException.BadRequest("Send the text or a file, not both.");
            var file = s.World.Store.GetFile(body.String("file", 64));
            if (file is null || file.Uploader != me.AccountKey) throw RequestException.BadRequest("Unknown page file.");
            if (file.Size > MaxPageBytes) throw RequestException.BadRequest($"Pages can be up to {MaxPageBytes / 1024} KB.");
            try
            {
                var bytes = File.ReadAllBytes(s.Uploads.PathFor(file.Sha256));
                if (bytes.Length > MaxPageBytes) throw RequestException.BadRequest($"Pages can be up to {MaxPageBytes / 1024} KB.");
                return CleanText(new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true).GetString(bytes));
            }
            catch (DecoderFallbackException)
            {
                throw RequestException.BadRequest("Pages must be UTF-8 text.");
            }
            catch (IOException)
            {
                throw RequestException.NotFound("Page file");
            }
        }
        return body.OptionalString("text", MaxPageBytes) is { } raw ? CleanText(raw) : null;
    }

    private static string[] FileIds(string text) => FileLink().Matches(text).Select(m => m.Groups[1].Value).Distinct().ToArray();

    /// <summary>Sub-pages go one level deep: a parent must be a top-level page in the same channel.</summary>
    private static long? Parent(Session s, Channel channel, Body body, long? self = null)
    {
        if (body.OptionalLong("parentId", min: 1) is not { } id) return null;
        if (id == self || s.World.Store.GetDocPage(id) is not { } parent || parent.ChannelId != channel.Id)
            throw RequestException.BadRequest("That parent page isn't in this channel.");
        if (parent.ParentId is not null) throw RequestException.BadRequest("Sub-pages can't have sub-pages of their own.");
        return id;
    }

    private static void AuditPage(Session s, string action, Channel channel, DocPage page, object? extra = null) =>
        Audit.Record(s, action, details: new { channelId = channel.Id, channelName = channel.Name, pageId = page.Id, title = page.Title, extra });

    // ── Requests ─────────────────────────────────────────────────────────────

    private static object List(Session s, Member me, Body body)
    {
        var channel = ReadableDocs(s, me, body.Long("channelId"));
        var home = s.World.Store.DocHome();
        return new { pages = s.World.Store.DocPages(channel.Id).Select(View), home };
    }

    private static object Get(Session s, Member me, Body body)
    {
        if (body.OptionalLong("version", min: 1) is { } version)
        {
            var (current, _) = ReadablePage(s, me, body.Long("id"));
            var revision = s.World.Store.GetDocRevision(current.Id, version) ?? throw RequestException.NotFound("Revision");
            return new
            {
                page = View(current),
                revision = new
                {
                    version = revision.Version, title = revision.Title, author = revision.Author, createdAt = revision.CreatedAt,
                    restoredFrom = revision.RestoredFrom, size = revision.Size, text = revision.Text,
                },
            };
        }
        var (page, _) = ReadablePage(s, me, body.Long("id"), withText: true);
        return new { page = FullView(page) };
    }

    private static object Create(Session s, Member me, Body body)
    {
        var channel = ReadableDocs(s, me, body.Long("channelId"));
        RequireWriter(me, channel);
        var store = s.World.Store;
        var title = Title(body.String("title", MaxTitleLength * 2));
        var parentId = Parent(s, channel, body);
        var text = BodyText(s, me, body) ?? "";
        if (store.DocPageCount(channel.Id) >= MaxPagesPerChannel)
            throw RequestException.BadRequest($"A docs channel can have up to {MaxPagesPerChannel} pages. Delete some first.");
        AutoModFeature.Check(s, me, channel, title + "\n" + text, "page");

        var page = store.CreateDocPage(channel.Id, parentId, title, text, FileIds(text), me.AccountKey, s.Now);
        AuditPage(s, "docs.page.create", channel, page);
        Updated(s, channel, page);
        return new { page = FullView(page with { Text = text }) };
    }

    private static object Save(Session s, Member me, Body body)
    {
        var (page, channel) = ReadablePage(s, me, body.Long("id"), withText: true);
        RequireWriter(me, channel);
        var baseVersion = body.OptionalLong("baseVersion", min: 1) ?? throw RequestException.BadRequest("'baseVersion' is required.");
        var title = body.OptionalString("title", MaxTitleLength * 2) is { } raw ? Title(raw) : page.Title;
        var text = BodyText(s, me, body) ?? page.Text!;
        if (!body.Has("title") && !body.Has("text") && !body.Has("file")) throw RequestException.BadRequest("Nothing to save.");
        if (baseVersion != page.Version) throw Conflict();
        if (title == page.Title && text == page.Text) return new { page = FullView(page) };
        AutoModFeature.Check(s, me, channel, title + "\n" + text, "page");
        return Commit(s, me, page, channel, title, text, baseVersion, null);
    }

    private static object Commit(Session s, Member me, DocPage page, Channel channel, string title, string text, long baseVersion, long? restoredFrom)
    {
        var store = s.World.Store;
        switch (store.SaveDocPage(page.Id, baseVersion, title, text, FileIds(text), me.AccountKey, s.Now, restoredFrom))
        {
            case DocSaveResult.Missing: throw RequestException.NotFound("Page");
            case DocSaveResult.Conflict: throw Conflict();
        }
        var saved = store.GetDocPage(page.Id, withText: true)!;
        Updated(s, channel, saved);
        if (title != page.Title && store.DocHome() == page.Id) BroadcastHome(s);
        return new { page = FullView(saved) };
    }

    private static RequestException Conflict() =>
        new("conflict", "Someone saved this page while you were editing it. Compare the changes and save again.");

    private static object Move(Session s, Member me, Body body)
    {
        var (page, channel) = ReadablePage(s, me, body.Long("id"));
        RequireWriter(me, channel);
        var store = s.World.Store;
        var parentId = Parent(s, channel, body, self: page.Id);
        if (parentId is not null && store.DocHasChildren(page.Id))
            throw RequestException.BadRequest("A page with sub-pages stays at the top level.");
        var before = body.OptionalLong("before", min: 1);
        if (before is { } b && (b == page.Id || store.GetDocPage(b) is not { } sibling || sibling.ChannelId != channel.Id || sibling.ParentId != parentId))
            throw RequestException.BadRequest("'before' must be another page at the same level.");

        store.MoveDocPage(page, parentId, before);
        foreach (var moved in store.DocPages(channel.Id).Where(p => p.ParentId == parentId || p.Id == page.Id)) Updated(s, channel, moved);
        return new { page = View(store.GetDocPage(page.Id)!) };
    }

    /// <summary>Writers delete their own pages; trusted+ writers and message managers delete anyone's.</summary>
    private static object? Delete(Session s, Member me, Body body)
    {
        var (page, channel) = ReadablePage(s, me, body.Long("id"));
        RequireWriter(me, channel);
        if (page.CreatedBy != me.AccountKey && !Permissions.CanPin(me, channel))
            throw RequestException.Forbidden("Only whoever made this page, or a moderator, can delete it.");
        var store = s.World.Store;
        var wasHome = store.DocHome() is { } home && (home == page.Id || store.GetDocPage(home)?.ParentId == page.Id);
        AuditPage(s, "docs.page.delete", channel, page);
        var ids = store.DeleteDocPage(page.Id);
        s.Hub.BroadcastToReaders(channel, Frames.Event("docs.page.deleted", new { channelId = channel.Id, ids }));
        if (wasHome) BroadcastHome(s);
        return null;
    }

    private static object History(Session s, Member me, Body body)
    {
        var (page, _) = ReadablePage(s, me, body.Long("id"));
        return new { page = View(page), revisions = s.World.Store.DocRevisions(page.Id).Select(RevisionView) };
    }

    private static object Restore(Session s, Member me, Body body)
    {
        var (page, channel) = ReadablePage(s, me, body.Long("id"), withText: true);
        RequireWriter(me, channel);
        var baseVersion = body.OptionalLong("baseVersion", min: 1) ?? throw RequestException.BadRequest("'baseVersion' is required.");
        var version = body.OptionalLong("version", min: 1) ?? throw RequestException.BadRequest("'version' is required.");
        var revision = s.World.Store.GetDocRevision(page.Id, version) ?? throw RequestException.NotFound("Revision");
        if (baseVersion != page.Version) throw Conflict();
        if (version == page.Version) throw RequestException.BadRequest("That's already the current version.");
        AutoModFeature.Check(s, me, channel, revision.Title + "\n" + revision.Text, "page");
        var result = Commit(s, me, page, channel, revision.Title, revision.Text!, baseVersion, version);
        AuditPage(s, "docs.page.restore", channel, page, new { version });
        return result;
    }

    private static object SetHome(Session s, Member me, Body body)
    {
        if (!Permissions.Has(me, Perm.ManageChannels)) throw RequestException.Forbidden("You can't choose the Start here page.");
        var store = s.World.Store;
        if (body.OptionalLong("pageId", min: 1) is { } id)
        {
            var (page, channel) = ReadablePage(s, me, id);
            store.SetDocHome(page.Id);
            AuditPage(s, "docs.home.set", channel, page);
        }
        else
        {
            if (store.DocHome() is null) return new { home = (object?)null };
            store.SetDocHome(null);
            Audit.Record(s, "docs.home.set", details: new { pageId = (long?)null });
        }
        BroadcastHome(s);
        return new { home = HomeView(store, me) };
    }

    private static object Search(Session s, Member me, Body body)
    {
        var terms = SearchFeature.Terms(body.OptionalString("query", SearchFeature.MaxQueryLength * 2));
        if (terms.Count == 0) throw RequestException.BadRequest("Type something to search for.");
        var limit = (int)(body.OptionalLong("limit", min: 1, max: MaxSearchResults) ?? 10);
        var store = s.World.Store;
        var readable = store.AllChannels().Where(c => c.Kind == "docs" && Permissions.CanRead(me, c)).Select(c => c.Id).ToList();
        if (body.OptionalLong("channelId") is { } channelId)
        {
            var channel = ReadableDocs(s, me, channelId);
            readable = [channel.Id];
        }
        var hits = store.SearchDocs(terms, readable, limit);
        return new
        {
            results = hits.Select(h => new { page = View(h.Page), snippet = h.Snippet, matches = h.Matches.Select(m => new[] { m.Start, m.Length }) }),
        };
    }
}
