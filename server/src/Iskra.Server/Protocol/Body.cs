using System.Text.Json;

namespace Iskra.Server.Protocol;

/// <summary>Thrown by handlers; the router turns it into an error frame. The session stays open.</summary>
public sealed class RequestException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;

    public static RequestException BadRequest(string message) => new("bad_request", message);
    public static RequestException Forbidden(string message = "You don't have permission to do that.") => new("forbidden", message);
    public static RequestException NotFound(string what) => new("not_found", $"{what} not found.");
}

/// <summary>Typed, validated access to a request body. Every field read goes through here.</summary>
public readonly struct Body(JsonElement element)
{
    private JsonElement? Field(string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind != JsonValueKind.Null
            ? value
            : null;

    /// <summary>The field is present and not null.</summary>
    public bool Has(string name) => Field(name) is not null;

    public string String(string name, int maxLength) =>
        OptionalString(name, maxLength) ?? throw RequestException.BadRequest($"'{name}' is required.");

    public string? OptionalString(string name, int maxLength)
    {
        if (Field(name) is not { } value) return null;
        if (value.ValueKind != JsonValueKind.String) throw RequestException.BadRequest($"'{name}' must be a string.");
        var text = value.GetString()!;
        if (text.Length > maxLength) throw RequestException.BadRequest($"'{name}' is longer than {maxLength} characters.");
        return text;
    }

    public string[] OptionalStringArray(string name, int maxItems, int maxLength)
    {
        if (Field(name) is not { } value) return [];
        if (value.ValueKind != JsonValueKind.Array) throw RequestException.BadRequest($"'{name}' must be a list.");
        if (value.GetArrayLength() > maxItems) throw RequestException.BadRequest($"'{name}' can have at most {maxItems} items.");
        return value.EnumerateArray().Select(item =>
            item.ValueKind == JsonValueKind.String && item.GetString() is { } s && s.Length <= maxLength
                ? s
                : throw RequestException.BadRequest($"'{name}' must be a list of strings.")).ToArray();
    }

    public bool? OptionalBool(string name)
    {
        if (Field(name) is not { } value) return null;
        return value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => throw RequestException.BadRequest($"'{name}' must be true or false."),
        };
    }

    public JsonElement Element(string name) =>
        Field(name) ?? throw RequestException.BadRequest($"'{name}' is required.");

    public long Long(string name) =>
        OptionalLong(name) ?? throw RequestException.BadRequest($"'{name}' is required.");

    public long? OptionalLong(string name, long min = long.MinValue, long max = long.MaxValue)
    {
        if (Field(name) is not { } value) return null;
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out var number))
            throw RequestException.BadRequest($"'{name}' must be an integer.");
        if (number < min || number > max) throw RequestException.BadRequest($"'{name}' is out of range.");
        return number;
    }
}
