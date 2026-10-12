using System.Net;

namespace Iskra.Server.Hosting;

/// <summary>
/// A pretend router for end-to-end tests (--Internet:TestRouter=...): "none" (no router), or
/// "&lt;external ip&gt;" optionally followed by ",refuse-low" (refuses ports below 1024, like many routers).
/// </summary>
public sealed class TestRouter(string spec) : IPortMapper, INatRouter
{
    private readonly string[] _parts = spec.Split(',', StringSplitOptions.TrimEntries);

    public string Kind => "UPnP";

    /// <summary>",model=&lt;make and model&gt;" in the spec: what UPnP says the router is.</summary>
    public string? Model => _parts.FirstOrDefault(p => p.StartsWith("model=", StringComparison.Ordinal))?["model=".Length..];

    /// <summary>",tailscale=&lt;100.x address&gt;" in the spec: pretend Tailscale is on (the server itself stays localhost-only).</summary>
    public IPAddress? TailscaleAddress =>
        _parts.FirstOrDefault(p => p.StartsWith("tailscale=", StringComparison.Ordinal)) is { } part && IPAddress.TryParse(part["tailscale=".Length..], out var ip) && Tailscale.InRange(ip)
            ? ip : null;

    public Task<INatRouter?> FindRouterAsync(CancellationToken cancel) =>
        Task.FromResult<INatRouter?>(_parts[0] == "none" ? null : this);

    public Task<IPAddress> ExternalAddressAsync(CancellationToken cancel) => Task.FromResult(IPAddress.Parse(_parts[0]));

    public Task<MappedPort> MapAsync(PortProtocol protocol, int internalPort, int externalPort, TimeSpan lifetime, string description, CancellationToken cancel)
    {
        if (externalPort < 1024 && _parts.Contains("refuse-low")) throw new PortMappingException("The router doesn't allow opening this port.");
        return Task.FromResult(new MappedPort(protocol, internalPort, externalPort, lifetime));
    }

    public Task UnmapAsync(MappedPort mapping, CancellationToken cancel) => Task.CompletedTask;
}
