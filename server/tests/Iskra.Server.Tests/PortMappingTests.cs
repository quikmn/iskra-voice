using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Text;
using Iskra.Server.Hosting;

namespace Iskra.Server.Tests;

/// <summary>The UPnP and NAT-PMP clients against scripted routers.</summary>
public class PortMappingTests
{
    private const string Description = """
        <?xml version="1.0"?>
        <root xmlns="urn:schemas-upnp-org:device-1-0">
          <device>
            <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
            <deviceList><device><deviceList><device>
              <serviceList>
                <service>
                  <serviceType>urn:schemas-upnp-org:service:WANPPPConnection:1</serviceType>
                  <controlURL>/ctl/PPP</controlURL>
                </service>
                <service>
                  <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
                  <controlURL>/ctl/IPConn</controlURL>
                </service>
                <service>
                  <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
                  <controlURL>http://203.0.113.9/elsewhere</controlURL>
                </service>
              </serviceList>
            </device></deviceList></device></deviceList>
          </device>
        </root>
        """;

    [Fact]
    public void Finds_the_wan_services_on_the_router_itself()
    {
        var services = Upnp.ParseServices(Description, new Uri("http://192.168.1.1:5000/rootDesc.xml"));
        Assert.Equal(2, services.Count); // the one pointing off the router is ignored
        Assert.Equal("urn:schemas-upnp-org:service:WANIPConnection:1", services[0].Type);
        Assert.Equal("http://192.168.1.1:5000/ctl/IPConn", services[0].Control.ToString());
        Assert.Equal("urn:schemas-upnp-org:service:WANPPPConnection:1", services[1].Type);
    }

    [Fact]
    public void Refuses_xml_with_a_dtd()
    {
        var evil = "<?xml version=\"1.0\"?><!DOCTYPE r [<!ENTITY x SYSTEM \"file:///etc/passwd\">]><root>&x;</root>";
        Assert.Throws<System.Xml.XmlException>(() => Upnp.ParseServices(evil, new Uri("http://192.168.1.1/")));
    }

    [Fact]
    public void Reads_the_location_header()
    {
        var reply = "HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=120\r\nlocation: http://192.168.1.1:5000/rootDesc.xml\r\nST: x\r\n\r\n";
        Assert.Equal("http://192.168.1.1:5000/rootDesc.xml", Upnp.ParseLocation(reply)!.ToString());
        Assert.Null(Upnp.ParseLocation("HTTP/1.1 200 OK\r\nLOCATION: https://192.168.1.1/x\r\n\r\n"));
    }

    /// <summary>Answers SOAP calls from a script: action name → (status, body).</summary>
    private sealed class ScriptedRouter(Func<string, string, (HttpStatusCode, string)> answer) : HttpMessageHandler
    {
        public List<string> Calls { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var action = request.Headers.GetValues("SOAPAction").Single().Trim('"').Split('#')[1];
            var body = await request.Content!.ReadAsStringAsync(cancellationToken);
            Calls.Add($"{action} {body}");
            var (status, xml) = answer(action, body);
            return new HttpResponseMessage(status) { Content = new StringContent(xml, Encoding.UTF8, "text/xml") };
        }
    }

    private static string Ok(string action, string inner = "") =>
        $"<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:{action}Response xmlns:u=\"x\">{inner}</u:{action}Response></s:Body></s:Envelope>";

    private static string Fault(int code) =>
        $"<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><s:Fault><detail><UPnPError xmlns=\"urn:schemas-upnp-org:control-1-0\"><errorCode>{code}</errorCode><errorDescription>Nope</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>";

    private static Upnp RouterWith(ScriptedRouter script) =>
        new(new HttpClient(script), new Uri("http://192.168.1.1:5000/ctl/IPConn"), "urn:schemas-upnp-org:service:WANIPConnection:1", IPAddress.Parse("192.168.1.20"));

    [Fact]
    public async Task Upnp_reads_the_address_and_maps_with_a_lease()
    {
        var script = new ScriptedRouter((action, _) => action switch
        {
            "GetExternalIPAddress" => (HttpStatusCode.OK, Ok(action, "<NewExternalIPAddress>203.0.113.7</NewExternalIPAddress>")),
            _ => (HttpStatusCode.OK, Ok(action)),
        });
        var router = RouterWith(script);
        Assert.Equal(IPAddress.Parse("203.0.113.7"), await router.ExternalAddressAsync(TestContext.Current.CancellationToken));

        var mapped = await router.MapAsync(PortProtocol.Udp, 7882, 7882, TimeSpan.FromHours(1), "Iskra", TestContext.Current.CancellationToken);
        Assert.Equal(TimeSpan.FromHours(1), mapped.Lifetime);
        var add = script.Calls.Single(c => c.StartsWith("AddPortMapping"));
        Assert.Contains("<NewProtocol>UDP</NewProtocol>", add);
        Assert.Contains("<NewInternalClient>192.168.1.20</NewInternalClient>", add);
        Assert.Contains("<NewLeaseDuration>3600</NewLeaseDuration>", add);

        await router.UnmapAsync(mapped, TestContext.Current.CancellationToken);
        Assert.Contains(script.Calls, c => c.StartsWith("DeletePortMapping") && c.Contains("<NewExternalPort>7882</NewExternalPort>"));
    }

    [Fact]
    public async Task Upnp_falls_back_to_a_permanent_mapping_on_old_routers()
    {
        var script = new ScriptedRouter((action, body) =>
            body.Contains("<NewLeaseDuration>0</NewLeaseDuration>") ? (HttpStatusCode.OK, Ok(action)) : (HttpStatusCode.InternalServerError, Fault(725)));
        var mapped = await RouterWith(script).MapAsync(PortProtocol.Tcp, 47070, 443, TimeSpan.FromHours(1), "Iskra", TestContext.Current.CancellationToken);
        Assert.Equal(TimeSpan.Zero, mapped.Lifetime);
        Assert.Equal(2, script.Calls.Count);
    }

    [Fact]
    public async Task Upnp_refusals_are_explained()
    {
        var script = new ScriptedRouter((_, _) => (HttpStatusCode.InternalServerError, Fault(718)));
        var error = await Assert.ThrowsAnyAsync<PortMappingException>(() =>
            RouterWith(script).MapAsync(PortProtocol.Tcp, 47070, 80, TimeSpan.FromHours(1), "Iskra", TestContext.Current.CancellationToken));
        Assert.True(error.Refused);
        Assert.Contains("another device", error.Message);
    }

    /// <summary>A NAT-PMP gateway on loopback.</summary>
    private static async Task RunPmpGateway(UdpClient udp, uint grant, ushort refuseBelow, CancellationToken cancel)
    {
        while (!cancel.IsCancellationRequested)
        {
            var request = await udp.ReceiveAsync(cancel);
            var r = request.Buffer;
            byte[] reply;
            if (r[1] == 0)
            {
                reply = [0, 128, 0, 0, 0, 0, 0, 1, 203, 0, 113, 7];
            }
            else
            {
                var external = BinaryPrimitives.ReadUInt16BigEndian(r.AsSpan(6));
                reply = new byte[16];
                reply[1] = (byte)(128 + r[1]);
                if (external != 0 && external < refuseBelow) BinaryPrimitives.WriteUInt16BigEndian(reply.AsSpan(2), 2);
                r.AsSpan(4, 2).CopyTo(reply.AsSpan(8));
                r.AsSpan(6, 2).CopyTo(reply.AsSpan(10));
                BinaryPrimitives.WriteUInt32BigEndian(reply.AsSpan(12), BinaryPrimitives.ReadUInt32BigEndian(r.AsSpan(8)) == 0 ? 0 : grant);
            }
            await udp.SendAsync(reply, request.RemoteEndPoint, cancel);
        }
    }

    [Fact]
    public async Task Nat_pmp_maps_and_reports_refusals()
    {
        using var gateway = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        var port = ((IPEndPoint)gateway.Client.LocalEndPoint!).Port;
        var server = RunPmpGateway(gateway, grant: 600, refuseBelow: 1024, stop.Token);

        var found = await NatPmp.DiscoverAsync([IPAddress.Loopback], stop.Token, port);
        Assert.NotNull(found);
        Assert.Equal("NAT-PMP", found.Kind);
        Assert.Equal(IPAddress.Parse("203.0.113.7"), await found.ExternalAddressAsync(stop.Token));

        var mapped = await found.MapAsync(PortProtocol.Tcp, 47070, 47070, TimeSpan.FromHours(1), "Iskra", stop.Token);
        Assert.Equal(47070, mapped.ExternalPort);
        Assert.Equal(TimeSpan.FromSeconds(600), mapped.Lifetime); // the router's grant wins

        var refused = await Assert.ThrowsAsync<PortMappingException>(() => found.MapAsync(PortProtocol.Tcp, 47070, 80, TimeSpan.FromHours(1), "Iskra", stop.Token));
        Assert.True(refused.Refused);

        await found.UnmapAsync(mapped, stop.Token);
        stop.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => server);
    }

    [Fact]
    public async Task Nat_pmp_gives_up_when_nobody_answers()
    {
        int port;
        using (var probe = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0))) port = ((IPEndPoint)probe.Client.LocalEndPoint!).Port;
        Assert.Null(await NatPmp.DiscoverAsync([IPAddress.Loopback], TestContext.Current.CancellationToken, port));
    }
}
