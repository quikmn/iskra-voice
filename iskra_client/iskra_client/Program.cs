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

// [Origin]-[Client]-[Core]-[Main]
namespace Origin.Client.Core
{
    public class Origin_Client_Core_Main : Form
    {
        private WebView2 webView;
        private ClientWebSocket wsClient;
        private string myAlias;

        public Origin_Client_Core_Main()
        {
            // Generate a temporary unique alias for local testing
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
            await webView.EnsureCoreWebView2Async(null);

            string uiPath = Path.Combine(Application.StartupPath, "index.html");
            if (File.Exists(uiPath))
            {
                webView.CoreWebView2.Navigate(uiPath);
            }
            else
            {
                webView.CoreWebView2.NavigateToString("<h1>index.html not found!</h1>");
            }

            await ConnectToServer();
            webView.CoreWebView2.WebMessageReceived += Origin_Client_Bridge_Listener;
        }

        // [Origin]-[Client]-[Net]-[Socket]
        private async Task ConnectToServer()
        {
            wsClient = new ClientWebSocket();
            try
            {
                Uri serverUri = new Uri("ws://localhost:8080/");
                await wsClient.ConnectAsync(serverUri, CancellationToken.None);

                var authData = new { password = "bunker_pass_2026", alias = myAlias };
                string jsonPayload = JsonSerializer.Serialize(authData);
                byte[] buffer = Encoding.UTF8.GetBytes(jsonPayload);

                await wsClient.SendAsync(new ArraySegment<byte>(buffer), WebSocketMessageType.Text, true, CancellationToken.None);

                // Tell the HTML UI what its alias is
                var initMsg = new { action = "INIT_CLIENT", alias = myAlias };
                this.Invoke((MethodInvoker)delegate {
                    webView.CoreWebView2.PostWebMessageAsString(JsonSerializer.Serialize(initMsg));
                });

                _ = Task.Run(() => ListenForServerMessages());
            }
            catch (Exception ex)
            {
                MessageBox.Show($"Server connection failed.\n\nError: {ex.Message}", "Origin Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        // [Origin]-[Client]-[Net]-[ReceiveLoop]
        private async Task ListenForServerMessages()
        {
            byte[] buffer = new byte[8192];
            while (wsClient != null && wsClient.State == WebSocketState.Open)
            {
                try
                {
                    var result = await wsClient.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
                    if (result.MessageType == WebSocketMessageType.Text)
                    {
                        string serverMessage = Encoding.UTF8.GetString(buffer, 0, result.Count);

                        this.Invoke((MethodInvoker)delegate {
                            webView.CoreWebView2.PostWebMessageAsString(serverMessage);
                        });
                    }
                }
                catch (Exception) { break; }
            }
        }

        // [Origin]-[Client]-[Bridge]-[Listener]
        private async void Origin_Client_Bridge_Listener(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string jsonMessage = e.TryGetWebMessageAsString();

            if (wsClient != null && wsClient.State == WebSocketState.Open)
            {
                byte[] buffer = Encoding.UTF8.GetBytes(jsonMessage);
                await wsClient.SendAsync(new ArraySegment<byte>(buffer), WebSocketMessageType.Text, true, CancellationToken.None);
            }
        }

        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new Origin_Client_Core_Main());
        }
    }
}