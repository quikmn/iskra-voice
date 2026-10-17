# A dice bot in plain Python, without the SDK: the bridge does the Iskra part, this reads and writes JSON lines.
#   npx iskra-bots bridge --name Roll --invite '<bot invite link>' -- python roll.py
import json, random, re, sys
sys.stdin.reconfigure(encoding="utf-8")

def send(type, body, id=[0]):
    id[0] += 1
    print(json.dumps({"id": id[0], "type": type, "body": body}), flush=True)

for line in sys.stdin:
    msg = json.loads(line)
    event, body = msg.get("event"), msg.get("body", {})
    if event == "hello":
        send("bridge.commands", {"commands": [{"name": "roll", "description": "Rolls dice", "usage": "2d6",
            "options": [{"name": "dice", "description": "Like 2d6", "type": "string"}]}]})
    elif event == "command" and body["command"] == "roll":
        m = re.fullmatch(r"(\d{0,2})d(\d{1,3})", str(body["options"].get("dice") or body["args"] or "d6"))
        if not m or int(m[2]) < 2:
            send("bridge.reply", {"ref": msg["ref"], "text": "Try /roll 2d6", "private": True})
            continue
        rolls = [random.randint(1, int(m[2])) for _ in range(int(m[1] or 1))]
        send("bridge.reply", {"ref": msg["ref"], "text": f"{body['userName']} rolled **{sum(rolls)}** ({', '.join(map(str, rolls))})"})
    elif event == "message" and "good bot" in body["message"]["text"].lower():
        send("bridge.react", {"ref": msg["ref"], "emoji": "🤖"})
    elif event == "stopped":
        sys.exit(1)
    elif "ok" in msg and not msg["ok"]:
        print(f"request {msg['id']} failed: {msg['error']['code']}", file=sys.stderr)
