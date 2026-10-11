using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using Iskra.Server.Gifs;

namespace Iskra.Server.Tests.Support;

/// <summary>Answers like KLIPY does, and records every request the server makes.</summary>
public sealed class FakeGifUpstream : IGifUpstream
{
    public ConcurrentQueue<Uri> Requests { get; } = new();
    public ConcurrentQueue<Uri> MediaRequests { get; } = new();

    /// <summary>The API's answer for a request (null: unreachable).</summary>
    public Func<Uri, string?> Json { get; set; } = uri => uri.AbsolutePath.EndsWith("/categories") ? Categories : Page("cat", 2);

    /// <summary>The media answer: content type and bytes (and an optional declared length).</summary>
    public Func<Uri, (string Type, byte[] Bytes, long? Length)> Media { get; set; } = _ => ("image/gif", "GIF89a-fake"u8.ToArray(), null);

    public static string Item(string slug, string host = "static.klipy.com", string type = "gif") => $$"""
        { "id": 1, "slug": "{{slug}}", "title": "A {{slug}}", "type": "{{type}}",
          "file": {
            "md": { "gif": { "url": "https://{{host}}/ii/{{slug}}/md.gif", "width": 220, "height": 160, "size": 1000 },
                    "webp": { "url": "https://{{host}}/ii/{{slug}}/md.webp", "width": 220, "height": 160, "size": 900 } },
            "sm": { "gif": { "url": "https://{{host}}/ii/{{slug}}/sm.gif", "width": 110, "height": 80, "size": 400 } } } }
        """;

    public static string Page(string prefix, int count, bool hasNext = true, params string[] extra) =>
        $$"""{ "result": true, "data": { "data": [ {{string.Join(",", Enumerable.Range(1, count).Select(i => Item($"{prefix}-{i}")).Concat(extra))}} ], "current_page": 1, "per_page": 24, "has_next": {{(hasNext ? "true" : "false")}} } }""";

    public const string Categories = """
        { "result": true, "data": { "categories": [
          { "category": "Happy", "query": "happy", "preview_url": "https://static.klipy.com/ii/happy.gif" },
          { "category": "Evil", "query": "evil", "preview_url": "https://evil.example/x.gif" } ] } }
        """;

    public Task<string?> GetJsonAsync(Uri uri, CancellationToken cancel)
    {
        Requests.Enqueue(uri);
        return Task.FromResult(Json(uri));
    }

    public Task<HttpResponseMessage> GetMediaAsync(Uri uri, CancellationToken cancel)
    {
        MediaRequests.Enqueue(uri);
        var (type, bytes, length) = Media(uri);
        var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = new MediaTypeHeaderValue(type);
        if (length is { } l) content.Headers.ContentLength = l;
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
    }
}
