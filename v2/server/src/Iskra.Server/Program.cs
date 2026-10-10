using Iskra.Server.Features;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Microsoft.Extensions.Options;

// Usage: iskra-server <world-folder>   (the folder is created with defaults if it doesn't exist)
var builder = WebApplication.CreateBuilder(args);

var worldPath = builder.Configuration["World"] ?? args.FirstOrDefault(a => !a.StartsWith('-')) ?? "world";
var world = World.OpenOrCreate(worldPath);

builder.Services.AddSingleton(world);
builder.Services.AddSingleton<Hub>();
builder.Services.AddSingleton<Router>();
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.Configure<SessionLimits>(builder.Configuration.GetSection("Session"));
builder.WebHost.UseUrls($"http://0.0.0.0:{world.Settings.Port}"); // TLS arrives with hosting (M6)

var app = builder.Build();
app.Lifetime.ApplicationStopped.Register(world.Dispose);

app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(20) });

app.MapGet("/", (World w) => Results.Json(new { iskra = 1, name = w.Settings.Name }));

app.Map("/ws", async (HttpContext context, World w, Hub hub, Router router, IOptions<SessionLimits> limits,
    ILogger<Session> log, TimeProvider time) =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }
    using var socket = await context.WebSockets.AcceptWebSocketAsync();
    await new Session(socket, w, hub, router, limits.Value, log, time).RunAsync(context.RequestAborted);
});

app.Logger.LogInformation("World '{Name}' at {Path}, listening on port {Port}", world.Settings.Name, world.Path, world.Settings.Port);
if (OwnerSetup.EnsureOwnerInvite(world, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) is { } ownerLink)
{
    app.Logger.LogWarning("This server has no owner yet. Open this link to become the owner (single use, also saved in {File}):\n\n    {Link}\n",
        OwnerSetup.FileName, ownerLink);
}
app.Run();

public partial class Program;
