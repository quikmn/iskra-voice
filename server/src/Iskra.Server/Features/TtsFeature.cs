using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// /tts messages: a normal message with <c>tts: true</c>, which recipients who turned on "Play /tts messages" hear read
/// aloud on their own device (speech synthesis never touches the server). Sending one needs the <c>sendTts</c>
/// permission (admins and the owner have it; give it to others with a role). The server only checks and stores the flag.
/// In encrypted channels the flag rides inside the encrypted content instead, so the server never sees it.
/// </summary>
public static class TtsFeature
{
    /// <summary>The optional <c>tts</c> of a chat.send: false when absent or false; checked against the sender and the message.</summary>
    public static bool Parse(Member me, Body body, string text, bool voice)
    {
        if (body.OptionalBool("tts") is not true) return false;
        if (!Permissions.Has(me, Perm.SendTts)) throw RequestException.Forbidden("You can't send /tts messages on this server.", "tts_forbidden");
        if (text.Length == 0 || voice) throw RequestException.BadRequest("A /tts message needs text.", "tts_needs_text");
        return true;
    }

    public static void Saved(Store store, Message message, bool tts)
    {
        if (tts) store.SetTtsMessage(message.Id);
    }

    public static bool? View(Store store, long messageId) => store.IsTtsMessage(messageId) ? true : null;
}
