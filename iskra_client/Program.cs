using System;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Origin.Client.Core
{
    public class Origin_Client_Core_Main : Form
    {
        private WebView2 webView;
        private ClientWebSocket wsClient;
        private string myAlias;

        public Origin_Client_Core_Main()
        {
            myAlias = "viklun_" + new Random().Next(10, 99);
            InitializeWindow();
            InitializeWebView();
        }

        private void InitializeWindow()
        {
            this.Text = $"Origin Voice Client - {myAlias}";
            this.Width = 1200;
            this.Height = 800;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = System.Drawing.Color.FromArgb(32, 34, 37);

            webView = new WebView2();
            webView.Dock = DockStyle.Fill;
            this.Controls.Add(webView);
        }

        private async void InitializeWebView()
        {
            // Set up environment for persistent permissions
            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Path.GetTempPath(), "Origin_WebView2_Data"));
            await webView.EnsureCoreWebView2Async(env);

            // --- THE FIX: AUTO-GRANT MICROPHONE PERMISSIONS ---
            webView.CoreWebView2.PermissionRequested += (s, e) =>
            {
                if (e.PermissionKind == CoreWebView2PermissionKind.Microphone)
                {
                    e.State = CoreWebView2PermissionState.Allow;
                    Console.WriteLine("[UI] Automatically granted Microphone permission.");
                }
            };

            string uiPath = Path.Combine(Application.StartupPath, "index.html");
            if (File.Exists(uiPath)) webView.CoreWebView2.Navigate(uiPath);
            else webView.CoreWebView2.NavigateToString("<h1>index.html not found!</h1>");

            await ConnectToServer();
            webView.CoreWebView2.WebMessageReceived += Origin_Client_Bridge_Listener;
        }

        private async Task ConnectToServer()
        {
            wsClient = new ClientWebSocket();
            try
            {
                Uri serverUri = new Uri("ws://localhost:8080/");
                await wsClient.ConnectAsync(serverUri, CancellationToken.None);

                var authData = new { password = "bunker_pass_2026", alias = myAlias };
                await wsClient.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(authData))), WebSocketMessageType.Text, true, CancellationToken.None);

                this.Invoke((MethodInvoker)delegate {
                    webView.CoreWebView2.PostWebMessageAsString(JsonSerializer.Serialize(new { action = "INIT_CLIENT", alias = myAlias }));
                });

                _ = Task.Run(() => ListenForServerMessages());
            }
            catch (Exception ex) { MessageBox.Show($"Connection failed: {ex.Message}"); }
        }

        private async Task ListenForServerMessages()
        {
            byte[] buffer = new byte[16384];
            while (wsClient != null && wsClient.State == WebSocketState.Open)
            {
                try
                {
                    var result = await wsClient.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
                    if (result.MessageType == WebSocketMessageType.Text)
                    {
                        string serverMessage = Encoding.UTF8.GetString(buffer, 0, result.Count);
                        this.Invoke((MethodInvoker)delegate { webView.CoreWebView2.PostWebMessageAsString(serverMessage); });
                    }
                }
                catch { break; }
            }
        }

        private async void Origin_Client_Bridge_Listener(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string jsonMessage = e.TryGetWebMessageAsString();
            if (wsClient != null && wsClient.State == WebSocketState.Open)
                await wsClient.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(jsonMessage)), WebSocketMessageType.Text, true, CancellationToken.None);
        }

        [STAThread]
        static void Main() { Application.Run(new Origin_Client_Core_Main()); }
    }
}