using System.Text.Json;
using System.Text.Json.Nodes;

namespace Iskra.Server.Protocol;

/// <summary>One frame on the wire: { type, id?, seq?, body? }. See protocol/PROTOCOL.md.</summary>
public sealed record Envelope(string Type, string? Id, JsonElement Body)
{
    public const int MaxIdLength = 32;

    /// <summary>Parses a client frame. Returns null for anything that isn't a well-formed envelope.</summary>
    public static Envelope? TryParse(ReadOnlySpan<byte> utf8)
    {
        try
        {
            using var doc = JsonDocument.Parse(utf8.ToArray(), new JsonDocumentOptions { MaxDepth = 16 });
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!root.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String) return null;

            string? id = null;
            if (root.TryGetProperty("id", out var idElement))
            {
                if (idElement.ValueKind != JsonValueKind.String) return null;
                id = idElement.GetString();
                if (id is null || id.Length is 0 or > MaxIdLength) return null;
            }

            var body = root.TryGetProperty("body", out var b) ? b.Clone() : default;
            return new Envelope(type.GetString()!, id, body);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

public static class Frames
{
    public static string Event(string type, object body) =>
        new JsonObject { ["type"] = type, ["body"] = JsonSerializer.SerializeToNode(body, Json.Options) }.ToJsonString();

    public static string Result(string? id, object body) =>
        new JsonObject { ["type"] = "result", ["id"] = id, ["body"] = JsonSerializer.SerializeToNode(body, Json.Options) }.ToJsonString();

    public static string Error(string? id, string code, string message, object? extra = null)
    {
        var body = extra is null ? new JsonObject() : JsonSerializer.SerializeToNode(extra, Json.Options)!.AsObject();
        body["code"] = code;
        body["message"] = message;
        var frame = new JsonObject
        {
            ["type"] = "error",
            ["body"] = body,
        };
        if (id is not null) frame["id"] = id;
        return frame.ToJsonString();
    }
}

public static class Json
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);
}

public static class CloseCodes
{
    public const int BadRequests = 4400;
    public const int AuthFailed = 4401;
    public const int Forbidden = 4403;
    /// <summary>The account moved to a new key (preceded by an account.rotated event).</summary>
    public const int Rotated = 4409;
    public const int TooLarge = 4413;
}
