# The assistant (bring your own AI)

Iskra doesn't come with AI, and it never sees what you ask one. If you want help from an AI model, you bring your own:
a key from an AI provider, or a model running on your own computer. The app then talks to that provider straight from
your device, only when you press **Send**.

The assistant can:

- answer "how do I…" questions about Iskra, from Iskra's own docs (hosting, bots, this page, the wire protocol);
- help you write a bot, and set one up on your server;
- summarize or search channels you can read, when you ask;
- organize your server: create, rename and move channels and categories;
- make a colour theme from a description;
- if you turn them on: moderate (time out, warn, kick, ban, delete messages) and change server settings (roles, rules,
  deleting channels).

Every change shows you exactly what it will do and waits for your OK.

## Turning it on

1. Open **My settings → Assistant** and turn on the assistant. It's off until you do.
2. Pick a provider. **Anthropic (Claude)** is the default; the others are OpenAI, Mistral, Groq, OpenRouter, Google
   Gemini, any other OpenAI-compatible service, or a model on your own computer with **Ollama** or **LM Studio**.
3. Paste your API key and press **Save key**. Local models usually need no key.
4. Press **Test connection**. It lists the models your key can use (this costs nothing), so you can pick one under
   **Model**. For Anthropic the default model is `claude-opus-5-5`.
5. Open the assistant with the sparkle button in the server list (a sheet on phones).

The privacy line at the top of the panel always says where your messages go, for example "What you send goes to
api.anthropic.com. Iskra never sees it."

## Privacy

- **Nothing is sent until you press Send.** Then your message, the conversation so far and what the assistant's tools
  read for that question go to the provider you chose, under that provider's own terms. Iskra and your servers never
  see it.
- **Your key stays on your device**, encrypted with the device's other secrets (the same protection as your account
  keys), never in plain browser storage. It goes only to the address it was saved for: if you change the address to
  another site, the saved key is removed and you save it again.
- **Encrypted chats are never read for you.** The tools can't open direct messages, groups or end-to-end encrypted
  channels. If you want help with text from one, paste it yourself.
- **Reads are small.** Tools return names, ids and short message texts (at most 50 recent messages of one channel),
  never keys, recovery codes, tokens, invite links or passwords.
- The conversation is kept only in memory: it's gone when you press **New conversation** or close the app. The
  **Activity** tab lists what the assistant did (which tool, on which server, the outcome), on this device only.

## Providers

| Provider | Address (filled in for you) | Notes |
|---|---|---|
| Anthropic | `https://api.anthropic.com` | The web and phone apps send Anthropic's `anthropic-dangerous-direct-browser-access` header, which Anthropic requires for requests from a web page. The key is your own and stays on your device. |
| OpenAI | `https://api.openai.com/v1` | |
| Mistral | `https://api.mistral.ai/v1` | |
| Groq | `https://api.groq.com/openai/v1` | |
| OpenRouter | `https://openrouter.ai/api/v1` | |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | Gemini's OpenAI-compatible API |
| Ollama | `http://localhost:11434/v1` | On this computer, no key |
| LM Studio | `http://localhost:1234/v1` | On this computer, no key |

Any other OpenAI-compatible service works too. Addresses must use `https`; plain `http` only works for `localhost`
(a model on the same computer). The model has to support tool calls for the assistant to act; without them it can still
answer questions.

**The desktop app** sends provider requests from its main process, so browser rules (CORS) don't get in the way. The
page tells the app the address you saved, and the app sends requests only to that address's provider endpoints
(`/v1/messages`, `/chat/completions`, `/models`), without following redirects, and stops reading an answer past 4 MB.

**The web app and the phone apps** send requests from the page, so the provider must allow that. Anthropic does (with
the header above). For a model on your own computer, allow Iskra's web address:

- **Ollama**: start it with `OLLAMA_ORIGINS` set to the app's address, for example
  `OLLAMA_ORIGINS=https://app.iskra.foo ollama serve` (PowerShell: `$env:OLLAMA_ORIGINS='https://app.iskra.foo'; ollama serve`).
- **LM Studio**: turn on **Enable CORS** in its server settings.

## Tools

The assistant acts through a fixed list of tools. Each one sends the same request as the app's own buttons, so your
server checks your rights for every one of them, exactly as when you click.

| Group | Tools | Asks you first |
|---|---|---|
| Search & read (always on) | help search, list servers, list channels, list members, list roles, search messages, read a channel's recent messages | No (what they read goes to your provider) |
| Organize (always on) | create, rename and move channels and categories; make a theme; set up a bot | Yes, every change. Only moving channels and categories and making a theme can be allowed **for this session** (per server, until you start a new conversation) |
| Moderation (off until you turn it on) | time out, end a timeout, warn, kick, ban, delete messages | Yes, every single time |
| Server admin (off until you turn it on) | change someone's role, create a role, set someone's roles, delete a channel, replace the rules | Yes, every single time |

- The approval card says what will happen in plain words, on which server, shows in full any text others will see
  (a channel name, a reason, the rules), and shows the exact request under **Exact request**. **Deny** is final for
  that action.
- **Set up a bot** creates a single-use bot invite (valid 7 days). The link is shown to you in the panel to copy; the
  model never sees it. Bot code reads it from the `ISKRA_INVITE` environment variable (see [Bots](bots.md)).
- There are no tools for keys, recovery codes, tokens, invite links, webhooks, passkeys, linking devices, backups or
  deleting your account, and none that send messages or direct messages for you.
- At most 30 tool calls a minute (10 changes), 40 changes in one conversation, and at most 12 steps for one question.
- Requests from an MCP client are never allowed "for this session": each change asks.
- Text from other people (messages, names, topics) reaches the model marked as data, with the rule that it is never an
  instruction. If a message tries to talk the model into something, the approval card is still there: nothing changes
  without your OK.

## Use Iskra's tools from Claude Desktop or Claude Code (MCP)

The desktop app can offer the same tools to an AI app on the same computer through the
[Model Context Protocol](https://modelcontextprotocol.io) (MCP), over stdio.

1. In **My settings → Assistant**, turn on the assistant and **Allow local MCP clients**. It's off by default.
2. Copy the command shown there. For **Claude Code**:

   ```sh
   claude mcp add iskra -- "C:\Program Files\Iskra\Iskra.exe" --mcp
   ```

   For **Claude Desktop**, add the snippet shown in settings to its config file (Settings → Developer → Edit config):

   ```json
   { "mcpServers": { "iskra": { "command": "C:\\Program Files\\Iskra\\Iskra.exe", "args": ["--mcp"] } } }
   ```

   (On macOS the command is `/Applications/Iskra.app/Contents/MacOS/Iskra`, on Linux your AppImage or `/opt/Iskra/iskra`.)
3. Keep Iskra open. Changes the other app asks for appear as approval cards in the Iskra window, marked "An app on this
   computer (MCP) wants to"; the same groups and limits apply.

How it works: `Iskra --mcp` starts a small bridge with no window. It connects to the running Iskra over a private local
channel (a named pipe with a random name on Windows, a socket file in Iskra's data folder on macOS and Linux), never a
network port. Both sides prove they know a random token kept in Iskra's data folder, so other users on the computer
can't use it. While **Allow local MCP clients** is off, Iskra doesn't listen at all and the bridge offers no tools;
turning it off also denies any of its changes still waiting for your OK. On Windows the bridge runs as a second copy
of the app in Node mode (Electron's `ELECTRON_RUN_AS_NODE`), because the app's main process can't read the pipes an MCP
client starts it with. The other app sends what
it reads through the tools to its own AI provider, under that provider's terms.

## When it doesn't work

- **"The provider didn't accept the key"**: check the key in My settings → Assistant (replace it if needed).
- **"Couldn't reach the provider"**: check the address and your connection. In the web app, a model on this computer
  needs to allow Iskra's address (see above).
- **The model doesn't use tools**: pick a model that supports tool calls (function calling).
- **MCP: "Iskra's tools aren't available"**: open Iskra, turn on the assistant and Allow local MCP clients, and make sure
  the app isn't locked.
