using Iskra.Server.Features;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Iskra.Server.Voice;
using Microsoft.Extensions.Options;

// Usage: iskra-server <world-folder>   (the folder is created with defaults if it doesn't exist)
var builder = WebApplication.CreateBuilder(args);

var worldPath = builder.Configuration["World"] ?? args.FirstOrDefault(a => !a.StartsWith('-')) ?? "world";
var world = World.OpenOrCreate(worldPath);

builder.Services.AddSingleton(world);
builder.Services.AddSingleton<Hub>();
builder.Services.AddSingleton<Router>();
builder.Services.AddSingleton<LiveKitHost>();
builder.Services.AddSingleton<IVoiceBackend>(sp => sp.GetRequiredService<LiveKitHost>());
builder.Services.AddHostedService(sp => sp.GetRequiredService<LiveKitHost>());
builder.Services.AddSingleton<VoiceRegistry>();
builder.Services.AddReverseProxy().LoadFromMemory(
[
    new Yarp.ReverseProxy.Configuration.RouteConfig
    {
        RouteId = "livekit",
        ClusterId = "livekit",
        Match = new() { Path = "/livekit/{**rest}" },
        Transforms = [new Dictionary<string, string> { ["PathRemovePrefix"] = "/livekit" }],
    },
],
[
    new Yarp.ReverseProxy.Configuration.ClusterConfig
    {
        ClusterId = "livekit",
        Destinations = new Dictionary<string, Yarp.ReverseProxy.Configuration.DestinationConfig>
        {
            ["local"] = new() { Address = $"http://127.0.0.1:{world.Settings.Voice.Port}" },
        },
    },
]);
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.Configure<SessionLimits>(builder.Configuration.GetSection("Session"));
builder.WebHost.UseUrls($"http://0.0.0.0:{world.Settings.Port}"); // TLS arrives with hosting (M6)

var app = builder.Build();
app.Lifetime.ApplicationStopped.Register(world.Dispose);

app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(20) });

app.MapGet("/", (World w) => Results.Json(new { iskra = 1, name = w.Settings.Name }));

// LiveKit tells us who joined or left voice. Only requests signed with this world's LiveKit secret count.
app.MapPost("/internal/livekit-webhook", async (HttpContext context, IVoiceBackend backend, VoiceRegistry voice, TimeProvider time) =>
{
    // LiveKit runs on this machine; nobody else has any business here.
    if (context.Connection.RemoteIpAddress is { } ip && !System.Net.IPAddress.IsLoopback(ip)) return Results.NotFound();
    const int maxBody = 64 * 1024;
    if (context.Request.ContentLength > maxBody) return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
    var buffer = new byte[maxBody + 1];
    var length = 0;
    int read;
    while (length < buffer.Length && (read = await context.Request.Body.ReadAsync(buffer.AsMemory(length))) > 0) length += read;
    if (length > maxBody) return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
    var body = buffer[..length];
    if (!LiveKitTokens.VerifyWebhook(context.Request.Headers.Authorization, body, backend.ApiKey, backend.ApiSecret, time.GetUtcNow()))
        return Results.Unauthorized();
    try
    {
        using var doc = System.Text.Json.JsonDocument.Parse(body);
        voice.HandleWebhook(doc.RootElement, time.GetUtcNow().ToUnixTimeMilliseconds());
    }
    catch (System.Text.Json.JsonException)
    {
        return Results.BadRequest();
    }
    return Results.Ok();
});

app.Map("/ws", async (HttpContext context, World w, Hub hub, VoiceRegistry voice, Router router, IOptions<SessionLimits> limits,
    ILogger<Session> log, TimeProvider time) =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }
    using var socket = await context.WebSockets.AcceptWebSocketAsync();
    await new Session(socket, w, hub, voice, router, limits.Value, log, time).RunAsync(context.RequestAborted);
});

// Voice signaling (LiveKit's WebSocket and HTTP) on the same port as everything else.
app.MapReverseProxy();

app.Logger.LogInformation("World '{Name}' at {Path}, listening on port {Port}", world.Settings.Name, world.Path, world.Settings.Port);
if (OwnerSetup.EnsureOwnerInvite(world, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) is { } ownerLink)
{
    app.Logger.LogWarning("This server has no owner yet. Open this link to become the owner (single use, also saved in {File}):\n\n    {Link}\n",
        OwnerSetup.FileName, ownerLink);
}
app.Run();

public partial class Program;
