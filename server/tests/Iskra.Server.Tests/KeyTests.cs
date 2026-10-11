using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;
using Microsoft.Data.Sqlite;
using Key = NSec.Cryptography.Key;

namespace Iskra.Server.Tests;

public class KeyTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static string KeyOf(Key key) => Ed25519.ToB64u(Ed25519.PublicKeyOf(key));
    private static string DeviceKeyOf(TestIdentity identity) => KeyOf(identity.Device);

    private static JsonObject Rotation(Key from, Key to, long at, Key? signNewWith = null)
    {
        var payload = Ed25519.Payload(KeyFeature.RotateContext, Ed25519.PublicKeyOf(from), Ed25519.PublicKeyOf(to), Ed25519.U64BigEndian(at));
        return new JsonObject
        {
            ["oldKey"] = KeyOf(from), ["newKey"] = KeyOf(to), ["rotatedAt"] = at,
            ["oldSig"] = Ed25519.ToB64u(Ed25519.Sign(from, payload)),
            ["newSig"] = Ed25519.ToB64u(Ed25519.Sign(signNewWith ?? to, payload)),
        };
    }

    /// <summary>A certificate for an existing device key, signed by another account key.</summary>
    private static JsonObject Recertify(TestIdentity device, Key account)
    {
        var devicePub = Ed25519.PublicKeyOf(device.Device);
        var sig = Ed25519.Sign(account, Ed25519.Payload(Identity.DeviceCertContext, devicePub, Ed25519.U64BigEndian(device.Created)));
        return new JsonObject { ["accountKey"] = KeyOf(account), ["deviceKey"] = Ed25519.ToB64u(devicePub), ["created"] = device.Created, ["sig"] = Ed25519.ToB64u(sig) };
    }

    private static string FakeSeal() => Ed25519.ToB64u(System.Security.Cryptography.RandomNumberGenerator.GetBytes(80));

    /// <summary>Signs in with an existing device under a (possibly new) account certificate, optionally bringing a rotation chain.</summary>
    private static async Task<(TestClient Client, JsonElement Reply)> LoginAsync(IskraServer server, TestIdentity device, JsonObject cert, params JsonObject[] rotations)
    {
        var client = await server.ConnectAsync();
        var hello = await client.ReceiveAsync();
        var frame = device.AuthFrame(hello, "Alice", cert: cert);
        if (rotations.Length > 0) frame["body"]!["rotations"] = new JsonArray(rotations.Select(r => (JsonNode)r.DeepClone()).ToArray());
        await client.SendAsync(frame);
        return (client, await client.ReceiveAsync());
    }

    private static void Backdate(IskraServer server, string oldKey, long appliedAt)
    {
        using var db = new SqliteConnection($"Data Source={Path.Combine(server.WorldPath, "iskra.db")};Pooling=False");
        db.Open();
        using var cmd = db.CreateCommand();
        cmd.CommandText = "UPDATE account_rotations SET applied_at = $at WHERE old_key = $k;";
        cmd.Parameters.AddWithValue("$at", appliedAt);
        cmd.Parameters.AddWithValue("$k", oldKey);
        Assert.Equal(1, cmd.ExecuteNonQuery());
    }

    [Fact]
    public async Task A_rotation_moves_the_account_and_retires_the_old_key()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice", "trusted");
        using var bob = await server.JoinAsync("Bob");
        using var phone = new TestIdentity(alice.Identity.Account);
        using var phoneClient = await server.ConnectAsync();
        Assert.Equal("welcome", (await phoneClient.LoginAsync(phone, "Alice")).Type());
        using var stolen = new TestIdentity(alice.Identity.Account); // a device the owner doesn't carry over
        using (var stolenClient = await server.ConnectAsync()) Assert.Equal("welcome", (await stolenClient.LoginAsync(stolen, "Alice")).Type());

        // Some state to carry over: a message, a reaction, a profile, a DM.
        var message = (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "hello" })).Body().GetProperty("message");
        await alice.RequestAsync("chat.react", new { id = message.GetProperty("id").GetInt64(), emoji = "👍" });
        await alice.RequestAsync("profile.update", new { bio = "Still me." });
        await bob.RequestAsync("dm.send", new { accountKey = alice.Key, envelope = new { v = 2, opaque = "x" } });

        using var next = Ed25519.KeyFromSeed(Ed25519.NewSeed());
        var newKey = KeyOf(next);
        var rotation = Rotation(alice.Identity.Account, next, Now);
        var phoneSeal = FakeSeal();
        var result = await alice.RequestAsync("account.rotate", new
        {
            rotation,
            certs = new[] { Recertify(alice.Identity, next), Recertify(phone, next) },
            handovers = new[] { new { device = DeviceKeyOf(phone), seal = phoneSeal } },
        });
        Assert.Equal("applied", result.Body().GetProperty("status").GetString());

        // The old key's sessions learn where the account went (each with its own hand-over) and close.
        var rotated = (await phoneClient.EventAsync("account.rotated")).Body();
        Assert.Equal(newKey, rotated.GetProperty("rotations")[0].GetProperty("newKey").GetString());
        Assert.Equal(phoneSeal, rotated.GetProperty("handover").GetString());
        Assert.Equal(4409, await phoneClient.ReceiveCloseAsync());
        Assert.Equal(JsonValueKind.Null, (await alice.EventAsync("account.rotated")).Body().GetProperty("handover").ValueKind);
        Assert.Equal(4409, await alice.Client.ReceiveCloseAsync());

        // Everyone else is told, with the signed statement so their apps can check it themselves.
        var moved = (await bob.EventAsync("member.rotated")).Body();
        Assert.Equal(alice.Key, moved.GetProperty("rotation").GetProperty("oldKey").GetString());
        Assert.Equal(newKey, moved.GetProperty("member").GetProperty("accountKey").GetString());
        Assert.Equal("trusted", moved.GetProperty("member").GetProperty("role").GetString());
        Assert.Equal("Still me.", moved.GetProperty("member").GetProperty("bio").GetString());

        // The old key can't sign in any more; a carried-over device gets its hand-over, others don't.
        var (oldPhone, refused) = await LoginAsync(server, phone, phone.Cert());
        using (oldPhone)
        {
            Assert.Equal("account_rotated", refused.ErrorCode());
            Assert.Equal(phoneSeal, refused.Body().GetProperty("handover").GetString());
            Assert.Equal(newKey, refused.Body().GetProperty("rotations")[0].GetProperty("newKey").GetString());
            Assert.Equal(4401, await oldPhone.ReceiveCloseAsync());
        }
        var (thief, thiefReply) = await LoginAsync(server, stolen, stolen.Cert());
        using (thief)
        {
            Assert.Equal("account_rotated", thiefReply.ErrorCode());
            Assert.Equal(JsonValueKind.Null, thiefReply.Body().GetProperty("handover").ValueKind);
        }
        using (var restored = await server.ConnectAsync()) // a new device from the old recovery key
            Assert.Equal("account_rotated", (await restored.LoginAsync(new TestIdentity(alice.Identity.Account), "Alice")).ErrorCode());

        // The new key is the same member: role, profile, messages, reactions, DMs.
        var (fresh, welcome) = await LoginAsync(server, phone, Recertify(phone, next));
        using (fresh)
        {
            Assert.Equal("welcome", welcome.Type());
            var you = welcome.Body().GetProperty("you");
            Assert.Equal(newKey, you.GetProperty("accountKey").GetString());
            Assert.Equal("trusted", you.GetProperty("role").GetString());
            Assert.DoesNotContain(welcome.Body().GetProperty("members").EnumerateArray(), m => m.GetProperty("accountKey").GetString() == alice.Key);
            Assert.Equal(alice.Key, welcome.Body().GetProperty("rotations")[0].GetProperty("oldKey").GetString());

            var history = (await fresh.RequestAsync("chat.history", new { channelId = server.General })).Body().GetProperty("messages");
            var hello = history.EnumerateArray().Single(m => m.GetProperty("text").GetString() == "hello");
            Assert.Equal(newKey, hello.GetProperty("author").GetString());
            Assert.Equal(newKey, hello.GetProperty("reactions")[0].GetProperty("accounts")[0].GetString());
            var dms = (await fresh.RequestAsync("dm.history", new { accountKey = bob.Key })).Body().GetProperty("messages");
            Assert.Equal(newKey, dms[0].GetProperty("to").GetString());

            // Senders see only the re-certified devices, under the new key.
            var bundle = (await bob.RequestAsync("dm.devices", new { accountKey = newKey })).Body().GetProperty("devices");
            Assert.Equal(2, bundle.GetArrayLength());
            Assert.All(bundle.EnumerateArray(), d => Assert.Equal(newKey, d.GetProperty("accountKey").GetString()));
            Assert.DoesNotContain(bundle.EnumerateArray(), d => d.GetProperty("deviceKey").GetString() == DeviceKeyOf(stolen));
            Assert.Equal("not_found", (await bob.RequestAsync("dm.devices", new { accountKey = alice.Key })).ErrorCode());

            // History of the account's keys.
            var chain = (await bob.RequestAsync("account.rotations", new { accountKey = newKey })).Body().GetProperty("rotations");
            Assert.Equal(alice.Key, chain.EnumerateArray().Single().GetProperty("oldKey").GetString());
        }
        // Once the phone signed in with the new key, its hand-over is gone.
        Assert.Null(server.World.Store.HandoverFor(newKey, DeviceKeyOf(phone)));
    }

    [Fact]
    public async Task Rotations_need_both_keys_and_a_fresh_new_key()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var next = Ed25519.KeyFromSeed(Ed25519.NewSeed());
        using var other = Ed25519.KeyFromSeed(Ed25519.NewSeed());

        // The new key must sign too (no pointing your account at a key you don't hold).
        Assert.Equal("bad_request", (await alice.RequestAsync("account.rotate", new { rotation = Rotation(alice.Identity.Account, next, Now, signNewWith: other) })).ErrorCode());
        // Not into an existing account (merging into Bob).
        Assert.Equal("bad_request", (await alice.RequestAsync("account.rotate", new { rotation = Rotation(alice.Identity.Account, bob.Identity.Account, Now) })).ErrorCode());
        // Only your own account.
        Assert.Equal("forbidden", (await bob.RequestAsync("account.rotate", new { rotation = Rotation(alice.Identity.Account, next, Now) })).ErrorCode());
        // Not from the future, not garbage, bounded lists.
        Assert.Equal("bad_request", (await alice.RequestAsync("account.rotate", new { rotation = Rotation(alice.Identity.Account, next, Now + 3_600_000) })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("account.rotate", new { rotation = new { oldKey = alice.Key, newKey = KeyOf(next), rotatedAt = Now, oldSig = "x", newSig = "y" } })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("account.rotate", new
        {
            rotation = Rotation(alice.Identity.Account, next, Now),
            certs = Enumerable.Range(0, 21).Select(_ => Recertify(alice.Identity, next)).ToArray(),
        })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("account.rotate", new
        {
            rotation = Rotation(alice.Identity.Account, next, Now),
            handovers = new[] { new { device = DeviceKeyOf(alice.Identity), seal = "short" } },
        })).ErrorCode());
        await bob.NoEventAsync("member.rotated");
        Assert.Equal("result", (await alice.RequestAsync("ping")).Type()); // still the same account
    }

    [Fact]
    public async Task A_device_can_bring_the_rotation_to_a_server_that_missed_it()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice", "admin");
        using var bob = await server.JoinAsync("Bob");
        alice.Client.Dispose();
        using var k1 = Ed25519.KeyFromSeed(Ed25519.NewSeed());
        using var k2 = Ed25519.KeyFromSeed(Ed25519.NewSeed());
        var chain = new[] { Rotation(alice.Identity.Account, k1, Now - 1000), Rotation(k1, k2, Now) };

        // A broken chain is ignored: the device is just a stranger.
        var (broken, refused) = await LoginAsync(server, alice.Identity, Recertify(alice.Identity, k2), chain[1]);
        using (broken) Assert.Equal("invite_required", refused.ErrorCode());

        var (client, welcome) = await LoginAsync(server, alice.Identity, Recertify(alice.Identity, k2), chain);
        using (client)
        {
            Assert.Equal("welcome", welcome.Type());
            Assert.Equal("admin", welcome.Body().GetProperty("you").GetProperty("role").GetString());
            Assert.Equal(KeyOf(k1), (await bob.EventAsync("member.rotated")).Body().GetProperty("member").GetProperty("accountKey").GetString());
            Assert.Equal(KeyOf(k2), (await bob.EventAsync("member.rotated")).Body().GetProperty("member").GetProperty("accountKey").GetString());
            // Uploading the rest (other devices' certificates and hand-overs) afterwards is fine.
            Assert.Equal("already", (await client.RequestAsync("account.rotate", new { rotation = chain[1], certs = new[] { Recertify(alice.Identity, k2) } })).Body().GetProperty("status").GetString());
            Assert.Equal(2, (await bob.RequestAsync("account.rotations", new { accountKey = KeyOf(k2) })).Body().GetProperty("rotations").GetArrayLength());
        }
        // Both retired keys are refused, pointing at where the account went.
        using var oldDevice = new TestIdentity(k1);
        var (stale, staleReply) = await LoginAsync(server, oldDevice, oldDevice.Cert());
        using (stale)
        {
            Assert.Equal("account_rotated", staleReply.ErrorCode());
            Assert.Equal(KeyOf(k2), staleReply.Body().GetProperty("rotations")[0].GetProperty("newKey").GetString());
        }
    }

    [Fact]
    public async Task A_second_claim_on_the_old_key_is_a_dispute_that_an_admin_settles()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice", "trusted");
        using var thief = Ed25519.KeyFromSeed(Ed25519.NewSeed());
        using var real = Ed25519.KeyFromSeed(Ed25519.NewSeed());

        // Someone who has Alice's key rotates first. First valid rotation wins.
        Assert.Equal("applied", (await alice.RequestAsync("account.rotate", new { rotation = Rotation(alice.Identity.Account, thief, Now) })).Body().GetProperty("status").GetString());
        await admin.EventAsync("member.rotated");
        using var thiefDevice = new TestIdentity(thief);
        var (thiefClient, thiefWelcome) = await LoginAsync(server, thiefDevice, thiefDevice.Cert());
        Assert.Equal("trusted", thiefWelcome.Body().GetProperty("you").GetProperty("role").GetString());

        // Alice's own device notices and claims the old key for a new key of hers: the server records a dispute.
        var (claim, disputed) = await LoginAsync(server, alice.Identity, Recertify(alice.Identity, real), Rotation(alice.Identity.Account, real, Now));
        using (claim)
        {
            Assert.Equal("account_disputed", disputed.ErrorCode());
            Assert.Equal(KeyOf(thief), disputed.Body().GetProperty("rotations")[0].GetProperty("newKey").GetString());
        }
        var notice = (await admin.EventAsync("account.disputed")).Body();
        Assert.True(notice.GetProperty("rotation").GetProperty("disputed").GetBoolean());
        Assert.Equal(KeyOf(real), notice.GetProperty("rotation").GetProperty("contest").GetProperty("newKey").GetString());
        Assert.Equal("member", notice.GetProperty("member").GetProperty("role").GetString()); // capped until settled

        // A third claim isn't recorded; nobody but an admin can settle it.
        using var third = Ed25519.KeyFromSeed(Ed25519.NewSeed());
        var (late, lateReply) = await LoginAsync(server, alice.Identity, Recertify(alice.Identity, third), Rotation(alice.Identity.Account, third, Now));
        using (late) Assert.Equal("invite_required", lateReply.ErrorCode());
        Assert.Equal("forbidden", (await thiefClient.RequestAsync("account.dispute.resolve", new { oldKey = alice.Key, keep = KeyOf(thief) })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("account.dispute.resolve", new { oldKey = alice.Key, keep = KeyOf(third) })).ErrorCode());

        // The admin knows Alice and gives the account to her key: the thief is signed out, Alice gets her role back.
        Assert.Equal("result", (await admin.RequestAsync("account.dispute.resolve", new { oldKey = alice.Key, keep = KeyOf(real) })).Type());
        await thiefClient.EventAsync("account.rotated");
        Assert.Equal(4409, await thiefClient.ReceiveCloseAsync());
        thiefClient.Dispose();
        var resolved = (await admin.EventAsync("account.resolved")).Body();
        Assert.Equal(KeyOf(thief), resolved.GetProperty("previousKey").GetString());
        Assert.Equal(KeyOf(real), resolved.GetProperty("member").GetProperty("accountKey").GetString());

        var (back, welcome) = await LoginAsync(server, alice.Identity, Recertify(alice.Identity, real));
        using (back) Assert.Equal("trusted", welcome.Body().GetProperty("you").GetProperty("role").GetString());
        var (gone, goneReply) = await LoginAsync(server, thiefDevice, thiefDevice.Cert());
        using (gone) Assert.Equal("invite_required", goneReply.ErrorCode());
        Assert.Equal("not_found", (await admin.RequestAsync("account.dispute.resolve", new { oldKey = alice.Key, keep = KeyOf(real) })).ErrorCode());
    }

    [Fact]
    public async Task Keeping_the_first_key_restores_its_role_and_late_claims_are_refused()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice", "trusted");
        using var mine = Ed25519.KeyFromSeed(Ed25519.NewSeed());
        using var thief = Ed25519.KeyFromSeed(Ed25519.NewSeed());

        await alice.RequestAsync("account.rotate", new { rotation = Rotation(alice.Identity.Account, mine, Now) });
        using var thiefDevice = new TestIdentity(thief);
        var (claim, reply) = await LoginAsync(server, thiefDevice, thiefDevice.Cert(), Rotation(alice.Identity.Account, thief, Now));
        using (claim) Assert.Equal("account_disputed", reply.ErrorCode());
        await admin.EventAsync("account.disputed");
        Assert.Equal("member", server.World.Store.GetMember(KeyOf(mine))!.Role);

        await admin.RequestAsync("account.dispute.resolve", new { oldKey = alice.Key, keep = KeyOf(mine) });
        Assert.Equal("trusted", server.World.Store.GetMember(KeyOf(mine))!.Role);

        // After the contest window, a different claim on the old key is simply refused.
        using var server2 = new IskraServer();
        using var bob = await server2.JoinAsync("Bob");
        using var bobNext = Ed25519.KeyFromSeed(Ed25519.NewSeed());
        await bob.RequestAsync("account.rotate", new { rotation = Rotation(bob.Identity.Account, bobNext, Now) });
        Backdate(server2, bob.Key, Now - KeyFeature.ContestWindowMs - 1000);
        using var bobThief = new TestIdentity(Ed25519.KeyFromSeed(Ed25519.NewSeed()));
        var (lateClaim, late) = await LoginAsync(server2, bobThief, bobThief.Cert(), Rotation(bob.Identity.Account, bobThief.Account, Now));
        using (lateClaim) Assert.Equal("invite_required", late.ErrorCode());
        Assert.False(server2.World.Store.RotationFrom(bob.Key)!.Disputed);
    }

    /// <summary>
    /// Every table that holds account keys moves with a rotation: the naming convention (account_key, *_key, *_by, uploader)
    /// plus the audit log and a group's member list. Only signed statements keep the old key.
    /// </summary>
    [Fact]
    public async Task A_rotation_moves_the_account_in_every_feature()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice", "admin");
        using var bob = await server.JoinAsync("Bob");
        var a = alice.Key;
        var b = bob.Key;
        var store = server.World.Store;
        var stage = store.CreateChannel("stage", "stage", "member", "member", 0).Id;
        var forum = store.CreateChannel("help", "forum", "member", "member", 0);
        var post = store.CreateForumPost(forum, a, "question", "body", [], [], Now);
        using (var db = new SqliteConnection($"Data Source={Path.Combine(server.WorldPath, "iskra.db")};Pooling=False"))
        {
            db.Open();
            void Sql(string sql)
            {
                using var cmd = db.CreateCommand();
                cmd.CommandText = sql;
                cmd.Parameters.AddWithValue("$a", a);
                cmd.Parameters.AddWithValue("$b", b);
                cmd.Parameters.AddWithValue("$stage", stage);
                cmd.Parameters.AddWithValue("$now", Now);
                cmd.Parameters.AddWithValue("$members", JsonSerializer.Serialize(new[] { b, a }));
                cmd.ExecuteNonQuery();
            }
            Sql("INSERT INTO blocks (account_key, blocked_key, blocked, at) VALUES ($a, $b, 1, $now), ($b, $a, 1, $now);");
            Sql("INSERT INTO timeouts (account_key, until, reason, by_key, at) VALUES ($b, $now + 60000, 'x', $a, $now);");
            Sql("INSERT INTO audit_log (at, action, actor, actor_name, target, target_name) VALUES ($now, 'member.kick', $a, 'Alice', $b, 'Bob'), ($now, 'member.timeout', $b, 'Bob', $a, 'Alice');");
            Sql("INSERT INTO nicknames (account_key, nick) VALUES ($a, 'Al');");
            Sql("INSERT INTO account_prefs (account_key, name, data, updated_at) VALUES ($a, 'rail', 'sealed', $now);");
            Sql("INSERT INTO roles (id, name, position, created_at) VALUES (5, 'Crew', 1, $now);");
            Sql("INSERT INTO member_roles (account_key, role_id) VALUES ($a, 5);");
            Sql("INSERT INTO send_nonces (account_key, nonce, message_id, created_at) VALUES ($a, 'nonce-123', 1, $now);");
            Sql("INSERT INTO dm_files (file_id, uploader) VALUES ('dmf1', $a);");
            Sql("INSERT INTO dm_file_access (file_id, account_key) VALUES ('dmf1', $a), ('dmf1', $b);");
            Sql("INSERT INTO stickers (id, name, file_id, created_by, created_at) VALUES ('st1', 'wave', 'f', $a, $now);");
            Sql("INSERT INTO notify_settings (account_key, channel_id, level) VALUES ($a, 0, 'all');");
            Sql("INSERT INTO presence (account_key, status, updated_at) VALUES ($a, 'dnd', $now);");
            Sql("INSERT INTO events (id, title, start_at, end_at, time_zone, location_kind, location, created_by, created_at) VALUES (77, 't', $now + 3600000, $now + 7200000, 'UTC', 'place', 'here', $a, $now);");
            Sql("INSERT INTO event_interest (event_id, account_key, created_at) VALUES (77, $a, $now);");
            Sql("INSERT INTO stage_moderators (channel_id, account_key, added_by, added_at) VALUES ($stage, $a, $a, $now);");
            Sql("INSERT INTO groups (id, created_by, created_at, version, head, members) VALUES ('g1', $a, $now, 1, 'h', $members);");
            Sql("INSERT INTO group_members (group_id, account_key) VALUES ('g1', $a), ('g1', $b);");
            Sql("INSERT INTO group_changes (group_id, version, payload, sig, created_at) VALUES ('g1', 1, $a, 'sig', $now);");
            Sql("INSERT INTO group_messages (group_id, from_key, version, envelope, created_at) VALUES ('g1', $a, 1, '{}', $now);");
            Sql("INSERT INTO pins (message_id, channel_id, pinned_by, pinned_at) VALUES ((SELECT id FROM messages LIMIT 1), 0, $a, $now);");
        }

        using var next = Ed25519.KeyFromSeed(Ed25519.NewSeed());
        var newKey = KeyOf(next);
        var result = await alice.RequestAsync("account.rotate", new
        {
            rotation = Rotation(alice.Identity.Account, next, Now), certs = new[] { Recertify(alice.Identity, next) }, handovers = Array.Empty<object>(),
        });
        Assert.Equal("applied", result.Body().GetProperty("status").GetString());

        // The old key is gone from every column of every table, except the signed statements.
        var signed = new HashSet<string> { "account_rotations", "rotation_handovers", "device_revocations", "devices", "group_changes" };
        using (var db = new SqliteConnection($"Data Source={Path.Combine(server.WorldPath, "iskra.db")};Mode=ReadOnly;Pooling=False"))
        {
            db.Open();
            var tables = new List<string>();
            using (var list = db.CreateCommand())
            {
                list.CommandText = "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND sql NOT LIKE 'CREATE VIRTUAL%';";
                using var r = list.ExecuteReader();
                while (r.Read()) tables.Add(r.GetString(0));
            }
            foreach (var table in tables.Where(t => !signed.Contains(t)))
            {
                var columns = new List<string>();
                using (var info = db.CreateCommand())
                {
                    info.CommandText = $"SELECT name FROM pragma_table_info('{table}');";
                    using var r = info.ExecuteReader();
                    while (r.Read()) columns.Add(r.GetString(0));
                }
                foreach (var column in columns)
                {
                    using var cmd = db.CreateCommand();
                    cmd.CommandText = $"SELECT COUNT(*) FROM \"{table}\" WHERE CAST(\"{column}\" AS TEXT) LIKE '%' || $a || '%';";
                    cmd.Parameters.AddWithValue("$a", a);
                    Assert.True(Convert.ToInt64(cmd.ExecuteScalar()) == 0, $"{table}.{column} still has the old key");
                }
            }
        }
        Assert.Equal(newKey, store.GetForumPost(post.Id)!.Thread.CreatedBy);
        Assert.Equal(newKey, store.GetEvent(77)!.CreatedBy);
        Assert.Equal([newKey], store.Interested(77));
        Assert.True(store.EitherBlocked(newKey, b));
        Assert.Contains(newKey, JsonSerializer.Deserialize<string[]>(ReadGroupMembers(server))!);
    }

    private static string ReadGroupMembers(IskraServer server)
    {
        using var db = new SqliteConnection($"Data Source={Path.Combine(server.WorldPath, "iskra.db")};Mode=ReadOnly;Pooling=False");
        db.Open();
        using var cmd = db.CreateCommand();
        cmd.CommandText = "SELECT members FROM groups WHERE id = 'g1';";
        return (string)cmd.ExecuteScalar()!;
    }
}
