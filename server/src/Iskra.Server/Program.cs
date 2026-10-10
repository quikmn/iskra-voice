using Iskra.Server.Features;
using Iskra.Server.Files;
using Iskra.Server.Hosting;
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
builder.Services.AddSingleton<CallRegistry>();
builder.Services.AddSingleton<VoiceRegistry>();
builder.Services.AddSingleton<Uploads>();
builder.Services.AddSingleton<LinkPreviews>();
builder.Services.AddSingleton<WebhookIngress>();
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
builder.Services.AddSingleton<Certificates>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<Certificates>());

var https = world.Settings.Https;
if (https.Enabled)
{
    builder.WebHost.ConfigureKestrel(kestrel =>
    {
        var certificates = kestrel.ApplicationServices.GetRequiredService<Certificates>();
        certificates.LoadExisting();
        kestrel.ListenLocalhost(world.Settings.Port); // internal: LiveKit webhooks and local tools
        kestrel.ListenAnyIP(https.HttpPort);          // Let's Encrypt challenges, everything else redirects
        kestrel.ListenAnyIP(https.Port, listen => listen.UseHttps(new Microsoft.AspNetCore.Server.Kestrel.Https.TlsHandshakeCallbackOptions
        {
            // Asked on every handshake, so a renewed certificate is used right away.
            OnConnection = _ => ValueTask.FromResult(new System.Net.Security.SslServerAuthenticationOptions
            {
                ServerCertificateContext = certificates.Context,
            }),
        }));
    });
}
else
{
    builder.WebHost.UseUrls($"http://0.0.0.0:{world.Settings.Port}");
}

var app = builder.Build();
app.Lifetime.ApplicationStopped.Register(world.Dispose);
ChildProcesses.StopWhenParentExits(app.Lifetime, app.Logger);

if (https.Enabled)
{
    var certificates = app.Services.GetRequiredService<Certificates>();
    app.Use(async (context, next) =>
    {
        if (context.Connection.LocalPort == https.HttpPort)
        {
            // Plain HTTP: only Let's Encrypt's challenge is answered; everything else goes to HTTPS.
            if (context.Request.Path.StartsWithSegments("/.well-known/acme-challenge", out var rest)
                && certificates.Challenge(rest.Value?.Trim('/') ?? "") is { } answer)
            {
                context.Response.ContentType = "text/plain";
                await context.Response.WriteAsync(answer);
                return;
            }
            context.Response.Redirect($"{https.DefaultUrl}{context.Request.Path}{context.Request.QueryString}");
            return;
        }
        if (context.Request.IsHttps) context.Response.Headers.StrictTransportSecurity = "max-age=31536000";
        await next();
    });
}

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

// Files: PUT with a ticket from upload.begin; GET by unguessable id.
app.MapMethods("/upload/{token}", ["PUT"], async (HttpContext context, string token, Uploads uploads) =>
{
    if (context.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
        limit.MaxRequestBodySize = uploads.MaxBytes;
    await uploads.HandleUploadAsync(context, token);
});
app.MapMethods("/upload/{token}", ["OPTIONS"], (HttpContext context) =>
{
    Uploads.AllowCors(context);
    return Results.NoContent();
});
app.MapGet("/files/{id}/{**name}", (HttpContext context, string id, Uploads uploads) => uploads.Serve(context, id));

// Incoming webhooks: POST /hooks/{id}/{secret}.
WebhookIngress.Map(app);

app.Map("/ws", async (HttpContext context, World w, Hub hub, VoiceRegistry voice, Uploads uploads, LinkPreviews previews, Router router,
    IOptions<SessionLimits> limits, ILogger<Session> log, TimeProvider time) =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }
    using var socket = await context.WebSockets.AcceptWebSocketAsync();
    await new Session(socket, w, hub, voice, uploads, previews, router, limits.Value, log, time).RunAsync(context.RequestAborted);
});

// Voice signaling (LiveKit's WebSocket and HTTP) on the same port as everything else.
app.MapReverseProxy();

app.Logger.LogInformation("World '{Name}' at {Path}, reachable at {Url}", world.Settings.Name, world.Path, world.Settings.EffectivePublicUrl);
if (OwnerSetup.EnsureOwnerInvite(world, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) is { } ownerLink)
{
    app.Logger.LogWarning("This server has no owner yet. Open this link to become the owner (single use, also saved in {File}):\n\n    {Link}\n",
        OwnerSetup.FileName, ownerLink);
}
app.Run();

public partial class Program;
