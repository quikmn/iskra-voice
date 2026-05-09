using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Security.Cryptography;
using Microsoft.Data.Sqlite;
using BCrypt.Net;

// ─── Config ─────────────────────────────────────────────────────────────────

var cfgPath = Path.Combine(Directory.GetCurrentDirectory(), "relay.json");
RelayConfig cfg;
if (File.Exists(cfgPath))
{
    cfg = JsonSerializer.Deserialize<RelayConfig>(File.ReadAllText(cfgPath))!;
}
else
{
    cfg = new RelayConfig();
    File.WriteAllText(cfgPath, JsonSerializer.Serialize(cfg, new JsonSerializerOptions { WriteIndented = true }));
    Console.WriteLine($"[relay] Created default config at {cfgPath} — fill in ResendApiKey then restart.");
}

// ─── Database ────────────────────────────────────────────────────────────────

var db = new SqliteConnection($"Data Source={cfg.DbPath}");
db.Open();
using (var cmd = db.CreateCommand())
{
    cmd.CommandText = @"
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    alias         TEXT UNIQUE NOT NULL COLLATE NOCASE,
    email         TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    email_verified INTEGER NOT NULL DEFAULT 0,
    pubkey        TEXT,
    key_backup    TEXT,
    created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS messages (
    id           TEXT PRIMARY KEY,
    sender_id    TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    ciphertext   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    FOREIGN KEY(sender_id)    REFERENCES users(id),
    FOREIGN KEY(recipient_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS email_tokens (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    kind       TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS friend_requests (
    id          TEXT PRIMARY KEY,
    from_id     TEXT NOT NULL,
    to_id       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  INTEGER NOT NULL,
    FOREIGN KEY(from_id) REFERENCES users(id),
    FOREIGN KEY(to_id)   REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_recip   ON messages(recipient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_fr_from          ON friend_requests(from_id);
CREATE INDEX IF NOT EXISTS idx_fr_to            ON friend_requests(to_id);
";
    cmd.ExecuteNonQuery();
}

// Migration: add alias_changed_at if not present
try {
    using var mc = db.CreateCommand();
    mc.CommandText = "ALTER TABLE users ADD COLUMN alias_changed_at INTEGER";
    mc.ExecuteNonQuery();
} catch { /* column already exists */ }

// Migration: add profile_url if not present
try {
    using var mc2 = db.CreateCommand();
    mc2.CommandText = "ALTER TABLE users ADD COLUMN profile_url TEXT";
    mc2.ExecuteNonQuery();
} catch { /* column already exists */ }

// Migration: add relay_avatar if not present
try {
    using var mc3 = db.CreateCommand();
    mc3.CommandText = "ALTER TABLE users ADD COLUMN relay_avatar TEXT";
    mc3.ExecuteNonQuery();
} catch { }

// Migration: add servers_json if not present
try {
    using var mc6 = db.CreateCommand();
    mc6.CommandText = "ALTER TABLE users ADD COLUMN servers_json TEXT";
    mc6.ExecuteNonQuery();
} catch { }

// Migration: add expires_at to sessions
try {
    using var mcs = db.CreateCommand();
    mcs.CommandText = "ALTER TABLE sessions ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0";
    mcs.ExecuteNonQuery();
} catch { }
// Stamp existing sessions with a 30-day expiry so they eventually expire
{
    using var mcs2 = db.CreateCommand();
    mcs2.CommandText = "UPDATE sessions SET expires_at=$e WHERE expires_at=0";
    mcs2.Parameters.AddWithValue("$e", DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 30 * 86400L);
    mcs2.ExecuteNonQuery();
}

// Migration: public server directory
try {
    using var mc4 = db.CreateCommand();
    mc4.CommandText = @"CREATE TABLE IF NOT EXISTS public_servers (
        address      TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        description  TEXT DEFAULT '',
        player_count INTEGER DEFAULT 0,
        announced_at INTEGER NOT NULL
    )";
    mc4.ExecuteNonQuery();
} catch { }

// Migration: relay DM read receipts
try {
    using var mc5 = db.CreateCommand();
    mc5.CommandText = @"CREATE TABLE IF NOT EXISTS receipts (
        id               TEXT PRIMARY KEY,
        sender_id        TEXT NOT NULL,
        recipient_alias  TEXT NOT NULL,
        message_id       TEXT NOT NULL,
        read_at          INTEGER NOT NULL
    )";
    mc5.ExecuteNonQuery();
} catch { }

// ─── Helpers ─────────────────────────────────────────────────────────────────

string NewId()  => Guid.NewGuid().ToString("N");
string NewToken() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLower();
long   Now()    => DateTimeOffset.UtcNow.ToUnixTimeSeconds();

SqliteCommand Cmd(string sql, params (string, object?)[] parms)
{
    var c = db.CreateCommand();
    c.CommandText = sql;
    foreach (var (k, v) in parms)
        c.Parameters.AddWithValue(k, v ?? DBNull.Value);
    return c;
}

string? Scalar(string sql, params (string, object?)[] parms)
    => Cmd(sql, parms).ExecuteScalar()?.ToString();

bool Exists(string sql, params (string, object?)[] parms)
    => Scalar(sql, parms) != null;

JsonSerializerOptions jsonOpts = new() { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };

IResult Ok(object? data = null)      => Results.Ok(data ?? new { ok = true });
IResult Err(int code, string msg)    => Results.Json(new { error = msg }, statusCode: code);
IResult ErrUnauth()                  => Err(401, "Unauthorized");
IResult ErrBad(string msg)           => Err(400, msg);
IResult ErrConflict(string msg)      => Err(409, msg);
IResult ErrNotFound(string msg)      => Err(404, msg);

string? AuthUser(HttpContext ctx)
{
    var auth = ctx.Request.Headers.Authorization.ToString();
    if (!auth.StartsWith("Bearer ")) return null;
    var tok = auth[7..].Trim();
    return Scalar("SELECT user_id FROM sessions WHERE token=$t AND expires_at>$now",
        ("$t", tok), ("$now", Now()));
}

// ── Login lockout (in-memory; resets on relay restart) ───────────────────────
var _loginAttempts = new Dictionary<string, (int count, long lockedUntil)>(StringComparer.OrdinalIgnoreCase);
var _loginLock = new object();
const int LoginMaxAttempts = 5;
const long LoginLockoutSecs = 900; // 15 min

async Task SendEmail(string to, string subject, string html)
{
    if (string.IsNullOrEmpty(cfg.ResendApiKey))
    {
        Console.WriteLine($"[relay] EMAIL (no key) → {to}\n  Subject: {subject}\n  Body: {html}");
        return;
    }
    var payload = JsonSerializer.Serialize(new { from = cfg.FromEmail, to, subject, html });
    using var http = new HttpClient();
    http.DefaultRequestHeaders.Add("Authorization", $"Bearer {cfg.ResendApiKey}");
    var res = await http.PostAsync("https://api.resend.com/emails",
        new StringContent(payload, Encoding.UTF8, "application/json"));
    if (!res.IsSuccessStatusCode)
        Console.WriteLine($"[relay] email failed ({res.StatusCode}): {await res.Content.ReadAsStringAsync()}");
}

// ─── Profile page proxy ──────────────────────────────────────────────────────

string[] allowedProfileSuffixes = [".github.io", ".neocities.org", ".pages.dev", ".netlify.app"];

bool IsAllowedProfileUrl(string? url)
{
    if (string.IsNullOrWhiteSpace(url)) return false;
    if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return false;
    if (uri.Scheme != "https") return false;
    var host = uri.Host.ToLowerInvariant();
    return host == "raw.githubusercontent.com"
        || allowedProfileSuffixes.Any(s => host.EndsWith(s));
}

string SanitizeProfileHtml(string html, string baseUrl)
{
    // Strip all <script> blocks including content
    html = Regex.Replace(html, @"<script\b[^>]*>[\s\S]*?</script>", "", RegexOptions.IgnoreCase);
    // Strip on* inline event handlers (both quote styles)
    html = Regex.Replace(html, @"\s+on[a-zA-Z]+\s*=\s*(?:""[^""]*""|'[^']*')", "", RegexOptions.IgnoreCase);
    // Block javascript: and data: URIs in href/src/action/formaction/srcset
    html = Regex.Replace(html, @"((?:href|src|action|formaction|srcset)\s*=\s*"")\s*(?:javascript|data):[^""]*""", "$1#\"", RegexOptions.IgnoreCase);
    html = Regex.Replace(html, @"((?:href|src|action|formaction|srcset)\s*=\s*')\s*(?:javascript|data):[^']*'", "$1#'", RegexOptions.IgnoreCase);
    // Block meta refresh redirects
    html = Regex.Replace(html, @"<meta[^>]+http-equiv\s*=\s*(?:""|')refresh(?:""|')[^>]*>", "", RegexOptions.IgnoreCase);
    // Remove any existing CSP (we inject a stricter one)
    html = Regex.Replace(html, @"<meta[^>]+http-equiv\s*=\s*(?:""|')Content-Security-Policy(?:""|')[^>]*>", "", RegexOptions.IgnoreCase);
    // Block CSS expression() (legacy IE attack)
    html = Regex.Replace(html, @"expression\s*\(", "BLOCKED(", RegexOptions.IgnoreCase);
    // Block @import in style blocks
    html = Regex.Replace(html, @"(@import\b)", "/* $1 */", RegexOptions.IgnoreCase);

    // Patch YouTube embeds: start muted + enable postMessage volume API
    html = Regex.Replace(html,
        @"(src=[""'])(https://(?:www\.)?youtube(?:-nocookie)?\.com/embed/[^""'?]*)(\?[^""']*)?([""'])",
        m => {
            var a = m.Groups[1].Value; var url = m.Groups[2].Value;
            var qs = m.Groups[3].Value; var q = m.Groups[4].Value;
            var combined = string.IsNullOrEmpty(qs) ? "?" : qs + "&";
            if (!combined.Contains("mute=1"))       combined += "mute=1&";
            if (!combined.Contains("enablejsapi=1")) combined += "enablejsapi=1&";
            return a + url + combined.TrimEnd('&') + q;
        }, RegexOptions.IgnoreCase);

    // Inject CSP (nonce-gated so only our controller script runs) + base tag + media controller
    var nonce    = Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLower();
    var safeBase = baseUrl.Replace("\"", "%22").Replace("<", "%3C").Replace(">", "%3E");
    // Controller: start muted, sync native audio/video and YouTube iframes on postMessage from parent
    var ctrlScript = @"(function(){var _m=true,_v=0.5;function an(){document.querySelectorAll('audio,video').forEach(function(e){e.muted=_m;e.volume=_v;});}function ay(){document.querySelectorAll('iframe').forEach(function(f){if(!/youtube/.test(f.src))return;try{f.contentWindow.postMessage(JSON.stringify({event:'command',func:_m?'mute':'unMute',args:''}),'*');}catch(e){}});}function ap(){an();ay();}document.addEventListener('DOMContentLoaded',ap);new MutationObserver(ap).observe(document,{childList:true,subtree:true});window.addEventListener('message',function(e){if(e.data&&e.data.action==='iskraVolume'){_m=e.data.muted;_v=e.data.volume;ap();}});})();";
    var inject = $"<meta http-equiv=\"Content-Security-Policy\" content=\"default-src https: 'unsafe-inline'; script-src 'nonce-{nonce}'; object-src 'none'; base-uri 'none'; form-action 'none';\">" +
                 $"<base href=\"{safeBase}\">" +
                 $"<script nonce=\"{nonce}\">{ctrlScript}</script>";

    // Insert after <head> if present, otherwise prepend (use evaluator to avoid $ in inject string being misread as backreference)
    if (Regex.IsMatch(html, @"<head\b", RegexOptions.IgnoreCase))
        html = Regex.Replace(html, @"(<head\b[^>]*>)", m => m.Value + inject, RegexOptions.IgnoreCase);
    else
        html = inject + html;

    return html;
}

var profileHttp = new HttpClient(new HttpClientHandler {
    AllowAutoRedirect    = true,
    MaxAutomaticRedirections = 3,
    CheckCertificateRevocationList = true
}) { Timeout = TimeSpan.FromSeconds(10) };

// ─── App ─────────────────────────────────────────────────────────────────────

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls($"http://0.0.0.0:{cfg.Port}");
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));
var app = builder.Build();
app.UseCors();

// Health
app.MapGet("/health", () => Ok(new { status = "ok", ts = Now() }));

// ── Auth ──────────────────────────────────────────────────────────────────────

app.MapPost("/api/register", async (HttpContext ctx) =>
{
    var body = await ctx.Request.ReadFromJsonAsync<RegRequest>();
    if (body is null || string.IsNullOrWhiteSpace(body.Alias) ||
        string.IsNullOrWhiteSpace(body.Email) || string.IsNullOrWhiteSpace(body.Password))
        return ErrBad("alias, email, and password are required");

    var alias = body.Alias.Trim();
    var email = body.Email.Trim().ToLower();
    var pw    = body.Password;

    if (alias.Length < 2 || alias.Length > 32 || !System.Text.RegularExpressions.Regex.IsMatch(alias, @"^[a-zA-Z0-9_\-]+$"))
        return ErrBad("alias must be 2-32 chars, letters/numbers/-/_ only");
    if (pw.Length < 8)
        return ErrBad("password must be at least 8 characters");

    if (Exists("SELECT id FROM users WHERE alias=$a", ("$a", alias)))
        return ErrConflict("alias already taken");
    if (Exists("SELECT id FROM users WHERE email=$e", ("$e", email)))
        return ErrConflict("email already registered");

    var id   = NewId();
    var hash = BCrypt.Net.BCrypt.HashPassword(pw);
    Cmd("INSERT INTO users(id,alias,email,password_hash,pubkey,key_backup,created_at) VALUES($id,$a,$e,$h,$pk,$kb,$t)",
        ("$id", id), ("$a", alias), ("$e", email), ("$h", hash),
        ("$pk", (object?)body.Pubkey ?? DBNull.Value),
        ("$kb", (object?)body.KeyBackup ?? DBNull.Value),
        ("$t", Now()))
        .ExecuteNonQuery();

    var vTok = NewToken();
    Cmd("INSERT INTO email_tokens(token,user_id,kind,expires_at) VALUES($t,$u,'verify',$x)",
        ("$t", vTok), ("$u", id), ("$x", Now() + 86400 * 3))
        .ExecuteNonQuery();

    var link = $"{cfg.BaseUrl}/verify?token={vTok}";
    await SendEmail(email, "Verify your Iskra ID",
        $"<p>Welcome to Iskra, <b>{alias}</b>!</p>" +
        $"<p><a href=\"{link}\">Click here to verify your email</a></p>" +
        $"<p>Link expires in 3 days. If you didn't register, ignore this.</p>");

    return Ok(new { userId = id, alias, emailSent = true });
});

app.MapPost("/api/verify-email", async (HttpContext ctx) =>
{
    var body = await ctx.Request.ReadFromJsonAsync<TokenRequest>();
    if (body is null || string.IsNullOrWhiteSpace(body.Token)) return ErrBad("token required");

    using var cmd = Cmd("SELECT user_id, expires_at FROM email_tokens WHERE token=$t AND kind='verify'", ("$t", body.Token));
    using var r = cmd.ExecuteReader();
    if (!r.Read()) return ErrBad("invalid or expired token");
    var userId = r.GetString(0);
    var exp    = r.GetInt64(1);
    r.Close();

    if (exp < Now()) return ErrBad("token expired");

    Cmd("UPDATE users SET email_verified=1 WHERE id=$u", ("$u", userId)).ExecuteNonQuery();
    Cmd("DELETE FROM email_tokens WHERE token=$t", ("$t", body.Token)).ExecuteNonQuery();

    return Ok();
});

app.MapPost("/api/resend-verify", async (HttpContext ctx) =>
{
    var body = await ctx.Request.ReadFromJsonAsync<EmailRequest>();
    if (body is null || string.IsNullOrWhiteSpace(body.Email)) return ErrBad("email required");
    var email = body.Email.Trim().ToLower();

    using var cmd = Cmd("SELECT id, alias, email_verified FROM users WHERE email=$e", ("$e", email));
    using var r = cmd.ExecuteReader();
    if (!r.Read()) return Ok(); // don't leak existence
    var userId   = r.GetString(0);
    var alias    = r.GetString(1);
    var verified = r.GetInt64(2) == 1;
    r.Close();

    if (verified) return ErrBad("already verified");

    Cmd("DELETE FROM email_tokens WHERE user_id=$u AND kind='verify'", ("$u", userId)).ExecuteNonQuery();
    var vTok = NewToken();
    Cmd("INSERT INTO email_tokens(token,user_id,kind,expires_at) VALUES($t,$u,'verify',$x)",
        ("$t", vTok), ("$u", userId), ("$x", Now() + 86400 * 3))
        .ExecuteNonQuery();

    var link = $"{cfg.BaseUrl}/verify?token={vTok}";
    await SendEmail(email, "Verify your Iskra ID",
        $"<p>Hi <b>{alias}</b>, here's your new verification link:</p>" +
        $"<p><a href=\"{link}\">Verify email</a></p>");

    return Ok();
});

// HTML verify landing page
app.MapGet("/verify", (string token) =>
{
    using var cmd = Cmd("SELECT user_id, expires_at FROM email_tokens WHERE token=$t AND kind='verify'", ("$t", token));
    using var r = cmd.ExecuteReader();
    bool valid = r.Read() && r.GetInt64(1) >= Now();
    string uid = valid ? r.GetString(0) : "";
    r.Close();

    if (valid)
    {
        Cmd("UPDATE users SET email_verified=1 WHERE id=$u", ("$u", uid)).ExecuteNonQuery();
        Cmd("DELETE FROM email_tokens WHERE token=$t", ("$t", token)).ExecuteNonQuery();
    }

    var msg = valid ? "Email verified! You can now log in." : "Invalid or expired verification link.";
    var html = $@"<!DOCTYPE html><html><head><meta charset=utf-8>
<title>Iskra ID</title>
<style>body{{background:#1a1a2e;color:#e0e0e0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}}
.box{{background:#16213e;padding:2rem 3rem;border-radius:12px;text-align:center;max-width:400px}}
h2{{color:{(valid ? "#7ec8e3" : "#ff6b6b")};margin-bottom:.5rem}}
a{{color:#7ec8e3;text-decoration:none}}</style></head>
<body><div class=box><h2>Iskra ID</h2><p>{msg}</p><a href='iskra://'>Open Iskra</a></div></body></html>";
    return Results.Content(html, "text/html");
});

app.MapPost("/api/login", async (HttpContext ctx) =>
{
    var body = await ctx.Request.ReadFromJsonAsync<LoginRequest>();
    if (body is null || string.IsNullOrWhiteSpace(body.Alias) || string.IsNullOrWhiteSpace(body.Password))
        return ErrBad("alias and password required");

    var aliasKey = body.Alias.Trim().ToLowerInvariant();

    // Lockout check
    lock (_loginLock) {
        if (_loginAttempts.TryGetValue(aliasKey, out var st) && st.lockedUntil > Now())
            return Err(429, "Too many failed attempts — try again in 15 minutes");
    }

    using var cmd = Cmd("SELECT id, password_hash, email_verified, pubkey FROM users WHERE alias=$a", ("$a", body.Alias.Trim()));
    using var r = cmd.ExecuteReader();
    if (!r.Read()) {
        // Count miss as failed attempt to prevent alias enumeration timing attack
        lock (_loginLock) { _loginAttempts[aliasKey] = (_loginAttempts.TryGetValue(aliasKey, out var s) ? s.count + 1 : 1, Now() + LoginLockoutSecs); }
        return Err(401, "Invalid credentials");
    }
    var userId   = r.GetString(0);
    var hash     = r.GetString(1);
    var verified = r.GetInt64(2) == 1;
    var pubkey   = r.IsDBNull(3) ? null : r.GetString(3);
    r.Close();

    if (!BCrypt.Net.BCrypt.Verify(body.Password, hash)) {
        lock (_loginLock) {
            _loginAttempts.TryGetValue(aliasKey, out var s);
            var newCount = s.count + 1;
            _loginAttempts[aliasKey] = (newCount, newCount >= LoginMaxAttempts ? Now() + LoginLockoutSecs : s.lockedUntil);
        }
        return Err(401, "Invalid credentials");
    }

    // Success — clear lockout, issue session with 30-day expiry
    lock (_loginLock) { _loginAttempts.Remove(aliasKey); }
    var tok = NewToken();
    var expiresAt = Now() + 30 * 86400L;
    Cmd("INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES($t,$u,$ts,$ex)",
        ("$t", tok), ("$u", userId), ("$ts", Now()), ("$ex", expiresAt))
        .ExecuteNonQuery();

    return Ok(new { token = tok, userId, alias = body.Alias.Trim(), emailVerified = verified, pubkey });
});

app.MapPost("/api/logout", (HttpContext ctx) =>
{
    var userId = AuthUser(ctx);
    if (userId is null) return ErrUnauth();
    var auth = ctx.Request.Headers.Authorization.ToString()[7..].Trim();
    Cmd("DELETE FROM sessions WHERE token=$t", ("$t", auth)).ExecuteNonQuery();
    return Ok();
});

// ── Password recovery ─────────────────────────────────────────────────────────

app.MapPost("/api/recover", async (HttpContext ctx) =>
{
    var body = await ctx.Request.ReadFromJsonAsync<EmailRequest>();
    if (body is null || string.IsNullOrWhiteSpace(body.Email)) return Ok(); // always 200

    var email = body.Email.Trim().ToLower();
    using var cmd = Cmd("SELECT id, alias FROM users WHERE email=$e", ("$e", email));
    using var r = cmd.ExecuteReader();
    if (!r.Read()) return Ok();
    var userId = r.GetString(0);
    var alias  = r.GetString(1);
    r.Close();

    Cmd("DELETE FROM email_tokens WHERE user_id=$u AND kind='reset'", ("$u", userId)).ExecuteNonQuery();
    var rTok = NewToken();
    Cmd("INSERT INTO email_tokens(token,user_id,kind,expires_at) VALUES($t,$u,'reset',$x)",
        ("$t", rTok), ("$u", userId), ("$x", Now() + 3600))
        .ExecuteNonQuery();

    var link = $"{cfg.BaseUrl}/reset?token={rTok}";
    await SendEmail(email, "Reset your Iskra password",
        $"<p>Hi <b>{alias}</b>, someone requested a password reset.</p>" +
        $"<p><a href=\"{link}\">Reset password</a> — expires in 1 hour.</p>" +
        $"<p>If you didn't request this, ignore it.</p>");

    return Ok();
});

app.MapGet("/reset", (string token) =>
{
    using var cmd = Cmd("SELECT user_id, expires_at FROM email_tokens WHERE token=$t AND kind='reset'", ("$t", token));
    using var r = cmd.ExecuteReader();
    bool valid = r.Read() && r.GetInt64(1) >= Now();
    r.Close();

    if (!valid)
        return Results.Content("<html><body style='background:#1a1a2e;color:#ff6b6b;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh'><p>Invalid or expired reset link.</p></body></html>", "text/html");

    var html = $@"<!DOCTYPE html><html><head><meta charset=utf-8>
<title>Reset Password — Iskra ID</title>
<style>
body{{background:#1a1a2e;color:#e0e0e0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}}
.box{{background:#16213e;padding:2rem 3rem;border-radius:12px;width:320px}}
h2{{color:#7ec8e3;margin:0 0 1.5rem}}
input{{width:100%;padding:.6rem .8rem;background:#0f3460;border:1px solid #7ec8e340;border-radius:6px;color:#e0e0e0;font-size:1rem;box-sizing:border-box;margin-bottom:1rem}}
button{{width:100%;padding:.7rem;background:#7ec8e3;color:#1a1a2e;border:none;border-radius:6px;font-size:1rem;cursor:pointer;font-weight:bold}}
#msg{{margin-top:.8rem;font-size:.9rem;text-align:center}}
</style></head>
<body><div class=box>
<h2>Reset Password</h2>
<input type=password id=pw placeholder=""New password (8+ chars)"">
<input type=password id=pw2 placeholder=""Confirm password"">
<button onclick=submit()>Set new password</button>
<div id=msg></div>
</div>
<script>
async function submit(){{
  var pw=document.getElementById('pw').value,pw2=document.getElementById('pw2').value,msg=document.getElementById('msg');
  if(pw.length<8){{msg.style.color='#ff6b6b';msg.textContent='Password must be at least 8 characters';return;}}
  if(pw!==pw2){{msg.style.color='#ff6b6b';msg.textContent='Passwords do not match';return;}}
  var r=await fetch('/api/reset-password',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{token:'{token}',password:pw}})}});
  var d=await r.json();
  if(d.ok){{msg.style.color='#7ec8e3';msg.textContent='Password updated! You can now log in.';}}
  else{{msg.style.color='#ff6b6b';msg.textContent=d.error||'Error';}}
}}
</script></body></html>";
    return Results.Content(html, "text/html");
});

app.MapPost("/api/reset-password", async (HttpContext ctx) =>
{
    var body = await ctx.Request.ReadFromJsonAsync<ResetRequest>();
    if (body is null || string.IsNullOrWhiteSpace(body.Token) || string.IsNullOrWhiteSpace(body.Password))
        return ErrBad("token and password required");
    if (body.Password.Length < 8) return ErrBad("password must be at least 8 characters");

    using var cmd = Cmd("SELECT user_id, expires_at FROM email_tokens WHERE token=$t AND kind='reset'", ("$t", body.Token));
    using var r = cmd.ExecuteReader();
    if (!r.Read() || r.GetInt64(1) < Now()) return ErrBad("invalid or expired token");
    var userId = r.GetString(0);
    r.Close();

    var hash = BCrypt.Net.BCrypt.HashPassword(body.Password);
    Cmd("UPDATE users SET password_hash=$h WHERE id=$u", ("$h", hash), ("$u", userId)).ExecuteNonQuery();
    Cmd("DELETE FROM email_tokens WHERE token=$t", ("$t", body.Token)).ExecuteNonQuery();
    Cmd("DELETE FROM sessions WHERE user_id=$u", ("$u", userId)).ExecuteNonQuery();

    return Ok();
});

// ── Me ────────────────────────────────────────────────────────────────────────

app.MapGet("/api/me", (HttpContext ctx) =>
{
    var userId = AuthUser(ctx);
    if (userId is null) return ErrUnauth();

    using var cmd = Cmd("SELECT id, alias, email, email_verified, pubkey, created_at, profile_url, relay_avatar FROM users WHERE id=$u", ("$u", userId));
    using var r = cmd.ExecuteReader();
    if (!r.Read()) return ErrUnauth();
    var alias = r.GetString(1);
    return Ok(new
    {
        userId = r.GetString(0), alias, email = r.GetString(2),
        emailVerified = r.GetInt64(3) == 1, pubkey = r.IsDBNull(4) ? null : r.GetString(4),
        createdAt = r.GetInt64(5), profileUrl = r.IsDBNull(6) ? null : r.GetString(6),
        relayAvatar = r.IsDBNull(7) ? null : r.GetString(7),
        avatarUrl = r.IsDBNull(7) ? null : $"/api/avatar/{Uri.EscapeDataString(alias)}"
    });
});

app.MapPut("/api/me/keys", async (HttpContext ctx) =>
{
    var userId = AuthUser(ctx);
    if (userId is null) return ErrUnauth();
    var body = await ctx.Request.ReadFromJsonAsync<KeysRequest>();
    if (body is null) return ErrBad("body required");

    Cmd("UPDATE users SET pubkey=$pk, key_backup=$kb WHERE id=$u",
        ("$pk", body.Pubkey), ("$kb", body.KeyBackup), ("$u", userId))
        .ExecuteNonQuery();
    return Ok();
});

app.MapGet("/api/me/key-backup", (HttpContext ctx) =>
{
    var userId = AuthUser(ctx);
    if (userId is null) return ErrUnauth();
    var kb = Scalar("SELECT key_backup FROM users WHERE id=$u", ("$u", userId));
    return Ok(new { keyBackup = kb });
});

app.MapPut("/api/me/alias", async (HttpContext ctx) =>
{
    var userId = AuthUser(ctx);
    if (userId is null) return ErrUnauth();

    var body = await ctx.Request.ReadFromJsonAsync<AliasRequest>();
    if (body is null || string.IsNullOrWhiteSpace(body.Alias)) return ErrBad("alias required");

    var newAlias = body.Alias.Trim();
    if (newAlias.Length < 2 || newAlias.Length > 32 || !System.Text.RegularExpressions.Regex.IsMatch(newAlias, @"^[a-zA-Z0-9_\-]+$"))
        return ErrBad("alias must be 2-32 chars, letters/numbers/-/_ only");

    var lastChanged = Scalar("SELECT alias_changed_at FROM users WHERE id=$u", ("$u", userId));
    if (lastChanged != null && long.TryParse(lastChanged, out long lc) && Now() - lc < 86400 * 30)
    {
        var daysLeft = 30 - (int)((Now() - lc) / 86400);
        return ErrBad($"alias can only be changed once every 30 days ({daysLeft} days remaining)");
    }

    if (Exists("SELECT id FROM users WHERE alias=$a AND id != $u", ("$a", newAlias), ("$u", userId)))
        return ErrConflict("alias already taken");

    Cmd("UPDATE users SET alias=$a, alias_changed_at=$t WHERE id=$u",
        ("$a", newAlias), ("$t", Now()), ("$u", userId)).ExecuteNonQuery();

    return Ok(new { alias = newAlias });

});

// ── User lookup ───────────────────────────────────────────────────────────────

app.MapGet("/api/user/{alias}", (string alias) =>
{
    using var cmd = Cmd("SELECT id, alias, pubkey, created_at, profile_url, relay_avatar FROM users WHERE alias=$a AND email_verified=1", ("$a", alias));
    using var r = cmd.ExecuteReader();
    if (!r.Read()) return ErrNotFound("user not found");
    var a = r.GetString(1);
    return Ok(new { userId = r.GetString(0), alias = a, pubkey = r.IsDBNull(2) ? null : r.GetString(2), createdAt = r.GetInt64(3), hasProfile = !r.IsDBNull(4),
        avatarUrl = r.IsDBNull(5) ? null : $"/api/avatar/{Uri.EscapeDataString(a)}" });
});

app.MapGet("/api/user/id/{userId}", (string userId) =>
{
    using var cmd = Cmd("SELECT id, alias, pubkey, created_at, profile_url, relay_avatar FROM users WHERE id=$u AND email_verified=1", ("$u", userId));
    using var r = cmd.ExecuteReader();
    if (!r.Read()) return ErrNotFound("user not found");
    var a = r.GetString(1);
    return Ok(new { userId = r.GetString(0), alias = a, pubkey = r.IsDBNull(2) ? null : r.GetString(2), createdAt = r.GetInt64(3), hasProfile = !r.IsDBNull(4),
        avatarUrl = r.IsDBNull(5) ? null : $"/api/avatar/{Uri.EscapeDataString(a)}" });
});

app.MapGet("/api/search", (HttpContext ctx) =>
{
    var q = ctx.Request.Query["q"].ToString();
    if (q.Length < 2) return ErrBad("query too short");
    var results = new List<object>();
    using var cmd = Cmd("SELECT id, alias, pubkey FROM users WHERE alias LIKE $q AND email_verified=1 LIMIT 20", ("$q", $"{q}%"));
    using var r = cmd.ExecuteReader();
    while (r.Read())
        results.Add(new { userId = r.GetString(0), alias = r.GetString(1), pubkey = r.IsDBNull(2) ? null : r.GetString(2) });
    return Ok(new { results });
});

// ── Messages ──────────────────────────────────────────────────────────────────

app.MapPost("/api/message", async (HttpContext ctx) =>
{
    var senderId = AuthUser(ctx);
    if (senderId is null) return ErrUnauth();

    var body = await ctx.Request.ReadFromJsonAsync<SendMessageRequest>();
    if (body is null || string.IsNullOrWhiteSpace(body.RecipientAlias) || string.IsNullOrWhiteSpace(body.Ciphertext))
        return ErrBad("recipientAlias and ciphertext required");

    var recipId = Scalar("SELECT id FROM users WHERE alias=$a AND email_verified=1", ("$a", body.RecipientAlias));
    if (recipId is null) return ErrNotFound("recipient not found");

    var msgId = NewId();
    Cmd("INSERT INTO messages(id,sender_id,recipient_id,ciphertext,created_at) VALUES($id,$s,$r,$c,$t)",
        ("$id", msgId), ("$s", senderId), ("$r", recipId), ("$c", body.Ciphertext), ("$t", Now()))
        .ExecuteNonQuery();

    return Ok(new { messageId = msgId });
});

app.MapGet("/api/inbox", (HttpContext ctx) =>
{
    var userId = AuthUser(ctx);
    if (userId is null) return ErrUnauth();

    // Prune old messages (>30 days)
    Cmd("DELETE FROM messages WHERE recipient_id=$u AND created_at < $cutoff",
        ("$u", userId), ("$cutoff", Now() - 86400 * 30))
        .ExecuteNonQuery();

    var msgs = new List<object>();
    using var cmd = Cmd(@"
        SELECT m.id, u.alias, m.ciphertext, m.created_at
        FROM messages m JOIN users u ON u.id=m.sender_id
        WHERE m.recipient_id=$u ORDER BY m.created_at ASC LIMIT 200",
        ("$u", userId));
    using var r = cmd.ExecuteReader();
    while (r.Read())
        msgs.Add(new { id = r.GetString(0), senderAlias = r.GetString(1), ciphertext = r.GetString(2), createdAt = r.GetInt64(3) });
    return Ok(new { messages = msgs });
});

app.MapPost("/api/inbox/ack", async (HttpContext ctx) =>
{
    var userId = AuthUser(ctx);
    if (userId is null) return ErrUnauth();

    var body = await ctx.Request.ReadFromJsonAsync<AckRequest>();
    if (body?.Ids is null || body.Ids.Length == 0) return ErrBad("ids required");

    var myAlias = Scalar("SELECT alias FROM users WHERE id=$u", ("$u", userId)) ?? "";
    foreach (var id in body.Ids)
    {
        // Create a read receipt for the sender before deleting
        var senderId = Scalar("SELECT sender_id FROM messages WHERE id=$id AND recipient_id=$u", ("$id", id), ("$u", userId));
        if (senderId != null)
            Cmd("INSERT OR IGNORE INTO receipts(id,sender_id,recipient_alias,message_id,read_at) VALUES($rid,$s,$ra,$mid,$t)",
                ("$rid", NewId()), ("$s", senderId), ("$ra", myAlias), ("$mid", id), ("$t", Now()))
                .ExecuteNonQuery();
        Cmd("DELETE FROM messages WHERE id=$id AND recipient_id=$u", ("$id", id), ("$u", userId)).ExecuteNonQuery();
    }
    return Ok();
});

// ── Friends ───────────────────────────────────────────────────────────────────

app.MapPost("/api/friend/request", async (HttpContext ctx) =>
{
    var fromId = AuthUser(ctx);
    if (fromId is null) return ErrUnauth();

    var body = await ctx.Request.ReadFromJsonAsync<AliasRequest>();
    if (body is null || string.IsNullOrWhiteSpace(body.Alias)) return ErrBad("alias required");

    var toId = Scalar("SELECT id FROM users WHERE alias=$a AND email_verified=1", ("$a", body.Alias));
    if (toId is null) return ErrNotFound("user not found");
    if (toId == fromId) return ErrBad("can't friend yourself");

    if (Exists("SELECT id FROM friend_requests WHERE from_id=$f AND to_id=$t AND status IN ('pending','accepted')", ("$f", fromId), ("$t", toId)))
        return ErrConflict("request already exists");
    if (Exists("SELECT id FROM friend_requests WHERE from_id=$f AND to_id=$t AND status IN ('pending','accepted')", ("$f", toId), ("$t", fromId)))
        return ErrConflict("they already sent you a request — accept it instead");

    Cmd("INSERT INTO friend_requests(id,from_id,to_id,status,created_at) VALUES($id,$f,$t,'pending',$ts)",
        ("$id", NewId()), ("$f", fromId), ("$t", toId), ("$ts", Now()))
        .ExecuteNonQuery();

    return Ok();
});

app.MapGet("/api/friend/requests", (HttpContext ctx) =>
{
    var userId = AuthUser(ctx);
    if (userId is null) return ErrUnauth();

    var incoming = new List<object>();
    var outgoing = new List<object>();

    using var cmd1 = Cmd(@"SELECT fr.id, u.alias, fr.created_at FROM friend_requests fr
        JOIN users u ON u.id=fr.from_id
        WHERE fr.to_id=$u AND fr.status='pending'", ("$u", userId));
    using var r1 = cmd1.ExecuteReader();
    while (r1.Read())
        incoming.Add(new { requestId = r1.GetString(0), alias = r1.GetString(1), createdAt = r1.GetInt64(2) });
    r1.Close();

    using var cmd2 = Cmd(@"SELECT fr.id, u.alias, fr.created_at FROM friend_requests fr
        JOIN users u ON u.id=fr.to_id
        WHERE fr.from_id=$u AND fr.status='pending'", ("$u", userId));
    using var r2 = cmd2.ExecuteReader();
    while (r2.Read())
        outgoing.Add(new { requestId = r2.GetString(0), alias = r2.GetString(1), createdAt = r2.GetInt64(2) });

    return Ok(new { incoming, outgoing });
});

app.MapPost("/api/friend/accept", async (HttpContext ctx) =>
{
    var userId = AuthUser(ctx);
    if (userId is null) return ErrUnauth();

    var body = await ctx.Request.ReadFromJsonAsync<RequestIdRequest>();
    if (body is null || string.IsNullOrWhiteSpace(body.RequestId)) return ErrBad("requestId required");

    var rows = Cmd("UPDATE friend_requests SET status='accepted' WHERE id=$id AND to_id=$u AND status='pending'",
        ("$id", body.RequestId), ("$u", userId)).ExecuteNonQuery();

    return rows > 0 ? Ok() : ErrNotFound("request not found");
});

app.MapPost("/api/friend/reject", async (HttpContext ctx) =>
{
    var userId = AuthUser(ctx);
    if (userId is null) return ErrUnauth();

    var body = await ctx.Request.ReadFromJsonAsync<RequestIdRequest>();
    if (body is null || string.IsNullOrWhiteSpace(body.RequestId)) return ErrBad("requestId required");

    var rows = Cmd("UPDATE friend_requests SET status='rejected' WHERE id=$id AND to_id=$u AND status='pending'",
        ("$id", body.RequestId), ("$u", userId)).ExecuteNonQuery();

    return rows > 0 ? Ok() : ErrNotFound("request not found");
});

app.MapPost("/api/friend/remove", async (HttpContext ctx) =>
{
    var userId = AuthUser(ctx);
    if (userId is null) return ErrUnauth();

    var body = await ctx.Request.ReadFromJsonAsync<AliasRequest>();
    if (body is null || string.IsNullOrWhiteSpace(body.Alias)) return ErrBad("alias required");

    var otherId = Scalar("SELECT id FROM users WHERE alias=$a", ("$a", body.Alias));
    if (otherId is null) return ErrNotFound("user not found");

    Cmd("DELETE FROM friend_requests WHERE status='accepted' AND ((from_id=$me AND to_id=$other) OR (from_id=$other AND to_id=$me))",
        ("$me", userId), ("$other", otherId)).ExecuteNonQuery();

    return Ok();
});

app.MapGet("/api/friends", (HttpContext ctx) =>
{
    var userId = AuthUser(ctx);
    if (userId is null) return ErrUnauth();

    var friends = new List<object>();
    using var cmd = Cmd(@"
        SELECT u.id, u.alias, u.pubkey
        FROM friend_requests fr
        JOIN users u ON u.id = CASE WHEN fr.from_id=$u THEN fr.to_id ELSE fr.from_id END
        WHERE fr.status='accepted' AND (fr.from_id=$u OR fr.to_id=$u)", ("$u", userId));
    using var r = cmd.ExecuteReader();
    while (r.Read())
        friends.Add(new { userId = r.GetString(0), alias = r.GetString(1), pubkey = r.IsDBNull(2) ? null : r.GetString(2) });

    return Ok(new { friends });
});

// ── Profile page ──────────────────────────────────────────────────────────────

app.MapPut("/api/me/profile-url", async (HttpContext ctx) =>
{
    var userId = AuthUser(ctx);
    if (userId is null) return ErrUnauth();
    var body = await ctx.Request.ReadFromJsonAsync<ProfileUrlRequest>();
    var url = body?.Url?.Trim();

    if (string.IsNullOrEmpty(url))
    {
        Cmd("UPDATE users SET profile_url=NULL WHERE id=$u", ("$u", userId)).ExecuteNonQuery();
        return Ok(new { profileUrl = (string?)null });
    }

    if (!IsAllowedProfileUrl(url))
        return ErrBad("URL must be HTTPS from: *.github.io, *.neocities.org, *.pages.dev, or *.netlify.app");

    Cmd("UPDATE users SET profile_url=$p WHERE id=$u", ("$p", url), ("$u", userId)).ExecuteNonQuery();
    return Ok(new { profileUrl = url });
});

app.MapGet("/api/profile/{alias}", async (string alias) =>
{
    var profileUrl = Scalar("SELECT profile_url FROM users WHERE alias=$a AND email_verified=1", ("$a", alias));
    if (string.IsNullOrEmpty(profileUrl)) return ErrNotFound("no profile page set");

    // Re-validate domain at serve time (defence against stale/modified data)
    if (!IsAllowedProfileUrl(profileUrl)) return ErrBad("profile URL not on allowed host");

    try
    {
        var req = new HttpRequestMessage(HttpMethod.Get, profileUrl);
        req.Headers.TryAddWithoutValidation("User-Agent", "Iskra-Profile-Proxy/1.0");
        req.Headers.TryAddWithoutValidation("Accept", "text/html");

        using var resp = await profileHttp.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);

        // Validate final URL after any redirects
        var finalUrl = (resp.RequestMessage?.RequestUri ?? new Uri(profileUrl)).ToString();
        if (!IsAllowedProfileUrl(finalUrl)) return ErrBad("redirect to disallowed host");

        // Must be an HTML page
        var ct = resp.Content.Headers.ContentType?.MediaType ?? "";
        if (!ct.Contains("html", StringComparison.OrdinalIgnoreCase))
            return ErrBad("profile URL must serve an HTML page");

        // Read up to 512 KB
        using var stream = await resp.Content.ReadAsStreamAsync();
        var buf = new byte[512 * 1024];
        int total = 0, read;
        while (total < buf.Length && (read = await stream.ReadAsync(buf.AsMemory(total))) > 0)
            total += read;

        var html = Encoding.UTF8.GetString(buf, 0, total);
        var sanitized = SanitizeProfileHtml(html, finalUrl);

        return Ok(new { html = sanitized });
    }
    catch (Exception ex)
    {
        return ErrBad($"could not fetch profile: {ex.Message}");
    }
});

// ── Relay avatar ──────────────────────────────────────────────────────────────

app.MapPut("/api/me/avatar", async (HttpContext ctx) =>
{
    var userId = AuthUser(ctx);
    if (userId is null) return ErrUnauth();
    var body = await ctx.Request.ReadFromJsonAsync<RelayAvatarRequest>();
    if (body is null || string.IsNullOrWhiteSpace(body.DataUrl))
    {
        Cmd("UPDATE users SET relay_avatar=NULL WHERE id=$u", ("$u", userId)).ExecuteNonQuery();
        return Ok(new { relayAvatar = (string?)null });
    }
    if (!body.DataUrl.StartsWith("data:image/") || body.DataUrl.Length > 131072)
        return ErrBad("must be a data: image URL under 128 KB");
    Cmd("UPDATE users SET relay_avatar=$a WHERE id=$u", ("$a", body.DataUrl), ("$u", userId)).ExecuteNonQuery();
    return Ok(new { relayAvatar = body.DataUrl });
});

app.MapGet("/api/avatar/{alias}", (string alias) =>
{
    var dataUrl = Scalar("SELECT relay_avatar FROM users WHERE alias=$a AND email_verified=1", ("$a", alias));
    if (string.IsNullOrEmpty(dataUrl)) return Results.NotFound();
    var comma = dataUrl.IndexOf(',');
    if (comma < 0) return Results.NotFound();
    var mime = dataUrl[5..dataUrl.IndexOf(';')]; // data:image/webp;base64,...  →  image/webp
    try { return Results.Bytes(Convert.FromBase64String(dataUrl[(comma + 1)..]), mime); }
    catch { return Results.NotFound(); }
});

// ── Read receipts ─────────────────────────────────────────────────────────────

app.MapGet("/api/receipts", (HttpContext ctx) =>
{
    var userId = AuthUser(ctx);
    if (userId is null) return ErrUnauth();
    var recs = new List<object>();
    using var cmd = Cmd("SELECT id, recipient_alias, message_id, read_at FROM receipts WHERE sender_id=$u ORDER BY read_at ASC", ("$u", userId));
    using var r = cmd.ExecuteReader();
    while (r.Read())
        recs.Add(new { id = r.GetString(0), recipientAlias = r.GetString(1), messageId = r.GetString(2), readAt = r.GetInt64(3) });
    return Ok(new { receipts = recs });
});

app.MapPost("/api/receipts/ack", async (HttpContext ctx) =>
{
    var userId = AuthUser(ctx);
    if (userId is null) return ErrUnauth();
    var body = await ctx.Request.ReadFromJsonAsync<AckRequest>();
    if (body?.Ids is null) return ErrBad("ids required");
    foreach (var id in body.Ids)
        Cmd("DELETE FROM receipts WHERE id=$id AND sender_id=$u", ("$id", id), ("$u", userId)).ExecuteNonQuery();
    return Ok();
});

// ── Public server directory ───────────────────────────────────────────────────

app.MapPost("/api/servers/announce", async (HttpContext ctx) =>
{
    var body = await ctx.Request.ReadFromJsonAsync<ServerAnnounceRequest>();
    if (body is null || string.IsNullOrWhiteSpace(body.Address) || string.IsNullOrWhiteSpace(body.Name))
        return ErrBad("address and name required");
    var addr = body.Address.Trim();
    if (addr.Length > 200 || addr.Contains(' ')) return ErrBad("invalid address");
    // Soft rate-limit: min 60s between announces per address
    var last = Scalar("SELECT announced_at FROM public_servers WHERE address=$a", ("$a", addr));
    if (last != null && long.TryParse(last, out long la) && Now() - la < 60) return Ok();
    var name = body.Name.Trim()[..Math.Min(80, body.Name.Trim().Length)];
    var desc = (body.Description ?? "").Trim();
    if (desc.Length > 200) desc = desc[..200];
    Cmd("INSERT OR REPLACE INTO public_servers(address,name,description,player_count,announced_at) VALUES($a,$n,$d,$pc,$t)",
        ("$a", addr), ("$n", name), ("$d", desc), ("$pc", body.PlayerCount), ("$t", Now()))
        .ExecuteNonQuery();
    return Ok();
});

app.MapGet("/api/servers", () =>
{
    var cutoff = Now() - 600;
    var servers = new List<object>();
    using var cmd = Cmd("SELECT address,name,description,player_count,announced_at FROM public_servers WHERE announced_at>$c ORDER BY player_count DESC,name ASC", ("$c", cutoff));
    using var r = cmd.ExecuteReader();
    while (r.Read())
        servers.Add(new { address = r.GetString(0), name = r.GetString(1), description = r.IsDBNull(2) ? "" : r.GetString(2), playerCount = r.GetInt64(3), lastSeen = r.GetInt64(4) });
    return Ok(new { servers });
});

app.MapGet("/findservers", () =>
{
    var cutoff = Now() - 600;
    var cards = new System.Text.StringBuilder();
    using var cmd = Cmd("SELECT address,name,description,player_count FROM public_servers WHERE announced_at>$c ORDER BY player_count DESC,name ASC", ("$c", cutoff));
    using var r = cmd.ExecuteReader();
    bool any = false;
    while (r.Read())
    {
        any = true;
        var addr = System.Net.WebUtility.HtmlEncode(r.GetString(0));
        var name = System.Net.WebUtility.HtmlEncode(r.GetString(1));
        var desc = System.Net.WebUtility.HtmlEncode(r.IsDBNull(2) ? "" : r.GetString(2));
        var pc   = r.GetInt64(3);
        cards.Append($@"<div class=srv>
  <div class=srv-name>{name}</div>
  {(desc.Length > 0 ? $"<div class=srv-desc>{desc}</div>" : "")}
  <div class=srv-meta>
    <span class=srv-addr>📡 {addr}</span>
    {(pc > 0 ? $"<span class=srv-online>🟢 {pc} online</span>" : "")}
  </div>
  <button onclick=""copy('{addr}')"">Copy address</button>
</div>");
    }
    if (!any) cards.Append("<div class=empty>No servers online right now. Run your own!</div>");

    return Results.Content($@"<!DOCTYPE html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content=""width=device-width,initial-scale=1"">
<title>Find Iskra Servers</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:#0d0d14;color:#ddddf0;font-family:system-ui,sans-serif;padding:32px 16px}}
.wrap{{max-width:700px;margin:0 auto}}
h1{{font-size:28px;font-weight:800;margin-bottom:6px;background:linear-gradient(90deg,#7c6af7,#e040fb);-webkit-background-clip:text;-webkit-text-fill-color:transparent}}
.sub{{color:#6d6f82;font-size:13px;margin-bottom:28px}}a{{color:#7c6af7}}
.srv{{background:#16162a;border:1px solid #2a2a44;border-radius:12px;padding:18px 20px;margin-bottom:12px;transition:border-color .15s}}
.srv:hover{{border-color:#7c6af7}}
.srv-name{{font-weight:700;font-size:17px;margin-bottom:4px}}
.srv-desc{{color:#8888a8;font-size:13px;margin-bottom:10px}}
.srv-meta{{display:flex;gap:18px;font-size:12px;color:#5a5a7a;margin-bottom:12px;align-items:center}}
.srv-online{{color:#57f287;font-weight:600}}
.srv button{{background:#7c6af7;border:none;color:#fff;border-radius:6px;padding:5px 14px;font-size:12px;cursor:pointer;font-weight:600;transition:background .1s}}
.srv button:hover{{background:#6c5ae7}}
.empty{{color:#5a5a7a;text-align:center;padding:48px;font-size:14px}}
</style></head>
<body><div class=wrap>
<h1>Find Servers</h1>
<p class=sub>Public Iskra servers — updated live. <a href=https://github.com/vlundgren/iskra>Get Iskra</a></p>
{cards}
</div>
<script>function copy(a){{navigator.clipboard.writeText(a).then(()=>{{event.target.textContent='Copied!';setTimeout(()=>event.target.textContent='Copy address',1500)}});}}</script>
</body></html>", "text/html");
});

// ── Password change ───────────────────────────────────────────────────────────

app.MapPut("/api/me/password", async (HttpContext ctx) =>
{
    var userId = AuthUser(ctx);
    if (userId is null) return ErrUnauth();
    var body = await ctx.Request.ReadFromJsonAsync<JsonElement>();
    if (!body.TryGetProperty("currentPassword", out var curEl) ||
        !body.TryGetProperty("newPassword",     out var newEl))
        return ErrBad("currentPassword and newPassword required");

    var cur = curEl.GetString() ?? "";
    var nw  = newEl.GetString() ?? "";
    if (nw.Length < 8) return ErrBad("password must be at least 8 characters");

    var hash = Scalar("SELECT password_hash FROM users WHERE id=$u", ("$u", userId));
    if (hash is null || !BCrypt.Net.BCrypt.Verify(cur, hash)) return Err(401, "Current password is incorrect");

    var newHash = BCrypt.Net.BCrypt.HashPassword(nw);
    Cmd("UPDATE users SET password_hash=$h WHERE id=$u", ("$h", newHash), ("$u", userId)).ExecuteNonQuery();
    // Invalidate all OTHER sessions so other devices re-authenticate
    var tok = ctx.Request.Headers["Authorization"].ToString().Replace("Bearer ", "").Trim();
    Cmd("DELETE FROM sessions WHERE user_id=$u AND token != $t", ("$u", userId), ("$t", tok)).ExecuteNonQuery();

    return Ok();
});

// ── Server list sync ──────────────────────────────────────────────────────────

app.MapGet("/api/me/servers", (HttpContext ctx) =>
{
    var userId = AuthUser(ctx);
    if (userId is null) return ErrUnauth();
    var json = Scalar("SELECT servers_json FROM users WHERE id=$u", ("$u", userId));
    return Ok(new { servers = json });
});

app.MapPut("/api/me/servers", async (HttpContext ctx) =>
{
    var userId = AuthUser(ctx);
    if (userId is null) return ErrUnauth();
    var body = await ctx.Request.ReadFromJsonAsync<JsonElement>();
    if (!body.TryGetProperty("servers", out var sv)) return ErrBad("servers required");
    var json = sv.GetRawText();
    if (json.Length > 65536) return ErrBad("payload too large");
    Cmd("UPDATE users SET servers_json=$j WHERE id=$u", ("$j", json), ("$u", userId)).ExecuteNonQuery();
    return Ok();
});

app.Run();

// ─── Request models ───────────────────────────────────────────────────────────

record RelayConfig
{
    public string DbPath      { get; init; } = "iskra_relay.db";
    public int    Port        { get; init; } = 5000;
    public string BaseUrl     { get; init; } = "https://id.iskra.foo";
    public string ResendApiKey{ get; init; } = "";
    public string FromEmail   { get; init; } = "noreply@iskra.foo";
}

record RegRequest         ([property: JsonPropertyName("alias")]         string? Alias,
                           [property: JsonPropertyName("email")]         string? Email,
                           [property: JsonPropertyName("password")]      string? Password,
                           [property: JsonPropertyName("pubkey")]        string? Pubkey = null,
                           [property: JsonPropertyName("keyBackup")]     string? KeyBackup = null);
record LoginRequest       ([property: JsonPropertyName("alias")]         string? Alias,
                           [property: JsonPropertyName("password")]      string? Password);
record TokenRequest       ([property: JsonPropertyName("token")]         string? Token);
record EmailRequest       ([property: JsonPropertyName("email")]         string? Email);
record ResetRequest       ([property: JsonPropertyName("token")]         string? Token,
                           [property: JsonPropertyName("password")]      string? Password);
record KeysRequest        ([property: JsonPropertyName("pubkey")]        string? Pubkey,
                           [property: JsonPropertyName("keyBackup")]     string? KeyBackup);
record SendMessageRequest ([property: JsonPropertyName("recipientAlias")]string? RecipientAlias,
                           [property: JsonPropertyName("ciphertext")]    string? Ciphertext);
record AckRequest         ([property: JsonPropertyName("ids")]           string[]? Ids);
record AliasRequest       ([property: JsonPropertyName("alias")]         string? Alias);
record RequestIdRequest   ([property: JsonPropertyName("requestId")]     string? RequestId);
record ProfileUrlRequest  ([property: JsonPropertyName("url")]            string? Url);
record RelayAvatarRequest ([property: JsonPropertyName("dataUrl")]         string? DataUrl);
record ServerAnnounceRequest(
    [property: JsonPropertyName("address")]     string? Address,
    [property: JsonPropertyName("name")]        string? Name,
    [property: JsonPropertyName("description")] string? Description = null,
    [property: JsonPropertyName("playerCount")] int     PlayerCount  = 0);
