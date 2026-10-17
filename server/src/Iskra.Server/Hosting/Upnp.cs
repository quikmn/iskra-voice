using System.Net;
using System.Net.Sockets;
using System.Security;
using System.Text;
using System.Xml;
using System.Xml.Linq;

namespace Iskra.Server.Hosting;

/// <summary>
/// UPnP Internet Gateway Device: SSDP discovery, then SOAP calls to the router's WANIPConnection
/// (or WANPPPConnection) service. Router answers are untrusted input: sizes are capped, DTDs refused,
/// and only routers on the local network are talked to.
/// </summary>
public sealed class Upnp : INatRouter
{
    private const int MaxResponseBytes = 256 * 1024;
    private static readonly string[] SearchTargets =
    [
        "urn:schemas-upnp-org:device:InternetGatewayDevice:2",
        "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
        "urn:schemas-upnp-org:service:WANIPConnection:1",
    ];
    // Best first.
    private static readonly string[] Services =
    [
        "urn:schemas-upnp-org:service:WANIPConnection:2",
        "urn:schemas-upnp-org:service:WANIPConnection:1",
        "urn:schemas-upnp-org:service:WANPPPConnection:1",
    ];

    private readonly HttpClient _http;

    public string Kind => "UPnP";
    public Uri ControlUrl { get; }
    public string ServiceType { get; }
    /// <summary>This computer's address on the router's network (where mapped ports point).</summary>
    public IPAddress LocalAddress { get; }

    /// <summary>The router's make and model from its UPnP description (e.g. "AVM FRITZ!Box 7590"), if it said.</summary>
    public string? Model { get; init; }

    /// <summary>Whether it answered from the default gateway's address (any LAN device can answer a UPnP search).</summary>
    public bool AtGateway { get; init; }

    public Upnp(HttpClient http, Uri controlUrl, string serviceType, IPAddress localAddress)
    {
        _http = http;
        ControlUrl = controlUrl;
        ServiceType = serviceType;
        LocalAddress = localAddress;
    }

    // ── Discovery ────────────────────────────────────────────────────────────

    public static async Task<INatRouter?> DiscoverAsync(HttpClient http, TimeSpan wait, ILogger log, CancellationToken cancel)
    {
        var searches = Networks.Interfaces().Where(i => Networks.IsLan(i.Local))
            .Select(i => DiscoverOnAsync(http, i.Local, i.Gateway, wait, log, cancel)).ToList();
        while (searches.Count > 0)
        {
            var done = await Task.WhenAny(searches);
            searches.Remove(done);
            if (await done is { } router) return router;
        }
        return null;
    }

    /// <summary>
    /// Searches one network. The default gateway is the router we want: its answer is used as soon as it comes.
    /// Other devices that answer (a second router, or anything on the LAN pretending to be one) are only tried
    /// after the search window, if the gateway didn't answer.
    /// </summary>
    private static async Task<INatRouter?> DiscoverOnAsync(HttpClient http, IPAddress local, IPAddress gateway, TimeSpan wait, ILogger log,
        CancellationToken cancel)
    {
        using var udp = new UdpClient(new IPEndPoint(local, 0));
        var multicast = new IPEndPoint(IPAddress.Parse("239.255.255.250"), 1900);
        foreach (var target in SearchTargets)
        {
            var search = Encoding.ASCII.GetBytes(
                $"M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {target}\r\n\r\n");
            await udp.SendAsync(search, multicast, cancel);
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        timeout.CancelAfter(wait);
        var tried = new HashSet<string>();
        var others = new List<Uri>();
        while (true)
        {
            UdpReceiveResult reply;
            try
            {
                reply = await udp.ReceiveAsync(timeout.Token);
            }
            catch (OperationCanceledException) when (!cancel.IsCancellationRequested)
            {
                break;
            }
            catch (SocketException)
            {
                continue; // e.g. ICMP unreachable echoed back on Windows
            }
            var location = ParseLocation(Encoding.ASCII.GetString(reply.Buffer));
            // Only follow descriptions on the router that answered, on the local network.
            if (location is null || !IPAddress.TryParse(location.Host, out var host) || !host.Equals(reply.RemoteEndPoint.Address)
                || !Networks.IsLan(host) || !tried.Add(location.AbsoluteUri))
                continue;
            if (!host.Equals(gateway))
            {
                others.Add(location);
                continue;
            }
            if (await TryAsync(location, atGateway: true) is { } router) return router;
        }
        foreach (var location in others)
            if (await TryAsync(location, atGateway: false) is { } router) return router;
        return null;

        async Task<Upnp?> TryAsync(Uri location, bool atGateway)
        {
            try
            {
                return await FromDescriptionAsync(http, location, local, cancel) is { } found ? found.WithGateway(atGateway) : null;
            }
            catch (Exception ex) when (ex is HttpRequestException or XmlException or PortMappingException or TaskCanceledException or InvalidOperationException)
            {
                if (cancel.IsCancellationRequested) throw;
                log.Debug("nat", "skipped", ("what", "upnp-device"), ("name", ex.GetType().Name));
                return null;
            }
        }
    }

    private Upnp WithGateway(bool atGateway) => new(_http, ControlUrl, ServiceType, LocalAddress) { AtGateway = atGateway, Model = Model };

    internal static Uri? ParseLocation(string response)
    {
        foreach (var line in response.Split("\r\n"))
        {
            var colon = line.IndexOf(':');
            if (colon > 0 && line[..colon].Trim().Equals("LOCATION", StringComparison.OrdinalIgnoreCase)
                && Uri.TryCreate(line[(colon + 1)..].Trim(), UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttp)
                return uri;
        }
        return null;
    }

    /// <summary>Reads the device description and picks a WAN connection service that reports an external address.</summary>
    internal static async Task<Upnp?> FromDescriptionAsync(HttpClient http, Uri location, IPAddress local, CancellationToken cancel)
    {
        using var response = await http.GetAsync(location, HttpCompletionOption.ResponseHeadersRead, cancel);
        response.EnsureSuccessStatusCode();
        var xml = await ReadLimitedAsync(response, cancel);
        var model = ParseModel(xml);
        foreach (var (type, control) in ParseServices(xml, location))
        {
            var router = new Upnp(http, control, type, local) { Model = model };
            try
            {
                await router.ExternalAddressAsync(cancel);
                return router;
            }
            catch (PortMappingException) { } // an unused WAN connection; try the next
        }
        return null;
    }

    /// <summary>
    /// The root device's make and model, for the owner's port-forwarding help. Untrusted text from the network:
    /// printable characters only (no direction overrides), at most 80.
    /// </summary>
    internal static string? ParseModel(string xml)
    {
        try
        {
            var device = ParseXml(xml).Descendants().FirstOrDefault(e => e.Name.LocalName == "device");
            if (device is null) return null;
            string? Field(string name) => device.Elements().FirstOrDefault(e => e.Name.LocalName == name)?.Value.Trim();
            var maker = Field("manufacturer");
            var model = Field("modelName");
            if (string.IsNullOrEmpty(model)) model = Field("friendlyName");
            var number = Field("modelNumber");
            if (!string.IsNullOrEmpty(number) && !string.IsNullOrEmpty(model) && !model.Contains(number, StringComparison.OrdinalIgnoreCase)) model += " " + number;
            var text = string.IsNullOrEmpty(maker) || (model?.StartsWith(maker, StringComparison.OrdinalIgnoreCase) ?? false) ? model : $"{maker} {model}";
            if (string.IsNullOrWhiteSpace(text)) return null;
            var clean = new string(text.Select(c => char.IsControl(c) || char.GetUnicodeCategory(c) == System.Globalization.UnicodeCategory.Format ? ' ' : c).ToArray());
            clean = string.Join(' ', clean.Split(' ', StringSplitOptions.RemoveEmptyEntries));
            return clean.Length == 0 ? null : clean.Length > 80 ? clean[..80] : clean;
        }
        catch (XmlException)
        {
            return null;
        }
    }

    /// <summary>The WAN connection services in a device description, best first, with absolute control URLs.</summary>
    internal static List<(string Type, Uri Control)> ParseServices(string xml, Uri location)
    {
        var doc = ParseXml(xml);
        var urlBase = doc.Descendants().FirstOrDefault(e => e.Name.LocalName == "URLBase")?.Value.Trim();
        var baseUri = !string.IsNullOrEmpty(urlBase) && Uri.TryCreate(urlBase, UriKind.Absolute, out var b) ? b : location;
        var found = new List<(string, Uri)>();
        foreach (var service in doc.Descendants().Where(e => e.Name.LocalName == "service"))
        {
            var type = service.Elements().FirstOrDefault(e => e.Name.LocalName == "serviceType")?.Value.Trim();
            var control = service.Elements().FirstOrDefault(e => e.Name.LocalName == "controlURL")?.Value.Trim();
            if (type is null || control is null || !Services.Contains(type)) continue;
            if (!Uri.TryCreate(baseUri, control, out var url) || url.Scheme != Uri.UriSchemeHttp || url.Host != location.Host) continue;
            found.Add((type, url));
        }
        return found.OrderBy(s => Array.IndexOf(Services, s.Item1)).ToList();
    }

    // ── Actions ──────────────────────────────────────────────────────────────

    public async Task<IPAddress> ExternalAddressAsync(CancellationToken cancel)
    {
        var result = await CallAsync("GetExternalIPAddress", [], cancel);
        if (result.TryGetValue("NewExternalIPAddress", out var text) && IPAddress.TryParse(text, out var ip)) return ip;
        throw new PortMappingException("The router doesn't have an internet address right now.", refused: false);
    }

    public async Task<MappedPort> MapAsync(PortProtocol protocol, int internalPort, int externalPort, TimeSpan lifetime, string description,
        CancellationToken cancel)
    {
        var lease = (int)lifetime.TotalSeconds;
        try
        {
            await AddAsync(protocol, internalPort, externalPort, lease, description, cancel);
        }
        catch (UpnpError e) when (e.Code == 725 && lease != 0)
        {
            // OnlyPermanentLeasesSupported: older routers. We remove it on shutdown.
            lease = 0;
            await AddAsync(protocol, internalPort, externalPort, lease, description, cancel);
        }
        return new MappedPort(protocol, internalPort, externalPort, TimeSpan.FromSeconds(lease));
    }

    private Task AddAsync(PortProtocol protocol, int internalPort, int externalPort, int lease, string description, CancellationToken cancel) =>
        CallAsync("AddPortMapping",
        [
            ("NewRemoteHost", ""),
            ("NewExternalPort", externalPort.ToString()),
            ("NewProtocol", protocol == PortProtocol.Tcp ? "TCP" : "UDP"),
            ("NewInternalPort", internalPort.ToString()),
            ("NewInternalClient", LocalAddress.ToString()),
            ("NewEnabled", "1"),
            ("NewPortMappingDescription", description),
            ("NewLeaseDuration", lease.ToString()),
        ], cancel);

    public async Task UnmapAsync(MappedPort mapping, CancellationToken cancel)
    {
        try
        {
            await CallAsync("DeletePortMapping",
            [
                ("NewRemoteHost", ""),
                ("NewExternalPort", mapping.ExternalPort.ToString()),
                ("NewProtocol", mapping.Protocol == PortProtocol.Tcp ? "TCP" : "UDP"),
            ], cancel);
        }
        catch (UpnpError e) when (e.Code == 714) { } // already gone
    }

    private sealed class UpnpError(int code, string message) : PortMappingException(message)
    {
        public int Code { get; } = code;
    }

    private async Task<Dictionary<string, string>> CallAsync(string action, (string Name, string Value)[] args, CancellationToken cancel)
    {
        var body = new StringBuilder()
            .Append("<?xml version=\"1.0\"?>")
            .Append("<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">")
            .Append($"<s:Body><u:{action} xmlns:u=\"{ServiceType}\">");
        foreach (var (name, value) in args) body.Append($"<{name}>{SecurityElement.Escape(value)}</{name}>");
        body.Append($"</u:{action}></s:Body></s:Envelope>");

        using var request = new HttpRequestMessage(HttpMethod.Post, ControlUrl)
        {
            Content = new StringContent(body.ToString(), Encoding.UTF8, "text/xml"),
        };
        request.Headers.TryAddWithoutValidation("SOAPAction", $"\"{ServiceType}#{action}\"");
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancel);
        var xml = await ReadLimitedAsync(response, cancel);
        if (!response.IsSuccessStatusCode)
        {
            var (code, text) = ParseFault(xml);
            throw new UpnpError(code, Explain(code, text));
        }
        return ParseResult(xml, action + "Response");
    }

    internal static Dictionary<string, string> ParseResult(string xml, string element)
    {
        var doc = ParseXml(xml);
        var response = doc.Descendants().FirstOrDefault(e => e.Name.LocalName == element)
            ?? throw new PortMappingException("The router sent an answer we don't understand.", refused: false);
        return response.Elements().GroupBy(e => e.Name.LocalName).ToDictionary(g => g.Key, g => g.First().Value.Trim());
    }

    internal static (int Code, string Text) ParseFault(string xml)
    {
        try
        {
            var doc = ParseXml(xml);
            var code = doc.Descendants().FirstOrDefault(e => e.Name.LocalName == "errorCode")?.Value.Trim();
            var text = doc.Descendants().FirstOrDefault(e => e.Name.LocalName == "errorDescription")?.Value.Trim() ?? "";
            return (int.TryParse(code, out var n) ? n : 0, text.Length > 100 ? text[..100] : text);
        }
        catch (XmlException)
        {
            return (0, "");
        }
    }

    internal static string Explain(int code, string text) => code switch
    {
        401 or 606 => "The router doesn't allow opening this port.",
        718 => "The router already forwards this port to another device.",
        724 => "The router only forwards ports to the same port number.",
        728 => "The router has no room for more port forwards.",
        729 => "The router's settings block opening this port.",
        _ => $"The router said no (error {code}{(text.Length > 0 ? $": {text}" : "")}).",
    };

    private static XDocument ParseXml(string xml)
    {
        var settings = new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            MaxCharactersInDocument = MaxResponseBytes,
        };
        using var reader = XmlReader.Create(new StringReader(xml), settings);
        return XDocument.Load(reader);
    }

    private static async Task<string> ReadLimitedAsync(HttpResponseMessage response, CancellationToken cancel)
    {
        if (response.Content.Headers.ContentLength > MaxResponseBytes) throw new PortMappingException("The router's answer is too large.", refused: false);
        await using var stream = await response.Content.ReadAsStreamAsync(cancel);
        var buffer = new byte[MaxResponseBytes + 1];
        var length = 0;
        int read;
        while (length < buffer.Length && (read = await stream.ReadAsync(buffer.AsMemory(length), cancel)) > 0) length += read;
        if (length > MaxResponseBytes) throw new PortMappingException("The router's answer is too large.", refused: false);
        return Encoding.UTF8.GetString(buffer, 0, length);
    }
}
