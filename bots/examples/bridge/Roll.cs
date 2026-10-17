// A dice bot in C#, one file, no SDK: the bridge does the Iskra part, this reads and writes JSON lines.
//   npx iskra-bots bridge --name Roll --invite '<bot invite link>' -- dotnet run Roll.cs
// (.NET 10 runs a single .cs file. Lines that aren't JSON, like build output, only go to the bridge's log.)
using System.Text;
using System.Text.Json.Nodes;

var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
var nextId = 0;
void Send(string type, JsonObject body) =>
    output.WriteLine(new JsonObject { ["id"] = ++nextId, ["type"] = type, ["body"] = body }.ToJsonString());

while (input.ReadLine() is { } line)
{
    if (JsonNode.Parse(line) is not JsonObject msg) continue;
    var body = msg["body"] as JsonObject ?? new JsonObject();
    switch ((string?)msg["event"])
    {
        case "hello":
            Send("bridge.commands", new JsonObject
            {
                ["commands"] = new JsonArray(new JsonObject
                {
                    ["name"] = "roll", ["description"] = "Rolls a die", ["usage"] = "20",
                    ["options"] = new JsonArray(new JsonObject { ["name"] = "sides", ["description"] = "How many sides (default 6)", ["type"] = "integer" }),
                }),
            });
            break;
        case "command" when (string?)body["command"] == "roll":
            var sides = (int?)body["options"]?["sides"] ?? 6;
            var text = sides is >= 2 and <= 1000
                ? $"{(string?)body["userName"]} rolled **{Random.Shared.Next(1, sides + 1)}** (d{sides})"
                : "A die has 2 to 1000 sides.";
            Send("bridge.reply", new JsonObject { ["ref"] = (string?)msg["ref"], ["text"] = text, ["private"] = sides is < 2 or > 1000 });
            break;
        case "stopped":
            return 1;
    }
    if (msg["ok"] is JsonValue ok && !ok.GetValue<bool>())
        Console.Error.WriteLine($"request {msg["id"]} failed: {msg["error"]?["code"]}");
}
return 0;
