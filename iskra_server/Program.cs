using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Origin.Server.Core
{
    using Origin.Server.Data;

    class Origin_Server_Core_Main
    {
        private static string _logFile;
        private static readonly object LogLock = new();

        private static void Log(string cat, string msg)
        {
            var line = $"[{DateTime.Now:HH:mm:ss.fff}][{cat,-8}] {msg}";
            Console.WriteLine(line);
            if (_logFile != null)
                lock (LogLock) { try { File.AppendAllText(_logFile, line + Environment.NewLine); } catch { } }
        }

        private static string ToRelativeUploadPath(string url)
        {
            if (string.IsNullOrEmpty(url)) return url;
            if (url.StartsWith("/uploads/")) return url;
            var m = Regex.Match(url, @"(/uploads/.+)");
            return m.Success ? m.Groups[1].Value : url;
        }

        private static Origin_Server_Data_Config ActiveConfig;
        private static string ActiveWorldPath;
        private static string ConfigFile     => Path.Combine(ActiveWorldPath, "server.json");
        private static string ChatFile(string channelId) => Path.Combine(ActiveWorldPath, $"chat-{channelId}.jsonl");
        private static ConcurrentDictionary<string, WebSocket>    ActiveClients    = new();
        private static ConcurrentDictionary<string, List<string>> ChannelOccupants = new();
        private static ConcurrentDictionary<string, string>       ClientGuids      = new(); // alias → machineGuid
        private static Dictionary<string, FingerprintRecord>      Fingerprints     = new();
        private static HashSet<string>                             BannedGuids      = new();
        private static readonly object FingerprintLock = new();
        private static Dictionary<string, string>                  UserRoles        = new(); // alias → role
        private static readonly object RoleLock = new();
        private static string RoleFile => Path.Combine(ActiveWorldPath, "roles.json");
        private static Dictionary<string, string>                  UserAvatars      = new(); // alias → url
        private static readonly object AvatarLock = new();
        private static string AvatarFile => Path.Combine(ActiveWorldPath, "avatars.json");
        private static string FingerprintFile => Path.Combine(ActiveWorldPath, "fingerprints.json");
        private static string BanFile         => Path.Combine(ActiveWorldPath, "bans.json");
        private static string UploadDir       => Path.Combine(ActiveWorldPath, "uploads");
        private static ConcurrentDictionary<string, DateTime> _lastMsgTime = new(); // "channelId:alias" → last send time
        private static ConcurrentDictionary<string, string> UserStatuses  = new(); // alias → "online"/"away"/"dnd"/"invisible"
        private static ConcurrentDictionary<string, WebSocket> BotClients = new(); // botName → socket
        private static readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(5) };
        private static string AuditFile => Path.Combine(ActiveWorldPath, "audit.jsonl");
        private static string EmojiFile => Path.Combine(ActiveWorldPath, "emojis.json");
        private static Dictionary<string, string> ServerEmojis = new(); // shortcode → url
        private static readonly object EmojiLock = new();

        // ── E2E encryption ───────────────────────────────────────────────────────
        private static Dictionary<string, Dictionary<string, E2EWrappedKey>> E2EKeys = new(); // channelId → alias → wrapped key
        private static readonly object E2ELock   = new();
        private static string E2EFile     => Path.Combine(ActiveWorldPath, "e2e.json");
        private static Dictionary<string, string> PublicKeys = new(); // alias → base64 raw EC pubkey
        private static readonly object PubKeyLock = new();
        private static string PubKeyFile   => Path.Combine(ActiveWorldPath, "public_keys.json");


        // ── DM storage ───────────────────────────────────────────────────────────
        private static string DmDir => Path.Combine(ActiveWorldPath, "dms");
        private static readonly object DmLock = new();
        private static ConcurrentDictionary<string, string> PreviewCache = new(); // url → json
        private static string DmFile(string a, string b)
        {
            string Clean(string s) => Regex.Replace(s.ToLowerInvariant(), @"[^a-z0-9]", "");
            var arr = new[] { Clean(a), Clean(b) };
            Array.Sort(arr);
            return Path.Combine(DmDir, $"{arr[0]}_{arr[1]}.jsonl");
        }

        // In-memory message store — channelId → ordered list of live messages
        private static ConcurrentDictionary<string, List<StoredMessage>> ChannelHistory = new();
        private static readonly object HistoryLock = new();

        private static readonly HashSet<string> AllowedUploadExts = new(StringComparer.OrdinalIgnoreCase)
            { ".jpg", ".jpeg", ".png", ".gif", ".webp", ".zip", ".7z", ".mp3", ".wav", ".ogg", ".webm" };
        private static readonly HashSet<string> ImageExts = new(StringComparer.OrdinalIgnoreCase)
            { ".jpg", ".jpeg", ".png", ".gif", ".webp" };
        private static readonly HashSet<string> AudioExts = new(StringComparer.OrdinalIgnoreCase)
            { ".mp3", ".wav", ".ogg", ".webm" };
        private static readonly Dictionary<string, string> MimeTypes = new(StringComparer.OrdinalIgnoreCase)
        {
            { ".jpg",  "image/jpeg" }, { ".jpeg", "image/jpeg" }, { ".png",  "image/png"  },
            { ".gif",  "image/gif"  }, { ".webp", "image/webp" },
            { ".zip",  "application/zip" }, { ".7z", "application/x-7z-compressed" },
            { ".mp3",  "audio/mpeg" },  { ".wav", "audio/wav" }, { ".ogg", "audio/ogg" }, { ".webm", "audio/webm" }
        };

        static async Task Main(string[] args)
        {
            ActiveWorldPath = Path.GetFullPath(args.Length > 0 ? args[0] : ".");
            Directory.CreateDirectory(ActiveWorldPath);
            _logFile = Path.Combine(ActiveWorldPath, "server.log");
            LoadOrGenerateConfig();
            // Normalize server icon to relative path (migrate legacy full URLs)
            if (!string.IsNullOrEmpty(ActiveConfig.Settings.ServerIcon))
                ActiveConfig.Settings.ServerIcon = ToRelativeUploadPath(ActiveConfig.Settings.ServerIcon);
            LoadFingerprints();
            LoadRoles();
            LoadAvatars();
            LoadChannelHistory();   // must come before PurgeOldHistory
            PurgeOldHistory();
            LoadEmojis();
            LoadPublicKeys();
            LoadE2EKeys();
            Directory.CreateDirectory(UploadDir);
            Console.Title = $"Origin Server — {ActiveConfig.Settings.ServerName} :{ActiveConfig.Settings.Port}";

            HttpListener listener = new HttpListener();
            listener.Prefixes.Add($"http://+:{ActiveConfig.Settings.Port}/");
            try
            {
                listener.Start();
                Log("SYSTEM", $"Origin Server booted on port {ActiveConfig.Settings.Port} (all interfaces)");
            }
            catch (HttpListenerException ex)
            {
                listener.Close();
                Log("SYSTEM", $"ERROR: Cannot bind to port {ActiveConfig.Settings.Port} — {ex.Message}");
                Log("SYSTEM", $"Fix: run server as Administrator, or run once in admin terminal:");
                Log("SYSTEM", $"  netsh http add urlacl url=http://+:{ActiveConfig.Settings.Port}/ user=Everyone");
                Console.ReadKey();
                return;
            }

            bool adminConfigured = !string.IsNullOrEmpty(ActiveConfig.Settings.AdminPassword);
            Log("SYSTEM", adminConfigured ? "Owner password configured." : "WARNING: No AdminPassword set — owner commands disabled. Set AdminPassword in server.json.");
            Log("SYSTEM", "Awaiting client connections...");

            try
            {
                while (true)
                {
                    HttpListenerContext context = await listener.GetContextAsync();
                    string path = context.Request.Url?.AbsolutePath ?? "";
                    if (context.Request.IsWebSocketRequest)
                    {
                        if (path == "/bot") ProcessBotConnection(context);
                        else                ProcessClientConnection(context);
                    }
                    else if (path == "/upload")
                        HandleUpload(context);
                    else if (path.StartsWith("/uploads/"))
                        ServeUpload(context);
                    else if (path == "/export")
                        HandleExport(context);
                    else if (path == "/audit")
                        HandleAudit(context);
                    else if (path == "/preview")
                        HandlePreview(context);
                    else
                        { context.Response.StatusCode = 404; context.Response.Close(); }
                }
            }
            catch (Exception ex) { Log("FATAL", $"Server Error: {ex.Message}"); }
        }

        private static void LoadOrGenerateConfig()
        {
            if (File.Exists(ConfigFile))
            {
                ActiveConfig = JsonSerializer.Deserialize<Origin_Server_Data_Config>(File.ReadAllText(ConfigFile));
                Log("CONFIG", $"World: {ActiveWorldPath}");
                Log("CONFIG", $"port:{ActiveConfig.Settings.Port} | channels:{ActiveConfig.Channels.Count}");
            }
            else
            {
                ActiveConfig = new Origin_Server_Data_Config();
                var ch = ActiveConfig.Channels;

                ch.Add(new Channel { Id = "hdr_info",    Name = "Information",          Type = "Header" });
                ch.Add(new Channel { Id = "t_announce",  Name = "announcements",        Type = "Text",  ReadOnly = true  });
                ch.Add(new Channel { Id = "t_rules",     Name = "rules",                Type = "Text",  ReadOnly = true  });
                ch.Add(new Channel { Id = "t_changelog", Name = "changelog",            Type = "Text",  ReadOnly = true  });

                ch.Add(new Channel { Id = "hdr_sep1",    Name = "────────────────────", Type = "Header" });

                ch.Add(new Channel { Id = "hdr_general", Name = "General",              Type = "Header" });
                ch.Add(new Channel { Id = "v_lobby",     Name = "Lobby",                Type = "Voice"  });
                ch.Add(new Channel { Id = "v_hangout",   Name = "Hangout",              Type = "Voice"  });
                ch.Add(new Channel { Id = "v_afk",       Name = "AFK",                  Type = "Voice",  Muted = true     });
                ch.Add(new Channel { Id = "t_general",   Name = "general",              Type = "Text"   });
                ch.Add(new Channel { Id = "t_memes",     Name = "memes",                Type = "Text"   });
                ch.Add(new Channel { Id = "t_media",     Name = "media",                Type = "Text"   });

                ch.Add(new Channel { Id = "hdr_sep2",    Name = "────────────────────", Type = "Header" });

                ch.Add(new Channel { Id = "hdr_gaming",  Name = "Gaming",               Type = "Header" });
                ch.Add(new Channel { Id = "v_squad1",    Name = "Squad 1",              Type = "Voice"  });
                ch.Add(new Channel { Id = "v_squad2",    Name = "Squad 2",              Type = "Voice"  });
                ch.Add(new Channel { Id = "v_squad3",    Name = "Squad 3",              Type = "Voice"  });
                ch.Add(new Channel { Id = "t_lfg",       Name = "looking-for-group",    Type = "Text"   });
                ch.Add(new Channel { Id = "t_gametalk",  Name = "game-talk",            Type = "Text"   });
                ch.Add(new Channel { Id = "t_clips",     Name = "clips",                Type = "Text"   });

                ch.Add(new Channel { Id = "hdr_sep3",    Name = "────────────────────", Type = "Header" });

                ch.Add(new Channel { Id = "hdr_priv",    Name = "Private",              Type = "Header" });
                ch.Add(new Channel { Id = "v_priv",      Name = "Private VC",           Type = "Voice",  MinRole = "trusted" });
                ch.Add(new Channel { Id = "t_priv",      Name = "private",              Type = "Text",   MinRole = "trusted" });

                File.WriteAllText(ConfigFile, JsonSerializer.Serialize(ActiveConfig, new JsonSerializerOptions { WriteIndented = true }));
                Log("CONFIG", $"New world created → {ActiveWorldPath}");
            }
        }

        // ── Channel history (in-memory + JSONL persistence) ─────────────────────

        private static string MessageToJsonLine(string channelId, StoredMessage m) =>
            JsonSerializer.Serialize(new {
                id           = m.Id,
                action       = "CHAT_RECEIVE",
                channelId,
                author       = m.Author,
                authorGuid   = m.AuthorGuid,
                time         = m.Time,
                ts           = m.Ts,
                message      = m.Message,
                reactions    = m.Reactions,
                replyToId    = m.ReplyToId,
                replySnippet = m.ReplySnippet,
                editHistory  = m.Edits != null && m.Edits.Count > 0 ? (object)m.Edits : null
            });

        private static void LoadChannelHistory()
        {
            foreach (var ch in ActiveConfig.Channels.Where(c => c.Type == "Text" || c.Type == "Voice"))
            {
                var msgs = new List<StoredMessage>();
                string file = ChatFile(ch.Id);
                if (File.Exists(file))
                {
                    foreach (var line in File.ReadLines(file))
                    {
                        try
                        {
                            using var doc = JsonDocument.Parse(line);
                            var root = doc.RootElement;
                            if (!root.TryGetProperty("message", out _)) continue;
                            msgs.Add(new StoredMessage {
                                Id         = root.TryGetProperty("id",         out var idEl)  ? idEl.GetString()  : null,
                                Author     = root.TryGetProperty("author",     out var aEl)   ? aEl.GetString()   : "?",
                                AuthorGuid = root.TryGetProperty("authorGuid", out var agEl) && agEl.ValueKind == JsonValueKind.String ? agEl.GetString() : null,
                                Time       = root.TryGetProperty("time",       out var tEl)   ? tEl.GetString()   : "",
                                Ts         = root.TryGetProperty("ts",         out var tsEl)  ? tsEl.GetInt64()   : 0,
                                Message    = root.TryGetProperty("message",    out var mEl)   ? mEl.GetString()   : "",
                                ReplyToId  = root.TryGetProperty("replyToId",  out var riEl) && riEl.ValueKind == JsonValueKind.String ? riEl.GetString() : null,
                                ReplySnippet = root.TryGetProperty("replySnippet", out var rsEl) && rsEl.ValueKind == JsonValueKind.Object
                                    ? JsonSerializer.Deserialize<ReplySnippet>(rsEl.GetRawText())
                                    : null,
                                Reactions = root.TryGetProperty("reactions", out var rEl) && rEl.ValueKind == JsonValueKind.Object
                                    ? JsonSerializer.Deserialize<Dictionary<string, List<string>>>(rEl.GetRawText()) ?? new()
                                    : new(),
                                Edits     = root.TryGetProperty("editHistory", out var ehEl) && ehEl.ValueKind == JsonValueKind.Array
                                    ? JsonSerializer.Deserialize<List<EditEntry>>(ehEl.GetRawText()) ?? new()
                                    : new()
                            });
                        }
                        catch { }
                    }
                }
                ChannelHistory[ch.Id] = msgs;
                if (msgs.Count > 0) Log("HIST", $"'{ch.Name}': {msgs.Count} message(s) loaded");
            }
        }

        private static void RewriteChannelHistory(string channelId)
        {
            lock (HistoryLock)
            {
                if (!ChannelHistory.TryGetValue(channelId, out var msgs)) return;
                File.WriteAllLines(ChatFile(channelId), msgs.Select(m => MessageToJsonLine(channelId, m)));
            }
        }

        private static void PurgeOldHistory()
        {
            int days = ActiveConfig.Settings.HistoryRetentionDays;
            if (days <= 0) return;
            long cutoffTs = DateTimeOffset.UtcNow.AddDays(-days).ToUnixTimeSeconds();

            foreach (var ch in ActiveConfig.Channels.Where(c => c.Type == "Text" || c.Type == "Voice"))
            {
                if (!ChannelHistory.TryGetValue(ch.Id, out var msgs)) continue;
                int before = msgs.Count;
                lock (HistoryLock) msgs.RemoveAll(m => m.Ts > 0 && m.Ts < cutoffTs);
                int removed = before - msgs.Count;
                if (removed > 0)
                {
                    RewriteChannelHistory(ch.Id);
                    Log("PURGE", $"'{ch.Name}': {removed} message(s) older than {days}d removed");
                }
            }

            if (Directory.Exists(UploadDir))
            {
                var cutoffDt = DateTimeOffset.FromUnixTimeSeconds(cutoffTs).UtcDateTime;
                int removed  = 0;
                foreach (var f in Directory.GetFiles(UploadDir))
                    if (File.GetLastWriteTimeUtc(f) < cutoffDt)
                        try { File.Delete(f); removed++; } catch { }
                if (removed > 0) Log("PURGE", $"{removed} upload file(s) older than {days}d deleted");
            }
        }

        // ── Upload handling ──────────────────────────────────────────────────────

        private static async void HandleUpload(HttpListenerContext ctx)
        {
            ctx.Response.AddHeader("Access-Control-Allow-Origin", "*");
            ctx.Response.AddHeader("Access-Control-Allow-Headers", "Content-Type");
            if (ctx.Request.HttpMethod == "OPTIONS")
                { ctx.Response.AddHeader("Access-Control-Allow-Methods", "POST, OPTIONS"); ctx.Response.StatusCode = 204; ctx.Response.Close(); return; }
            if (ctx.Request.HttpMethod != "POST") { ctx.Response.StatusCode = 405; ctx.Response.Close(); return; }
            try
            {
                string name = ctx.Request.QueryString["name"] ?? "file";
                string ext  = Path.GetExtension(name).ToLowerInvariant();
                if (!AllowedUploadExts.Contains(ext))
                {
                    ctx.Response.StatusCode = 400; ctx.Response.ContentType = "application/json";
                    await ctx.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { error = "File type not allowed" })));
                    ctx.Response.Close(); return;
                }
                long maxBytes = (long)ActiveConfig.Settings.MaxUploadMb * 1024 * 1024;
                if (ctx.Request.ContentLength64 > maxBytes) { ctx.Response.StatusCode = 413; ctx.Response.Close(); return; }
                using var ms = new MemoryStream();
                await ctx.Request.InputStream.CopyToAsync(ms);
                byte[] bytes = ms.ToArray();
                if (bytes.Length > maxBytes) { ctx.Response.StatusCode = 413; ctx.Response.Close(); return; }

                // Disk quota check
                if (ActiveConfig.Settings.MaxDiskGb > 0)
                {
                    var di = new DirectoryInfo(UploadDir);
                    long usedBytes = di.Exists ? di.GetFiles().Sum(f => f.Length) : 0;
                    if (usedBytes + bytes.Length > (long)(ActiveConfig.Settings.MaxDiskGb * 1024 * 1024 * 1024))
                    {
                        ctx.Response.StatusCode = 507; ctx.Response.ContentType = "application/json";
                        await ctx.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { error = "Server storage limit reached" })));
                        ctx.Response.Close(); return;
                    }
                }

                // Validate magic bytes for images — prevents disguised executables
                if (ImageExts.Contains(ext))
                {
                    bool validMagic = ext switch {
                        ".jpg" or ".jpeg" => bytes.Length >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF,
                        ".png"  => bytes.Length >= 8 && bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47,
                        ".gif"  => bytes.Length >= 6 && bytes[0] == 0x47 && bytes[1] == 0x49 && bytes[2] == 0x46,
                        ".webp" => bytes.Length >= 12 && bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x46
                                    && bytes[8] == 0x57 && bytes[9] == 0x45 && bytes[10] == 0x42 && bytes[11] == 0x50,
                        _ => true
                    };
                    if (!validMagic)
                    {
                        ctx.Response.StatusCode = 400; ctx.Response.ContentType = "application/json";
                        await ctx.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { error = "Invalid image data" })));
                        ctx.Response.Close(); return;
                    }
                }

                string hash;
                using (var sha = System.Security.Cryptography.SHA256.Create())
                    hash = Convert.ToHexString(sha.ComputeHash(bytes))[..16].ToLowerInvariant();
                Directory.CreateDirectory(UploadDir);
                string filePath = Path.Combine(UploadDir, hash + ext);
                if (!File.Exists(filePath)) await File.WriteAllBytesAsync(filePath, bytes);
                string url = $"/uploads/{hash}{ext}";

                string emojiName = ctx.Request.QueryString["emojiname"] ?? "";
                if (!string.IsNullOrEmpty(emojiName))
                {
                    emojiName = Regex.Replace(emojiName.ToLowerInvariant(), @"[^a-z0-9_]", "");
                    if (!string.IsNullOrEmpty(emojiName))
                    {
                        string absoluteUrl = $"http://{ctx.Request.UserHostName}{url}";
                        lock (EmojiLock) ServerEmojis[emojiName] = absoluteUrl;
                        SaveEmojis();
                        Dictionary<string, string> emojisBroadcast;
                        lock (EmojiLock) emojisBroadcast = new(ServerEmojis);
                        _ = Task.Run(async () => await Broadcast(new { action = "EMOJIS_UPDATED", emojis = emojisBroadcast }));
                        Log("EMOJI", $":{emojiName}: → {absoluteUrl}");
                    }
                }

                ctx.Response.StatusCode = 200; ctx.Response.ContentType = "application/json";
                await ctx.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { url, emojiName })));
                ctx.Response.Close();
                Log("UPLOAD", $"{bytes.Length / 1024.0:F1} KB → {hash}{ext}");
            }
            catch (Exception ex) { Log("ERR", $"HandleUpload: {ex.Message}"); try { ctx.Response.StatusCode = 500; ctx.Response.Close(); } catch { } }
        }

        private static async void ServeUpload(HttpListenerContext ctx)
        {
            ctx.Response.AddHeader("Access-Control-Allow-Origin", "*");
            ctx.Response.AddHeader("X-Content-Type-Options", "nosniff");
            try
            {
                string filename = Path.GetFileName(ctx.Request.Url?.AbsolutePath ?? "");
                string filePath = Path.Combine(UploadDir, filename);
                if (string.IsNullOrEmpty(filename) || !File.Exists(filePath))
                    { ctx.Response.StatusCode = 404; ctx.Response.Close(); return; }
                string ext = Path.GetExtension(filename).ToLowerInvariant();
                ctx.Response.ContentType = MimeTypes.GetValueOrDefault(ext, "application/octet-stream");
                bool isImage = ImageExts.Contains(ext) || AudioExts.Contains(ext);
                ctx.Response.AddHeader("Content-Disposition", isImage ? "inline" : $"attachment; filename=\"{filename}\"");
                ctx.Response.AddHeader("Cache-Control", "max-age=86400");
                byte[] bytes = await File.ReadAllBytesAsync(filePath);
                ctx.Response.ContentLength64 = bytes.Length;
                await ctx.Response.OutputStream.WriteAsync(bytes);
                ctx.Response.Close();
            }
            catch (Exception ex) { Log("ERR", $"ServeUpload: {ex.Message}"); try { ctx.Response.StatusCode = 500; ctx.Response.Close(); } catch { } }
        }

        // ── Fingerprints / bans ──────────────────────────────────────────────────

        private static void LoadFingerprints()
        {
            if (File.Exists(FingerprintFile))
            {
                Fingerprints = JsonSerializer.Deserialize<Dictionary<string, FingerprintRecord>>(File.ReadAllText(FingerprintFile)) ?? new();
                Log("CONFIG", $"Fingerprints loaded: {Fingerprints.Count}");
            }
            if (File.Exists(BanFile))
            {
                var bans = JsonSerializer.Deserialize<List<BanRecord>>(File.ReadAllText(BanFile)) ?? new();
                BannedGuids = new HashSet<string>(bans.Select(b => b.MachineGuid).Where(g => g != null));
                Log("CONFIG", $"Bans loaded: {BannedGuids.Count}");
            }
        }

        private static void SaveFingerprints()
        {
            lock (FingerprintLock)
                File.WriteAllText(FingerprintFile, JsonSerializer.Serialize(Fingerprints, new JsonSerializerOptions { WriteIndented = true }));
        }

        // ── Roles ────────────────────────────────────────────────────────────────

        private static int RoleRank(string role) => role switch {
            "guest"   => 0,
            "member"  => 1,
            "trusted" => 2,
            "admin"   => 3,
            "owner"   => 4,
            _         => 0
        };

        private static bool CanAccess(string userRole, string minRole) =>
            RoleRank(userRole) >= RoleRank(minRole ?? "guest");

        private static void LoadRoles()
        {
            if (File.Exists(RoleFile))
            {
                UserRoles = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(RoleFile)) ?? new();
                Log("CONFIG", $"Roles loaded: {UserRoles.Count}");
            }
        }

        private static void SaveRoles()
        {
            lock (RoleLock)
                File.WriteAllText(RoleFile, JsonSerializer.Serialize(UserRoles, new JsonSerializerOptions { WriteIndented = true }));
        }

        // ── Avatars ──────────────────────────────────────────────────────────────

        private static void LoadAvatars()
        {
            if (File.Exists(AvatarFile))
            {
                UserAvatars = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(AvatarFile)) ?? new();
                // Normalize any legacy full URLs to relative paths
                foreach (var key in UserAvatars.Keys.ToList())
                    UserAvatars[key] = ToRelativeUploadPath(UserAvatars[key]);
                Log("CONFIG", $"Avatars loaded: {UserAvatars.Count}");
            }
        }

        private static void SaveAvatars()
        {
            lock (AvatarLock)
                File.WriteAllText(AvatarFile, JsonSerializer.Serialize(UserAvatars, new JsonSerializerOptions { WriteIndented = true }));
        }

        // ── Broadcast helpers ────────────────────────────────────────────────────

        private static async Task Send(WebSocket ws, object payload)
        {
            var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload));
            if (ws.State == WebSocketState.Open)
                await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
        }

        private static async Task SendRaw(WebSocket ws, byte[] bytes)
        {
            if (ws.State == WebSocketState.Open)
                await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
        }

        private static async Task Broadcast(object payload)
        {
            var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload));
            foreach (var client in ActiveClients.Values)
                try { await SendRaw(client, bytes); } catch { }
            foreach (var bot in BotClients.Values)
                try { await SendRaw(bot, bytes); } catch { }
        }

        private static async Task BroadcastSystemMessage(string message)
        {
            Log("SYSTEM", $"Broadcast: {message}");
            await Broadcast(new { action = "SYSTEM_MESSAGE", message });
        }

        private static async Task BroadcastChannelUpdate()
        {
            _ = Task.Run(() => File.WriteAllText(ConfigFile, JsonSerializer.Serialize(ActiveConfig, new JsonSerializerOptions { WriteIndented = true })));
            foreach (var kv in ActiveClients.ToList())
            {
                string alias = kv.Key;
                string role;
                lock (RoleLock) role = UserRoles.TryGetValue(alias, out var r) ? r : "guest";
                var visibleChs = ActiveConfig.Channels
                    .Where(c => c.Type == "Header" || CanAccess(role, c.MinRole))
                    .Select(c => new { id = c.Id, name = c.Name, type = c.Type, readOnly = c.ReadOnly, muted = c.Muted, slowMode = c.SlowMode, minRole = c.MinRole, writeRole = c.WriteRole, e2e = c.E2E });
                try { await Send(kv.Value, new { action = "CHANNELS_UPDATED", channels = visibleChs }); } catch { }
            }
        }

        // ── Audit log ────────────────────────────────────────────────────────────

        private static void LogAudit(string action, string actor, string target = "", string detail = "")
        {
            try
            {
                var entry = JsonSerializer.Serialize(new {
                    ts     = DateTime.UtcNow.ToString("o"),
                    action, actor, target, detail
                });
                File.AppendAllText(AuditFile, entry + Environment.NewLine);
            }
            catch { }
        }

        // ── Emojis ───────────────────────────────────────────────────────────────

        private static void LoadEmojis()
        {
            if (File.Exists(EmojiFile))
            {
                ServerEmojis = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(EmojiFile)) ?? new();
                Log("CONFIG", $"Custom emojis loaded: {ServerEmojis.Count}");
            }
        }

        private static void SaveEmojis()
        {
            lock (EmojiLock)
                File.WriteAllText(EmojiFile, JsonSerializer.Serialize(ServerEmojis, new JsonSerializerOptions { WriteIndented = true }));
        }

        private static void LoadPublicKeys()
        {
            if (File.Exists(PubKeyFile))
            {
                lock (PubKeyLock)
                    PublicKeys = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(PubKeyFile)) ?? new();
                Log("CONFIG", $"E2E public keys loaded: {PublicKeys.Count}");
            }
        }

        private static void LoadE2EKeys()
        {
            if (File.Exists(E2EFile))
            {
                lock (E2ELock)
                    E2EKeys = JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, E2EWrappedKey>>>(File.ReadAllText(E2EFile)) ?? new();
                Log("CONFIG", $"E2E channel keys loaded: {E2EKeys.Count} channel(s)");
            }
        }

        // ── Webhooks ─────────────────────────────────────────────────────────────

        private static void FireWebhooks(string channelId, string channelName, string author, string message, string time)
        {
            var hooks = ActiveConfig.Settings.Webhooks
                .Where(w => !string.IsNullOrEmpty(w.Url) && (string.IsNullOrEmpty(w.ChannelId) || w.ChannelId == channelId))
                .ToList();
            if (!hooks.Any()) return;
            var payload = JsonSerializer.Serialize(new {
                server = ActiveConfig.Settings.ServerName, channelId, channel = channelName, author, message, time
            });
            _ = Task.Run(async () => {
                foreach (var hook in hooks)
                    try
                    {
                        using var req = new HttpRequestMessage(HttpMethod.Post, hook.Url)
                            { Content = new StringContent(payload, Encoding.UTF8, "application/json") };
                        await _http.SendAsync(req);
                        Log("WEBHOOK", $"→ {hook.Name} ({channelName}): {author}: {message[..Math.Min(40,message.Length)]}");
                    }
                    catch (Exception ex) { Log("WEBHOOK", $"Failed → {hook.Name}: {ex.Message}"); }
            });
        }

        // ── Export ───────────────────────────────────────────────────────────────

        private static async void HandleExport(HttpListenerContext ctx)
        {
            ctx.Response.AddHeader("Access-Control-Allow-Origin", "*");
            try
            {
                string token = ctx.Request.QueryString["token"] ?? "";
                if (string.IsNullOrEmpty(ActiveConfig.Settings.AdminPassword) || token != ActiveConfig.Settings.AdminPassword)
                    { ctx.Response.StatusCode = 403; ctx.Response.Close(); return; }

                using var ms = new MemoryStream();
                using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
                {
                    void AddFile(string srcPath, string entryName)
                    {
                        if (!File.Exists(srcPath)) return;
                        var entry = zip.CreateEntry(entryName, CompressionLevel.Optimal);
                        using var dst = entry.Open();
                        using var src = File.OpenRead(srcPath);
                        src.CopyTo(dst);
                    }

                    AddFile(ConfigFile,                             "server.json");
                    AddFile(RoleFile,                               "roles.json");
                    AddFile(BanFile,                                "bans.json");
                    AddFile(AvatarFile,                             "avatars.json");
                    AddFile(FingerprintFile,                        "fingerprints.json");
                    AddFile(EmojiFile,                              "emojis.json");
                    AddFile(AuditFile,                              "audit.jsonl");

                    foreach (var ch in ActiveConfig.Channels.Where(c => c.Type == "Text"))
                        AddFile(ChatFile(ch.Id), $"chat-{ch.Id}.jsonl");

                    if (Directory.Exists(UploadDir))
                        foreach (var f in Directory.GetFiles(UploadDir, "*", SearchOption.AllDirectories))
                        {
                            var rel = Path.GetRelativePath(ActiveWorldPath, f).Replace('\\', '/');
                            var e2  = zip.CreateEntry($"uploads/{rel}", CompressionLevel.Fastest);
                            using var dst2 = e2.Open();
                            using var src2 = File.OpenRead(f);
                            src2.CopyTo(dst2);
                        }
                }

                byte[] zipBytes = ms.ToArray();
                string fname    = $"iskra-backup-{DateTime.Now:yyyyMMdd-HHmm}.zip";
                ctx.Response.StatusCode      = 200;
                ctx.Response.ContentType     = "application/zip";
                ctx.Response.ContentLength64 = zipBytes.Length;
                ctx.Response.AddHeader("Content-Disposition", $"attachment; filename=\"{fname}\"");
                await ctx.Response.OutputStream.WriteAsync(zipBytes);
                ctx.Response.Close();
                Log("EXPORT", $"Backup sent: {zipBytes.Length / 1024}KB");
            }
            catch (Exception ex) { Log("ERR", $"HandleExport: {ex.Message}"); try { ctx.Response.StatusCode = 500; ctx.Response.Close(); } catch { } }
        }

        // ── Audit endpoint ───────────────────────────────────────────────────────

        private static async void HandleAudit(HttpListenerContext ctx)
        {
            ctx.Response.AddHeader("Access-Control-Allow-Origin", "*");
            try
            {
                string token = ctx.Request.QueryString["token"] ?? "";
                if (string.IsNullOrEmpty(ActiveConfig.Settings.AdminPassword) || token != ActiveConfig.Settings.AdminPassword)
                    { ctx.Response.StatusCode = 403; ctx.Response.Close(); return; }

                int limit = int.TryParse(ctx.Request.QueryString["limit"], out var l) ? Math.Min(l, 500) : 200;
                var lines = File.Exists(AuditFile)
                    ? (await File.ReadAllLinesAsync(AuditFile))
                        .Where(s => !string.IsNullOrWhiteSpace(s))
                        .TakeLast(limit)
                        .Select(s => JsonDocument.Parse(s).RootElement)
                        .ToList()
                    : new List<JsonElement>();

                string json = JsonSerializer.Serialize(lines);
                ctx.Response.StatusCode    = 200;
                ctx.Response.ContentType   = "application/json";
                ctx.Response.AddHeader("Cache-Control", "no-cache");
                await ctx.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes(json));
                ctx.Response.Close();
            }
            catch (Exception ex) { Log("ERR", $"HandleAudit: {ex.Message}"); try { ctx.Response.StatusCode = 500; ctx.Response.Close(); } catch { } }
        }

        // ── Link preview ─────────────────────────────────────────────────────────

        private static async void HandlePreview(HttpListenerContext ctx)
        {
            ctx.Response.AddHeader("Access-Control-Allow-Origin", "*");
            ctx.Response.AddHeader("Cache-Control", "public, max-age=3600");
            string url = ctx.Request.QueryString["url"] ?? "";
            if (string.IsNullOrEmpty(url) || !Uri.TryCreate(url, UriKind.Absolute, out var uri)
                || (uri.Scheme != "http" && uri.Scheme != "https"))
            { ctx.Response.StatusCode = 400; ctx.Response.Close(); return; }

            if (PreviewCache.TryGetValue(url, out string cached))
            {
                ctx.Response.StatusCode = 200; ctx.Response.ContentType = "application/json";
                await ctx.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes(cached));
                ctx.Response.Close(); return;
            }
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, url);
                req.Headers.UserAgent.ParseAdd("Mozilla/5.0 (compatible; Iskra/1.0)");
                req.Headers.Accept.ParseAdd("text/html,*/*;q=0.9");
                using var resp = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
                if (!resp.IsSuccessStatusCode) { ctx.Response.StatusCode = 204; ctx.Response.Close(); return; }
                var ct = resp.Content.Headers.ContentType?.MediaType ?? "";
                if (!ct.StartsWith("text/html")) { ctx.Response.StatusCode = 204; ctx.Response.Close(); return; }
                var htmlBytes = await resp.Content.ReadAsByteArrayAsync();
                string html = Encoding.UTF8.GetString(htmlBytes, 0, Math.Min(htmlBytes.Length, 131072));

                string GetMeta(string prop) {
                    var m = Regex.Match(html,
                        $@"<meta\s[^>]*(?:property|name)=[""']{Regex.Escape(prop)}[""'][^>]*content=[""']([^""'<]*)[""']|<meta\s[^>]*content=[""']([^""'<]*)[""'][^>]*(?:property|name)=[""']{Regex.Escape(prop)}[""']",
                        RegexOptions.IgnoreCase | RegexOptions.Singleline);
                    return m.Success ? (m.Groups[1].Value.Length > 0 ? m.Groups[1].Value : m.Groups[2].Value).Trim() : "";
                }
                string title = GetMeta("og:title");
                if (string.IsNullOrEmpty(title)) {
                    var tm = Regex.Match(html, @"<title[^>]*>([^<]+)</title>", RegexOptions.IgnoreCase);
                    title = tm.Success ? System.Net.WebUtility.HtmlDecode(tm.Groups[1].Value.Trim()) : "";
                }
                string description = GetMeta("og:description");
                if (string.IsNullOrEmpty(description)) description = GetMeta("description");
                string image    = GetMeta("og:image");
                string siteName = GetMeta("og:site_name");
                if (string.IsNullOrEmpty(title) && string.IsNullOrEmpty(image)) { ctx.Response.StatusCode = 204; ctx.Response.Close(); return; }

                title       = title.Length       > 120 ? title[..120]       : title;
                description = description.Length > 250 ? description[..250] : description;
                string json = JsonSerializer.Serialize(new { title, description, image, siteName, url });
                PreviewCache.TryAdd(url, json);
                ctx.Response.StatusCode = 200; ctx.Response.ContentType = "application/json";
                await ctx.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes(json));
                ctx.Response.Close();
                Log("PREVIEW", $"{url[..Math.Min(60,url.Length)]} → {title[..Math.Min(40,title.Length)]}");
            }
            catch (Exception ex)
            {
                Log("PREVIEW", $"Fail: {ex.Message}");
                try { ctx.Response.StatusCode = 204; ctx.Response.Close(); } catch { }
            }
        }

        // ── Bot WebSocket handler ────────────────────────────────────────────────

        private static async void ProcessBotConnection(HttpListenerContext context)
        {
            HttpListenerWebSocketContext wsCtx = await context.AcceptWebSocketAsync(null);
            WebSocket socket = wsCtx.WebSocket;
            string botName = "bot";
            try
            {
                byte[] buf = new byte[4096];
                var result = await socket.ReceiveAsync(new ArraySegment<byte>(buf), CancellationToken.None);
                string authJson = Encoding.UTF8.GetString(buf, 0, result.Count);
                using var authDoc = JsonDocument.Parse(authJson);
                string token = authDoc.RootElement.TryGetProperty("token", out var tEl) ? tEl.GetString() ?? "" : "";
                botName       = authDoc.RootElement.TryGetProperty("name",  out var nEl) ? nEl.GetString() ?? "bot" : "bot";

                if (!ActiveConfig.Settings.BotTokens.Contains(token))
                {
                    await Send(socket, new { action = "BOT_AUTH_FAILED", reason = "Invalid token" });
                    await socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, "Invalid token", CancellationToken.None);
                    Log("BOT", $"Auth failed for bot '{botName}'");
                    return;
                }

                BotClients[botName] = socket;
                await Send(socket, new { action = "BOT_AUTH_OK", name = botName, server = ActiveConfig.Settings.ServerName });
                Log("BOT", $"'{botName}' connected");
                LogAudit("BOT_CONNECT", botName);

                var msgStream = new MemoryStream(16384);
                while (socket.State == WebSocketState.Open)
                {
                    msgStream.SetLength(0);
                    WebSocketReceiveResult recv;
                    do
                    {
                        var chunk = new byte[4096];
                        recv = await socket.ReceiveAsync(new ArraySegment<byte>(chunk), CancellationToken.None);
                        msgStream.Write(chunk, 0, recv.Count);
                    } while (!recv.EndOfMessage);

                    if (recv.MessageType != WebSocketMessageType.Text) break;
                    string msg = Encoding.UTF8.GetString(msgStream.GetBuffer(), 0, (int)msgStream.Length);
                    try
                    {
                        using var doc = JsonDocument.Parse(msg);
                        string act = doc.RootElement.GetProperty("action").GetString();
                        if (act == "SEND_CHAT")
                        {
                            string channelId = doc.RootElement.GetProperty("channelId").GetString();
                            string text      = doc.RootElement.GetProperty("message").GetString()?.Trim() ?? "";
                            if (!string.IsNullOrEmpty(text) && ActiveConfig.Channels.Any(c => c.Id == channelId && c.Type == "Text"))
                            {
                                string msgId = Guid.NewGuid().ToString("N")[..12];
                                var stored   = new StoredMessage { Id = msgId, Author = botName, Time = DateTime.Now.ToString("h:mm tt"), Ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds(), Message = text };
                                lock (HistoryLock)
                                {
                                    if (!ChannelHistory.ContainsKey(channelId)) ChannelHistory[channelId] = new();
                                    ChannelHistory[channelId].Add(stored);
                                }
                                string jsonLine = MessageToJsonLine(channelId, stored);
                                await File.AppendAllTextAsync(ChatFile(channelId), jsonLine + Environment.NewLine);
                                var lineBytes = Encoding.UTF8.GetBytes(jsonLine);
                                foreach (var client in ActiveClients.Values)
                                    try { await client.SendAsync(new ArraySegment<byte>(lineBytes), WebSocketMessageType.Text, true, CancellationToken.None); } catch { }
                                Log("BOT", $"[{channelId}] {botName}: {text}");
                            }
                        }
                    }
                    catch { }
                }
            }
            catch { }
            finally
            {
                BotClients.TryRemove(botName, out _);
                Log("BOT", $"'{botName}' disconnected");
                LogAudit("BOT_DISCONNECT", botName);
            }
        }

        // ── Admin actions ────────────────────────────────────────────────────────

        private static async Task KickUser(string targetAlias, string kickedBy, string reason)
        {
            if (ActiveClients.TryGetValue(targetAlias, out WebSocket targetSock))
            {
                Log("ADMIN", $"'{kickedBy}' kicked '{targetAlias}' — {reason}");
                LogAudit("KICK", kickedBy, targetAlias, reason);
                try { await Send(targetSock, new { action = "KICKED", reason }); } catch { }
                try { await targetSock.CloseAsync(WebSocketCloseStatus.PolicyViolation, reason, CancellationToken.None); } catch { }
                await BroadcastSystemMessage($"{targetAlias} was kicked by {kickedBy}.");
            }
            else Log("ADMIN", $"Kick failed — '{targetAlias}' not connected");
        }

        private static async Task BanUser(string targetAlias, string bannedBy, string reason)
        {
            string guid = ClientGuids.TryGetValue(targetAlias, out var g) ? g : null;
            if (!string.IsNullOrEmpty(guid))
            {
                BannedGuids.Add(guid);
                var banList = File.Exists(BanFile)
                    ? JsonSerializer.Deserialize<List<BanRecord>>(File.ReadAllText(BanFile)) ?? new()
                    : new List<BanRecord>();
                banList.Add(new BanRecord { MachineGuid = guid, BannedAlias = targetAlias, BannedBy = bannedBy, BannedAt = DateTime.Now, Reason = reason });
                File.WriteAllText(BanFile, JsonSerializer.Serialize(banList, new JsonSerializerOptions { WriteIndented = true }));
                Log("ADMIN", $"'{targetAlias}' (guid:{guid}) banned by '{bannedBy}'");
                LogAudit("BAN", bannedBy, targetAlias, reason);
            }
            else Log("ADMIN", $"Ban recorded for '{targetAlias}' — no GUID on file");
            await KickUser(targetAlias, bannedBy, $"Banned: {reason}");
        }

        private static async Task UnbanGuid(string guid, string unbannedBy)
        {
            if (!BannedGuids.Remove(guid)) { Log("ADMIN", $"UnbanGuid: '{guid}' not in ban list"); return; }
            if (File.Exists(BanFile))
            {
                var banList = JsonSerializer.Deserialize<List<BanRecord>>(File.ReadAllText(BanFile)) ?? new();
                banList.RemoveAll(b => b.MachineGuid == guid);
                File.WriteAllText(BanFile, JsonSerializer.Serialize(banList, new JsonSerializerOptions { WriteIndented = true }));
            }
            Log("ADMIN", $"'{guid}' unbanned by '{unbannedBy}'");
            LogAudit("UNBAN", unbannedBy, guid);
            await BroadcastSystemMessage($"A ban was lifted by {unbannedBy}.");
        }

        // ── Per-client connection handler ────────────────────────────────────────

        private static async void ProcessClientConnection(HttpListenerContext context)
        {
            HttpListenerWebSocketContext webSocketContext = await context.AcceptWebSocketAsync(null);
            WebSocket socket = webSocketContext.WebSocket;
            string clientIp = context.Request.RemoteEndPoint?.ToString() ?? "Unknown";
            string currentAlias        = "Unknown";
            string currentVoiceChannel = null;
            string userRole            = "guest";

            byte[] chunk = new byte[16384];
            var msgStream = new MemoryStream(65536);

            try
            {
                Log("NET", $"Incoming connection from {clientIp}");

                // ── Auth ─────────────────────────────────────────────────────────
                msgStream.SetLength(0);
                WebSocketReceiveResult authResult;
                do
                {
                    authResult = await socket.ReceiveAsync(new ArraySegment<byte>(chunk), CancellationToken.None);
                    msgStream.Write(chunk, 0, authResult.Count);
                } while (!authResult.EndOfMessage);

                using JsonDocument authDoc = JsonDocument.Parse(Encoding.UTF8.GetString(msgStream.GetBuffer(), 0, (int)msgStream.Length));
                currentAlias = authDoc.RootElement.GetProperty("alias").GetString();
                string machineGuid  = authDoc.RootElement.TryGetProperty("machineGuid",   out JsonElement mgEl) ? mgEl.GetString() ?? "" : "";
                string adminPwSent  = authDoc.RootElement.TryGetProperty("adminPassword", out JsonElement apEl) ? apEl.GetString() ?? "" : "";
                string userPassword = authDoc.RootElement.TryGetProperty("userPassword",  out JsonElement upEl) ? upEl.GetString() ?? "" : "";

                if (ActiveConfig.Settings.RequirePassword)
                {
                    string pw = authDoc.RootElement.TryGetProperty("password", out JsonElement pwEl) ? pwEl.GetString() ?? "" : "";
                    if (pw != ActiveConfig.Settings.ServerPassword)
                    {
                        Log("AUTH", $"'{currentAlias}' rejected — wrong password from {clientIp}");
                        await Send(socket, new { action = "AUTH_FAILED", reason = "Wrong password" });
                        await socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, "Wrong password", CancellationToken.None);
                        return;
                    }
                }

                // Per-user auth
                string authMode = ActiveConfig.Settings.AuthMode ?? "open";
                if (authMode != "open")
                {
                    var registered = ActiveConfig.Settings.RegisteredUsers ?? new();
                    if (registered.TryGetValue(currentAlias, out string? storedHash))
                    {
                        if (!BCrypt.Net.BCrypt.Verify(userPassword, storedHash))
                        {
                            Log("AUTH", $"'{currentAlias}' rejected — wrong user password from {clientIp}");
                            await Send(socket, new { action = "AUTH_FAILED", reason = $"Wrong password for alias '{currentAlias}'." });
                            await socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, "Auth failed", CancellationToken.None);
                            return;
                        }
                        Log("AUTH", $"'{currentAlias}' user password verified");
                    }
                    else if (authMode == "verified-only")
                    {
                        Log("AUTH", $"'{currentAlias}' rejected — not registered, server is verified-only");
                        await Send(socket, new { action = "AUTH_FAILED", reason = "This server only allows registered accounts. Ask the server owner to add you with /adduser." });
                        await socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, "Not registered", CancellationToken.None);
                        return;
                    }
                }

                // Resolve role: owner if AdminPassword matches, else look up roles.json
                if (!string.IsNullOrEmpty(ActiveConfig.Settings.AdminPassword)
                    && adminPwSent == ActiveConfig.Settings.AdminPassword)
                {
                    userRole = "owner";
                    Log("AUTH", $"'{currentAlias}' authenticated as OWNER from {clientIp}");
                }
                else
                {
                    lock (RoleLock)
                        userRole = UserRoles.TryGetValue(currentAlias, out var storedRole) ? storedRole : "guest";
                }

                // GUID ban + fingerprint
                if (!string.IsNullOrEmpty(machineGuid))
                {
                    if (BannedGuids.Contains(machineGuid))
                    {
                        Log("AUTH", $"'{currentAlias}' BANNED (guid:{machineGuid[..Math.Min(8,machineGuid.Length)]}…) from {clientIp}");
                        await Send(socket, new { action = "AUTH_FAILED", reason = "You are banned from this server." });
                        await socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, "Banned", CancellationToken.None);
                        return;
                    }
                    ClientGuids[currentAlias] = machineGuid;
                    lock (FingerprintLock)
                    {
                        if (!Fingerprints.TryGetValue(machineGuid, out var fp))
                            fp = new FingerprintRecord { MachineGuid = machineGuid };
                        if (!fp.Aliases.Contains(currentAlias))    fp.Aliases.Add(currentAlias);
                        if (!fp.IpAddresses.Contains(clientIp))    fp.IpAddresses.Add(clientIp);
                        fp.LastSeen = DateTime.Now;
                        Fingerprints[machineGuid] = fp;
                    }
                    _ = Task.Run(SaveFingerprints);
                }

                ActiveClients[currentAlias] = socket;
                UserStatuses[currentAlias] = "online";
                Log("AUTH", $"'{currentAlias}' authenticated | role:{userRole} | total:{ActiveClients.Count}");
                LogAudit("JOIN", currentAlias, "", $"from {clientIp} role:{userRole}");
                await Broadcast(new { action = "STATUS_UPDATED", alias = currentAlias, status = "online" });

                // ── SERVER_INFO ──────────────────────────────────────────────────
                var iceServers = new List<object> { new { urls = new[] { "stun:stun.l.google.com:19302" } } };
                if (ActiveConfig.Settings.TurnUrls?.Count > 0
                    && !string.IsNullOrEmpty(ActiveConfig.Settings.TurnUsername)
                    && !string.IsNullOrEmpty(ActiveConfig.Settings.TurnCredential))
                {
                    iceServers.Add(new {
                        urls       = ActiveConfig.Settings.TurnUrls.ToArray(),
                        username   = ActiveConfig.Settings.TurnUsername,
                        credential = ActiveConfig.Settings.TurnCredential
                    });
                }
                Dictionary<string, string> avatarsCopy;
                lock (AvatarLock) avatarsCopy = new(UserAvatars);
                var statusesCopy = new Dictionary<string, string>();
                foreach (var kv in UserStatuses) if (kv.Value != "invisible") statusesCopy[kv.Key] = kv.Value;
                var rolesCopy = new Dictionary<string, string>();
                lock (RoleLock)
                    foreach (var alias in ActiveClients.Keys)
                        rolesCopy[alias] = UserRoles.TryGetValue(alias, out var r) ? r : "guest";
                rolesCopy[currentAlias] = userRole; // ensures owner role is reflected correctly
                Dictionary<string, string> emojisCopy;
                lock (EmojiLock) emojisCopy = new(ServerEmojis);
                bool isAdmin = RoleRank(userRole) >= RoleRank("admin");
                Dictionary<string, string> pubKeysCopy = null;
                Dictionary<string, List<string>> e2eAccessCopy = null;
                if (isAdmin)
                {
                    lock (PubKeyLock) pubKeysCopy = new(PublicKeys);
                    lock (E2ELock)    e2eAccessCopy = E2EKeys.ToDictionary(kv => kv.Key, kv => kv.Value.Keys.ToList());
                }
                await Send(socket, new {
                    action       = "SERVER_INFO",
                    name         = ActiveConfig.Settings.ServerName,
                    serverIcon   = ActiveConfig.Settings.ServerIcon ?? "",
                    userAvatars  = avatarsCopy,
                    userStatuses = statusesCopy,
                    userRoles    = rolesCopy,
                    emojis       = emojisCopy,
                    // admin-only fields
                    webhooks     = isAdmin ? ActiveConfig.Settings.Webhooks : null,
                    botTokens    = isAdmin ? ActiveConfig.Settings.BotTokens : null,
                    publicKeys   = pubKeysCopy,
                    e2eAccess    = e2eAccessCopy,
                    uploadBase   = $"http://{context.Request.UserHostName}",
                    channels     = ActiveConfig.Channels
                        .Where(c => c.Type == "Header" || CanAccess(userRole, c.MinRole))
                        .Select(c => new { id = c.Id, name = c.Name, type = c.Type, readOnly = c.ReadOnly, muted = c.Muted, slowMode = c.SlowMode, minRole = c.MinRole, writeRole = c.WriteRole, e2e = c.E2E }),
                    iceServers
                });

                await Send(socket, new { action = "ROLE_GRANTED", role = userRole });

                // ── E2E keys for this user ────────────────────────────────────────
                var e2eGrants = new List<(string channelId, string ephemPub, string iv, string wrapped)>();
                lock (E2ELock)
                    foreach (var eCh in ActiveConfig.Channels.Where(c => c.E2E && E2EKeys.ContainsKey(c.Id)))
                        if (E2EKeys[eCh.Id].TryGetValue(currentAlias, out var ek))
                            e2eGrants.Add((eCh.Id, ek.EphemPub, ek.Iv, ek.Wrapped));
                foreach (var g in e2eGrants)
                    await Send(socket, new { action = "E2E_KEY_GRANTED", channelId = g.channelId, ephemPub = g.ephemPub, iv = g.iv, wrapped = g.wrapped });

                // ── Chat history ─────────────────────────────────────────────────
                foreach (var ch in ActiveConfig.Channels.Where(c => c.Type == "Text" || c.Type == "Voice"))
                {
                    if (!ChannelHistory.TryGetValue(ch.Id, out var msgs) || msgs.Count == 0) continue;
                    Log("DATA", $"Pushing '{ch.Name}' history ({Math.Min(msgs.Count, 50)} msgs) → '{currentAlias}'");
                    foreach (var m in msgs.TakeLast(50))
                    {
                        var line = Encoding.UTF8.GetBytes(MessageToJsonLine(ch.Id, m));
                        await socket.SendAsync(new ArraySegment<byte>(line), WebSocketMessageType.Text, true, CancellationToken.None);
                    }
                }

                // ── Pinned messages ───────────────────────────────────────────────
                foreach (var ch in ActiveConfig.Channels.Where(c => c.Type == "Text" && c.PinnedMessageIds?.Count > 0))
                {
                    var pinMsgs = new List<object>();
                    lock (HistoryLock)
                        if (ChannelHistory.TryGetValue(ch.Id, out var pMsgs))
                            foreach (var pid in ch.PinnedMessageIds)
                            {
                                var pm = pMsgs.FirstOrDefault(x => x.Id == pid);
                                if (pm != null) pinMsgs.Add(new { id = pm.Id, author = pm.Author, time = pm.Time, message = pm.Message });
                            }
                    if (pinMsgs.Count > 0)
                        await Send(socket, new { action = "PINS_UPDATED", channelId = ch.Id, pins = pinMsgs });
                }

                // ── DM summary ───────────────────────────────────────────────
                try
                {
                    if (Directory.Exists(DmDir))
                    {
                        var dmSummaries = new List<object>();
                        foreach (var f in Directory.GetFiles(DmDir, "*.jsonl"))
                        {
                            string lastLine = File.ReadLines(f).LastOrDefault();
                            if (lastLine == null) continue;
                            var lastDm = JsonSerializer.Deserialize<DmMessage>(lastLine);
                            if (lastDm == null) continue;
                            bool involves = lastDm.From.Equals(currentAlias, StringComparison.OrdinalIgnoreCase)
                                         || lastDm.To.Equals(currentAlias, StringComparison.OrdinalIgnoreCase);
                            if (!involves) continue;
                            string otherAlias = lastDm.From.Equals(currentAlias, StringComparison.OrdinalIgnoreCase)
                                ? lastDm.To : lastDm.From;
                            dmSummaries.Add(new { with = otherAlias, lastMessage = lastDm.Message, lastTs = lastDm.Ts, from = lastDm.From });
                        }
                        if (dmSummaries.Count > 0)
                            await Send(socket, new { action = "DM_SUMMARY", conversations = dmSummaries });
                    }
                }
                catch (Exception ex) { Log("DM", $"DM_SUMMARY error: {ex.Message}"); }

                // ── Message loop ─────────────────────────────────────────────────
                while (socket.State == WebSocketState.Open)
                {
                    msgStream.SetLength(0);
                    WebSocketReceiveResult msgResult;
                    do
                    {
                        msgResult = await socket.ReceiveAsync(new ArraySegment<byte>(chunk), CancellationToken.None);
                        msgStream.Write(chunk, 0, msgResult.Count);
                    } while (!msgResult.EndOfMessage);

                    if (msgResult.MessageType == WebSocketMessageType.Close) break;

                    byte[] msgBytes  = msgStream.ToArray();
                    string rawMessage = Encoding.UTF8.GetString(msgBytes);
                    using JsonDocument incoming = JsonDocument.Parse(rawMessage);
                    string action = incoming.RootElement.GetProperty("action").GetString();

                    // ── SEND_CHAT ────────────────────────────────────────────────
                    if (action == "SEND_CHAT")
                    {
                        string text      = incoming.RootElement.GetProperty("message").GetString();
                        string channelId = incoming.RootElement.TryGetProperty("channelId", out JsonElement cidEl) ? cidEl.GetString() : null;
                        if (string.IsNullOrEmpty(channelId))
                            channelId = ActiveConfig.Channels.FirstOrDefault(c => c.Type == "Text")?.Id ?? "general";

                        var chatCh = ActiveConfig.Channels.FirstOrDefault(c => c.Id == channelId);
                        if (chatCh != null && !CanAccess(userRole, chatCh.MinRole))
                        {
                            await Send(socket, new { action = "SYSTEM_MESSAGE", message = "You don't have access to that channel." });
                            continue;
                        }
                        if (chatCh != null && chatCh.ReadOnly && RoleRank(userRole) < RoleRank("admin"))
                        {
                            await Send(socket, new { action = "SYSTEM_MESSAGE", message = "That channel is read-only." });
                            continue;
                        }
                        if (chatCh != null && RoleRank(userRole) < RoleRank(chatCh.WriteRole) && RoleRank(userRole) < RoleRank("admin"))
                        {
                            await Send(socket, new { action = "SYSTEM_MESSAGE", message = $"You need the '{chatCh.WriteRole}' role to post here." });
                            continue;
                        }

                        if (text.StartsWith("/") && text.Length > 1 && char.IsLetter(text[1]))
                        {
                            if (RoleRank(userRole) < RoleRank("admin"))
                            {
                                await Send(socket, new { action = "SYSTEM_MESSAGE", message = "You don't have permission to use admin commands." });
                                continue;
                            }
                            var parts = text.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                            string cmd = parts[0].ToLowerInvariant();
                            Log("ADMIN", $"'{currentAlias}' cmd: {text}");
                            if      (cmd == "/kick"  && parts.Length >= 2) await KickUser(parts[1], currentAlias, parts.Length >= 3 ? string.Join(" ", parts[2..]) : "Kicked by admin");
                            else if (cmd == "/ban"   && parts.Length >= 2) await BanUser(parts[1], currentAlias, parts.Length >= 3 ? string.Join(" ", parts[2..]) : "Banned by admin");
                            else if (cmd == "/unban" && parts.Length >= 2) await UnbanGuid(parts[1], currentAlias);
                            else if (cmd == "/role"  && parts.Length >= 3)
                            {
                                string targetAlias = parts[1];
                                string newRole     = parts[2].ToLowerInvariant();
                                string[] grantable = userRole == "owner"
                                    ? new[] { "guest", "member", "trusted", "admin" }
                                    : new[] { "guest", "member", "trusted" };
                                if (!grantable.Contains(newRole))
                                    await Send(socket, new { action = "SYSTEM_MESSAGE", message = $"Cannot grant '{newRole}'. Valid: {string.Join(", ", grantable)}" });
                                else
                                {
                                    lock (RoleLock) UserRoles[targetAlias] = newRole;
                                    _ = Task.Run(SaveRoles);
                                    Log("ADMIN", $"'{currentAlias}' set role of '{targetAlias}' to '{newRole}'");
                                    LogAudit("ROLE", currentAlias, targetAlias, newRole);
                                    await BroadcastSystemMessage($"{targetAlias} has been given the {newRole} role.");
                                    if (ActiveClients.TryGetValue(targetAlias, out WebSocket tSock))
                                        await Send(tSock, new { action = "ROLE_GRANTED", role = newRole });
                                    await Broadcast(new { action = "USER_ROLE_UPDATED", alias = targetAlias, role = newRole });
                                }
                            }
                            else if (cmd == "/slowmode" && parts.Length >= 2)
                            {
                                if (int.TryParse(parts[1], out int secs) && secs >= 0)
                                {
                                    string targetId = parts.Length >= 3 ? parts[2] : channelId;
                                    var tCh = ActiveConfig.Channels.FirstOrDefault(c => c.Id == targetId);
                                    if (tCh != null)
                                    {
                                        tCh.SlowMode = secs;
                                        File.WriteAllText(ConfigFile, JsonSerializer.Serialize(ActiveConfig, new JsonSerializerOptions { WriteIndented = true }));
                                        Log("ADMIN", $"'{currentAlias}' set slow mode on #{tCh.Name} to {secs}s");
                                        await BroadcastSystemMessage($"#{tCh.Name} slow mode: {(secs == 0 ? "off" : $"{secs}s")}");
                                        await Broadcast(new { action = "SLOW_MODE_UPDATED", channelId = targetId, seconds = secs });
                                    }
                                    else await Send(socket, new { action = "SYSTEM_MESSAGE", message = "Channel not found." });
                                }
                                else await Send(socket, new { action = "SYSTEM_MESSAGE", message = "Usage: /slowmode <seconds> [channelId]" });
                            }
                            else if (cmd == "/adduser" && parts.Length >= 3 && userRole == "owner")
                            {
                                string tAlias = parts[1];
                                string tPass  = string.Join(" ", parts[2..]);
                                if (ActiveConfig.Settings.RegisteredUsers == null)
                                    ActiveConfig.Settings.RegisteredUsers = new();
                                ActiveConfig.Settings.RegisteredUsers[tAlias] = BCrypt.Net.BCrypt.HashPassword(tPass, workFactor: 12);
                                File.WriteAllText(ConfigFile, JsonSerializer.Serialize(ActiveConfig, new JsonSerializerOptions { WriteIndented = true }));
                                Log("ADMIN", $"'{currentAlias}' registered user '{tAlias}'");
                                await Send(socket, new { action = "SYSTEM_MESSAGE", message = $"User '{tAlias}' registered. They must set their user password in the server connection settings." });
                            }
                            else if (cmd == "/removeuser" && parts.Length >= 2 && userRole == "owner")
                            {
                                string tAlias = parts[1];
                                if (ActiveConfig.Settings.RegisteredUsers?.Remove(tAlias) == true)
                                {
                                    File.WriteAllText(ConfigFile, JsonSerializer.Serialize(ActiveConfig, new JsonSerializerOptions { WriteIndented = true }));
                                    Log("ADMIN", $"'{currentAlias}' removed registered user '{tAlias}'");
                                    await Send(socket, new { action = "SYSTEM_MESSAGE", message = $"User '{tAlias}' removed from registered users." });
                                }
                                else await Send(socket, new { action = "SYSTEM_MESSAGE", message = $"'{tAlias}' is not a registered user." });
                            }
                            else if (cmd == "/passwd" && parts.Length >= 3 && userRole == "owner")
                            {
                                string tAlias = parts[1];
                                string tPass  = string.Join(" ", parts[2..]);
                                if (ActiveConfig.Settings.RegisteredUsers?.ContainsKey(tAlias) == true)
                                {
                                    ActiveConfig.Settings.RegisteredUsers[tAlias] = BCrypt.Net.BCrypt.HashPassword(tPass, workFactor: 12);
                                    File.WriteAllText(ConfigFile, JsonSerializer.Serialize(ActiveConfig, new JsonSerializerOptions { WriteIndented = true }));
                                    Log("ADMIN", $"'{currentAlias}' changed password for '{tAlias}'");
                                    await Send(socket, new { action = "SYSTEM_MESSAGE", message = $"Password updated for '{tAlias}'." });
                                }
                                else await Send(socket, new { action = "SYSTEM_MESSAGE", message = $"'{tAlias}' is not a registered user. Use /adduser first." });
                            }
                            else if (cmd == "/authmode" && parts.Length >= 2 && userRole == "owner")
                            {
                                string mode = parts[1].ToLowerInvariant();
                                if (mode != "open" && mode != "registered+guests" && mode != "verified-only")
                                    await Send(socket, new { action = "SYSTEM_MESSAGE", message = "Valid modes: open, registered+guests, verified-only" });
                                else
                                {
                                    ActiveConfig.Settings.AuthMode = mode;
                                    File.WriteAllText(ConfigFile, JsonSerializer.Serialize(ActiveConfig, new JsonSerializerOptions { WriteIndented = true }));
                                    Log("ADMIN", $"'{currentAlias}' set auth mode to '{mode}'");
                                    await Send(socket, new { action = "SYSTEM_MESSAGE", message = $"Auth mode set to '{mode}'." });
                                }
                            }
                            else if (cmd == "/listusers" && userRole == "owner")
                            {
                                var users = ActiveConfig.Settings.RegisteredUsers ?? new();
                                string mode = ActiveConfig.Settings.AuthMode ?? "open";
                                string list = users.Count == 0 ? "(none)" : string.Join(", ", users.Keys);
                                await Send(socket, new { action = "SYSTEM_MESSAGE", message = $"Auth mode: {mode} | Registered users ({users.Count}): {list}" });
                            }
                            else await Send(socket, new { action = "SYSTEM_MESSAGE", message = $"Unknown command: {cmd}" });
                        }
                        else
                        {
                            if (chatCh != null && chatCh.SlowMode > 0 && RoleRank(userRole) < RoleRank("admin"))
                            {
                                string smKey = $"{channelId}:{currentAlias}";
                                if (_lastMsgTime.TryGetValue(smKey, out DateTime last) && (DateTime.UtcNow - last).TotalSeconds < chatCh.SlowMode)
                                {
                                    int retryAfter = (int)Math.Ceiling(chatCh.SlowMode - (DateTime.UtcNow - last).TotalSeconds);
                                    await Send(socket, new { action = "RATE_LIMITED", retryAfter });
                                    continue;
                                }
                                _lastMsgTime[smKey] = DateTime.UtcNow;
                            }
                            string replyToId = incoming.RootElement.TryGetProperty("replyToId", out var rtEl) && rtEl.ValueKind == JsonValueKind.String ? rtEl.GetString() : null;
                            ReplySnippet replySnippet = null;
                            if (!string.IsNullOrEmpty(replyToId) && chatCh?.E2E != true)
                                lock (HistoryLock)
                                    if (ChannelHistory.TryGetValue(channelId, out var prevMsgs))
                                    {
                                        var parent = prevMsgs.FirstOrDefault(m => m.Id == replyToId);
                                        if (parent != null)
                                            replySnippet = new ReplySnippet { Author = parent.Author, Text = parent.Message.Length > 80 ? parent.Message[..80] + "…" : parent.Message };
                                    }
                            string msgId = Guid.NewGuid().ToString("N")[..12];
                            var stored = new StoredMessage {
                                Id           = msgId,
                                Author       = currentAlias,
                                AuthorGuid   = ClientGuids.TryGetValue(currentAlias, out var senderGuid) ? senderGuid : null,
                                Time         = DateTime.Now.ToString("h:mm tt"),
                                Ts           = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                                Message      = text,
                                ReplyToId    = replyToId,
                                ReplySnippet = replySnippet
                            };
                            lock (HistoryLock)
                            {
                                if (!ChannelHistory.ContainsKey(channelId)) ChannelHistory[channelId] = new();
                                ChannelHistory[channelId].Add(stored);
                            }
                            string jsonLine = MessageToJsonLine(channelId, stored);
                            await File.AppendAllTextAsync(ChatFile(channelId), jsonLine + Environment.NewLine);
                            Log("CHAT", $"[{channelId}] {currentAlias}: {(chatCh?.E2E == true ? "[encrypted]" : text)}");
                            var lineBytes = Encoding.UTF8.GetBytes(jsonLine);
                            foreach (var client in ActiveClients.Values)
                                try { await client.SendAsync(new ArraySegment<byte>(lineBytes), WebSocketMessageType.Text, true, CancellationToken.None); } catch { }
                            foreach (var bot in BotClients.Values)
                                try { await bot.SendAsync(new ArraySegment<byte>(lineBytes), WebSocketMessageType.Text, true, CancellationToken.None); } catch { }
                            var chObj = ActiveConfig.Channels.FirstOrDefault(c => c.Id == channelId);
                            if (chatCh?.E2E != true)
                                FireWebhooks(channelId, chObj?.Name ?? channelId, currentAlias, text, stored.Time);
                        }
                    }

                    // ── EDIT_MESSAGE ─────────────────────────────────────────────
                    else if (action == "EDIT_MESSAGE")
                    {
                        string channelId = incoming.RootElement.GetProperty("channelId").GetString();
                        string messageId = incoming.RootElement.GetProperty("messageId").GetString();
                        string newText   = incoming.RootElement.GetProperty("newText").GetString()?.Trim();
                        if (string.IsNullOrEmpty(newText)) continue;

                        StoredMessage target = null;
                        lock (HistoryLock)
                            if (ChannelHistory.TryGetValue(channelId, out var msgs))
                                target = msgs.FirstOrDefault(m => m.Id == messageId);

                        string editorGuid = ClientGuids.TryGetValue(currentAlias, out var eg) ? eg : "";
                        bool canEdit = target != null && (
                            // GUID present on both sides: require GUID match (blocks alias squatters)
                            (!string.IsNullOrEmpty(editorGuid) && editorGuid == target.AuthorGuid) ||
                            // Old message with no GUID: fall back to alias match
                            (string.IsNullOrEmpty(target.AuthorGuid) && target.Author == currentAlias));
                        if (!canEdit)
                        {
                            await Send(socket, new { action = "SYSTEM_MESSAGE", message = "Cannot edit that message." });
                        }
                        else
                        {
                            List<EditEntry> editHistory;
                            lock (HistoryLock)
                            {
                                target.Edits ??= new List<EditEntry>();
                                target.Edits.Add(new EditEntry { OldText = target.Message, EditedAt = DateTime.Now.ToString("h:mm tt") });
                                target.Message = newText;
                                editHistory = target.Edits.ToList();
                            }
                            _ = Task.Run(() => RewriteChannelHistory(channelId));
                            Log("CHAT", $"[{channelId}] '{currentAlias}' edited {messageId}");
                            LogAudit("EDIT_MSG", currentAlias, messageId, $"ch:{channelId}");
                            await Broadcast(new { action = "MESSAGE_EDITED", channelId, messageId, newText, editHistory });
                        }
                    }

                    // ── DELETE_MESSAGE ───────────────────────────────────────────
                    else if (action == "DELETE_MESSAGE")
                    {
                        string channelId = incoming.RootElement.GetProperty("channelId").GetString();
                        string messageId = incoming.RootElement.GetProperty("messageId").GetString();

                        StoredMessage target = null;
                        lock (HistoryLock)
                            if (ChannelHistory.TryGetValue(channelId, out var msgs))
                                target = msgs.FirstOrDefault(m => m.Id == messageId);

                        bool isElevated  = RoleRank(userRole) >= RoleRank("admin");
                        string delGuid   = ClientGuids.TryGetValue(currentAlias, out var dg) ? dg : "";
                        bool guidOwns    = !string.IsNullOrEmpty(delGuid) && delGuid == target?.AuthorGuid;
                        bool aliasOwns   = string.IsNullOrEmpty(target?.AuthorGuid) && target?.Author == currentAlias;
                        bool canDelete   = target != null && (guidOwns || aliasOwns || isElevated);
                        if (!canDelete)
                        {
                            await Send(socket, new { action = "SYSTEM_MESSAGE", message = "Cannot delete that message." });
                        }
                        else
                        {
                            lock (HistoryLock)
                                if (ChannelHistory.TryGetValue(channelId, out var msgs))
                                    msgs.RemoveAll(m => m.Id == messageId);
                            _ = Task.Run(() => RewriteChannelHistory(channelId));
                            Log("CHAT", $"[{channelId}] message {messageId} deleted by '{currentAlias}'{(isElevated && target.Author != currentAlias ? $" ({userRole})" : "")}");
                            LogAudit("DELETE_MSG", currentAlias, target.Author, $"ch:{channelId} id:{messageId}");
                            await Broadcast(new { action = "MESSAGE_DELETED", channelId, messageId });
                        }
                    }

                    // ── SCREEN_SHARE_STARTED ─────────────────────────────────────
                    else if (action == "SCREEN_SHARE_STARTED")
                    {
                        var ssCh = ActiveConfig.Channels.FirstOrDefault(c => c.Id == currentVoiceChannel);
                        if (ssCh != null && !CanAccess(userRole, ssCh.MinRole)) continue;
                        Log("VOICE", $"'{currentAlias}' started screen share in '{currentVoiceChannel}'");
                        await Broadcast(new { action = "SCREEN_SHARE_STARTED", alias = currentAlias, channelId = currentVoiceChannel });
                    }

                    // ── SCREEN_SHARE_STOPPED ──────────────────────────────────────
                    else if (action == "SCREEN_SHARE_STOPPED")
                    {
                        Log("VOICE", $"'{currentAlias}' stopped screen share");
                        await Broadcast(new { action = "SCREEN_SHARE_STOPPED", alias = currentAlias });
                    }

                    // ── SET_AVATAR ───────────────────────────────────────────────
                    else if (action == "SET_AVATAR")
                    {
                        string url = ToRelativeUploadPath(incoming.RootElement.GetProperty("url").GetString() ?? "");
                        if (!string.IsNullOrEmpty(url))
                        {
                            lock (AvatarLock) UserAvatars[currentAlias] = url;
                            _ = Task.Run(SaveAvatars);
                            Log("AVATAR", $"'{currentAlias}' set avatar → {url}");
                            await Broadcast(new { action = "AVATAR_UPDATED", alias = currentAlias, url });
                        }
                    }

                    // ── SET_SERVER_ICON ──────────────────────────────────────────
                    else if (action == "SET_SERVER_ICON")
                    {
                        if (RoleRank(userRole) < RoleRank("admin"))
                        {
                            await Send(socket, new { action = "SYSTEM_MESSAGE", message = "Only admins and the owner can change the server icon." });
                            continue;
                        }
                        string url = ToRelativeUploadPath(incoming.RootElement.GetProperty("url").GetString() ?? "");
                        if (!string.IsNullOrEmpty(url))
                        {
                            ActiveConfig.Settings.ServerIcon = url;
                            File.WriteAllText(ConfigFile, JsonSerializer.Serialize(ActiveConfig, new JsonSerializerOptions { WriteIndented = true }));
                            Log("AVATAR", $"'{currentAlias}' set server icon → {url}");
                            await Broadcast(new { action = "SERVER_ICON_UPDATED", url });
                        }
                    }

                    // ── WEBRTC_SIGNAL ────────────────────────────────────────────
                    else if (action == "WEBRTC_SIGNAL")
                    {
                        string target  = incoming.RootElement.GetProperty("target").GetString();
                        string sigType = incoming.RootElement.GetProperty("payload").GetProperty("type").GetString();
                        if (ActiveClients.TryGetValue(target, out WebSocket tSock))
                        {
                            await tSock.SendAsync(new ArraySegment<byte>(msgBytes), WebSocketMessageType.Text, true, CancellationToken.None);
                            Log("SIGNAL", $"{currentAlias} → {target} ({sigType}) | {msgBytes.Length}B");
                        }
                        else Log("SIGNAL", $"WARN: target '{target}' not found for signal from {currentAlias} ({sigType})");
                    }

                    // ── JOIN_VOICE ───────────────────────────────────────────────
                    else if (action == "JOIN_VOICE")
                    {
                        string channelId = incoming.RootElement.GetProperty("channelId").GetString();

                        var voiceCh = ActiveConfig.Channels.FirstOrDefault(c => c.Id == channelId);
                        if (voiceCh != null && !CanAccess(userRole, voiceCh.MinRole))
                        {
                            await Send(socket, new { action = "SYSTEM_MESSAGE", message = "You don't have access to that channel." });
                            continue;
                        }

                        if (currentVoiceChannel != null && currentVoiceChannel != channelId)
                        {
                            if (ChannelOccupants.TryGetValue(currentVoiceChannel, out var oldUsers))
                            {
                                oldUsers.Remove(currentAlias);
                                var leftMsg = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { action = "USER_LEFT_VOICE", alias = currentAlias }));
                                foreach (var u in oldUsers)
                                    if (ActiveClients.TryGetValue(u, out WebSocket uSock))
                                        try { await uSock.SendAsync(new ArraySegment<byte>(leftMsg), WebSocketMessageType.Text, true, CancellationToken.None); } catch { }
                                await Broadcast(new { action = "VOICE_STATE_UPDATE", channelId = currentVoiceChannel, users = oldUsers });
                            }
                        }

                        currentVoiceChannel = channelId;
                        if (!ChannelOccupants.ContainsKey(channelId)) ChannelOccupants[channelId] = new List<string>();
                        if (ChannelOccupants[channelId].Contains(currentAlias)) continue;

                        Log("VOICE", $"'{currentAlias}' joining '{channelId}' | occupants before:{ChannelOccupants[channelId].Count}");

                        var joinNotice = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { action = "USER_JOINED_VOICE", alias = currentAlias }));
                        foreach (var user in ChannelOccupants[channelId])
                            if (ActiveClients.TryGetValue(user, out WebSocket oSock))
                                await oSock.SendAsync(new ArraySegment<byte>(joinNotice), WebSocketMessageType.Text, true, CancellationToken.None);

                        ChannelOccupants[channelId].Add(currentAlias);

                        await Broadcast(new { action = "VOICE_STATE_UPDATE", channelId, users = ChannelOccupants[channelId] });
                    }

                    // ── LEAVE_VOICE ──────────────────────────────────────────────
                    else if (action == "LEAVE_VOICE")
                    {
                        string channelId = incoming.RootElement.GetProperty("channelId").GetString();
                        if (currentVoiceChannel == channelId && ChannelOccupants.TryGetValue(channelId, out var leaveList))
                        {
                            leaveList.Remove(currentAlias);
                            currentVoiceChannel = null;
                            Log("VOICE", $"'{currentAlias}' left '{channelId}' (voluntary) | remaining:{leaveList.Count}");
                            var leftNotice  = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { action = "USER_LEFT_VOICE", alias = currentAlias }));
                            var stateBytes  = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { action = "VOICE_STATE_UPDATE", channelId, users = leaveList }));
                            foreach (var u in leaveList)
                                if (ActiveClients.TryGetValue(u, out WebSocket oSock))
                                {
                                    await oSock.SendAsync(new ArraySegment<byte>(leftNotice), WebSocketMessageType.Text, true, CancellationToken.None);
                                    await oSock.SendAsync(new ArraySegment<byte>(stateBytes),  WebSocketMessageType.Text, true, CancellationToken.None);
                                }
                            await socket.SendAsync(new ArraySegment<byte>(stateBytes), WebSocketMessageType.Text, true, CancellationToken.None);
                        }
                    }

                    // ── SET_STATUS ───────────────────────────────────────────────
                    else if (action == "SET_STATUS")
                    {
                        string status = incoming.RootElement.TryGetProperty("status", out JsonElement stEl) ? stEl.GetString() ?? "online" : "online";
                        string[] validStatuses = { "online", "away", "dnd", "invisible" };
                        if (validStatuses.Contains(status))
                        {
                            UserStatuses[currentAlias] = status;
                            string broadcastStatus = status == "invisible" ? "offline" : status;
                            await Broadcast(new { action = "STATUS_UPDATED", alias = currentAlias, status = broadcastStatus });
                            Log("STATUS", $"'{currentAlias}' → {status}");
                        }
                    }

                    // ── ADD_REACTION ─────────────────────────────────────────────
                    else if (action == "ADD_REACTION")
                    {
                        string channelId = incoming.RootElement.GetProperty("channelId").GetString();
                        string messageId = incoming.RootElement.GetProperty("messageId").GetString();
                        string emoji     = incoming.RootElement.GetProperty("emoji").GetString();
                        if (string.IsNullOrEmpty(emoji) || emoji.Length > 8) continue;

                        var reactCh = ActiveConfig.Channels.FirstOrDefault(c => c.Id == channelId);
                        if (reactCh == null || !CanAccess(userRole, reactCh.MinRole)) continue;

                        StoredMessage reactTarget = null;
                        lock (HistoryLock)
                            if (ChannelHistory.TryGetValue(channelId, out var rMsgs))
                                reactTarget = rMsgs.FirstOrDefault(m => m.Id == messageId);
                        if (reactTarget == null) continue;

                        Dictionary<string, List<string>> reactions;
                        lock (HistoryLock)
                        {
                            if (reactTarget.Reactions == null) reactTarget.Reactions = new();
                            if (!reactTarget.Reactions.ContainsKey(emoji)) reactTarget.Reactions[emoji] = new List<string>();
                            if (reactTarget.Reactions[emoji].Contains(currentAlias))
                            {
                                reactTarget.Reactions[emoji].Remove(currentAlias);
                                if (reactTarget.Reactions[emoji].Count == 0) reactTarget.Reactions.Remove(emoji);
                            }
                            else reactTarget.Reactions[emoji].Add(currentAlias);
                            reactions = reactTarget.Reactions.ToDictionary(kv => kv.Key, kv => kv.Value.ToList());
                        }
                        _ = Task.Run(() => RewriteChannelHistory(channelId));
                        await Broadcast(new { action = "REACTION_UPDATED", channelId, messageId, reactions });
                        Log("REACT", $"[{channelId}] {currentAlias} reacted {emoji} on {messageId}");
                    }

                    // ── PIN_MESSAGE ──────────────────────────────────────────────
                    else if (action == "PIN_MESSAGE")
                    {
                        if (RoleRank(userRole) < RoleRank("admin"))
                        { await Send(socket, new { action = "SYSTEM_MESSAGE", message = "Only admins can pin messages." }); continue; }

                        string channelId = incoming.RootElement.GetProperty("channelId").GetString();
                        string messageId = incoming.RootElement.GetProperty("messageId").GetString();
                        var pinCh = ActiveConfig.Channels.FirstOrDefault(c => c.Id == channelId);
                        if (pinCh == null) continue;

                        if (pinCh.PinnedMessageIds == null) pinCh.PinnedMessageIds = new List<string>();
                        bool pinning = !pinCh.PinnedMessageIds.Contains(messageId);
                        if (pinning) pinCh.PinnedMessageIds.Add(messageId);
                        else pinCh.PinnedMessageIds.Remove(messageId);

                        File.WriteAllText(ConfigFile, JsonSerializer.Serialize(ActiveConfig, new JsonSerializerOptions { WriteIndented = true }));

                        var pinMsgs2 = new List<object>();
                        lock (HistoryLock)
                            if (ChannelHistory.TryGetValue(channelId, out var pMsgs2))
                                foreach (var pid in pinCh.PinnedMessageIds)
                                { var pm = pMsgs2.FirstOrDefault(x => x.Id == pid); if (pm != null) pinMsgs2.Add(new { id = pm.Id, author = pm.Author, time = pm.Time, message = pm.Message }); }

                        await Broadcast(new { action = "PINS_UPDATED", channelId, pins = pinMsgs2 });
                        await BroadcastSystemMessage($"{currentAlias} {(pinning ? "pinned" : "unpinned")} a message in #{pinCh.Name}.");
                        LogAudit("PIN", currentAlias, messageId, $"ch:{channelId} {(pinning ? "pinned" : "unpinned")}");
                        Log("ADMIN", $"'{currentAlias}' {(pinning ? "pinned" : "unpinned")} {messageId} in #{pinCh.Name}");
                    }

                    // ── VIDEO_STARTED ────────────────────────────────────────────
                    else if (action == "VIDEO_STARTED")
                    {
                        Log("VOICE", $"'{currentAlias}' started camera in '{currentVoiceChannel}'");
                        await Broadcast(new { action = "VIDEO_STARTED", alias = currentAlias, channelId = currentVoiceChannel });
                    }

                    // ── VIDEO_STOPPED ────────────────────────────────────────────
                    else if (action == "VIDEO_STOPPED")
                    {
                        Log("VOICE", $"'{currentAlias}' stopped camera");
                        await Broadcast(new { action = "VIDEO_STOPPED", alias = currentAlias });
                    }

                    // ── GENERATE_BOT_TOKEN ───────────────────────────────────────
                    else if (action == "GENERATE_BOT_TOKEN")
                    {
                        if (RoleRank(userRole) < RoleRank("admin"))
                        { await Send(socket, new { action = "SYSTEM_MESSAGE", message = "Only admins can manage bot tokens." }); continue; }
                        string newToken = Guid.NewGuid().ToString("N");
                        ActiveConfig.Settings.BotTokens.Add(newToken);
                        File.WriteAllText(ConfigFile, JsonSerializer.Serialize(ActiveConfig, new JsonSerializerOptions { WriteIndented = true }));
                        Log("BOT", $"'{currentAlias}' generated bot token");
                        LogAudit("BOT_TOKEN_CREATE", currentAlias, newToken[..8] + "…");
                        await Send(socket, new { action = "BOT_TOKEN_CREATED", token = newToken, tokens = ActiveConfig.Settings.BotTokens });
                    }

                    // ── REVOKE_BOT_TOKEN ─────────────────────────────────────────
                    else if (action == "REVOKE_BOT_TOKEN")
                    {
                        if (RoleRank(userRole) < RoleRank("admin"))
                        { await Send(socket, new { action = "SYSTEM_MESSAGE", message = "Only admins can manage bot tokens." }); continue; }
                        string tokenToRevoke = incoming.RootElement.GetProperty("token").GetString() ?? "";
                        bool removed = ActiveConfig.Settings.BotTokens.Remove(tokenToRevoke);
                        if (removed)
                        {
                            File.WriteAllText(ConfigFile, JsonSerializer.Serialize(ActiveConfig, new JsonSerializerOptions { WriteIndented = true }));
                            Log("BOT", $"'{currentAlias}' revoked bot token {tokenToRevoke[..Math.Min(8, tokenToRevoke.Length)]}…");
                            LogAudit("BOT_TOKEN_REVOKE", currentAlias, tokenToRevoke[..Math.Min(8, tokenToRevoke.Length)] + "…");
                        }
                        await Send(socket, new { action = "BOT_TOKENS_UPDATED", tokens = ActiveConfig.Settings.BotTokens });
                    }

                    // ── ADD_WEBHOOK ──────────────────────────────────────────────
                    else if (action == "ADD_WEBHOOK")
                    {
                        if (RoleRank(userRole) < RoleRank("admin"))
                        { await Send(socket, new { action = "SYSTEM_MESSAGE", message = "Only admins can manage webhooks." }); continue; }
                        string whName = incoming.RootElement.TryGetProperty("name",      out var wnEl) ? wnEl.GetString() ?? "Webhook" : "Webhook";
                        string whUrl  = incoming.RootElement.TryGetProperty("url",       out var wuEl) ? wuEl.GetString() ?? "" : "";
                        string whCh   = incoming.RootElement.TryGetProperty("channelId", out var wcEl) ? wcEl.GetString() ?? "" : "";
                        if (string.IsNullOrEmpty(whUrl)) { await Send(socket, new { action = "SYSTEM_MESSAGE", message = "Webhook URL is required." }); continue; }
                        var hook = new WebhookEntry { Name = whName, Url = whUrl, ChannelId = whCh };
                        ActiveConfig.Settings.Webhooks.Add(hook);
                        File.WriteAllText(ConfigFile, JsonSerializer.Serialize(ActiveConfig, new JsonSerializerOptions { WriteIndented = true }));
                        Log("WEBHOOK", $"'{currentAlias}' added webhook '{whName}' → {whUrl}");
                        LogAudit("WEBHOOK_ADD", currentAlias, whName, whUrl);
                        await Send(socket, new { action = "WEBHOOKS_UPDATED", webhooks = ActiveConfig.Settings.Webhooks });
                    }

                    // ── DELETE_WEBHOOK ───────────────────────────────────────────
                    else if (action == "DELETE_WEBHOOK")
                    {
                        if (RoleRank(userRole) < RoleRank("admin"))
                        { await Send(socket, new { action = "SYSTEM_MESSAGE", message = "Only admins can manage webhooks." }); continue; }
                        string whUrl = incoming.RootElement.GetProperty("url").GetString() ?? "";
                        int removed  = ActiveConfig.Settings.Webhooks.RemoveAll(w => w.Url == whUrl);
                        if (removed > 0)
                        {
                            File.WriteAllText(ConfigFile, JsonSerializer.Serialize(ActiveConfig, new JsonSerializerOptions { WriteIndented = true }));
                            Log("WEBHOOK", $"'{currentAlias}' removed webhook {whUrl}");
                            LogAudit("WEBHOOK_DELETE", currentAlias, whUrl);
                        }
                        await Send(socket, new { action = "WEBHOOKS_UPDATED", webhooks = ActiveConfig.Settings.Webhooks });
                    }

                    // ── SEARCH_MESSAGES ──────────────────────────────────────────
                    else if (action == "SEARCH_MESSAGES")
                    {
                        string srchChId = incoming.RootElement.GetProperty("channelId").GetString() ?? "";
                        string srchQ    = incoming.RootElement.GetProperty("query").GetString()?.Trim().ToLowerInvariant() ?? "";
                        if (string.IsNullOrEmpty(srchQ)) { await Send(socket, new { action = "SEARCH_RESULTS", channelId = srchChId, query = srchQ, results = Array.Empty<object>() }); continue; }
                        var srchCh = ActiveConfig.Channels.FirstOrDefault(c => c.Id == srchChId);
                        if (srchCh == null || !CanAccess(userRole, srchCh.MinRole)) continue;
                        List<object> srchResults;
                        lock (HistoryLock)
                        {
                            if (!ChannelHistory.TryGetValue(srchChId, out var srchMsgs)) srchResults = new();
                            else srchResults = srchMsgs
                                .Where(m => (m.Message?.ToLowerInvariant().Contains(srchQ) == true) || (m.Author?.ToLowerInvariant().Contains(srchQ) == true))
                                .Select(m => (object)new { m.Id, m.Author, m.Time, m.Ts, m.Message })
                                .ToList();
                        }
                        await Send(socket, new { action = "SEARCH_RESULTS", channelId = srchChId, query = srchQ, results = srchResults });
                        Log("SEARCH", $"'{currentAlias}' searched [{srchChId}] '{srchQ}' → {srchResults.Count} hits");
                    }

                    // ── SEND_DM ──────────────────────────────────────────────────
                    else if (action == "SEND_DM")
                    {
                        string dmTo   = incoming.RootElement.GetProperty("to").GetString()?.Trim() ?? "";
                        string dmText = incoming.RootElement.GetProperty("message").GetString()?.Trim() ?? "";
                        if (string.IsNullOrEmpty(dmTo) || string.IsNullOrEmpty(dmText) || dmTo == currentAlias) continue;
                        string dmId = Guid.NewGuid().ToString("N")[..12];
                        var dm = new DmMessage { Id = dmId, From = currentAlias, To = dmTo, Time = DateTime.Now.ToString("h:mm tt"), Ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds(), Message = dmText };
                        Directory.CreateDirectory(DmDir);
                        lock (DmLock) File.AppendAllText(DmFile(currentAlias, dmTo), JsonSerializer.Serialize(dm) + Environment.NewLine);
                        var dmPayload = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { action = "DM_RECEIVED", id = dm.Id, from = dm.From, to = dm.To, time = dm.Time, ts = dm.Ts, message = dm.Message }));
                        try { await socket.SendAsync(new ArraySegment<byte>(dmPayload), WebSocketMessageType.Text, true, CancellationToken.None); } catch { }
                        if (ActiveClients.TryGetValue(dmTo, out var dmRecipSocket))
                            try { await dmRecipSocket.SendAsync(new ArraySegment<byte>(dmPayload), WebSocketMessageType.Text, true, CancellationToken.None); } catch { }
                        Log("DM", $"{currentAlias} → {dmTo}: {(dmText.Length > 40 ? dmText[..40] + "…" : dmText)}");
                    }

                    // ── GET_DM_HISTORY ───────────────────────────────────────────
                    else if (action == "GET_DM_HISTORY")
                    {
                        string dmWith = incoming.RootElement.GetProperty("with").GetString()?.Trim() ?? "";
                        if (string.IsNullOrEmpty(dmWith)) continue;
                        var dmMsgs = new List<DmMessage>();
                        string dmPath = DmFile(currentAlias, dmWith);
                        lock (DmLock)
                            if (File.Exists(dmPath))
                                foreach (var line in File.ReadLines(dmPath))
                                    try { var m = JsonSerializer.Deserialize<DmMessage>(line); if (m != null) dmMsgs.Add(m); } catch { }
                        await Send(socket, new { action = "DM_HISTORY", with = dmWith, messages = dmMsgs.TakeLast(100).Select(m => new { id = m.Id, from = m.From, to = m.To, time = m.Time, ts = m.Ts, message = m.Message }) });
                    }

                    // ── MARK_DM_READ ─────────────────────────────────────────────
                    else if (action == "MARK_DM_READ")
                    {
                        string dmWith = incoming.RootElement.TryGetProperty("with",   out var mrEl) ? mrEl.GetString()?.Trim() ?? "" : "";
                        string lastId = incoming.RootElement.TryGetProperty("lastId", out var liEl) ? liEl.GetString()?.Trim() ?? "" : "";
                        if (!string.IsNullOrEmpty(dmWith) && !string.IsNullOrEmpty(lastId)
                            && ActiveClients.TryGetValue(dmWith, out var readRecipSocket))
                            try { await Send(readRecipSocket, new { action = "DM_READ", fromAlias = currentAlias, lastId }); } catch { }
                    }

                    // ── DELETE_EMOJI ─────────────────────────────────────────────
                    else if (action == "DELETE_EMOJI")
                    {
                        if (RoleRank(userRole) < RoleRank("admin"))
                        { await Send(socket, new { action = "SYSTEM_MESSAGE", message = "Only admins can manage custom emojis." }); continue; }
                        string shortcode = incoming.RootElement.GetProperty("shortcode").GetString() ?? "";
                        bool removed;
                        lock (EmojiLock) removed = ServerEmojis.Remove(shortcode);
                        if (removed)
                        {
                            SaveEmojis();
                            Log("EMOJI", $"'{currentAlias}' deleted emoji :{shortcode}:");
                            LogAudit("EMOJI_DELETE", currentAlias, shortcode);
                            Dictionary<string, string> emojisBroadcast;
                            lock (EmojiLock) emojisBroadcast = new(ServerEmojis);
                            await Broadcast(new { action = "EMOJIS_UPDATED", emojis = emojisBroadcast });
                        }
                    }

                    // ── REGISTER_PUBLIC_KEY ───────────────────────────────────────
                    else if (action == "REGISTER_PUBLIC_KEY")
                    {
                        if (!incoming.RootElement.TryGetProperty("publicKey", out var pkEl) || pkEl.ValueKind != JsonValueKind.String) continue;
                        string pubKeyB64 = pkEl.GetString() ?? "";
                        if (string.IsNullOrEmpty(pubKeyB64)) continue;
                        lock (PubKeyLock)
                        {
                            PublicKeys[currentAlias] = pubKeyB64;
                            File.WriteAllText(PubKeyFile, JsonSerializer.Serialize(PublicKeys));
                        }
                        Log("E2E", $"Public key registered: '{currentAlias}'");
                        if (RoleRank(userRole) >= RoleRank("admin"))
                            await Broadcast(new { action = "E2E_PUBKEY_UPDATED", alias = currentAlias });
                    }

                    // ── ENABLE_CHANNEL_E2E ────────────────────────────────────────
                    else if (action == "ENABLE_CHANNEL_E2E")
                    {
                        if (RoleRank(userRole) < RoleRank("admin")) continue;
                        string e2eChId = incoming.RootElement.TryGetProperty("channelId", out var e2eChEl) ? e2eChEl.GetString()?.Trim() ?? "" : "";
                        var e2eCh = ActiveConfig.Channels.FirstOrDefault(c => c.Id == e2eChId && c.Type == "Text");
                        if (e2eCh == null) continue;
                        e2eCh.E2E = true;
                        var wkDict = new Dictionary<string, E2EWrappedKey>();
                        if (incoming.RootElement.TryGetProperty("wrappedKeys", out var wkEl))
                            foreach (var prop in wkEl.EnumerateObject())
                            {
                                var wk = JsonSerializer.Deserialize<E2EWrappedKey>(prop.Value.GetRawText());
                                if (wk != null) wkDict[prop.Name] = wk;
                            }
                        lock (E2ELock) { E2EKeys[e2eChId] = wkDict; File.WriteAllText(E2EFile, JsonSerializer.Serialize(E2EKeys)); }
                        _ = Task.Run(() => File.WriteAllText(ConfigFile, JsonSerializer.Serialize(ActiveConfig, new JsonSerializerOptions { WriteIndented = true })));
                        LogAudit("E2E_ENABLE", currentAlias, e2eChId, $"keys:{wkDict.Count}");
                        Log("E2E", $"'{currentAlias}' enabled E2E on #{e2eCh.Name} | {wkDict.Count} key(s) distributed");
                        await Broadcast(new { action = "CHANNEL_UPDATED", channelId = e2eChId, e2e = true });
                        foreach (var kv in wkDict)
                            if (ActiveClients.TryGetValue(kv.Key, out var kSock))
                                await Send(kSock, new { action = "E2E_KEY_GRANTED", channelId = e2eChId, ephemPub = kv.Value.EphemPub, iv = kv.Value.Iv, wrapped = kv.Value.Wrapped });
                    }

                    // ── DISABLE_CHANNEL_E2E ───────────────────────────────────────
                    else if (action == "DISABLE_CHANNEL_E2E")
                    {
                        if (RoleRank(userRole) < RoleRank("admin")) continue;
                        string e2eChId2 = incoming.RootElement.TryGetProperty("channelId", out var e2eCh2El) ? e2eCh2El.GetString()?.Trim() ?? "" : "";
                        var e2eCh2 = ActiveConfig.Channels.FirstOrDefault(c => c.Id == e2eChId2);
                        if (e2eCh2 == null) continue;
                        e2eCh2.E2E = false;
                        lock (E2ELock) { E2EKeys.Remove(e2eChId2); File.WriteAllText(E2EFile, JsonSerializer.Serialize(E2EKeys)); }
                        _ = Task.Run(() => File.WriteAllText(ConfigFile, JsonSerializer.Serialize(ActiveConfig, new JsonSerializerOptions { WriteIndented = true })));
                        LogAudit("E2E_DISABLE", currentAlias, e2eChId2, "");
                        Log("E2E", $"'{currentAlias}' disabled E2E on #{e2eCh2.Name}");
                        await Broadcast(new { action = "CHANNEL_UPDATED", channelId = e2eChId2, e2e = false });
                        await Broadcast(new { action = "E2E_KEY_REVOKED", channelId = e2eChId2 });
                    }

                    // ── GRANT_E2E_ACCESS ──────────────────────────────────────────
                    else if (action == "GRANT_E2E_ACCESS")
                    {
                        if (RoleRank(userRole) < RoleRank("admin")) continue;
                        string grantChId  = incoming.RootElement.TryGetProperty("channelId", out var gChEl)    ? gChEl.GetString()?.Trim()    ?? "" : "";
                        string grantAlias = incoming.RootElement.TryGetProperty("alias",     out var gAliasEl) ? gAliasEl.GetString()?.Trim() ?? "" : "";
                        if (string.IsNullOrEmpty(grantChId) || string.IsNullOrEmpty(grantAlias)) continue;
                        var grantKey = new E2EWrappedKey {
                            EphemPub = incoming.RootElement.TryGetProperty("ephemPub", out var epEl) ? epEl.GetString() ?? "" : "",
                            Iv       = incoming.RootElement.TryGetProperty("iv",       out var ivEl) ? ivEl.GetString() ?? "" : "",
                            Wrapped  = incoming.RootElement.TryGetProperty("wrapped",  out var wEl)  ? wEl.GetString()  ?? "" : ""
                        };
                        lock (E2ELock)
                        {
                            if (!E2EKeys.ContainsKey(grantChId)) E2EKeys[grantChId] = new();
                            E2EKeys[grantChId][grantAlias] = grantKey;
                            File.WriteAllText(E2EFile, JsonSerializer.Serialize(E2EKeys));
                        }
                        LogAudit("E2E_GRANT", currentAlias, grantAlias, grantChId);
                        Log("E2E", $"'{currentAlias}' granted E2E ch:{grantChId} → '{grantAlias}'");
                        if (ActiveClients.TryGetValue(grantAlias, out var gSock))
                            await Send(gSock, new { action = "E2E_KEY_GRANTED", channelId = grantChId, ephemPub = grantKey.EphemPub, iv = grantKey.Iv, wrapped = grantKey.Wrapped });
                        await Broadcast(new { action = "E2E_ACCESS_UPDATED", channelId = grantChId, alias = grantAlias, hasAccess = true });
                    }

                    // ── ROTATE_E2E_KEY ────────────────────────────────────────────
                    else if (action == "ROTATE_E2E_KEY")
                    {
                        if (RoleRank(userRole) < RoleRank("admin")) continue;
                        string rotChId = incoming.RootElement.TryGetProperty("channelId", out var rotChEl) ? rotChEl.GetString()?.Trim() ?? "" : "";
                        var rotCh = ActiveConfig.Channels.FirstOrDefault(c => c.Id == rotChId && c.E2E);
                        if (rotCh == null) continue;
                        var newWkDict = new Dictionary<string, E2EWrappedKey>();
                        if (incoming.RootElement.TryGetProperty("wrappedKeys", out var rotWkEl))
                            foreach (var prop in rotWkEl.EnumerateObject())
                            {
                                var wk = JsonSerializer.Deserialize<E2EWrappedKey>(prop.Value.GetRawText());
                                if (wk != null) newWkDict[prop.Name] = wk;
                            }
                        lock (E2ELock) { E2EKeys[rotChId] = newWkDict; File.WriteAllText(E2EFile, JsonSerializer.Serialize(E2EKeys)); }
                        LogAudit("E2E_ROTATE", currentAlias, rotChId, $"keys:{newWkDict.Count}");
                        Log("E2E", $"'{currentAlias}' rotated E2E key on #{rotCh.Name} | {newWkDict.Count} key(s)");
                        await Broadcast(new { action = "E2E_KEY_REVOKED", channelId = rotChId });
                        foreach (var kv in newWkDict)
                            if (ActiveClients.TryGetValue(kv.Key, out var kSock2))
                                await Send(kSock2, new { action = "E2E_KEY_GRANTED", channelId = rotChId, ephemPub = kv.Value.EphemPub, iv = kv.Value.Iv, wrapped = kv.Value.Wrapped });
                    }

                    // ── SET_USER_ROLE ─────────────────────────────────────────────
                    else if (action == "SET_USER_ROLE")
                    {
                        if (RoleRank(userRole) < RoleRank("admin"))
                        { await Send(socket, new { action = "SYSTEM_MESSAGE", message = "Only admins can change roles." }); continue; }
                        string targetAlias2 = incoming.RootElement.TryGetProperty("alias",  out var ta2El) ? ta2El.GetString()?.Trim() ?? "" : "";
                        string newRole2     = incoming.RootElement.TryGetProperty("role",   out var nr2El) ? nr2El.GetString()?.Trim().ToLowerInvariant() ?? "" : "";
                        string[] grantable2 = userRole == "owner"
                            ? new[] { "guest", "member", "trusted", "admin" }
                            : new[] { "guest", "member", "trusted" };
                        if (string.IsNullOrEmpty(targetAlias2) || !grantable2.Contains(newRole2)) continue;
                        lock (RoleLock) UserRoles[targetAlias2] = newRole2;
                        _ = Task.Run(SaveRoles);
                        LogAudit("ROLE", currentAlias, targetAlias2, newRole2);
                        if (ActiveClients.TryGetValue(targetAlias2, out WebSocket tSock2))
                            await Send(tSock2, new { action = "ROLE_GRANTED", role = newRole2 });
                        await Broadcast(new { action = "USER_ROLE_UPDATED", alias = targetAlias2, role = newRole2 });
                    }

                    // ── SET_CHANNEL_ROLES ─────────────────────────────────────────
                    else if (action == "SET_CHANNEL_ROLES")
                    {
                        if (RoleRank(userRole) < RoleRank("admin"))
                        { await Send(socket, new { action = "SYSTEM_MESSAGE", message = "Only admins can change channel permissions." }); continue; }
                        string chId2 = incoming.RootElement.TryGetProperty("channelId", out var ch2El) ? ch2El.GetString()?.Trim() ?? "" : "";
                        var tChan = ActiveConfig.Channels.FirstOrDefault(c => c.Id == chId2);
                        if (tChan == null) continue;
                        if (incoming.RootElement.TryGetProperty("minRole",   out var mrEl2) && mrEl2.ValueKind   == JsonValueKind.String) tChan.MinRole   = mrEl2.GetString() ?? "guest";
                        if (incoming.RootElement.TryGetProperty("writeRole", out var wrEl2) && wrEl2.ValueKind == JsonValueKind.String) tChan.WriteRole = wrEl2.GetString() ?? "guest";
                        _ = Task.Run(() => File.WriteAllText(ConfigFile, JsonSerializer.Serialize(ActiveConfig, new JsonSerializerOptions { WriteIndented = true })));
                        LogAudit("CHANNEL_ROLES", currentAlias, chId2, $"minRole:{tChan.MinRole} writeRole:{tChan.WriteRole}");
                        await Broadcast(new { action = "CHANNEL_UPDATED", channelId = chId2, minRole = tChan.MinRole, writeRole = tChan.WriteRole });
                    }

                    // ── ADD_CHANNEL ───────────────────────────────────────────────
                    else if (action == "ADD_CHANNEL")
                    {
                        if (RoleRank(userRole) < RoleRank("owner"))
                        { await Send(socket, new { action = "SYSTEM_MESSAGE", message = "Only the owner can add channels." }); continue; }
                        string newType = incoming.RootElement.TryGetProperty("type", out var ntEl) ? ntEl.GetString()?.Trim() ?? "Text" : "Text";
                        string newName = incoming.RootElement.TryGetProperty("name", out var nnEl) ? nnEl.GetString()?.Trim() ?? "new-channel" : "new-channel";
                        if (!new[] { "Text", "Voice", "Header" }.Contains(newType)) newType = "Text";
                        var newCh = new Channel { Id = Guid.NewGuid().ToString("N")[..8], Name = string.IsNullOrEmpty(newName) ? "new-channel" : newName, Type = newType };
                        ActiveConfig.Channels.Add(newCh);
                        await BroadcastChannelUpdate();
                        LogAudit("ADD_CHANNEL", currentAlias, newCh.Id, $"{newType}:{newCh.Name}");
                        Log("CONFIG", $"'{currentAlias}' added channel #{newCh.Name} (type:{newType})");
                    }

                    // ── DELETE_CHANNEL ────────────────────────────────────────────
                    else if (action == "DELETE_CHANNEL")
                    {
                        if (RoleRank(userRole) < RoleRank("owner"))
                        { await Send(socket, new { action = "SYSTEM_MESSAGE", message = "Only the owner can delete channels." }); continue; }
                        string delId = incoming.RootElement.TryGetProperty("channelId", out var delEl) ? delEl.GetString()?.Trim() ?? "" : "";
                        var delCh = ActiveConfig.Channels.FirstOrDefault(c => c.Id == delId);
                        if (delCh == null) continue;
                        ActiveConfig.Channels.Remove(delCh);
                        await BroadcastChannelUpdate();
                        LogAudit("DELETE_CHANNEL", currentAlias, delId, delCh.Name);
                        Log("CONFIG", $"'{currentAlias}' deleted channel #{delCh.Name}");
                    }

                    // ── RENAME_CHANNEL ────────────────────────────────────────────
                    else if (action == "RENAME_CHANNEL")
                    {
                        if (RoleRank(userRole) < RoleRank("admin"))
                        { await Send(socket, new { action = "SYSTEM_MESSAGE", message = "Only admins can rename channels." }); continue; }
                        string renId = incoming.RootElement.TryGetProperty("channelId", out var renEl) ? renEl.GetString()?.Trim() ?? "" : "";
                        string renName = incoming.RootElement.TryGetProperty("name", out var rnnEl) ? rnnEl.GetString()?.Trim() ?? "" : "";
                        if (string.IsNullOrEmpty(renName)) continue;
                        var renCh = ActiveConfig.Channels.FirstOrDefault(c => c.Id == renId);
                        if (renCh == null) continue;
                        renCh.Name = renName;
                        await BroadcastChannelUpdate();
                        LogAudit("RENAME_CHANNEL", currentAlias, renId, renName);
                    }

                    // ── REORDER_CHANNEL ───────────────────────────────────────────
                    else if (action == "REORDER_CHANNEL")
                    {
                        if (RoleRank(userRole) < RoleRank("admin"))
                        { await Send(socket, new { action = "SYSTEM_MESSAGE", message = "Only admins can reorder channels." }); continue; }
                        string reordId   = incoming.RootElement.TryGetProperty("channelId", out var reordEl) ? reordEl.GetString()?.Trim() ?? "" : "";
                        string direction = incoming.RootElement.TryGetProperty("direction", out var dirEl) ? dirEl.GetString() ?? "up" : "up";
                        int idx = ActiveConfig.Channels.FindIndex(c => c.Id == reordId);
                        if (idx < 0) continue;
                        int newIdx = direction == "down" ? idx + 1 : idx - 1;
                        if (newIdx < 0 || newIdx >= ActiveConfig.Channels.Count) continue;
                        var moved = ActiveConfig.Channels[idx];
                        ActiveConfig.Channels.RemoveAt(idx);
                        ActiveConfig.Channels.Insert(newIdx, moved);
                        await BroadcastChannelUpdate();
                        LogAudit("REORDER_CHANNEL", currentAlias, reordId, direction);
                    }

                    // ── TYPING ───────────────────────────────────────────────
                    else if (action == "TYPING")
                    {
                        string typingCh = incoming.RootElement.TryGetProperty("channelId", out var tyCh) ? tyCh.GetString()?.Trim() : null;
                        if (string.IsNullOrEmpty(typingCh)) continue;
                        var tyChObj = ActiveConfig.Channels.FirstOrDefault(c => c.Id == typingCh);
                        if (tyChObj == null || !CanAccess(userRole, tyChObj.MinRole)) continue;
                        var typingBytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(
                            new { action = "TYPING_INDICATOR", channelId = typingCh, alias = currentAlias }));
                        foreach (var kv in ActiveClients.ToList())
                            if (kv.Key != currentAlias)
                                try { await SendRaw(kv.Value, typingBytes); } catch { }
                    }
                }
            }
            catch (Exception ex) { Log("ERROR", $"Session for '{currentAlias}' faulted: {ex.Message}"); }
            finally
            {
                ActiveClients.TryRemove(currentAlias, out _);
                ClientGuids.TryRemove(currentAlias, out _);
                UserStatuses.TryRemove(currentAlias, out _);
                LogAudit("LEAVE", currentAlias);
                Log("NET", $"Connection closed for '{currentAlias}' | remaining:{ActiveClients.Count}");
                try { await Broadcast(new { action = "STATUS_UPDATED", alias = currentAlias, status = "offline" }); } catch { }

                if (currentVoiceChannel != null && ChannelOccupants.TryGetValue(currentVoiceChannel, out var users))
                {
                    users.Remove(currentAlias);
                    Log("VOICE", $"'{currentAlias}' left '{currentVoiceChannel}' on disconnect | remaining:{users.Count}");
                    var exitLeft  = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { action = "USER_LEFT_VOICE", alias = currentAlias }));
                    var exitState = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { action = "VOICE_STATE_UPDATE", channelId = currentVoiceChannel, users }));
                    foreach (var user in users)
                        if (ActiveClients.TryGetValue(user, out WebSocket oSock))
                        {
                            try { await oSock.SendAsync(new ArraySegment<byte>(exitLeft),  WebSocketMessageType.Text, true, CancellationToken.None); } catch { }
                            try { await oSock.SendAsync(new ArraySegment<byte>(exitState), WebSocketMessageType.Text, true, CancellationToken.None); } catch { }
                        }
                }
            }
        }
    }
}

namespace Origin.Server.Data
{
    public class Origin_Server_Data_Config
    {
        public ServerSettings Settings { get; set; } = new ServerSettings();
        public List<Channel>  Channels { get; set; } = new List<Channel>();
    }

    public class ServerSettings
    {
        public string ServerName           { get; set; } = "My Iskra Server";
        public int    Port                 { get; set; } = 8080;
        public bool   RequirePassword      { get; set; } = false;
        public string ServerPassword       { get; set; } = "";
        public string AdminPassword        { get; set; } = "";   // empty = admin commands disabled
        public string AdminEmail           { get; set; } = "";
        public List<string> TurnUrls       { get; set; } = new List<string>();
        public string TurnUsername         { get; set; } = "";
        public string TurnCredential       { get; set; } = "";
        public int    HistoryRetentionDays { get; set; } = 60;
        // "open" = anyone connects freely
        // "registered+guests" = registered aliases must provide correct password; others connect freely
        // "verified-only" = only registered aliases can connect
        public string AuthMode            { get; set; } = "open";
        public Dictionary<string, string> RegisteredUsers { get; set; } = new(); // alias → bcrypt hash
        public int    MaxUploadMb          { get; set; } = 2500;
        public double MaxDiskGb           { get; set; } = 100.0;  // 0 = unlimited
        public string ServerIcon           { get; set; } = "";
        public List<string>       BotTokens { get; set; } = new();
        public List<WebhookEntry> Webhooks  { get; set; } = new();
    }

    public class WebhookEntry
    {
        public string Name      { get; set; } = "";
        public string Url       { get; set; } = "";
        public string ChannelId { get; set; } = "";  // empty = all channels
    }

    public class Channel
    {
        public string Id               { get; set; }
        public string Name             { get; set; }
        public string Type             { get; set; }
        public string MinRole          { get; set; } = "guest";
        public string WriteRole        { get; set; } = "guest";
        public bool   E2E              { get; set; } = false;
        public bool   ReadOnly         { get; set; } = false;
        public bool   Muted            { get; set; } = false;
        public int    SlowMode         { get; set; } = 0;
        public List<string> PinnedMessageIds { get; set; } = new();
    }

    public class StoredMessage
    {
        public string Id           { get; set; }
        public string Author       { get; set; }
        public string AuthorGuid   { get; set; }  // HWID of sender — null on old messages
        public string Time         { get; set; }
        public long   Ts           { get; set; }
        public string Message      { get; set; }
        public string ReplyToId    { get; set; }
        public ReplySnippet ReplySnippet { get; set; }
        public Dictionary<string, List<string>> Reactions { get; set; } = new();
        public List<EditEntry> Edits { get; set; } = new();
    }

    public class ReplySnippet
    {
        public string Author { get; set; }
        public string Text   { get; set; }
    }

    public class EditEntry
    {
        public string OldText  { get; set; }
        public string EditedAt { get; set; }
    }

    public class DmMessage
    {
        public string Id      { get; set; }
        public string From    { get; set; }
        public string To      { get; set; }
        public string Time    { get; set; }
        public long   Ts      { get; set; }
        public string Message { get; set; }
    }

    public class FingerprintRecord
    {
        public string       MachineGuid  { get; set; }
        public List<string> Aliases      { get; set; } = new();
        public List<string> IpAddresses  { get; set; } = new();
        public DateTime     LastSeen     { get; set; }
    }

    public class E2EWrappedKey
    {
        public string EphemPub { get; set; }
        public string Iv       { get; set; }
        public string Wrapped  { get; set; }
    }


    public class BanRecord
    {
        public string   MachineGuid  { get; set; }
        public string   BannedAlias  { get; set; }
        public string   BannedBy     { get; set; }
        public DateTime BannedAt     { get; set; }
        public string   Reason       { get; set; }
    }
}
