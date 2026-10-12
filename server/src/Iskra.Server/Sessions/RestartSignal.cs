using System.Text.Json;
using System.Text.Json.Serialization;

namespace Iskra.Server.Sessions;

/// <summary>
/// What sessions are told when the server stops: close code 1012 ("Service Restart") with a small JSON reason, so apps
/// can say "restarting, hold on" and retry quickly (see "Restarts" in PROTOCOL.md).
/// </summary>
public sealed class RestartSignal
{
    public const int CloseCode = 1012;

    private volatile string _reason = Format("restart", null);

    /// <summary>The close reason sessions get: <c>{"v":1,"reason":"restart"|"update","etaMs"?:n}</c> (at most 123 bytes).</summary>
    public string Reason => _reason;

    /// <summary>Says why the coming stop happens and, when known, about how long it takes to come back.</summary>
    public void Expect(string reason, TimeSpan? eta) => _reason = Format(reason, eta);

    private static string Format(string reason, TimeSpan? eta) =>
        JsonSerializer.Serialize(new Body(1, reason, eta is { } e ? (long)Math.Clamp(e.TotalMilliseconds, 0, 600_000) : null));

    private sealed record Body(
        [property: JsonPropertyName("v")] int V,
        [property: JsonPropertyName("reason")] string Reason,
        [property: JsonPropertyName("etaMs"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? EtaMs);
}
