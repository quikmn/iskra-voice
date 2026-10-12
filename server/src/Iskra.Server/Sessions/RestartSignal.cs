using System.Text.Json;
using System.Text.Json.Serialization;

namespace Iskra.Server.Sessions;

/// <summary>
/// What sessions are told when the server stops (see "Restarts and reconnecting" in PROTOCOL.md). A stop that will come
/// back (an update, the desktop app restarting) closes with 1012 "Service Restart" so apps say "restarting, hold on" and
/// retry quickly; any other stop closes with 1001 "Going Away" and apps show the server as offline.
/// </summary>
public sealed class RestartSignal
{
    public const int RestartCode = 1012;
    public const int StopCode = 1001;

    private volatile Signal _signal = new(StopCode, Format("stop", null));

    /// <summary>The close code sessions get: 1012 when a restart is expected, else 1001.</summary>
    public int Code => _signal.Code;

    /// <summary>The close reason: <c>{"v":1,"reason":"stop"|"restart"|"update","etaMs"?:n}</c> (at most 123 bytes).</summary>
    public string Reason => _signal.Reason;

    /// <summary>The coming stop is a restart: says why and, when known, about how long it takes to come back.</summary>
    public void Expect(string reason, TimeSpan? eta) => _signal = new(RestartCode, Format(reason, eta));

    private sealed record Signal(int Code, string Reason);

    private static string Format(string reason, TimeSpan? eta) =>
        JsonSerializer.Serialize(new Body(1, reason, eta is { } e ? (long)Math.Clamp(e.TotalMilliseconds, 0, 600_000) : null));

    private sealed record Body(
        [property: JsonPropertyName("v")] int V,
        [property: JsonPropertyName("reason")] string Reason,
        [property: JsonPropertyName("etaMs"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? EtaMs);
}
