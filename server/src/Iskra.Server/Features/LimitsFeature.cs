using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Upload and expression limits. Everyone can read them (the app shows them next to upload buttons); only the owner
/// changes them, and changes are saved to server.json and apply right away. 0 means no limit where noted.
/// </summary>
public static class LimitsFeature
{
    /// <summary>The largest upload limit the app offers (1 TB); server.json can go higher.</summary>
    private const long MaxMb = 1024 * 1024;

    public static void Register(Router router)
    {
        router.Add("limits.get", (s, _, _) => Public(s.World.Settings));
        router.Add("limits.update", Update);
    }

    public static object Public(WorldSettings w) => new
    {
        maxUploadMb = w.MaxUploadMb,
        memberMbPerDay = w.UploadQuota.MemberMbPerDay,
        guestMbPerDay = w.UploadQuota.GuestMbPerDay,
        soundMaxSeconds = w.Limits.SoundMaxSeconds,
        soundMaxMb = w.Limits.SoundMaxMb,
        emojiMaxKb = w.Limits.EmojiMaxKb,
        stickerMaxKb = w.Limits.StickerMaxKb,
    };

    private static object Update(Session s, Member me, Body body)
    {
        if (me.Role != Roles.Owner) throw RequestException.Forbidden("Only the owner can change this server's limits.");
        int? Get(string key, long min) => (int?)body.OptionalLong(key, min: min, max: MaxMb);
        var maxUploadMb = Get("maxUploadMb", 1);
        var memberMbPerDay = Get("memberMbPerDay", 0);
        var guestMbPerDay = Get("guestMbPerDay", 0);
        var soundMaxSeconds = Get("soundMaxSeconds", 0);
        var soundMaxMb = Get("soundMaxMb", 0);
        var emojiMaxKb = Get("emojiMaxKb", 0);
        var stickerMaxKb = Get("stickerMaxKb", 0);
        s.World.UpdateSettings(w => w with
        {
            MaxUploadMb = maxUploadMb ?? w.MaxUploadMb,
            UploadQuota = w.UploadQuota with
            {
                MemberMbPerDay = memberMbPerDay ?? w.UploadQuota.MemberMbPerDay,
                GuestMbPerDay = guestMbPerDay ?? w.UploadQuota.GuestMbPerDay,
            },
            Limits = w.Limits with
            {
                SoundMaxSeconds = soundMaxSeconds ?? w.Limits.SoundMaxSeconds,
                SoundMaxMb = soundMaxMb ?? w.Limits.SoundMaxMb,
                EmojiMaxKb = emojiMaxKb ?? w.Limits.EmojiMaxKb,
                StickerMaxKb = stickerMaxKb ?? w.Limits.StickerMaxKb,
            },
        });
        Audit.Record(s, "limits.update");
        return Public(s.World.Settings);
    }
}
