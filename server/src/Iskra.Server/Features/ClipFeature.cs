using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Clips: people save the last seconds of a call on their own device (nothing is uploaded). The server only keeps the
/// consent side: who has clips turned on (<c>voice.state</c> <c>clips</c>, shown to everyone in the call) and a
/// "saved a clip" notice in the voice channel's chat that the person who saved it can't edit or delete.
/// </summary>
public static class ClipFeature
{
    public static void Register(Router router)
    {
        router.Add("voice.clip", Saved);
    }

    /// <summary>
    /// You saved a clip of the voice or stage channel you're in. Only with clips turned on (so everyone could see it
    /// beforehand); posts the notice to the channel's readers.
    /// </summary>
    private static object Saved(Session s, Member me, Body body)
    {
        var channelId = body.Long("channelId");
        var channel = ChatFeature.ReadableChannel(s, me, channelId);
        if (channel.Kind is not ("voice" or "stage")) throw RequestException.BadRequest("That isn't a voice channel.");
        E2eeChannelFeature.RefusePlaintext(s.World.Store, channel, "Clips");
        var here = s.Voice.Participant(channel.Id, me.AccountKey) ?? throw RequestException.Forbidden("You're not in that voice channel.", "not_in_voice_channel");
        if (!here.Clips) throw RequestException.BadRequest("Turn clips on first, so everyone in the call can see it.", "clips_turn_on");

        var message = s.World.Store.AddClipNotice(channel.Id, me.AccountKey, s.Now);
        var view = MessageViews.Public(s.World.Store, message);
        s.Hub.BroadcastToReaders(channel, Frames.Event("chat.message", new { message = view }));
        return new { message = view };
    }

    /// <summary>On a clip notice: <c>{ }</c> (the author is who saved it).</summary>
    public static object? View(Store store, long messageId) => store.IsClipNotice(messageId) ? new { } : null;

    public static void CheckEdit(Store store, Message message)
    {
        if (store.IsClipNotice(message.Id)) throw RequestException.BadRequest("Clip notices can't be edited.");
    }

    /// <summary>The notice is how the others know: the person who saved the clip can't take it down (other moderators can).</summary>
    public static void CheckDelete(Store store, Member me, Message message)
    {
        if (message.AuthorKey == me.AccountKey && store.IsClipNotice(message.Id))
            throw RequestException.Forbidden("You can't delete the notice that you saved a clip.", "clip_notice_delete");
    }
}
