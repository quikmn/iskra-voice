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

    /// <summary>Asserts that <paramref name="endpoint"/> gets nothing (more) for a little while.</summary>
    public async Task NoneAsync(string endpoint, int already = 0, int waitMs = 400)
    {
        await Task.Delay(waitMs);
        Assert.Equal(already, SentTo(endpoint).Count);
    }
}
