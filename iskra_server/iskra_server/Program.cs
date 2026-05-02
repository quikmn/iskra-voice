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

// [Origin]-[Server]-[Data]-[Config]
namespace Origin.Server.Data
{
    public class Origin_Server_Data_Config
    {
        public ServerSettings Settings { get; set; } = new ServerSettings();
        public List<Channel> Channels { get; set; } = new List<Channel>();
    }

    public class ServerSettings
    {
        public string ServerName { get; set; } = "Origin Primary Node";
        public int Port { get; set; } = 8080;
        public bool RequirePassword { get; set; } = true;
        public string ServerPassword { get; set; } = "bunker_pass_2026";
        public string AdminEmail { get; set; } = "viklun@vlun.onmicrosoft.com";
    }

    public class Channel
    {
        public string Id { get; set; }
        public string Name { get; set; }
        public string Type { get; set; }
    }
}

// [Origin]-[Server]-[Core]-[Main]
namespace Origin.Server.Core
{
    using Origin.Server.Data;

    class Origin_Server_Core_Main
    {
        private static Origin_Server_Data_Config ActiveConfig;
        private const string ConfigPath = "ServerConfig.json";
        private const string ChatHistoryFile = "general-chat.jsonl";

        // UPGRADED: Now maps "Alias" -> "WebSocket" for precise routing
        private static ConcurrentDictionary<string, WebSocket> ActiveClients = new ConcurrentDictionary<string, WebSocket>();

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
                    if (context.Request.IsWebSocketRequest)
                    {
                        ProcessClientConnection(context);
                    }
                    else
                    {
                        context.Response.StatusCode = 400;
                        context.Response.Close();
                    }
                }
            }
            catch (HttpListenerException ex)
            {
                Console.WriteLine($"[FATAL ERROR] Cannot bind to port: {ex.Message}");
                Console.ReadLine();
            }
        }

        private static void LoadOrGenerateConfig()
        {
            if (File.Exists(ConfigPath))
            {
                string json = File.ReadAllText(ConfigPath);
                ActiveConfig = JsonSerializer.Deserialize<Origin_Server_Data_Config>(json);
                Console.WriteLine("[CONFIG] Loaded existing ServerConfig.json");
            }
            else
            {
                ActiveConfig = new Origin_Server_Data_Config();
                ActiveConfig.Channels.Add(new Channel { Id = "c_gen_v", Name = "General", Type = "Voice" });
                ActiveConfig.Channels.Add(new Channel { Id = "c_gen_t", Name = "general-chat", Type = "Text" });

                string json = JsonSerializer.Serialize(ActiveConfig, new JsonSerializerOptions { WriteIndented = true });
                File.WriteAllText(ConfigPath, json);
                Console.WriteLine("[CONFIG] Generated default ServerConfig.json");
            }
        }

        // [Origin]-[Server]-[Net]-[Bouncer]
        private static async void ProcessClientConnection(HttpListenerContext context)
        {
            HttpListenerWebSocketContext webSocketContext = null;
            string clientIp = context.Request.RemoteEndPoint?.ToString() ?? "Unknown IP";
            string currentAlias = "Unknown";

            try
            {
                webSocketContext = await context.AcceptWebSocketAsync(subProtocol: null);
                Console.WriteLine($"[NET] Socket opened from {clientIp}. Verifying...");

                WebSocket socket = webSocketContext.WebSocket;
                byte[] buffer = new byte[1024];

                WebSocketReceiveResult result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
                string authPayload = Encoding.UTF8.GetString(buffer, 0, result.Count);

                using JsonDocument doc = JsonDocument.Parse(authPayload);
                if (doc.RootElement.TryGetProperty("password", out JsonElement passElement) &&
                    doc.RootElement.TryGetProperty("alias", out JsonElement aliasElement))
                {
                    string providedPassword = passElement.GetString();
                    currentAlias = aliasElement.GetString();

                    if (ActiveConfig.Settings.RequirePassword && providedPassword != ActiveConfig.Settings.ServerPassword)
                    {
                        Console.WriteLine($"[BOUNCER] Kick: Invalid password from {clientIp}");
                        await socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, "Invalid Password", CancellationToken.None);
                        return;
                    }

                    // Enforce unique aliases by rejecting if already exists, or just overwrite. We will overwrite for ease of testing.
                    ActiveClients[currentAlias] = socket;
                    Console.WriteLine($"[BOUNCER] Success: User '{currentAlias}' entered the bunker. Total clients: {ActiveClients.Count}");

                    if (File.Exists(ChatHistoryFile))
                    {
                        var historyLines = File.ReadLines(ChatHistoryFile).TakeLast(50);
                        foreach (var line in historyLines)
                        {
                            byte[] histBytes = Encoding.UTF8.GetBytes(line);
                            await socket.SendAsync(new ArraySegment<byte>(histBytes), WebSocketMessageType.Text, true, CancellationToken.None);
                        }
                    }

                    byte[] receiveBuffer = new byte[8192]; // Increased buffer size for larger WebRTC SDP payloads
                    try
                    {
                        while (socket.State == WebSocketState.Open)
                        {
                            WebSocketReceiveResult msgResult = await socket.ReceiveAsync(new ArraySegment<byte>(receiveBuffer), CancellationToken.None);
                            if (msgResult.MessageType == WebSocketMessageType.Close) break;

                            string rawMessage = Encoding.UTF8.GetString(receiveBuffer, 0, msgResult.Count);

                            using JsonDocument incoming = JsonDocument.Parse(rawMessage);
                            if (incoming.RootElement.TryGetProperty("action", out JsonElement action))
                            {
                                string actionStr = action.GetString();

                                // ROUTE: TEXT CHAT (Broadcast)
                                if (actionStr == "SEND_CHAT")
                                {
                                    string text = incoming.RootElement.GetProperty("message").GetString();
                                    Console.WriteLine($"[{currentAlias} -> c_gen_t]: {text}");

                                    var outboundMsg = new
                                    {
                                        action = "CHAT_RECEIVE",
                                        author = currentAlias,
                                        time = DateTime.Now.ToString("h:mm tt"),
                                        message = text
                                    };
                                    string outboundJson = JsonSerializer.Serialize(outboundMsg);
                                    byte[] outboundBytes = Encoding.UTF8.GetBytes(outboundJson);

                                    await File.AppendAllTextAsync(ChatHistoryFile, outboundJson + Environment.NewLine);

                                    foreach (var client in ActiveClients.Values)
                                    {
                                        if (client.State == WebSocketState.Open)
                                        {
                                            await client.SendAsync(new ArraySegment<byte>(outboundBytes), WebSocketMessageType.Text, true, CancellationToken.None);
                                        }
                                    }
                                }
                                // ROUTE: WEBRTC SIGNALING (Targeted)
                                else if (actionStr == "WEBRTC_SIGNAL")
                                {
                                    if (incoming.RootElement.TryGetProperty("target", out JsonElement targetElement))
                                    {
                                        string targetAlias = targetElement.GetString();

                                        // If the target is online, forward the raw packet straight to them
                                        if (ActiveClients.TryGetValue(targetAlias, out WebSocket targetSocket) && targetSocket.State == WebSocketState.Open)
                                        {
                                            // We forward the exact buffer we just received. No need to reconstruct it.
                                            await targetSocket.SendAsync(new ArraySegment<byte>(receiveBuffer, 0, msgResult.Count), WebSocketMessageType.Text, true, CancellationToken.None);
                                            Console.WriteLine($"[SIGNAL] Routed packet from {currentAlias} to {targetAlias}");
                                        }
                                    }
                                }
                            }
                        }
                    }
                    finally
                    {
                        ActiveClients.TryRemove(currentAlias, out _);
                        await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Disconnected", CancellationToken.None);
                        Console.WriteLine($"[NET] User '{currentAlias}' disconnected. Active users: {ActiveClients.Count}");
                    }
                }
                else
                {
                    await socket.CloseAsync(WebSocketCloseStatus.InvalidMessageType, "Malformed Auth", CancellationToken.None);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[ERROR] Connection failed: {ex.Message}");
            }
        }
    }
}