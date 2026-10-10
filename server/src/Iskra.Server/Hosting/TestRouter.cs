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
