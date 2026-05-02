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
        private static ConcurrentDictionary<string, WebSocket> ActiveClients = new ConcurrentDictionary<string, WebSocket>();
        private static ConcurrentDictionary<string, List<string>> ChannelOccupants = new ConcurrentDictionary<string, List<string>>();

        static async Task Main(string[] args)
        {
            ActiveWorldPath = Path.GetFullPath(args.Length > 0 ? args[0] : ".");
            Directory.CreateDirectory(ActiveWorldPath);
            LoadOrGenerateConfig();
            Console.Title = $"Origin Server — {ActiveConfig.Settings.ServerName} :{ActiveConfig.Settings.Port}";

            // Try binding to all interfaces first; fall back to localhost if not admin / no netsh rule
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
            Log("SYSTEM", "Awaiting client connections...");

            try
            {
                while (true)
                {
                    HttpListenerContext context = await listener.GetContextAsync();
                    if (context.Request.IsWebSocketRequest) ProcessClientConnection(context);
                    else { context.Response.StatusCode = 400; context.Response.Close(); }
                }
            }
            catch (Exception ex)
            {
                Log("FATAL", $"Server Error: {ex.Message}");
            }
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
                ActiveConfig.Channels.Add(new Channel { Id = "c_gen_v", Name = "General",      Type = "Voice" });
                ActiveConfig.Channels.Add(new Channel { Id = "c_gen_t", Name = "general-chat", Type = "Text"  });
                File.WriteAllText(ConfigFile, JsonSerializer.Serialize(ActiveConfig, new JsonSerializerOptions { WriteIndented = true }));
                Log("CONFIG", $"New world created → {ActiveWorldPath}");
            }
        }

        private static async void ProcessClientConnection(HttpListenerContext context)
        {
            HttpListenerWebSocketContext webSocketContext = await context.AcceptWebSocketAsync(null);
            WebSocket socket = webSocketContext.WebSocket;
            string clientIp = context.Request.RemoteEndPoint?.ToString() ?? "Unknown";
            string currentAlias = "Unknown";
            string currentVoiceChannel = null;

            // Chunk buffer + stream accumulator so large SDP messages (multi-frame) are read correctly
            byte[] chunk = new byte[16384];
            var msgStream = new MemoryStream(65536);

            try
            {
                Log("NET", $"Incoming connection from {clientIp}");

                // Auth Phase — read full message
                msgStream.SetLength(0);
                WebSocketReceiveResult authResult;
                do
                {
                    authResult = await socket.ReceiveAsync(new ArraySegment<byte>(chunk), CancellationToken.None);
                    msgStream.Write(chunk, 0, authResult.Count);
                } while (!authResult.EndOfMessage);

                using JsonDocument authDoc = JsonDocument.Parse(Encoding.UTF8.GetString(msgStream.GetBuffer(), 0, (int)msgStream.Length));
                currentAlias = authDoc.RootElement.GetProperty("alias").GetString();

                ActiveClients[currentAlias] = socket;
                Log("AUTH", $"'{currentAlias}' authenticated | total clients:{ActiveClients.Count}");

                // Send server info (channel list)
                var serverInfo = JsonSerializer.Serialize(new {
                    action   = "SERVER_INFO",
                    name     = ActiveConfig.Settings.ServerName,
                    channels = ActiveConfig.Channels.Select(c => new { id = c.Id, name = c.Name, type = c.Type })
                });
                await socket.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(serverInfo)), WebSocketMessageType.Text, true, CancellationToken.None);
                Log("DATA", $"Server info sent to '{currentAlias}' | channels:{ActiveConfig.Channels.Count}");

                // Send History — per text channel
                foreach (var ch in ActiveConfig.Channels.Where(c => c.Type == "Text"))
                {
                    string histFile = ChatFile(ch.Id);
                    if (!File.Exists(histFile)) continue;
                    Log("DATA", $"Pushing history for '{ch.Name}' to '{currentAlias}'...");
                    foreach (var line in File.ReadLines(histFile).TakeLast(50))
                        await socket.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(line)), WebSocketMessageType.Text, true, CancellationToken.None);
                }

                while (socket.State == WebSocketState.Open)
                {
                    // Accumulate all frames of one logical message
                    msgStream.SetLength(0);
                    WebSocketReceiveResult msgResult;
                    do
                    {
                        msgResult = await socket.ReceiveAsync(new ArraySegment<byte>(chunk), CancellationToken.None);
                        msgStream.Write(chunk, 0, msgResult.Count);
                    } while (!msgResult.EndOfMessage);

                    if (msgResult.MessageType == WebSocketMessageType.Close) break;

                    byte[] msgBytes = msgStream.ToArray();
                    string rawMessage = Encoding.UTF8.GetString(msgBytes);
                    using JsonDocument incoming = JsonDocument.Parse(rawMessage);
                    string action = incoming.RootElement.GetProperty("action").GetString();

                    if (action == "SEND_CHAT")
                    {
                        string text = incoming.RootElement.GetProperty("message").GetString();
                        string channelId = incoming.RootElement.TryGetProperty("channelId", out JsonElement cidEl) ? cidEl.GetString() : null;
                        if (string.IsNullOrEmpty(channelId))
                            channelId = ActiveConfig.Channels.FirstOrDefault(c => c.Type == "Text")?.Id ?? "general";
                        Log("CHAT", $"[{channelId}] {currentAlias}: {text}");

                        var msg = new { action = "CHAT_RECEIVE", channelId, author = currentAlias, time = DateTime.Now.ToString("h:mm tt"), message = text };
                        string json = JsonSerializer.Serialize(msg);
                        await File.AppendAllTextAsync(ChatFile(channelId), json + Environment.NewLine);

                        foreach (var client in ActiveClients.Values)
                            if (client.State == WebSocketState.Open)
                                await client.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(json)), WebSocketMessageType.Text, true, CancellationToken.None);
                    }
                    else if (action == "WEBRTC_SIGNAL")
                    {
                        string target = incoming.RootElement.GetProperty("target").GetString();
                        string sigType = incoming.RootElement.GetProperty("payload").GetProperty("type").GetString();
                        if (ActiveClients.TryGetValue(target, out WebSocket tSock))
                        {
                            await tSock.SendAsync(new ArraySegment<byte>(msgBytes), WebSocketMessageType.Text, true, CancellationToken.None);
                            Log("SIGNAL", $"{currentAlias} → {target} ({sigType}) | {msgBytes.Length}B");
                        }
                        else
                        {
                            Log("SIGNAL", $"WARN: target '{target}' not found for signal from {currentAlias} ({sigType})");
                        }
                    }
                    else if (action == "JOIN_VOICE")
                    {
                        string channelId = incoming.RootElement.GetProperty("channelId").GetString();

                        // If switching channels, cleanly leave the old one first
                        if (currentVoiceChannel != null && currentVoiceChannel != channelId)
                        {
                            if (ChannelOccupants.TryGetValue(currentVoiceChannel, out var oldUsers))
                            {
                                oldUsers.Remove(currentAlias);
                                var leaveUpdate = JsonSerializer.Serialize(new { action = "VOICE_STATE_UPDATE", channelId = currentVoiceChannel, users = oldUsers });
                                foreach (var u in oldUsers)
                                    if (ActiveClients.TryGetValue(u, out WebSocket oSock))
                                        await oSock.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(leaveUpdate)), WebSocketMessageType.Text, true, CancellationToken.None);
                            }
                        }

                        currentVoiceChannel = channelId;
                        if (!ChannelOccupants.ContainsKey(channelId)) ChannelOccupants[channelId] = new List<string>();

                        // Deduplicate — ignore if already present in this channel
                        if (ChannelOccupants[channelId].Contains(currentAlias)) continue;

                        Log("VOICE", $"'{currentAlias}' joining '{channelId}' | occupants before:{ChannelOccupants[channelId].Count}");

                        var joinNotice = JsonSerializer.Serialize(new { action = "USER_JOINED_VOICE", alias = currentAlias });
                        foreach (var user in ChannelOccupants[channelId])
                            if (ActiveClients.TryGetValue(user, out WebSocket oSock))
                                await oSock.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(joinNotice)), WebSocketMessageType.Text, true, CancellationToken.None);

                        ChannelOccupants[channelId].Add(currentAlias);

                        var stateUpdate = JsonSerializer.Serialize(new { action = "VOICE_STATE_UPDATE", channelId = channelId, users = ChannelOccupants[channelId] });
                        foreach (var user in ChannelOccupants[channelId])
                            if (ActiveClients.TryGetValue(user, out WebSocket oSock))
                                await oSock.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(stateUpdate)), WebSocketMessageType.Text, true, CancellationToken.None);
                    }
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
                                    await oSock.SendAsync(new ArraySegment<byte>(leftNotice),  WebSocketMessageType.Text, true, CancellationToken.None);
                                    await oSock.SendAsync(new ArraySegment<byte>(stateBytes),  WebSocketMessageType.Text, true, CancellationToken.None);
                                }
                            // Echo updated state back to the leaving client (clears their user list for that channel)
                            await socket.SendAsync(new ArraySegment<byte>(stateBytes), WebSocketMessageType.Text, true, CancellationToken.None);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Log("ERROR", $"Session for '{currentAlias}' faulted: {ex.Message}");
            }
            finally
            {
                ActiveClients.TryRemove(currentAlias, out _);
                Log("NET", $"Connection closed for '{currentAlias}' | remaining clients:{ActiveClients.Count}");

                if (currentVoiceChannel != null && ChannelOccupants.TryGetValue(currentVoiceChannel, out var users))
                {
                    users.Remove(currentAlias);
                    Log("VOICE", $"'{currentAlias}' left '{currentVoiceChannel}' | remaining:{users.Count}");

                    var exitLeft  = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { action = "USER_LEFT_VOICE", alias = currentAlias }));
                    var exitState = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { action = "VOICE_STATE_UPDATE", channelId = currentVoiceChannel, users }));
                    foreach (var user in users)
                        if (ActiveClients.TryGetValue(user, out WebSocket oSock))
                        {
                            await oSock.SendAsync(new ArraySegment<byte>(exitLeft),  WebSocketMessageType.Text, true, CancellationToken.None);
                            await oSock.SendAsync(new ArraySegment<byte>(exitState), WebSocketMessageType.Text, true, CancellationToken.None);
                        }
                }
            }
        }
    }
}

namespace Origin.Server.Data
{
    public class Origin_Server_Data_Config { public ServerSettings Settings { get; set; } = new ServerSettings(); public List<Channel> Channels { get; set; } = new List<Channel>(); }
    public class ServerSettings { public string ServerName { get; set; } = "Origin Primary Node"; public int Port { get; set; } = 8080; public bool RequirePassword { get; set; } = true; public string ServerPassword { get; set; } = "bunker_pass_2026"; public string AdminEmail { get; set; } = "viklun@vlun.onmicrosoft.com"; }
    public class Channel { public string Id { get; set; } public string Name { get; set; } public string Type { get; set; } }
}