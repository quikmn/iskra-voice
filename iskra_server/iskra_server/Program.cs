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
        private static Origin_Server_Data_Config ActiveConfig;
        private const string ConfigPath = "ServerConfig.json";
        private const string ChatHistoryFile = "general-chat.jsonl";
        private static ConcurrentDictionary<string, WebSocket> ActiveClients = new ConcurrentDictionary<string, WebSocket>();
        private static ConcurrentDictionary<string, List<string>> ChannelOccupants = new ConcurrentDictionary<string, List<string>>();

        static async Task Main(string[] args)
        {
            Console.Title = "Origin Voice Server - Core";
            LoadOrGenerateConfig();

            HttpListener listener = new HttpListener();
            listener.Prefixes.Add($"http://localhost:{ActiveConfig.Settings.Port}/");

            try
            {
                listener.Start();
                Console.WriteLine($"[SYSTEM] Origin Server booted natively on port {ActiveConfig.Settings.Port}");
                Console.WriteLine($"[SYSTEM] Awaiting client connections...");

                while (true)
                {
                    HttpListenerContext context = await listener.GetContextAsync();
                    if (context.Request.IsWebSocketRequest) ProcessClientConnection(context);
                    else { context.Response.StatusCode = 400; context.Response.Close(); }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[FATAL] Server Error: {ex.Message}");
            }
        }

        private static void LoadOrGenerateConfig()
        {
            if (File.Exists(ConfigPath))
            {
                ActiveConfig = JsonSerializer.Deserialize<Origin_Server_Data_Config>(File.ReadAllText(ConfigPath));
                Console.WriteLine("[CONFIG] Loaded existing ServerConfig.json");
            }
            else
            {
                ActiveConfig = new Origin_Server_Data_Config();
                ActiveConfig.Channels.Add(new Channel { Id = "c_gen_v", Name = "General", Type = "Voice" });
                ActiveConfig.Channels.Add(new Channel { Id = "c_gen_t", Name = "general-chat", Type = "Text" });
                File.WriteAllText(ConfigPath, JsonSerializer.Serialize(ActiveConfig, new JsonSerializerOptions { WriteIndented = true }));
                Console.WriteLine("[CONFIG] Generated default ServerConfig.json");
            }
        }

        private static async void ProcessClientConnection(HttpListenerContext context)
        {
            HttpListenerWebSocketContext webSocketContext = await context.AcceptWebSocketAsync(null);
            WebSocket socket = webSocketContext.WebSocket;
            string clientIp = context.Request.RemoteEndPoint?.ToString() ?? "Unknown";
            string currentAlias = "Unknown";
            string currentVoiceChannel = null;
            byte[] receiveBuffer = new byte[16384];

            try
            {
                Console.WriteLine($"[NET] Incoming connection from {clientIp}...");

                // Auth Phase
                WebSocketReceiveResult result = await socket.ReceiveAsync(new ArraySegment<byte>(receiveBuffer), CancellationToken.None);
                using JsonDocument authDoc = JsonDocument.Parse(Encoding.UTF8.GetString(receiveBuffer, 0, result.Count));
                currentAlias = authDoc.RootElement.GetProperty("alias").GetString();

                ActiveClients[currentAlias] = socket;
                Console.WriteLine($"[BOUNCER] User '{currentAlias}' authenticated successfully.");

                // Send History
                if (File.Exists(ChatHistoryFile))
                {
                    Console.WriteLine($"[DATA] Pushing chat history to {currentAlias}...");
                    foreach (var line in File.ReadLines(ChatHistoryFile).TakeLast(50))
                        await socket.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(line)), WebSocketMessageType.Text, true, CancellationToken.None);
                }

                while (socket.State == WebSocketState.Open)
                {
                    WebSocketReceiveResult msgResult = await socket.ReceiveAsync(new ArraySegment<byte>(receiveBuffer), CancellationToken.None);
                    if (msgResult.MessageType == WebSocketMessageType.Close) break;

                    string rawMessage = Encoding.UTF8.GetString(receiveBuffer, 0, msgResult.Count);
                    using JsonDocument incoming = JsonDocument.Parse(rawMessage);
                    string action = incoming.RootElement.GetProperty("action").GetString();

                    if (action == "SEND_CHAT")
                    {
                        string text = incoming.RootElement.GetProperty("message").GetString();
                        Console.WriteLine($"[CHAT] {currentAlias}: {text}");

                        var msg = new { action = "CHAT_RECEIVE", author = currentAlias, time = DateTime.Now.ToString("h:mm tt"), message = text };
                        string json = JsonSerializer.Serialize(msg);
                        await File.AppendAllTextAsync(ChatHistoryFile, json + Environment.NewLine);

                        foreach (var client in ActiveClients.Values)
                            if (client.State == WebSocketState.Open) await client.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(json)), WebSocketMessageType.Text, true, CancellationToken.None);
                    }
                    else if (action == "WEBRTC_SIGNAL")
                    {
                        string target = incoming.RootElement.GetProperty("target").GetString();
                        if (ActiveClients.TryGetValue(target, out WebSocket tSock))
                        {
                            await tSock.SendAsync(new ArraySegment<byte>(receiveBuffer, 0, msgResult.Count), WebSocketMessageType.Text, true, CancellationToken.None);
                            // Log signal type for debugging handshakes
                            using JsonDocument signalDoc = JsonDocument.Parse(rawMessage);
                            string sigType = signalDoc.RootElement.GetProperty("payload").GetProperty("type").GetString();
                            Console.WriteLine($"[SIGNAL] {currentAlias} -> {target} ({sigType})");
                        }
                    }
                    else if (action == "JOIN_VOICE")
                    {
                        string channelId = incoming.RootElement.GetProperty("channelId").GetString();
                        currentVoiceChannel = channelId;

                        if (!ChannelOccupants.ContainsKey(channelId)) ChannelOccupants[channelId] = new List<string>();

                        Console.WriteLine($"[VOICE] {currentAlias} entered channel '{channelId}'");

                        // Trigger Mesh Calls
                        var joinNotice = JsonSerializer.Serialize(new { action = "USER_JOINED_VOICE", alias = currentAlias });
                        foreach (var user in ChannelOccupants[channelId])
                            if (ActiveClients.TryGetValue(user, out WebSocket oSock)) await oSock.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(joinNotice)), WebSocketMessageType.Text, true, CancellationToken.None);

                        ChannelOccupants[channelId].Add(currentAlias);

                        // Sync UI State
                        var stateUpdate = JsonSerializer.Serialize(new { action = "VOICE_STATE_UPDATE", channelId = channelId, users = ChannelOccupants[channelId] });
                        foreach (var user in ChannelOccupants[channelId])
                            if (ActiveClients.TryGetValue(user, out WebSocket oSock)) await oSock.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(stateUpdate)), WebSocketMessageType.Text, true, CancellationToken.None);
                    }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[ERROR] Session for {currentAlias} faulted: {ex.Message}");
            }
            finally
            {
                ActiveClients.TryRemove(currentAlias, out _);
                Console.WriteLine($"[NET] Connection closed for {currentAlias}.");

                if (currentVoiceChannel != null && ChannelOccupants.TryGetValue(currentVoiceChannel, out var users))
                {
                    users.Remove(currentAlias);
                    Console.WriteLine($"[VOICE] {currentAlias} left channel '{currentVoiceChannel}'");

                    var exitUpdate = JsonSerializer.Serialize(new { action = "VOICE_STATE_UPDATE", channelId = currentVoiceChannel, users = users });
                    foreach (var user in users) if (ActiveClients.TryGetValue(user, out WebSocket oSock)) await oSock.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(exitUpdate)), WebSocketMessageType.Text, true, CancellationToken.None);
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