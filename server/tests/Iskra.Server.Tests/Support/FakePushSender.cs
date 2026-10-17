using System.Text.Json;
using Iskra.Server.Push;

namespace Iskra.Server.Tests.Support;

/// <summary>Records pushes instead of sending them. <see cref="Respond"/> picks the push service's answer.</summary>
public sealed class FakePushSender : IPushSender
{
    private readonly List<PushDelivery> _sent = [];

    public Func<PushDelivery, PushOutcome> Respond { get; set; } = _ => PushOutcome.Delivered;

    public Task<PushOutcome> SendAsync(PushDelivery delivery, CancellationToken cancel)
    {
        lock (_sent) _sent.Add(delivery);
        return Task.FromResult(Respond(delivery));
    }

    public List<PushDelivery> SentTo(string endpoint)
    {
        lock (_sent) return _sent.Where(d => d.Endpoint == endpoint).ToList();
    }

    /// <summary>Waits until <paramref name="endpoint"/> has had <paramref name="count"/> pushes; returns their payloads.</summary>
    public async Task<List<JsonElement>> WaitForAsync(string endpoint, int count = 1, int timeoutMs = 5_000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (SentTo(endpoint).Count < count)
        {
            if (DateTime.UtcNow > deadline) throw new Xunit.Sdk.XunitException($"Expected {count} push(es), got {SentTo(endpoint).Count}.");
            await Task.Delay(20);
        }
        return SentTo(endpoint).Select(d => JsonDocument.Parse(d.Payload).RootElement.Clone()).ToList();
    }

    /// <summary>Waits for one push to <paramref name="endpoint"/> that <paramref name="match"/> picks, whatever else arrives.</summary>
    public async Task<JsonElement> WaitForMatchAsync(string endpoint, Func<JsonElement, bool> match, int timeoutMs = 5_000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (true)
        {
            var found = SentTo(endpoint).Select(d => JsonDocument.Parse(d.Payload).RootElement.Clone()).Where(match).ToList();
            if (found.Count == 1) return found[0];
            if (found.Count > 1) throw new Xunit.Sdk.XunitException($"Expected one matching push, got {found.Count}.");
            if (DateTime.UtcNow > deadline) throw new Xunit.Sdk.XunitException($"No matching push among {SentTo(endpoint).Count}.");
            await Task.Delay(20);
        }
    }

    /// <summary>Asserts that <paramref name="endpoint"/> gets nothing (more) for a little while.</summary>
    public async Task NoneAsync(string endpoint, int already = 0, int waitMs = 400)
    {
        await Task.Delay(waitMs);
        Assert.Equal(already, SentTo(endpoint).Count);
    }
}
