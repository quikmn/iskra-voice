using System;
using System.IO;
using System.IO.Compression;
using System.IO.Pipes;
using System.Net;
using System.Net.Http;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace Origin.Client.Core
{
    public class Origin_Client_Core_Main : Form
    {
        // ── Win32 PTT hook + dev console ───────────────────────────────────────
        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int vKey);

        // ── DWM title bar theming ──────────────────────────────────────────────
        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

        private const int DWMWA_CAPTION_COLOR = 35;
        private const int DWMWA_TEXT_COLOR    = 36;

        private void SetTitleBarColor(string hex)
        {
            try
            {
                hex = hex.TrimStart('#');
                if (hex.Length != 6) return;
                int r = Convert.ToInt32(hex.Substring(0, 2), 16);
                int g = Convert.ToInt32(hex.Substring(2, 2), 16);
                int b = Convert.ToInt32(hex.Substring(4, 2), 16);
                int colorRef = r | (g << 8) | (b << 16);
                DwmSetWindowAttribute(this.Handle, DWMWA_CAPTION_COLOR, ref colorRef, sizeof(int));
                double lum = 0.2126 * r / 255.0 + 0.7152 * g / 255.0 + 0.0722 * b / 255.0;
                int textColor = lum < 0.5 ? 0x00FFFFFF : 0x00000000;
                DwmSetWindowAttribute(this.Handle, DWMWA_TEXT_COLOR, ref textColor, sizeof(int));
            }
            catch { }
        }

        private static readonly string _logFile = Path.Combine(
            Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location) ?? ".", "client.log");
        private static readonly object _logLock = new();

        private static void CLog(string cat, string msg)
        {
            var line = $"[{DateTime.Now:HH:mm:ss.fff}][{cat,-8}] {msg}";
            lock (_logLock)
            {
                try { File.AppendAllText(_logFile, line + Environment.NewLine); } catch { }
            }
        }

        private static readonly HttpClient _http = new HttpClient();

        private int    _pttVkCode    = 0x5A;  // default: 'Z'
        private bool   _isPttMode    = false;
        private bool   _pttWasDown   = false;
        private System.Threading.Timer _pttPollTimer;
        private NotifyIcon _trayIcon;
        private bool _isQuitting = false;
        private string _pendingInviteUrl = null;
        private string _appVersion = "dev";

        // ── Server connection tracking ──────────────────────────────────────────
        private string _serverHost = null;
        private int    _serverPort = 0;
        private readonly Dictionary<string, ClientWebSocket> _serverConnections = new();

        // ── WebView ─────────────────────────────────────────────────────────────
        private WebView2 webView;

        public Origin_Client_Core_Main(string pendingInviteUrl = null)
        {
            _pendingInviteUrl = pendingInviteUrl;
            InitializeWindow();
            InitializeWebView();
            RegisterIskraProtocol();
            _ = Task.Run(RunInvitePipeServer);
        }

        private void RegisterIskraProtocol()
        {
            try
            {
                string exePath = System.Diagnostics.Process.GetCurrentProcess().MainModule?.FileName ?? "";
                if (string.IsNullOrEmpty(exePath)) return;
                using var key    = Registry.CurrentUser.CreateSubKey(@"SOFTWARE\Classes\iskra");
                key.SetValue("", "URL:Iskra");
                key.SetValue("URL Protocol", "");
                using var cmdKey = key.CreateSubKey(@"shell\open\command");
                cmdKey.SetValue("", $"\"{exePath}\" \"%1\"");
            }
            catch { }
        }

        private async Task RunInvitePipeServer()
        {
            while (!_isQuitting)
            {
                try
                {
                    using var pipe = new NamedPipeServerStream("IskraClientInvite", PipeDirection.In, 1,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
                    await pipe.WaitForConnectionAsync();
                    using var reader = new StreamReader(pipe);
                    string url = await reader.ReadLineAsync();
                    if (!string.IsNullOrEmpty(url))
                        HandleInviteUrl(url);
                }
                catch { }
            }
        }

        private void HandleInviteUrl(string url)
        {
            if (string.IsNullOrEmpty(url)) return;
            try
            {
                this.Invoke((MethodInvoker)(() =>
                {
                    Show();
                    WindowState = FormWindowState.Normal;
                    Activate();
                    if (webView?.CoreWebView2 != null)
                        webView.CoreWebView2.PostWebMessageAsString(
                            JsonSerializer.Serialize(new { action = "HANDLE_INVITE_LINK", url }));
                    else
                        _pendingInviteUrl = url;
                }));
            }
            catch { }
        }

        private void PostResumeAudio()
        {
            try
            {
                if (webView?.CoreWebView2 == null) return;
                webView.CoreWebView2.PostWebMessageAsString(
                    JsonSerializer.Serialize(new { action = "RESUME_AUDIO" }));
            }
            catch { }
        }

        private void InitializeWindow()
        {
            string verFile = Path.Combine(Application.StartupPath, "version.txt");
            if (File.Exists(verFile)) _appVersion = File.ReadAllText(verFile).Trim();

            this.Text          = $"Iskra {_appVersion}";
            this.Width         = 1200;
            this.Height        = 800;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor     = System.Drawing.Color.FromArgb(32, 34, 37);
            this.Load         += (s, e) => SetTitleBarColor("#1e1e2e");
            this.LocationChanged += (s, e) => PostResumeAudio();
            this.SizeChanged     += (s, e) => PostResumeAudio();
            this.Activated       += (s, e) => PostResumeAudio();

            string icoPath = Path.Combine(Application.StartupPath, "iskra.ico");
            if (File.Exists(icoPath))
                this.Icon = new System.Drawing.Icon(icoPath);

            webView      = new WebView2();
            webView.Dock = DockStyle.Fill;
            this.Controls.Add(webView);

            InitializeTray();
        }

        private void InitializeTray()
        {
            string icoPath2 = Path.Combine(Application.StartupPath, "iskra.ico");
            _trayIcon = new NotifyIcon
            {
                Icon    = File.Exists(icoPath2) ? new System.Drawing.Icon(icoPath2) : SystemIcons.Application,
                Text    = $"Iskra {_appVersion}",
                Visible = true
            };
            var menu = new ContextMenuStrip();
            menu.Items.Add("Open Iskra", null, (s, e) => { Show(); WindowState = FormWindowState.Normal; Activate(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Check for updates", null, (s, e) =>
            {
                Show(); WindowState = FormWindowState.Normal; Activate();
                try { webView?.CoreWebView2?.PostWebMessageAsString(
                    JsonSerializer.Serialize(new { action = "CHECK_UPDATE_MANUAL" })); } catch { }
            });
            menu.Items.Add("About Iskra", null, (s, e) =>
            {
                MessageBox.Show(
                    $"Iskra Voice Client\nVersion: {_appVersion}\n\ngithub.com/quikmn/iskra-voice",
                    "About Iskra", MessageBoxButtons.OK, MessageBoxIcon.None);
            });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quit",  null, (s, e) => { _isQuitting = true; Application.Exit(); });
            _trayIcon.ContextMenuStrip = menu;
            _trayIcon.DoubleClick += (s, e) => { Show(); WindowState = FormWindowState.Normal; Activate(); };
        }

        private async void InitializeWebView()
        {
            CLog("WEBVIEW", "Initializing WebView2 environment...");
            var opts = new CoreWebView2EnvironmentOptions();
            opts.AdditionalBrowserArguments = "--autoplay-policy=no-user-gesture-required --allow-running-insecure-content --disable-features=MixedContentAutoupgrade --disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows";
            var env = await CoreWebView2Environment.CreateAsync(
                null, Path.Combine(Path.GetTempPath(), "Origin_WebView2_Data"), opts);
            await webView.EnsureCoreWebView2Async(env);
            CLog("WEBVIEW", $"WebView2 ready | version: {webView.CoreWebView2.Environment.BrowserVersionString}");

#if DEBUG
            webView.CoreWebView2.Settings.AreDevToolsEnabled = true;
#else
            webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
#endif

            webView.CoreWebView2.PermissionRequested += (s, e) =>
            {
                if (e.PermissionKind == CoreWebView2PermissionKind.Microphone)
                {
                    e.State = CoreWebView2PermissionState.Allow;
                    CLog("WEBVIEW", "Mic permission auto-granted");
                }
            };

            string startupFolder = Application.StartupPath;
            string indexPath = Path.Combine(startupFolder, "index.html");
            if (File.Exists(indexPath))
            {
                webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    "origin.app", startupFolder, CoreWebView2HostResourceAccessKind.Allow);
                CLog("WEBVIEW", $"Virtual host mapped: https://origin.app → {startupFolder}");
                webView.CoreWebView2.Navigate("https://origin.app/index.html");
            }
            else webView.CoreWebView2.NavigateToString("<h1>index.html not found!</h1>");

            webView.CoreWebView2.NavigationCompleted += (s, e) =>
            {
                Task.Delay(500).ContinueWith(_ =>
                {
                    try { this.Invoke((MethodInvoker)(() =>
                        webView.CoreWebView2.PostWebMessageAsString(
                            JsonSerializer.Serialize(new { action = "APP_VERSION", version = _appVersion })))); }
                    catch { }
                });

                if (_pendingInviteUrl == null) return;
                var url = _pendingInviteUrl;
                _pendingInviteUrl = null;
                Task.Delay(400).ContinueWith(_ =>
                {
                    try { this.Invoke((MethodInvoker)(() =>
                        webView.CoreWebView2.PostWebMessageAsString(
                            JsonSerializer.Serialize(new { action = "HANDLE_INVITE_LINK", url })))); }
                    catch { }
                });
            };

            webView.CoreWebView2.WebMessageReceived += Origin_Client_Bridge_Listener;

            _pttPollTimer = new System.Threading.Timer(PollPttState, null, 10, 10);
            CLog("PTT", $"Poll started at 10ms | default key: {(char)_pttVkCode} (0x{_pttVkCode:X2})");
            CLog("INFO", "F12 = DevTools | F9 in app = JS log panel | Use Settings → Servers to connect");
        }

        // ── Per-server localhost HTTP proxies (avoids WebView2 mixed-content blocks) ──
        // Each server connection gets its own listener on its own random port so multiple
        // servers (e.g. host:8080, host:8181, host:9999) can coexist without clobbering each other.
        private readonly Dictionary<string, HttpListener> _serverProxies      = new();
        private readonly Dictionary<string, int>          _serverProxyPorts   = new();
        private readonly Dictionary<string, string>       _serverProxyTargets = new();

        private static int GetFreePort()
        {
            using var l = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
            l.Start();
            int p = ((System.Net.IPEndPoint)l.LocalEndpoint).Port;
            l.Stop();
            return p;
        }

        private void StartServerProxy(string serverId, string targetBase)
        {
            StopServerProxy(serverId);
            int proxyPort = GetFreePort();
            var listener  = new HttpListener();
            listener.Prefixes.Add($"http://localhost:{proxyPort}/");
            listener.Start();
            _serverProxies[serverId]      = listener;
            _serverProxyPorts[serverId]   = proxyPort;
            _serverProxyTargets[serverId] = targetBase;
            string tag = serverId.Length > 8 ? serverId[..8] : serverId;
            CLog("PROXY", $"[{tag}] localhost:{proxyPort} → {targetBase}");
            _ = Task.Run(() => RunServerProxy(serverId, listener));
        }

        private void StopServerProxy(string serverId)
        {
            if (_serverProxies.TryGetValue(serverId, out var listener))
            {
                try { listener.Close(); } catch { }
                _serverProxies.Remove(serverId);
                _serverProxyPorts.Remove(serverId);
                _serverProxyTargets.Remove(serverId);
            }
        }

        private async Task RunServerProxy(string serverId, HttpListener listener)
        {
            while (listener.IsListening)
            {
                try
                {
                    var ctx = await listener.GetContextAsync();
                    _ = Task.Run(() => HandleServerProxyRequest(serverId, ctx));
                }
                catch { break; }
            }
        }

        // Headers managed by HttpClient — never forward these
        private static readonly HashSet<string> _skipHeaders = new(StringComparer.OrdinalIgnoreCase)
            { "Host", "Content-Length", "Transfer-Encoding", "Connection", "Keep-Alive",
              "TE", "Trailer", "Upgrade", "Content-Type" };

        private async Task HandleServerProxyRequest(string serverId, HttpListenerContext ctx)
        {
            try
            {
                if (ctx.Request.HttpMethod == "OPTIONS")
                {
                    ctx.Response.StatusCode = 204;
                    ctx.Response.AddHeader("Access-Control-Allow-Origin",  "*");
                    ctx.Response.AddHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
                    ctx.Response.AddHeader("Access-Control-Allow-Headers", "*");
                    ctx.Response.AddHeader("Access-Control-Max-Age",       "86400");
                    ctx.Response.Close();
                    return;
                }

                if (!_serverProxyTargets.TryGetValue(serverId, out var target) || string.IsNullOrEmpty(target))
                {
                    ctx.Response.StatusCode = 503;
                    ctx.Response.Close();
                    return;
                }

                string path = ctx.Request.Url?.PathAndQuery ?? "/";
                using var req = new HttpRequestMessage(new HttpMethod(ctx.Request.HttpMethod), target + path);

                foreach (string key in ctx.Request.Headers.AllKeys ?? [])
                {
                    if (_skipHeaders.Contains(key)) continue;
                    string val = ctx.Request.Headers[key] ?? "";
                    req.Headers.TryAddWithoutValidation(key, val);
                }

                if (ctx.Request.HasEntityBody)
                {
                    var ms = new MemoryStream();
                    await ctx.Request.InputStream.CopyToAsync(ms);
                    ms.Position = 0;
                    req.Content = new StreamContent(ms);
                    if (ctx.Request.ContentType is string ctype)
                        req.Content.Headers.TryAddWithoutValidation("Content-Type", ctype);
                }

                using var resp = await _http.SendAsync(req);
                byte[] body = await resp.Content.ReadAsByteArrayAsync();

                ctx.Response.StatusCode = (int)resp.StatusCode;
                ctx.Response.AddHeader("Access-Control-Allow-Origin",  "*");
                ctx.Response.AddHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
                ctx.Response.AddHeader("Access-Control-Allow-Headers", "*");
                if (resp.Content.Headers.ContentType?.ToString() is string ct)
                    ctx.Response.ContentType = ct;
                ctx.Response.ContentLength64 = body.Length;
                await ctx.Response.OutputStream.WriteAsync(body);
            }
            catch { try { ctx.Response.StatusCode = 502; } catch { } }
            finally { try { ctx.Response.Close(); } catch { } }
        }

        // ── PTT polling (threadpool thread) ────────────────────────────────────
        private void PollPttState(object _)
        {
            if (!_isPttMode) return;

            bool isDown = (GetAsyncKeyState(_pttVkCode) & 0x8000) != 0;
            if (isDown == _pttWasDown) return;
            _pttWasDown = isDown;

            CLog("PTT", $"Key {(isDown ? "DOWN ▶" : "UP   ◼")} | vk:0x{_pttVkCode:X2}");
            string msg = JsonSerializer.Serialize(new { action = "PTT_STATE", isActive = isDown });
            try
            {
                this.Invoke((MethodInvoker)(() =>
                    webView.CoreWebView2.PostWebMessageAsString(msg)));
            }
            catch { /* form is closing */ }
        }

        private static string GetMachineGuid()
        {
            try
            {
                using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography");
                return key?.GetValue("MachineGuid")?.ToString() ?? "";
            }
            catch { return ""; }
        }

        // ── Server connection (per-server, multi-server capable) ───────────────
        private async Task ConnectToServer(string serverId, string host, int port, string password, string alias, string adminPassword = "", string userPassword = "")
        {
            string tag = serverId.Length > 8 ? serverId[..8] : serverId;
            if (_serverConnections.TryGetValue(serverId, out var existing))
            {
                if (existing.State == WebSocketState.Open) { CLog("WS", $"[{tag}] Already connected"); return; }
                try { existing.Abort(); } catch { }
                _serverConnections.Remove(serverId);
            }

            var ws = new ClientWebSocket();
            _serverConnections[serverId] = ws;
            try
            {
                var scheme = port == 443 || port == 8443 ? "wss" : "ws";
                var uri = new Uri($"{scheme}://{host}:{port}/");
                CLog("WS", $"[{tag}] Connecting to {uri} as '{alias}'...");
                await ws.ConnectAsync(uri, CancellationToken.None);
                CLog("WS", $"[{tag}] Connected");

                var machineGuid = GetMachineGuid();
                var auth = new { password, alias, machineGuid, adminPassword, userPassword };
                await ws.SendAsync(
                    new ArraySegment<byte>(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(auth))),
                    WebSocketMessageType.Text, true, CancellationToken.None);
                CLog("WS", $"[{tag}] Auth sent | alias:{alias} guid:{(machineGuid.Length > 8 ? machineGuid[..8] + "…" : machineGuid)}");

                _ = Task.Run(() => ListenForServerMessages(serverId, ws));
            }
            catch (Exception ex)
            {
                _serverConnections.Remove(serverId);
                CLog("ERR", $"[{tag}] Connection failed: {ex.Message}");
                PostToJsForServer(serverId, new { action = "DISCONNECTED" });
            }
        }

        private async Task ListenForServerMessages(string serverId, ClientWebSocket ws)
        {
            string tag       = serverId.Length > 8 ? serverId[..8] : serverId;
            byte[] buf       = new byte[16384];
            var    msgStream = new MemoryStream(65536);
            while (ws.State == WebSocketState.Open)
            {
                try
                {
                    msgStream.SetLength(0);
                    WebSocketReceiveResult result;
                    do
                    {
                        result = await ws.ReceiveAsync(new ArraySegment<byte>(buf), CancellationToken.None);
                        msgStream.Write(buf, 0, result.Count);
                    } while (!result.EndOfMessage);

                    if (result.MessageType == WebSocketMessageType.Text)
                    {
                        string msg = Encoding.UTF8.GetString(msgStream.GetBuffer(), 0, (int)msgStream.Length);
                        PostToJsForServer(serverId, msg);
                    }
                }
                catch { break; }
            }
            _serverConnections.Remove(serverId);
            StopServerProxy(serverId);
            if (_serverHost != null) { _serverHost = null; _serverPort = 0; }
            CLog("WS", $"[{tag}] Receive loop exited — sending DISCONNECTED to JS");
            PostToJsForServer(serverId, new { action = "DISCONNECTED" });
        }

        private void PostToJs(object obj)
        {
            try
            {
                string json = JsonSerializer.Serialize(obj);
                this.Invoke((MethodInvoker)(() =>
                    webView?.CoreWebView2?.PostWebMessageAsString(json)));
            }
            catch { }
        }

        // Injects __serverId into a JSON payload and posts to JS bridge
        private void PostToJsForServer(string serverId, string json)
        {
            try
            {
                using var doc = JsonDocument.Parse(json);
                using var ms  = new MemoryStream();
                using (var w  = new Utf8JsonWriter(ms))
                {
                    w.WriteStartObject();
                    w.WriteString("__serverId", serverId);
                    foreach (var prop in doc.RootElement.EnumerateObject())
                        prop.WriteTo(w);
                    w.WriteEndObject();
                }
                string wrapped = Encoding.UTF8.GetString(ms.ToArray());
                this.Invoke((MethodInvoker)(() =>
                    webView?.CoreWebView2?.PostWebMessageAsString(wrapped)));
            }
            catch { }
        }

        private void PostToJsForServer(string serverId, object obj) =>
            PostToJsForServer(serverId, JsonSerializer.Serialize(obj));

        private async Task DoInstallUpdate(string downloadUrl)
        {
            string? tempZip = null;
            try
            {
                // Download here in the client so JS can see real progress before we exit.
                string tempDir = Path.Combine(Path.GetTempPath(), "IskraUpdate_" + Guid.NewGuid().ToString("N")[..8]);
                Directory.CreateDirectory(tempDir);
                tempZip = Path.Combine(tempDir, "Iskra-Client.zip");

                var req = new HttpRequestMessage(HttpMethod.Get, downloadUrl);
                req.Headers.TryAddWithoutValidation("User-Agent", "IskraClient/1.0");
                using var resp = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
                resp.EnsureSuccessStatusCode();

                long total = resp.Content.Headers.ContentLength ?? 0;
                long done  = 0;
                byte[] buf = new byte[65536];

                await using (var fs = new FileStream(tempZip, FileMode.Create, FileAccess.Write, FileShare.None, 65536, true))
                await using (var stream = await resp.Content.ReadAsStreamAsync())
                {
                    int read;
                    int lastPct = -1;
                    while ((read = await stream.ReadAsync(buf)) > 0)
                    {
                        await fs.WriteAsync(buf.AsMemory(0, read));
                        done += read;
                        if (total > 0)
                        {
                            int pct = (int)(done * 100L / total);
                            if (pct != lastPct) { PostToJs(new { action = "UPDATE_PROGRESS", phase = "downloading", pct }); lastPct = pct; }
                        }
                    }
                }

                PostToJs(new { action = "UPDATE_PROGRESS", phase = "restarting", pct = 100 });
                await Task.Delay(400);

                // Hand the pre-downloaded zip path to the launcher — it just needs to extract + swap files.
                using var pipe = new NamedPipeClientStream(".", "IskraLauncherUpdate", PipeDirection.Out);
                await pipe.ConnectAsync(3000);
                using var writer = new StreamWriter(pipe, Encoding.UTF8, leaveOpen: false);
                await writer.WriteAsync(JsonSerializer.Serialize(new { url = downloadUrl, localZip = tempZip }));
                await writer.FlushAsync();

                await Task.Delay(200);
                this.Invoke((MethodInvoker)(() => { _isQuitting = true; Application.Exit(); }));
            }
            catch (Exception ex)
            {
                if (tempZip != null) try { File.Delete(tempZip); Directory.Delete(Path.GetDirectoryName(tempZip)!); } catch { }
                PostToJs(new { action = "UPDATE_ERROR", message = ex.Message });
            }
        }

        // ── Bridge listener (JS → C#) ───────────────────────────────────────────
        private async void Origin_Client_Bridge_Listener(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string json = e.TryGetWebMessageAsString();

            // Intercept local-only config messages before forwarding to server
            try
            {
                using var doc = JsonDocument.Parse(json);
                string action = doc.RootElement.GetProperty("action").GetString();

                if (action == "NOTIFY")
                {
                    var title = doc.RootElement.TryGetProperty("title", out var tEl) ? tEl.GetString() ?? "" : "";
                    var body  = doc.RootElement.TryGetProperty("body",  out var bEl) ? bEl.GetString()  ?? "" : "";
                    try { this.Invoke((MethodInvoker)(() => _trayIcon?.ShowBalloonTip(4000, title, body, ToolTipIcon.None))); } catch { }
                    return;
                }
                if (action == "QUIT")
                {
                    _isQuitting = true;
                    try { this.Invoke((MethodInvoker)(() => Application.Exit())); } catch { }
                    return;
                }
                if (action == "CONNECT_SERVER")
                {
                    var sid           = doc.RootElement.GetProperty("serverId").GetString();
                    var host          = doc.RootElement.GetProperty("host").GetString();
                    var port          = doc.RootElement.GetProperty("port").GetInt32();
                    // nativePort: the server's direct HTTP/WS port (may differ from 'port' when connecting via nginx on 443)
                    var nativePort    = doc.RootElement.TryGetProperty("nativePort", out JsonElement npEl) ? npEl.GetInt32() : port;
                    var alias         = doc.RootElement.GetProperty("alias").GetString();
                    var password      = doc.RootElement.TryGetProperty("password",      out JsonElement pwEl) ? pwEl.GetString() ?? "" : "";
                    var adminPassword = doc.RootElement.TryGetProperty("adminPassword", out JsonElement apEl) ? apEl.GetString() ?? "" : "";
                    var userPassword  = doc.RootElement.TryGetProperty("userPassword",  out JsonElement upEl) ? upEl.GetString() ?? "" : "";
                    _serverHost = host;
                    _serverPort = port;
                    StartServerProxy(sid, $"http://{host}:{nativePort}");
                    PostToJsForServer(sid, new { action = "LOCAL_PROXY_PORT", port = _serverProxyPorts[sid] });
                    CLog("BRIDGE", $"← JS | CONNECT_SERVER host:{host}:{port}(http:{nativePort}) alias:{alias} sid:{sid[..Math.Min(8,sid.Length)]}");
                    _ = Task.Run(() => ConnectToServer(sid, host, port, password, alias, adminPassword, userPassword));
                    return;
                }
                if (action == "DISCONNECT_SERVER")
                {
                    var sid2 = doc.RootElement.GetProperty("serverId").GetString();
                    if (_serverConnections.TryGetValue(sid2, out var wsToClose))
                    {
                        _serverConnections.Remove(sid2);
                        try { wsToClose.Abort(); } catch { }
                    }
                    StopServerProxy(sid2);
                    _serverHost = null; _serverPort = 0;
                    CLog("BRIDGE", $"← JS | DISCONNECT_SERVER sid:{sid2[..Math.Min(8,sid2.Length)]}");
                    return;
                }
                if (action == "START_PROXY")
                {
                    var proxyHost = doc.RootElement.GetProperty("host").GetString();
                    var proxyPort = doc.RootElement.GetProperty("port").GetInt32();
                    var sid       = doc.RootElement.GetProperty("serverId").GetString();
                    _serverHost = proxyHost;
                    _serverPort = proxyPort;
                    StartServerProxy(sid, $"http://{proxyHost}:{proxyPort}");
                    PostToJs(new { action = "LOCAL_PROXY_PORT", serverId = sid, port = _serverProxyPorts[sid] });
                    CLog("BRIDGE", $"← JS (local) | START_PROXY host:{proxyHost}:{proxyPort} sid:{sid[..Math.Min(8,sid.Length)]}");
                    return;
                }
                if (action == "UPDATE_PROXY_TARGET")
                {
                    var proxyServerId = doc.RootElement.TryGetProperty("serverId", out JsonElement psEl) ? psEl.GetString() : null;
                    var proxyHost     = doc.RootElement.GetProperty("host").GetString();
                    var proxyPort     = doc.RootElement.GetProperty("port").GetInt32();
                    string newTarget  = $"http://{proxyHost}:{proxyPort}";
                    if (proxyServerId != null && _serverProxyTargets.ContainsKey(proxyServerId))
                        _serverProxyTargets[proxyServerId] = newTarget;
                    string ptag = proxyServerId != null && proxyServerId.Length > 8 ? proxyServerId[..8] : proxyServerId ?? "?";
                    CLog("PROXY", $"[{ptag}] Target → {newTarget}");
                    return;
                }
                if (action == "STOP_PROXY")
                {
                    var spSid = doc.RootElement.TryGetProperty("serverId", out JsonElement spEl) ? spEl.GetString() : null;
                    if (spSid != null) StopServerProxy(spSid);
                    _serverHost = null;
                    _serverPort = 0;
                    CLog("BRIDGE", "← JS (local) | STOP_PROXY");
                    return;
                }
                if (action == "SET_PTT_KEY")
                {
                    _pttVkCode = doc.RootElement.GetProperty("keyCode").GetInt32();
                    CLog("BRIDGE", $"← JS (local) | SET_PTT_KEY keyCode:{_pttVkCode} (0x{_pttVkCode:X2})");
                    return;
                }
                if (action == "SET_VOICE_MODE")
                {
                    var mode = doc.RootElement.GetProperty("mode").GetString();
                    _isPttMode  = mode == "ptt";
                    if (!_isPttMode) _pttWasDown = false;
                    CLog("BRIDGE", $"← JS (local) | SET_VOICE_MODE mode:{mode} | pttActive:{_isPttMode}");
                    return;
                }
                if (action == "SET_TITLE_COLOR")
                {
                    var hex = doc.RootElement.TryGetProperty("hex", out var hexEl) ? hexEl.GetString() ?? "" : "";
                    if (!string.IsNullOrEmpty(hex))
                        try { this.Invoke((MethodInvoker)(() => SetTitleBarColor(hex))); } catch { }
                    return;
                }
                if (action == "LOG")
                {
                    var cat = doc.RootElement.TryGetProperty("cat", out var catEl) ? catEl.GetString() ?? "JS" : "JS";
                    var logMsg = doc.RootElement.TryGetProperty("msg", out var msgEl) ? msgEl.GetString() ?? "" : "";
                    CLog($"JS:{cat,-5}", logMsg);
                    return;
                }
                if (action == "STORE_DM_KEY")
                {
                    var dkAlias  = doc.RootElement.TryGetProperty("alias",    out var dkaEl) ? dkaEl.GetString() ?? "" : "";
                    var dkSid    = doc.RootElement.TryGetProperty("serverId", out var dksEl) ? dksEl.GetString() ?? "" : "";
                    var dkBlob   = doc.RootElement.TryGetProperty("blob",     out var dkbEl) ? dkbEl.GetString() ?? "" : "";
                    if (!string.IsNullOrEmpty(dkAlias) && !string.IsNullOrEmpty(dkBlob))
                    {
                        var keyDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Iskra", "DmKeys");
                        Directory.CreateDirectory(keyDir);
                        var safeName = string.Concat($"{dkAlias}_{dkSid}".Select(c => Path.GetInvalidFileNameChars().Contains(c) ? '_' : c)) + ".ikkey";
                        File.WriteAllText(Path.Combine(keyDir, safeName), dkBlob);
                        CLog("BRIDGE", $"← JS | STORE_DM_KEY alias:{dkAlias}");
                    }
                    return;
                }
                if (action == "LOAD_DM_KEY")
                {
                    var dkAlias2 = doc.RootElement.TryGetProperty("alias",    out var dka2El) ? dka2El.GetString() ?? "" : "";
                    var dkSid2   = doc.RootElement.TryGetProperty("serverId", out var dks2El) ? dks2El.GetString() ?? "" : "";
                    var keyDir2  = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Iskra", "DmKeys");
                    var safeName2 = string.Concat($"{dkAlias2}_{dkSid2}".Select(c => Path.GetInvalidFileNameChars().Contains(c) ? '_' : c)) + ".ikkey";
                    var keyPath2  = Path.Combine(keyDir2, safeName2);
                    var blob2    = File.Exists(keyPath2) ? File.ReadAllText(keyPath2) : null;
                    var resp2    = System.Text.Json.JsonSerializer.Serialize(new { action = "DM_KEY_LOADED", alias = dkAlias2, serverId = dkSid2, blob = blob2 });
                    try { this.Invoke((MethodInvoker)(() => webView?.CoreWebView2?.PostWebMessageAsString(resp2))); } catch { }
                    CLog("BRIDGE", $"← JS | LOAD_DM_KEY alias:{dkAlias2} found:{blob2 != null}");
                    return;
                }
                if (action == "DELETE_DM_KEY")
                {
                    var dkAlias3 = doc.RootElement.TryGetProperty("alias",    out var dka3El) ? dka3El.GetString() ?? "" : "";
                    var dkSid3   = doc.RootElement.TryGetProperty("serverId", out var dks3El) ? dks3El.GetString() ?? "" : "";
                    var keyDir3  = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Iskra", "DmKeys");
                    var safeName3 = string.Concat($"{dkAlias3}_{dkSid3}".Select(c => Path.GetInvalidFileNameChars().Contains(c) ? '_' : c)) + ".ikkey";
                    var keyPath3  = Path.Combine(keyDir3, safeName3);
                    if (File.Exists(keyPath3)) File.Delete(keyPath3);
                    CLog("BRIDGE", $"← JS | DELETE_DM_KEY alias:{dkAlias3}");
                    return;
                }
                if (action == "OPEN_URL")
                {
                    var url = doc.RootElement.TryGetProperty("url", out var urlEl) ? urlEl.GetString() ?? "" : "";
                    if (!string.IsNullOrEmpty(url) && (url.StartsWith("https://") || url.StartsWith("http://")))
                        try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
                    return;
                }
                if (action == "INSTALL_UPDATE")
                {
                    var dlUrl = doc.RootElement.TryGetProperty("url", out var dlEl) ? dlEl.GetString() ?? "" : "";
                    if (!string.IsNullOrEmpty(dlUrl))
                        _ = Task.Run(() => DoInstallUpdate(dlUrl));
                    return;
                }
            }
            catch { /* malformed JSON — fall through */ }

            // Route JS→server messages: JS embeds __serverId to identify target server
            try
            {
                using var routeDoc = JsonDocument.Parse(json);
                if (routeDoc.RootElement.TryGetProperty("__serverId", out var sidProp))
                {
                    string targetSid = sidProp.GetString();
                    if (targetSid != null && _serverConnections.TryGetValue(targetSid, out var targetWs) && targetWs.State == WebSocketState.Open)
                    {
                        // Strip __serverId before forwarding to server
                        using var ms = new MemoryStream();
                        using (var jw = new Utf8JsonWriter(ms))
                        {
                            jw.WriteStartObject();
                            foreach (var prop in routeDoc.RootElement.EnumerateObject())
                                if (prop.Name != "__serverId") prop.WriteTo(jw);
                            jw.WriteEndObject();
                        }
                        byte[] cleanBytes = ms.ToArray();
                        CLog("BRIDGE", $"← JS → srv[{targetSid[..Math.Min(8,targetSid.Length)]}] | {(json.Length > 80 ? json[..80] + "…" : json)}");
                        await targetWs.SendAsync(new ArraySegment<byte>(cleanBytes), WebSocketMessageType.Text, true, CancellationToken.None);
                    }
                }
            }
            catch { }
        }

        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            if (keyData == Keys.F12) { webView.CoreWebView2.OpenDevToolsWindow(); return true; }
            return base.ProcessCmdKey(ref msg, keyData);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!_isQuitting)
            {
                e.Cancel = true;
                Hide();
            }
            base.OnFormClosing(e);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            _pttPollTimer?.Dispose();
            _trayIcon?.Dispose();
            base.OnFormClosed(e);
        }

        [STAThread]
        static void Main()
        {
            string[] cmdArgs = Environment.GetCommandLineArgs();
            string inviteUrl  = cmdArgs.Length > 1 && cmdArgs[1].StartsWith("iskra://", StringComparison.OrdinalIgnoreCase)
                ? cmdArgs[1] : null;

            bool createdNew;
            var mutex = new Mutex(true, "IskraClientSingleInstance", out createdNew);
            if (!createdNew)
            {
                if (inviteUrl != null)
                {
                    try
                    {
                        using var pipe = new NamedPipeClientStream(".", "IskraClientInvite", PipeDirection.Out);
                        pipe.Connect(2000);
                        using var writer = new StreamWriter(pipe);
                        writer.WriteLine(inviteUrl);
                    }
                    catch { }
                }
                GC.KeepAlive(mutex);
                return;
            }
            GC.KeepAlive(mutex);
            Application.Run(new Origin_Client_Core_Main(inviteUrl));
        }
    }
}
