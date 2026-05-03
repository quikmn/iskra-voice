using System;
using System.IO;
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

        [DllImport("kernel32.dll")]
        private static extern bool AllocConsole();

        private static void CLog(string cat, string msg) =>
            Console.WriteLine($"[{DateTime.Now:HH:mm:ss.fff}][{cat,-8}] {msg}");

        private int    _pttVkCode    = 0x5A;  // default: 'Z'
        private bool   _isPttMode    = false;
        private bool   _pttWasDown   = false;
        private System.Threading.Timer _pttPollTimer;
        private NotifyIcon _trayIcon;
        private bool _isQuitting = false;

        // ── WebSocket + UI ──────────────────────────────────────────────────────
        private WebView2 webView;
        private ClientWebSocket wsClient;
        private string myAlias;

        public Origin_Client_Core_Main()
        {
            InitializeWindow();
            InitializeWebView();
        }

        private void InitializeWindow()
        {
            this.Text          = "Origin Voice Client";
            this.Width         = 1200;
            this.Height        = 800;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor     = System.Drawing.Color.FromArgb(32, 34, 37);

            webView      = new WebView2();
            webView.Dock = DockStyle.Fill;
            this.Controls.Add(webView);

            InitializeTray();
        }

        private void InitializeTray()
        {
            _trayIcon = new NotifyIcon
            {
                Icon    = SystemIcons.Application,
                Text    = "Iskra",
                Visible = true
            };
            var menu = new ContextMenuStrip();
            menu.Items.Add("Open",  null, (s, e) => { Show(); WindowState = FormWindowState.Normal; Activate(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quit",  null, (s, e) => { _isQuitting = true; Application.Exit(); });
            _trayIcon.ContextMenuStrip = menu;
            _trayIcon.DoubleClick += (s, e) => { Show(); WindowState = FormWindowState.Normal; Activate(); };
        }

        private async void InitializeWebView()
        {
            CLog("WEBVIEW", "Initializing WebView2 environment...");
            var opts = new CoreWebView2EnvironmentOptions();
            opts.AdditionalBrowserArguments = "--autoplay-policy=no-user-gesture-required";
            var env = await CoreWebView2Environment.CreateAsync(
                null, Path.Combine(Path.GetTempPath(), "Origin_WebView2_Data"), opts);
            await webView.EnsureCoreWebView2Async(env);
            CLog("WEBVIEW", $"WebView2 ready | version: {webView.CoreWebView2.Environment.BrowserVersionString}");

            webView.CoreWebView2.Settings.AreDevToolsEnabled = true;

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

            webView.CoreWebView2.WebMessageReceived += Origin_Client_Bridge_Listener;

            _pttPollTimer = new System.Threading.Timer(PollPttState, null, 10, 10);
            CLog("PTT", $"Poll started at 10ms | default key: {(char)_pttVkCode} (0x{_pttVkCode:X2})");
            CLog("INFO", "F12 = DevTools | F9 in app = JS log panel | Use Settings → Servers to connect");
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

        // ── Server connection ───────────────────────────────────────────────────
        private async Task ConnectToServer(string host, int port, string password, string alias, string adminPassword = "")
        {
            if (wsClient != null && wsClient.State == WebSocketState.Open)
            {
                CLog("WS", "Already connected — ignoring CONNECT request");
                return;
            }

            wsClient = new ClientWebSocket();
            myAlias  = alias;
            try
            {
                var uri = new Uri($"ws://{host}:{port}/");
                CLog("WS", $"Connecting to {uri} as '{alias}'...");
                await wsClient.ConnectAsync(uri, CancellationToken.None);
                CLog("WS", "Connected");

                var machineGuid = GetMachineGuid();
                var auth = new { password, alias, machineGuid, adminPassword };
                await wsClient.SendAsync(
                    new ArraySegment<byte>(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(auth))),
                    WebSocketMessageType.Text, true, CancellationToken.None);
                CLog("WS", $"Auth sent | alias:{alias} admin:{!string.IsNullOrEmpty(adminPassword)} guid:{(machineGuid.Length > 8 ? machineGuid[..8] + "…" : machineGuid)}");

                this.Invoke((MethodInvoker)(() =>
                {
                    this.Text = $"Origin Voice Client - {alias}";
                    webView.CoreWebView2.PostWebMessageAsString(
                        JsonSerializer.Serialize(new { action = "INIT_CLIENT", alias }));
                }));
                CLog("BRIDGE", $"→ JS | INIT_CLIENT alias:{alias}");

                _ = Task.Run(ListenForServerMessages);
            }
            catch (Exception ex)
            {
                CLog("ERR", $"Connection failed: {ex.Message}");
                try
                {
                    this.Invoke((MethodInvoker)(() =>
                        webView.CoreWebView2.PostWebMessageAsString(
                            JsonSerializer.Serialize(new { action = "CONNECTION_FAILED", error = ex.Message }))));
                }
                catch { }
            }
        }

        private async Task ListenForServerMessages()
        {
            byte[] buf       = new byte[16384];
            var    msgStream = new MemoryStream(65536);
            while (wsClient != null && wsClient.State == WebSocketState.Open)
            {
                try
                {
                    msgStream.SetLength(0);
                    WebSocketReceiveResult result;
                    do
                    {
                        result = await wsClient.ReceiveAsync(new ArraySegment<byte>(buf), CancellationToken.None);
                        msgStream.Write(buf, 0, result.Count);
                    } while (!result.EndOfMessage);

                    if (result.MessageType == WebSocketMessageType.Text)
                    {
                        string msg = Encoding.UTF8.GetString(msgStream.GetBuffer(), 0, (int)msgStream.Length);
                        this.Invoke((MethodInvoker)(() =>
                            webView.CoreWebView2.PostWebMessageAsString(msg)));
                    }
                }
                catch { break; }
            }
            CLog("WS", "Receive loop exited — sending DISCONNECTED to JS");
            try
            {
                this.Invoke((MethodInvoker)(() =>
                {
                    this.Text = "Origin Voice Client";
                    webView.CoreWebView2.PostWebMessageAsString(
                        JsonSerializer.Serialize(new { action = "DISCONNECTED" }));
                }));
            }
            catch { }
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
                if (action == "CONNECT")
                {
                    var host          = doc.RootElement.GetProperty("host").GetString();
                    var port          = doc.RootElement.GetProperty("port").GetInt32();
                    var password      = doc.RootElement.GetProperty("password").GetString();
                    var alias         = doc.RootElement.GetProperty("alias").GetString();
                    var adminPassword = doc.RootElement.TryGetProperty("adminPassword", out JsonElement apEl) ? apEl.GetString() ?? "" : "";
                    CLog("BRIDGE", $"← JS (local) | CONNECT host:{host}:{port} alias:{alias} admin:{!string.IsNullOrEmpty(adminPassword)}");
                    _ = Task.Run(() => ConnectToServer(host, port, password, alias, adminPassword));
                    return;
                }
                if (action == "DISCONNECT")
                {
                    CLog("BRIDGE", "← JS (local) | DISCONNECT");
                    wsClient?.Abort();
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
            }
            catch { /* malformed JSON — fall through */ }

            if (wsClient != null && wsClient.State == WebSocketState.Open)
            {
                CLog("BRIDGE", $"← JS → srv | {(json.Length > 80 ? json[..80] + "…" : json)}");
                await wsClient.SendAsync(
                    new ArraySegment<byte>(Encoding.UTF8.GetBytes(json)),
                    WebSocketMessageType.Text, true, CancellationToken.None);
            }
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
            AllocConsole();
            Console.Title = "Origin Client — Dev Console";
            Console.OutputEncoding = System.Text.Encoding.UTF8;
            Application.Run(new Origin_Client_Core_Main());
        }
    }
}
