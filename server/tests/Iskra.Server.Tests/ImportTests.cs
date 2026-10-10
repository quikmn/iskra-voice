using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Files;
using Iskra.Server.Import;
using Iskra.Server.Tests.Support;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

public class ImportTests
{
    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 16, 0, 0, 0, 16];

    private static JsonObject User(string id, string name, string? nickname = null, string? avatar = null, bool bot = false) => new()
    {
        ["id"] = id, ["name"] = name, ["discriminator"] = "0000", ["nickname"] = nickname ?? name, ["color"] = null,
        ["isBot"] = bot, ["roles"] = new JsonArray(new JsonObject { ["id"] = "1", ["name"] = "Mods", ["color"] = "#ff0000", ["position"] = 1 }),
        ["avatarUrl"] = avatar ?? $"https://cdn.discordapp.com/avatars/{id}/abc.png",
    };

    private static JsonObject Message(string id, string time, JsonObject author, string content, JsonArray? attachments = null,
        JsonArray? reactions = null, string? replyTo = null, bool pinned = false, string type = "Default")
    {
        var m = new JsonObject
        {
            ["id"] = id, ["type"] = replyTo is null ? type : "Reply", ["timestamp"] = time, ["timestampEdited"] = null,
            ["callEndedTimestamp"] = null, ["isPinned"] = pinned, ["content"] = content, ["author"] = author.DeepClone(),
            ["attachments"] = attachments ?? [], ["embeds"] = new JsonArray(), ["stickers"] = new JsonArray(),
            ["reactions"] = reactions ?? [], ["mentions"] = new JsonArray(), ["inlineEmojis"] = new JsonArray(),
        };
        if (replyTo is not null) m["reference"] = new JsonObject { ["messageId"] = replyTo, ["channelId"] = "100", ["guildId"] = "1" };
        return m;
    }

    private static string Export(string channelId, string name, string? category, string? categoryId, JsonArray messages, string type = "GuildTextChat") =>
        new JsonObject
        {
            ["guild"] = new JsonObject { ["id"] = "1", ["name"] = "Old Discord", ["iconUrl"] = "https://cdn.discordapp.com/icons/1/x.png" },
            ["channel"] = new JsonObject { ["id"] = channelId, ["type"] = type, ["categoryId"] = categoryId, ["category"] = category, ["name"] = name, ["topic"] = null },
            ["dateRange"] = new JsonObject { ["after"] = null, ["before"] = null },
            ["exportedAt"] = "2026-01-01T00:00:00+00:00",
            ["messages"] = messages,
            ["messageCount"] = messages.Count,
        }.ToJsonString(new JsonSerializerOptions { WriteIndented = true });

    /// <summary>A zip like DiscordChatExporter makes with --media: exports plus their _Files folders.</summary>
    private static byte[] SampleZip()
    {
        var ann = User("200", "ann", "Annie", "general [100].json_Files\\avatar-AAAAA.png");
        var bob = User("201", "bob", avatar: "general [100].json_Files/not-an-image-BBBBB.png");
        var bot = User("202", "Dicey", bot: true);
        var general = Export("100", "general", "Text Channels", "50", [
            Message("1001", "2021-03-04T10:00:00.000+00:00", ann, "Hello **everyone**",
                attachments: [new JsonObject { ["id"] = "9", ["url"] = "general [100].json_Files\\cat-CCCCC.png", ["fileName"] = "cat.png", ["fileSizeBytes"] = Png.Length }],
                reactions: [
                    new JsonObject { ["emoji"] = new JsonObject { ["id"] = "", ["name"] = "👍", ["code"] = "thumbsup", ["isAnimated"] = false }, ["count"] = 3, ["users"] = new JsonArray() },
                    new JsonObject { ["emoji"] = new JsonObject { ["id"] = "77", ["name"] = "pog", ["code"] = "pog", ["isAnimated"] = false }, ["count"] = 2, ["users"] = new JsonArray() },
                ], pinned: true),
            Message("1002", "2021-03-04T10:01:00.000+00:00", bob, "hi ann", replyTo: "1001",
                attachments: [
                    new JsonObject { ["id"] = "10", ["url"] = "https://cdn.discordapp.com/attachments/1/2/remote.zip", ["fileName"] = "remote.zip", ["fileSizeBytes"] = 1234 },
                    new JsonObject { ["id"] = "11", ["url"] = "../../../etc/passwd", ["fileName"] = "passwd", ["fileSizeBytes"] = 10 },
                    new JsonObject { ["id"] = "12", ["url"] = "general [100].json_Files/notes-DDDDD.png", ["fileName"] = "notes.png", ["fileSizeBytes"] = 5 },
                ]),
            Message("1003", "2021-03-04T10:02:00.000+00:00", ann, "Annie joined the server.", type: "GuildMemberJoin"),
            Message("1004", "2021-03-04T10:03:00.000+00:00", bot, "rolled a 6\u0007 with a bell"),
        ]);
        var thread = Export("1001", "Cat talk", "general", "100", [
            Message("3001", "2021-03-04T11:00:00.000+00:00", bob, "nice cat"),
        ], type: "GuildPublicThread");
        // A partitioned channel, parts out of order in the zip.
        var part2 = Export("110", "Off Topic", "Text Channels", "50", [Message("1102", "2021-05-01T00:00:00Z", bob, "second")]);
        var part1 = Export("110", "Off Topic", "Text Channels", "50", [Message("1101", "2021-04-01T00:00:00Z", ann, "first")]);

        using var output = new MemoryStream();
        using (var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            void Add(string name, byte[] data)
            {
                using var stream = zip.CreateEntry(name).Open();
                stream.Write(data);
            }
            Add("export/general [100].json", Encoding.UTF8.GetBytes(general));
            Add("export/general [100].json_Files/avatar-AAAAA.png", Png);
            Add("export/general [100].json_Files/not-an-image-BBBBB.png", "plain text"u8.ToArray());
            Add("export/general [100].json_Files/cat-CCCCC.png", Png);
            Add("export/general [100].json_Files/notes-DDDDD.png", "notes"u8.ToArray());
            Add("export/general - Cat talk [1001].json", Encoding.UTF8.GetBytes(thread));
            Add("export/off-topic [110] [part 2].json", Encoding.UTF8.GetBytes(part2));
            Add("export/off-topic [110] [part 1].json", Encoding.UTF8.GetBytes(part1));
            Add("../outside.json", Encoding.UTF8.GetBytes(general));
            Add("export/readme.txt", "hi"u8.ToArray());
        }
        return output.ToArray();
    }

    private static async Task<JsonElement> UploadAsync(IskraServer server, User owner, byte[] data, bool readOnly = false)
    {
        var ticket = (await owner.RequestAsync("import.begin", new { size = data.Length, readOnly })).Body();
        using var response = await server.CreateClient().PutAsync(ticket.GetProperty("url").GetString(), new ByteArrayContent(data));
        Assert.Equal(System.Net.HttpStatusCode.Accepted, response.StatusCode);
        while (true)
        {
            var job = (await owner.EventAsync("import.progress")).Body().GetProperty("job");
            if (job.GetProperty("phase").GetString() is "done" or "failed" or "cancelled") return job;
        }
    }

    [Fact]
    public async Task Imported_channels_go_into_categories_by_name_in_discords_order()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        var existing = server.World.Store.CreateCategory("info"); // reused, ignoring case
        var ann = User("200", "ann");
        var exports = new (string File, string Json)[]
        {
            ("rules [301].json", Export("301", "rules", "Info", "40", [Message("1", "2021-01-01T00:00:00Z", ann, "be nice")])),
            ("general [302].json", Export("302", "general", "Text Channels", "50", [Message("2", "2021-01-01T00:00:00Z", ann, "hi")])),
            ("off-topic [303].json", Export("303", "off-topic", "Text Channels", "50", [Message("3", "2021-01-01T00:00:00Z", ann, "lol")])),
            ("lounge [304].json", Export("304", "lounge", null, null, [Message("4", "2021-01-01T00:00:00Z", ann, "hey")])),
        };
        using var output = new MemoryStream();
        using (var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (file, json) in exports)
            {
                using var stream = zip.CreateEntry(file).Open();
                stream.Write(Encoding.UTF8.GetBytes(json));
            }
        }

        var job = await UploadAsync(server, owner, output.ToArray());
        Assert.Equal("done", job.GetProperty("phase").GetString());
        var categories = server.World.Store.AllCategories();
        Assert.Equal(["info", "Text Channels"], categories.Select(c => c.Name));
        Assert.Equal(existing.Id, categories[0].Id);
        var channels = server.World.Store.AllChannels();
        long? CategoryOf(string name) => channels.Single(c => c.Name == name).CategoryId;
        Assert.Equal(existing.Id, CategoryOf("rules"));
        Assert.Equal(categories[1].Id, CategoryOf("general-2"));
        Assert.Equal(categories[1].Id, CategoryOf("off-topic"));
        Assert.Null(CategoryOf("lounge"));
        var inText = channels.Where(c => c.CategoryId == categories[1].Id).Select(c => c.Name).ToList();
        Assert.Equal(["general-2", "off-topic"], inText); // Discord's order
    }

    [Fact]
    public async Task Owner_imports_a_discord_export_with_media()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");
        var zip = SampleZip();

        var job = await UploadAsync(server, owner, zip);
        Assert.Equal("done", job.GetProperty("phase").GetString());
        Assert.Equal(6, job.GetProperty("messagesDone").GetInt64()); // the join notice is skipped
        Assert.Equal(2, job.GetProperty("files").GetInt32()); // cat.png and notes.png
        Assert.Equal(2, job.GetProperty("missingFiles").GetInt32());

        // Everyone gets the new channels; "general" was taken, so it got a suffix.
        var channels = (await member.EventAsync("channels")).Body().GetProperty("channels").EnumerateArray().Select(c => c.GetProperty("name").GetString()).ToList();
        Assert.Contains("general-2", channels);
        Assert.Contains("off-topic", channels);
        var imported = job.GetProperty("imported").EnumerateArray().ToList();
        Assert.Equal("Text Channels", imported.Single(c => c.GetProperty("name").GetString() == "general-2").GetProperty("category").GetString());
        var generalId = imported.Single(c => c.GetProperty("name").GetString() == "general-2").GetProperty("id").GetInt64();
        Assert.Equal("Text Channels", server.World.Store.ImportedCategory(generalId));

        var history = (await member.RequestAsync("chat.history", new { channelId = generalId })).Body().GetProperty("messages").EnumerateArray().ToList();
        Assert.Equal(3, history.Count);
        var first = history[0];
        Assert.Equal("discord:200", first.GetProperty("author").GetString());
        Assert.Equal(DateTimeOffset.Parse("2021-03-04T10:00:00Z").ToUnixTimeMilliseconds(), first.GetProperty("createdAt").GetInt64());
        Assert.Equal("Hello **everyone**", first.GetProperty("text").GetString());
        Assert.True(first.GetProperty("pinned").GetBoolean());
        var view = first.GetProperty("imported");
        Assert.Equal("discord", view.GetProperty("source").GetString());
        Assert.Equal("Annie", view.GetProperty("name").GetString());
        Assert.Equal("image/png", view.GetProperty("avatar").GetProperty("type").GetString());
        Assert.Equal("👍", view.GetProperty("reactions")[0].GetProperty("emoji").GetString());
        Assert.Equal(3, view.GetProperty("reactions")[0].GetProperty("count").GetInt32());
        Assert.Equal(":pog:", view.GetProperty("reactions")[1].GetProperty("emoji").GetString());
        Assert.Equal("image/png", first.GetProperty("attachments")[0].GetProperty("type").GetString());
        Assert.Equal(16, first.GetProperty("attachments")[0].GetProperty("width").GetInt32());
        // Real reactions still work on top.
        Assert.Equal("result", (await member.RequestAsync("chat.react", new { id = first.GetProperty("id").GetInt64(), emoji = "🎉" })).Type());

        var reply = history[1];
        Assert.Equal(first.GetProperty("id").GetInt64(), reply.GetProperty("replyTo").GetProperty("id").GetInt64());
        Assert.Equal("Annie", reply.GetProperty("replyTo").GetProperty("importedName").GetString());
        Assert.Equal(JsonValueKind.Null, reply.GetProperty("imported").GetProperty("avatar").ValueKind); // "not-an-image" wasn't one
        // Files are typed by content, whatever their name says; remote and out-of-zip ones are listed as missing.
        Assert.Equal("application/octet-stream", reply.GetProperty("attachments")[0].GetProperty("type").GetString());
        var missing = reply.GetProperty("imported").GetProperty("missingAttachments").EnumerateArray().Select(m => m.GetProperty("name").GetString()).ToList();
        Assert.Equal(["remote.zip", "passwd"], missing);

        var botPost = history[2];
        Assert.Equal("rolled a 6 with a bell", botPost.GetProperty("text").GetString()); // control character dropped
        Assert.True(botPost.GetProperty("imported").GetProperty("bot").GetBoolean());

        // The thread hangs off the message it started from.
        Assert.Equal("Cat talk", first.GetProperty("thread").GetProperty("name").GetString());
        var threadId = first.GetProperty("thread").GetProperty("id").GetInt64();
        var inThread = (await member.RequestAsync("chat.history", new { channelId = threadId })).Body().GetProperty("messages");
        Assert.Equal("nice cat", inThread[0].GetProperty("text").GetString());

        // Partitioned exports land in order.
        var offTopic = imported.Single(c => c.GetProperty("name").GetString() == "off-topic").GetProperty("id").GetInt64();
        var parts = (await member.RequestAsync("chat.history", new { channelId = offTopic })).Body().GetProperty("messages");
        Assert.Equal(["first", "second"], parts.EnumerateArray().Select(m => m.GetProperty("text").GetString()).ToArray());

        // Imported messages can't be edited by anyone; the owner can delete them.
        Assert.Equal("forbidden", (await owner.RequestAsync("chat.edit", new { id = first.GetProperty("id").GetInt64(), text = "x" })).ErrorCode());
        Assert.Equal("result", (await owner.RequestAsync("chat.delete", new { id = botPost.GetProperty("id").GetInt64() })).Type());

        // Search finds them like any message.
        var found = (await member.RequestAsync("search", new { query = "cat" })).Body().GetProperty("results");
        Assert.Equal("nice cat", found[0].GetProperty("message").GetProperty("text").GetString());

        // The sweep keeps imported avatars and attachments.
        server.World.Store.DeleteUnreferencedFiles(long.MaxValue, []);
        Assert.NotNull(server.World.Store.GetFile(view.GetProperty("avatar").GetProperty("id").GetString()!));
        Assert.NotNull(server.World.Store.GetFile(first.GetProperty("attachments")[0].GetProperty("id").GetString()!));
    }

    [Fact]
    public async Task Only_the_owner_imports_and_uploads_are_checked()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        Assert.Equal("forbidden", (await admin.RequestAsync("import.begin", new { size = 10 })).ErrorCode());
        Assert.Equal("forbidden", (await admin.RequestAsync("import.status")).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("import.begin", new { size = 5L * 1024 * 1024 * 1024 * 1024 })).ErrorCode());

        // Not a zip or JSON: refused by content.
        var ticket = (await owner.RequestAsync("import.begin", new { size = Png.Length })).Body().GetProperty("url").GetString();
        using (var response = await server.CreateClient().PutAsync(ticket, new ByteArrayContent(Png)))
            Assert.Equal(System.Net.HttpStatusCode.UnsupportedMediaType, response.StatusCode);
        // Tickets are single use.
        using (var again = await server.CreateClient().PutAsync(ticket, new ByteArrayContent("{}"u8.ToArray())))
            Assert.Equal(System.Net.HttpStatusCode.Forbidden, again.StatusCode);

        // JSON that isn't an export fails cleanly and leaves nothing behind.
        var before = server.World.Store.AllChannels().Count;
        var job = await UploadAsync(server, owner, "{ \"hello\": [1, 2, 3] }"u8.ToArray());
        Assert.Equal("failed", job.GetProperty("phase").GetString());
        Assert.Contains("No channels", job.GetProperty("error").GetString());
        Assert.Equal(before, server.World.Store.AllChannels().Count);
        Assert.Equal("failed", (await owner.RequestAsync("import.status")).Body().GetProperty("job").GetProperty("phase").GetString());

        // A single JSON export works without media: files show as not included; read-only makes it an archive.
        var json = Export("5", "Announcements", null, null, [Message("1", "2022-01-01T00:00:00Z", User("9", "zed"), "news",
            attachments: [new JsonObject { ["id"] = "1", ["url"] = "Announcements.json_Files/x.png", ["fileName"] = "x.png", ["fileSizeBytes"] = 4 }])]);
        job = await UploadAsync(server, owner, Encoding.UTF8.GetBytes("\uFEFF" + json), readOnly: true);
        Assert.True(job.GetProperty("phase").GetString() == "done", job.ToString());
        Assert.Equal(1, job.GetProperty("missingFiles").GetInt32());
        var channel = server.World.Store.AllChannels().Single(c => c.Name == "announcements");
        Assert.Equal("admin", channel.WriteRole);
    }

    [Fact]
    public void Reader_streams_big_exports_through_a_small_buffer()
    {
        var messages = new JsonArray();
        for (var i = 0; i < 3000; i++) messages.Add(Message($"{i + 1}", "2023-01-01T00:00:00Z", User("1", "a"), new string('x', 500)));
        var json = Encoding.UTF8.GetBytes(Export("1", "big", null, null, messages));
        Assert.True(json.Length > 1024 * 1024);
        var reader = new DceReader(new MemoryStream(json));
        var count = 0;
        reader.Read(m =>
        {
            Assert.Equal(500, m!.Content!.Length);
            count++;
            return true;
        });
        Assert.Equal(3000, count);
        Assert.Equal("big", reader.Channel?.Name);

        // A UTF-8 byte order mark (Windows tools add one) is fine.
        var withBom = new DceReader(new MemoryStream([0xEF, 0xBB, 0xBF, .. Encoding.UTF8.GetBytes(Export("7", "bom", null, null, []))]));
        withBom.Read(_ => true);
        Assert.Equal("bom", withBom.Channel?.Name);

        Assert.Throws<InvalidDataException>(() => new DceReader(new MemoryStream(json[..(json.Length / 2)])).Read(_ => true));
        Assert.Throws<InvalidDataException>(() => new DceReader(new MemoryStream("[1,2]"u8.ToArray())).Read(_ => true));
        // One giant value is refused instead of buffered without end.
        var huge = Encoding.UTF8.GetBytes("{\"messages\":[{\"content\":\"" + new string('y', DceReader.MaxValueBytes + 10) + "\"}]}");
        Assert.Throws<InvalidDataException>(() => new DceReader(new MemoryStream(huge)).Read(_ => true));
    }

    [Fact]
    public void Zip_entry_names_and_references_never_leave_the_archive()
    {
        Assert.Null(ExportSource.SafeEntryName("../x.json"));
        Assert.Null(ExportSource.SafeEntryName("a/../../x.json"));
        Assert.Null(ExportSource.SafeEntryName("/etc/passwd"));
        Assert.Null(ExportSource.SafeEntryName("C:\\Windows\\x"));
        Assert.Equal("a/b.json", ExportSource.SafeEntryName(".\\a\\b.json"));
        Assert.Null(ExportSource.Resolve("export", "../../x.png"));
        Assert.Equal("export/f_Files/x.png", ExportSource.Resolve("export", "f_Files\\x.png"));
        Assert.Equal("zip", ExportSource.Sniff("PK\u0003\u0004"u8));
        Assert.Equal("json", ExportSource.Sniff(" \n{"u8));
        Assert.Null(ExportSource.Sniff("<html>"u8));
        Assert.Equal("game-night", DiscordImporter.ChannelName("Game Night"));
        Assert.Equal("imported", DiscordImporter.ChannelName("\u200B"));
    }
}
