using Iskra.Server.Files;
using Iskra.Server.Import;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>Importing a Discord server's history from DiscordChatExporter exports (owner only).</summary>
public static class ImportFeature
{
    public static void Register(Router router, ImportService imports)
    {
        router.Add("import.begin", (s, me, body) => Begin(imports, me, body));
        router.Add("import.status", (_, me, _) =>
        {
            RequireOwner(me);
            return new { job = imports.Status(), running = imports.Busy };
        });
        router.Add("import.cancel", (_, me, _) =>
        {
            RequireOwner(me);
            if (!imports.Cancel()) throw RequestException.NotFound("Import");
            return null;
        });
    }

    public static void MapEndpoints(WebApplication app)
    {
        app.MapMethods("/import/{token}", ["PUT"], async (HttpContext context, string token, ImportService imports) =>
        {
            if (context.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
                limit.MaxRequestBodySize = imports.MaxBytes;
            await imports.HandleUploadAsync(context, token);
        });
        app.MapMethods("/import/{token}", ["OPTIONS"], (HttpContext context) =>
        {
            Uploads.AllowCors(context);
            return Results.NoContent();
        });
    }

    private static void RequireOwner(Member me)
    {
        if (me.Role != Roles.Owner) throw RequestException.Forbidden("Only the owner can import.", "owner_import");
    }

    private static object Begin(ImportService imports, Member me, Body body)
    {
        RequireOwner(me);
        var size = body.OptionalLong("size", min: 1) ?? throw RequestException.BadRequest("'size' is required.");
        if (size > imports.MaxBytes)
            throw RequestException.BadRequest($"Exports can be up to {imports.MaxBytes / 1024 / 1024} MB on this server (Import.MaxMb in server.json).", "import_size", new { mb = imports.MaxBytes / 1024 / 1024 });
        var readOnly = body.OptionalBool("readOnly") ?? false;
        var token = imports.Begin(me.AccountKey, size, readOnly)
            ?? throw new RequestException("rate_limited", "An import is already running. Wait for it to finish.", "import_running");
        return new { url = $"/import/{token}", maxBytes = imports.MaxBytes };
    }

    // ── How imported messages look ───────────────────────────────────────────

    /// <summary>Message.imported: who wrote it on Discord, reaction counts, files the export didn't include. Null for other messages.</summary>
    public static object? MessageView(Store store, Message m)
    {
        if (!m.AuthorKey.StartsWith(DiscordImporter.AuthorPrefix, StringComparison.Ordinal)) return null;
        var post = store.GetImportedPost(m.Id);
        var author = store.GetImportedAuthor(m.AuthorKey);
        var avatar = author?.AvatarFile is { } fileId ? store.GetFile(fileId) : null;
        return new
        {
            source = post?.Source ?? DiscordImporter.Source,
            name = author?.Name ?? "Discord user",
            avatar = avatar is null ? null : Uploads.Public(avatar),
            bot = author?.Bot ?? false,
            reactions = Parse(post?.Reactions),
            missingAttachments = Parse(post?.Missing),
        };
    }

    /// <summary>The name to show for an imported author in a reply quote; null for everyone else.</summary>
    public static string? AuthorName(Store store, string authorKey) =>
        authorKey.StartsWith(DiscordImporter.AuthorPrefix, StringComparison.Ordinal) ? store.GetImportedAuthor(authorKey)?.Name ?? "Discord user" : null;

    private static System.Text.Json.JsonElement Parse(string? json)
    {
        using var doc = System.Text.Json.JsonDocument.Parse(json ?? "[]");
        return doc.RootElement.Clone();
    }
}
