using Iskra.Server;
using Iskra.Server.Features;
using Iskra.Server.Files;
using Iskra.Server.Hosting;
using Iskra.Server.Push;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Iskra.Server.Voice;
using Microsoft.Extensions.Options;

// Usage: iskra-server <world-folder>   (the folder is created with defaults if it doesn't exist)
// Also: restore, backup, move, import-discord (see Cli.cs).
if (Iskra.Server.Cli.IsCommand(args.FirstOrDefault()))
{
    Environment.ExitCode = Iskra.Server.Cli.Run(args);
    return;
}

var (worldArg, configArgs) = CommandLine.Split(args);
var builder = WebApplication.CreateBuilder(configArgs);

var worldPath = builder.Configuration["World"] ?? worldArg ?? "world";
var world = World.OpenOrCreate(worldPath);
MoveFeature.Load(world);

builder.Services.AddSingleton(world);
builder.Services.AddSingleton<Hub>();
builder.Services.AddSingleton<Router>();
builder.Services.AddSingleton<LiveKitHost>();
builder.Services.AddSingleton<IVoiceBackend>(sp => sp.GetRequiredService<LiveKitHost>());
builder.Services.AddHostedService(sp => sp.GetRequiredService<LiveKitHost>());
builder.Services.AddSingleton<CallRegistry>();
builder.Services.AddSingleton<GroupCallRegistry>();
builder.Services.AddSingleton<VoiceRegistry>();
builder.Services.AddSingleton<Uploads>();
builder.Services.AddHostedService<UploadSweeper>();
builder.Services.AddSingleton<LinkPreviews>();
builder.Services.AddSingleton<Iskra.Server.Gifs.GifService>();
builder.Services.AddSingleton<Iskra.Server.Gifs.IGifUpstream, Iskra.Server.Gifs.GifUpstream>();
builder.Services.AddSingleton<WebhookIngress>();
builder.Services.AddHostedService<PollCloser>();
builder.Services.AddSingleton<EventScheduler>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<EventScheduler>());
builder.Services.AddHostedService<ModerationSweeper>();
builder.Services.AddHostedService<ProductivityScheduler>();
builder.Services.AddPush(world);
builder.Services.AddSingleton<LinkRelay>();
builder.Services.Configure<LinkSettings>(builder.Configuration.GetSection("Link"));
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
builder.Services.AddSingleton<IPortMapper>(sp => builder.Configuration["Internet:TestRouter"] is { Length: > 0 } fake
    ? new TestRouter(fake)
    : ActivatorUtilities.CreateInstance<PortMapper>(sp));
builder.Services.AddSingleton<InternetHost>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<InternetHost>());
builder.Services.AddSingleton<Iskra.Server.Backups.BackupService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<Iskra.Server.Backups.BackupService>());
builder.Services.AddSingleton<Iskra.Server.Import.ImportService>();
// Server updates from GitHub releases (Settings → Updates). Updates:FeedFile reads releases from a file instead (tests).
builder.Services.AddSingleton<Iskra.Server.Updates.IReleaseFeed>(sp => builder.Configuration["Updates:FeedFile"] is { Length: > 0 } feedFile
    ? new Iskra.Server.Updates.FileReleaseFeed(feedFile)
    : ActivatorUtilities.CreateInstance<Iskra.Server.Updates.GitHubReleaseFeed>(sp));
builder.Services.AddSingleton<Iskra.Server.Updates.UpdateService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<Iskra.Server.Updates.UpdateService>());
builder.Services.AddSingleton<DataExports>();
builder.Services.AddHostedService<RetentionSweeper>();

var https = world.Settings.Https;
if (https.Enabled)
{
    builder.WebHost.ConfigureKestrel(kestrel =>
    {
        var certificates = kestrel.ApplicationServices.GetRequiredService<Certificates>();
        certificates.LoadExisting();
        kestrel.ListenLocalhost(world.Settings.Port); // internal: LiveKit webhooks and local tools
        void Listen(int port, Action<Microsoft.AspNetCore.Server.Kestrel.Core.ListenOptions>? configure = null)
        {
            if (world.Settings.LocalOnly) kestrel.ListenLocalhost(port, configure ?? (_ => { }));
            else kestrel.ListenAnyIP(port, configure ?? (_ => { }));
        }
        Listen(https.HttpPort);          // Let's Encrypt challenges, everything else redirects
        Listen(https.Port, listen => listen.UseHttps(new Microsoft.AspNetCore.Server.Kestrel.Https.TlsHandshakeCallbackOptions
        {
            // Asked on every handshake, so a renewed certificate is used right away.
            OnConnection = _ => ValueTask.FromResult(new System.Net.Security.SslServerAuthenticationOptions
            {
                ServerCertificateContext = certificates.Context,
                EnabledSslProtocols = SecurityHeaders.Protocols,
            }),
        }));
    });
}
else
{
    // One port on every interface, speaking HTTP and (for internet hosting) HTTPS.
    builder.WebHost.ConfigureKestrel(kestrel =>
    {
        var certificates = kestrel.ApplicationServices.GetRequiredService<Certificates>();
        certificates.LoadExisting();
        void Dual(Microsoft.AspNetCore.Server.Kestrel.Core.ListenOptions listen) => listen.Use(DualProtocol.Middleware(() => certificates.Context));
        if (world.Settings.LocalOnly) kestrel.ListenLocalhost(world.Settings.Port, Dual);
        else kestrel.ListenAnyIP(world.Settings.Port, Dual);
    });
}

var app = builder.Build();
app.Lifetime.ApplicationStopped.Register(world.Dispose);
ChildProcesses.StopWhenParentExits(app.Lifetime, app.Logger);
ChildProcesses.StopWhenStdinCloses(app.Lifetime, app.Logger);
SecurityHeaders.Use(app);

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
            if (WebhookIngress.RefuseOverPlainHttp(context)) await WebhookIngress.WriteUseHttpsAsync(context);
            else context.Response.Redirect($"{https.DefaultUrl}{context.Request.Path}{context.Request.QueryString}");
            return;
        }
        if (context.Request.IsHttps) context.Response.Headers.StrictTransportSecurity = "max-age=31536000";
        await next();
    });
}
else
{
    // Internet hosting with a certificate: plain HTTP from the internet goes to HTTPS. LAN and localhost stay as they are.
    app.Use(async (context, next) =>
    {
        if (!context.Request.IsHttps && world.InternetUrl is { } publicUrl && publicUrl.StartsWith("https://", StringComparison.Ordinal)
            && context.Connection.RemoteIpAddress is { } remote && !Networks.IsNonPublic(remote)
            && !context.Request.Path.StartsWithSegments("/.well-known"))
        {
            if (WebhookIngress.RefuseOverPlainHttp(context)) await WebhookIngress.WriteUseHttpsAsync(context);
            else context.Response.Redirect($"{publicUrl}{context.Request.Path}{context.Request.QueryString}", permanent: false, preserveMethod: true);
            return;
        }
        await next();
    });
}

// Let's Encrypt's HTTP-01 check (internet hosting: outside port 80 leads here).
app.MapGet("/.well-known/acme-challenge/{token}", (string token, Certificates certificates) =>
    certificates.Challenge(token) is { } answer ? Results.Text(answer) : Results.NotFound());
// Internet hosting asks itself through the router to see whether the ports lead here.
app.MapGet("/.well-known/iskra-probe/{token}", (string token, InternetHost internet) =>
    token == internet.ProbeToken ? Results.Text(token) : Results.NotFound());

app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(20) });

app.MapGet("/", (World w) => Results.Json(new { iskra = 1, name = w.Settings.Name }));
// For uptime monitors: up, version, how long it's been running, whether voice is up. Nothing secret.
app.MapGet("/health", (IVoiceBackend voice, World w, Iskra.Server.Updates.UpdateService updates) => HealthFeature.Report(w, voice, updates.Env.Current));

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
app.MapGet("/gifs/media", (HttpContext context, Iskra.Server.Gifs.GifService gifs, Iskra.Server.Gifs.IGifUpstream upstream, Hub hub) =>
    GifFeature.ServeMedia(context, gifs, upstream, hub));
app.MapGet("/dmfiles/{id}", (HttpContext context, string id, Uploads uploads, World w) => DmFileFeature.Serve(context, w, uploads, id));
app.MapGet("/pages/{id}", (HttpContext context, string id, World w) => ProfilePages.Serve(context, w, id));

// Incoming webhooks: POST /hooks/{id}/{secret}.
WebhookIngress.Map(app);
// Device linking: a short-lived relay for a new device that has no account yet.
LinkRelay.MapEndpoints(app);
// Backups, moving to another computer, imports.
BackupFeature.MapEndpoints(app);
MoveFeature.MapEndpoints(app);
ImportFeature.MapEndpoints(app);
// "Download my data" links.
ComplianceFeature.MapEndpoints(app);
app.Services.GetRequiredService<Iskra.Server.Import.ImportService>().CleanUp();

app.Map("/ws", async (HttpContext context, World w, Hub hub, VoiceRegistry voice, Uploads uploads, LinkPreviews previews, Router router,
    IOptions<SessionLimits> limits, ILogger<Session> log, TimeProvider time, PushService push) =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }
    using var socket = await context.WebSockets.AcceptWebSocketAsync();
    await new Session(socket, w, hub, voice, uploads, previews, router, limits.Value, log, time)
    {
        Push = push,
        Gifs = context.RequestServices.GetRequiredService<Iskra.Server.Gifs.GifService>(),
        Origin = $"{context.Request.Scheme}://{context.Request.Host}",
        RemoteIp = context.Connection.RemoteIpAddress is { } ip ? (ip.IsIPv4MappedToIPv6 ? ip.MapToIPv4() : ip).ToString() : null,
    }.RunAsync(context.RequestAborted, context.RequestServices.GetRequiredService<IHostApplicationLifetime>().ApplicationStopping);
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
