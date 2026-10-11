using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

public delegate object? Handler(Session session, Member me, Body body);
public delegate Task<object?> AsyncHandler(Session session, Member me, Body body);

/// <summary>Maps request types to handlers. A handler returns the result body, or throws <see cref="RequestException"/>.</summary>
public sealed class Router
{
    private readonly Dictionary<string, Handler> _handlers = new(StringComparer.Ordinal);
    private readonly Dictionary<string, AsyncHandler> _asyncHandlers = new(StringComparer.Ordinal);
    private readonly ILogger<Router> _log;

    public Router(ILogger<Router> log, Hosting.InternetHost internet, Backups.BackupService backups, Import.ImportService imports)
    {
        _log = log;
        Add("ping", (_, _, _) => new { });
        ChatFeature.Register(this);
        ChannelFeature.Register(this);
        MemberFeature.Register(this);
        InviteFeature.Register(this);
        VoiceFeature.Register(this);
        DmFeature.Register(this);
        DeviceFeature.Register(this);
        LinkFeature.Register(this);
        PreviewFeature.Register(this);
        PinFeature.Register(this);
        SearchFeature.Register(this);
        ThreadFeature.Register(this);
        CallFeature.Register(this);
        BotFeature.Register(this);
        WebhookFeature.Register(this);
        PollFeature.Register(this);
        EmojiFeature.Register(this);
        SoundboardFeature.Register(this);
        PushFeature.Register(this);
        HostFeature.Register(this, internet);
        ProfileFeature.Register(this);
        ForumFeature.Register(this);
        EventFeature.Register(this);
        StageFeature.Register(this);
        PresenceFeature.Register(this);
        ModerationFeature.Register(this);
        OrganizeFeature.Register(this);
        WatchFeature.Register(this);
        GroupFeature.Register(this);
        GroupCallFeature.Register(this);
        BackupFeature.Register(this, backups);
        LimitsFeature.Register(this);
        MoveFeature.Register(this);
        ImportFeature.Register(this, imports);
        KeyFeature.Register(this);
        RoleFeature.Register(this);
        ActivityFeature.Register(this);
        DmFileFeature.Register(this);
        StickerFeature.Register(this);
        GifFeature.Register(this);
        RulesFeature.Register(this);
        AutoModFeature.Register(this);
        LeaveFeature.Register(this);
        ReportFeature.Register(this);
        AccountFeature.Register(this);
    }

    public void Add(string type, Handler handler) => _handlers.Add(type, handler);

    /// <summary>For slow work (network fetches): runs off the read loop, so the connection stays responsive.</summary>
    public void AddAsync(string type, AsyncHandler handler) => _asyncHandlers.Add(type, handler);

    public void Handle(Session session, Member me, Envelope request)
    {
        if ((ModerationFeature.Gate(session, me, request.Type) ?? RulesFeature.Gate(session, me, request.Type)) is { } refused)
        {
            session.Send(Frames.Error(request.Id, refused.Code, refused.Message));
            return;
        }
        if (MoveFeature.Refuse(session, request)) return;
        if (_asyncHandlers.TryGetValue(request.Type, out var asyncHandler))
        {
            _ = RunAsync(session, me, request, asyncHandler);
            return;
        }
        if (!_handlers.TryGetValue(request.Type, out var handler))
        {
            session.Send(Frames.Error(request.Id, "unknown_type", $"Unknown type '{Truncate(request.Type, 64)}'."));
            return;
        }
        try
        {
            var result = handler(session, me, new Body(request.Body));
            session.Send(Frames.Result(request.Id, result ?? new { }));
            session.RunAfterReply();
        }
        catch (RequestException ex)
        {
            session.Send(Frames.Error(request.Id, ex.Code, ex.Message));
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Handler {Type} failed", request.Type);
            session.Send(Frames.Error(request.Id, "internal", "Something went wrong on the server."));
        }
    }

    private async Task RunAsync(Session session, Member me, Envelope request, AsyncHandler handler)
    {
        try
        {
            var result = await handler(session, me, new Body(request.Body));
            session.Send(Frames.Result(request.Id, result ?? new { }));
        }
        catch (RequestException ex)
        {
            session.Send(Frames.Error(request.Id, ex.Code, ex.Message));
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Handler {Type} failed", request.Type);
            session.Send(Frames.Error(request.Id, "internal", "Something went wrong on the server."));
        }
    }

    private static string Truncate(string text, int max) => text.Length <= max ? text : text[..max];
}
