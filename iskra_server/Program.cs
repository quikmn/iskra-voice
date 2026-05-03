using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Origin.Server.Core
{
    using Origin.Server.Data;

    class Origin_Server_Core_Main
    {
        private static void Log(string cat, string msg) =>
            Console.WriteLine($"[{DateTime.Now:HH:mm:ss.fff}][{cat,-8}] {msg}");

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

        // In-memory message store — channelId → ordered list of live messages
        private static ConcurrentDictionary<string, List<StoredMessage>> ChannelHistory = new();
        private static readonly object HistoryLock = new();

        private static readonly HashSet<string> AllowedUploadExts = new(StringComparer.OrdinalIgnoreCase)
            { ".jpg", ".jpeg", ".png", ".gif", ".webp", ".zip", ".7z" };
        private static readonly HashSet<string> ImageExts = new(StringComparer.OrdinalIgnoreCase)
            { ".jpg", ".jpeg", ".png", ".gif", ".webp" };
        private static readonly Dictionary<string, string> MimeTypes = new(StringComparer.OrdinalIgnoreCase)
        {
            { ".jpg",  "image/jpeg" }, { ".jpeg", "image/jpeg" }, { ".png",  "image/png"  },
            { ".gif",  "image/gif"  }, { ".webp", "image/webp" },
            { ".zip",  "application/zip" }, { ".7z", "application/x-7z-compressed" }
        };

        static async Task Main(string[] args)
        {
            ActiveWorldPath = Path.GetFullPath(args.Length > 0 ? args[0] : ".");
            Directory.CreateDirectory(ActiveWorldPath);
            LoadOrGenerateConfig();
            LoadFingerprints();
            LoadRoles();
            LoadAvatars();
            LoadChannelHistory();   // must come before PurgeOldHistory
            PurgeOldHistory();
            Directory.CreateDirectory(UploadDir);
            Console.Title = $"Origin Server — {ActiveConfig.Settings.ServerName} :{ActiveConfig.Settings.Port}";

            HttpListener listener = new HttpListener();
            listener.Prefixes.Add($"http://+:{ActiveConfig.Settings.Port}/");
            try
            {
                listener.Start();
                Log("SYSTEM", $"Origin Server booted on port {ActiveConfig.Settings.Port} (all interfaces)");
            }
            catch (HttpListenerException)
            {
                listener.Close();
                listener = new HttpListener();
                listener.Prefixes.Add($"http://localhost:{ActiveConfig.Settings.Port}/");
                listener.Start();
                Log("SYSTEM", $"Origin Server booted on port {ActiveConfig.Settings.Port} (localhost only — run as admin or register URL for LAN access)");
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
                        ProcessClientConnection(context);
                    else if (path == "/upload")
                        HandleUpload(context);
                    else if (path.StartsWith("/uploads/"))
                        ServeUpload(context);
                    else
                        { context.Response.StatusCode = 400; context.Response.Close(); }
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
                id        = m.Id,
                action    = "CHAT_RECEIVE",
                channelId,
                author    = m.Author,
                time      = m.Time,
                ts        = m.Ts,
                message   = m.Message
            });

        private static void LoadChannelHistory()
        {
            foreach (var ch in ActiveConfig.Channels.Where(c => c.Type == "Text"))
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
                                Id      = root.TryGetProperty("id",     out var idEl)  ? idEl.GetString()  : null,
                                Author  = root.TryGetProperty("author", out var aEl)   ? aEl.GetString()   : "?",
                                Time    = root.TryGetProperty("time",   out var tEl)   ? tEl.GetString()   : "",
                                Ts      = root.TryGetProperty("ts",     out var tsEl)  ? tsEl.GetInt64()   : 0,
                                Message = root.TryGetProperty("message",out var mEl)   ? mEl.GetString()   : "",
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

            foreach (var ch in ActiveConfig.Channels.Where(c => c.Type == "Text"))
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
                ctx.Response.StatusCode = 200; ctx.Response.ContentType = "application/json";
                await ctx.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { url })));
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
                bool isImage = ImageExts.Contains(ext);
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
        }

        private static async Task BroadcastSystemMessage(string message)
        {
            Log("SYSTEM", $"Broadcast: {message}");
            await Broadcast(new { action = "SYSTEM_MESSAGE", message });
        }

        // ── Admin actions ────────────────────────────────────────────────────────

        private static async Task KickUser(string targetAlias, string kickedBy, string reason)
        {
            if (ActiveClients.TryGetValue(targetAlias, out WebSocket targetSock))
            {
                Log("ADMIN", $"'{kickedBy}' kicked '{targetAlias}' — {reason}");
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
                Log("AUTH", $"'{currentAlias}' authenticated | role:{userRole} | total:{ActiveClients.Count}");

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
                await Send(socket, new {
                    action      = "SERVER_INFO",
                    name        = ActiveConfig.Settings.ServerName,
                    serverIcon  = ActiveConfig.Settings.ServerIcon ?? "",
                    userAvatars = avatarsCopy,
                    channels    = ActiveConfig.Channels
                        .Where(c => c.Type == "Header" || CanAccess(userRole, c.MinRole))
                        .Select(c => new { id = c.Id, name = c.Name, type = c.Type, readOnly = c.ReadOnly, muted = c.Muted }),
                    iceServers
                });

                await Send(socket, new { action = "ROLE_GRANTED", role = userRole });

                // ── Chat history ─────────────────────────────────────────────────
                foreach (var ch in ActiveConfig.Channels.Where(c => c.Type == "Text"))
                {
                    if (!ChannelHistory.TryGetValue(ch.Id, out var msgs) || msgs.Count == 0) continue;
                    Log("DATA", $"Pushing '{ch.Name}' history ({Math.Min(msgs.Count, 50)} msgs) → '{currentAlias}'");
                    foreach (var m in msgs.TakeLast(50))
                    {
                        var line = Encoding.UTF8.GetBytes(MessageToJsonLine(ch.Id, m));
                        await socket.SendAsync(new ArraySegment<byte>(line), WebSocketMessageType.Text, true, CancellationToken.None);
                    }
                }

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

                        if (text.StartsWith("/"))
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
                                    await BroadcastSystemMessage($"{targetAlias} has been given the {newRole} role.");
                                    if (ActiveClients.TryGetValue(targetAlias, out WebSocket tSock))
                                        await Send(tSock, new { action = "ROLE_GRANTED", role = newRole });
                                }
                            }
                            else await Send(socket, new { action = "SYSTEM_MESSAGE", message = $"Unknown command: {cmd}" });
                        }
                        else
                        {
                            string msgId = Guid.NewGuid().ToString("N")[..12];
                            var stored = new StoredMessage {
                                Id      = msgId,
                                Author  = currentAlias,
                                Time    = DateTime.Now.ToString("h:mm tt"),
                                Ts      = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                                Message = text
                            };
                            lock (HistoryLock)
                            {
                                if (!ChannelHistory.ContainsKey(channelId)) ChannelHistory[channelId] = new();
                                ChannelHistory[channelId].Add(stored);
                            }
                            string jsonLine = MessageToJsonLine(channelId, stored);
                            await File.AppendAllTextAsync(ChatFile(channelId), jsonLine + Environment.NewLine);
                            Log("CHAT", $"[{channelId}] {currentAlias}: {text}");
                            var lineBytes = Encoding.UTF8.GetBytes(jsonLine);
                            foreach (var client in ActiveClients.Values)
                                try { await client.SendAsync(new ArraySegment<byte>(lineBytes), WebSocketMessageType.Text, true, CancellationToken.None); } catch { }
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

                        if (target == null || target.Author != currentAlias)
                        {
                            await Send(socket, new { action = "SYSTEM_MESSAGE", message = "Cannot edit that message." });
                        }
                        else
                        {
                            lock (HistoryLock) target.Message = newText;
                            _ = Task.Run(() => RewriteChannelHistory(channelId));
                            Log("CHAT", $"[{channelId}] '{currentAlias}' edited {messageId}");
                            await Broadcast(new { action = "MESSAGE_EDITED", channelId, messageId, newText });
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

                        bool isElevated = RoleRank(userRole) >= RoleRank("admin");
                        bool canDelete  = target != null && (target.Author == currentAlias || isElevated);
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
                            await Broadcast(new { action = "MESSAGE_DELETED", channelId, messageId });
                        }
                    }

                    // ── SCREEN_SHARE_STARTED ─────────────────────────────────────
                    else if (action == "SCREEN_SHARE_STARTED")
                    {
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
                        string url = incoming.RootElement.GetProperty("url").GetString() ?? "";
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
                        string url = incoming.RootElement.GetProperty("url").GetString() ?? "";
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
                                var leaveUpdate = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { action = "VOICE_STATE_UPDATE", channelId = currentVoiceChannel, users = oldUsers }));
                                foreach (var u in oldUsers)
                                    if (ActiveClients.TryGetValue(u, out WebSocket oSock))
                                        await oSock.SendAsync(new ArraySegment<byte>(leaveUpdate), WebSocketMessageType.Text, true, CancellationToken.None);
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

                        var stateUpdate = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { action = "VOICE_STATE_UPDATE", channelId, users = ChannelOccupants[channelId] }));
                        foreach (var user in ChannelOccupants[channelId])
                            if (ActiveClients.TryGetValue(user, out WebSocket oSock))
                                await oSock.SendAsync(new ArraySegment<byte>(stateUpdate), WebSocketMessageType.Text, true, CancellationToken.None);
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
                }
            }
            catch (Exception ex) { Log("ERROR", $"Session for '{currentAlias}' faulted: {ex.Message}"); }
            finally
            {
                ActiveClients.TryRemove(currentAlias, out _);
                ClientGuids.TryRemove(currentAlias, out _);
                Log("NET", $"Connection closed for '{currentAlias}' | remaining:{ActiveClients.Count}");

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
        public int    MaxUploadMb          { get; set; } = 25;
        public string ServerIcon           { get; set; } = "";
    }

    public class Channel
    {
        public string Id       { get; set; }
        public string Name     { get; set; }
        public string Type     { get; set; }
        public string MinRole  { get; set; } = "guest";
        public bool   ReadOnly { get; set; } = false;
        public bool   Muted    { get; set; } = false;
    }

    public class StoredMessage
    {
        public string Id      { get; set; }
        public string Author  { get; set; }
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

    public class BanRecord
    {
        public string   MachineGuid  { get; set; }
        public string   BannedAlias  { get; set; }
        public string   BannedBy     { get; set; }
        public DateTime BannedAt     { get; set; }
        public string   Reason       { get; set; }
    }
}
