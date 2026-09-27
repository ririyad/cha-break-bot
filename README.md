# Cha-Break Bot Live

This is the live, audience-participation demo for the talk **From Answering to Acting**. People in the room scan a QR code and ask an AI assistant for tea-break snacks from a **synthetic** stall menu. The projector then shows what really happens behind each answer: which tool call the model *proposed*, which checks the app ran, what the code *actually* did, and what the order sheet *really* contains.

It has **no dependencies**. You only need Node.js 18 or newer. There is nothing to `npm install`.

---

## 1. Run it (2 minutes)

### On Windows

1. **Install Node.js once:** download the LTS installer from https://nodejs.org, or run `winget install OpenJS.NodeJS.LTS` in PowerShell.
2. Unzip `cha-break-bot-live.zip` somewhere simple, for example `C:\cha-break-bot-live`. Don't run it from inside the zip.
3. **Double-click `Start demo.bat`.** A console window shows the Audience link, the Stage link and a QR code, and the Stage page opens in your browser.
4. **Windows Firewall will ask about Node.js the first time. Tick both "Private networks" and "Public networks", then click Allow.** Venue and office Wi-Fi is usually marked *Public*, and if Public is not ticked, phones can't connect. See section 3 if you already clicked Cancel.
5. Put the browser window on the projector and press **F** (or F11) for full screen.

Keep the console window open during the talk. Closing it stops the demo.

*If you prefer a terminal:* `node server.js` in the folder. In PowerShell, `npm start` may fail with "running scripts is disabled on this system". Use `node server.js` or `npm.cmd start` instead.

### On a Mac or Linux

```bash
cd cha-break-bot-live
node -v            # must be v18 or newer
npm start
```

On a Mac, click **Allow** when asked whether node may accept incoming network connections.

### Either way

With no API key, the demo uses the **Simulated model**. This is a rule-based stand-in with no AI in it, and it is clearly labelled on every screen. Everything else is real: the executor, the checks, the order sheet, the trace and the evaluation. It is your offline fallback, and you can force it with `Start demo - simulated, no AI.bat` (or `npm run simulated`).

## 2. Use a real model: DeepSeek V4.1 Flash via OpenRouter (recommended)

OpenRouter is one account and one API key that reaches many models. This demo is set up for **DeepSeek V4.1 Flash** (`deepseek/deepseek-v4.1-flash`): fast, supports tool calling, and very cheap.

### Step 1: create a key with a spending limit

1. Sign in at https://openrouter.ai and check your credit balance.
2. Go to https://openrouter.ai/settings/keys → **Create key**. Name it `cha-break-bot` and set a **credit limit** (for example $2). If the key ever leaks, it can't spend more than that.
3. Copy the key (it starts with `sk-or-`). You'll only see it once.

### Step 2: put the key in `.env`

The settings file must be named exactly `.env` and sit **next to `server.js`**.

**Windows (PowerShell, in the folder that contains `server.js`):**
```powershell
Copy-Item .env.example .env
notepad .env
```
In Notepad, paste your key after `OPENROUTER_API_KEY=` and save. The top of the file should read:
```
PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-your-key-here
MODEL=deepseek/deepseek-v4.1-flash
```
Quotes around the key are optional.

**Mac/Linux:** `cp .env.example .env`, then edit it the same way.

### Step 3: start and check

Double-click `Start demo.bat` (Mac: `npm start`). The console should show:
```
Settings:  read .env (found OPENROUTER_API_KEY)
Model:     OpenRouter · deepseek/deepseek-v4.1-flash
...
OpenRouter key OK · credit left on this key: $2.00
```
The badge at the top of the stage turns green: **Live model: deepseek/deepseek-v4.1-flash**. Send one message from your phone, then run **Results → Run evaluation** (9 tasks, about 25 model calls).

If the console says something else, it tells you why. For example, "Your key is in .env.example" or "OpenRouter rejected this API key".

### Cost and speed

- **Cost:** one audience message uses 2–3 model calls and about 5,000 input tokens. At OpenRouter's listed price ($0.035 per million input tokens, $0.29 per million output) that is roughly **$0.0003 per message**. A room of 30 people sending 10 messages each costs about **$0.10**. Running the evaluation costs less than a cent. Your $5 is plenty, even if OpenRouter routes some requests to a pricier provider.
- **Speed:** the demo runs up to 8 model calls at once for OpenRouter, and doesn't cap calls per minute. If replies feel slow in rehearsal, try these in `.env`, restart, and compare:
  - `OPENROUTER_SORT=latency` prefers the fastest upstream provider.
  - `REASONING=off` asks the model to skip "thinking" before answering. If replies then fail with an error, remove the line: that provider doesn't accept the setting.
- **Only providers that support tool calling** are used. The app asks OpenRouter to skip any upstream provider that can't handle every parameter it sends (`require_parameters`).
- **Check spending** any time at https://openrouter.ai/activity.

### If something goes wrong

| What you see | Meaning and fix |
|---|---|
| Badge still says **Simulated** | The key wasn't loaded. Read the `Settings:` line in the console. |
| "Live model unavailable (API key rejected (401))" | Wrong or deleted key. Copy it again into `.env`. |
| "Live model unavailable (out of credits (402))" | The account or the key's credit limit ran out. Top up, or raise the key's limit. |
| "Live model unavailable (model not found (404))" | The model name changed. Look it up on openrouter.ai and update `MODEL=`. |
| "Live model unavailable (rate limit (429))" | The upstream provider is busy. Remove `OPENROUTER_SORT`, or wait a moment. Affected messages are answered by the labelled Simulated fallback. |

In every case the demo keeps working: the Simulated stand-in answers that message, and the screen says so.

### Other model options

| Option | What to set in `.env` | Notes |
|---|---|---|
| Google Gemini | `PROVIDER=gemini`, `GEMINI_API_KEY=` | Free key at https://aistudio.google.com/apikey. A Gemini app subscription does *not* include API usage. The free tier allows only a few calls per minute, too few for a full room. |
| Anthropic Claude | `PROVIDER=anthropic`, `ANTHROPIC_API_KEY=` | Default model `claude-haiku-4-5-20251001`. |
| OpenAI | `PROVIDER=openai`, `OPENAI_API_KEY=` | Default model `gpt-5-mini`. |
| Another OpenRouter model | keep `PROVIDER=openrouter`, change `MODEL=` | Any OpenRouter model that supports tools. |
| Ollama (local, offline) | `PROVIDER=ollama`, `MODEL=qwen3:8b` | Install from https://ollama.com and pull a model that supports tools. |
| Any OpenAI-compatible server | `PROVIDER=custom`, `BASE_URL=`, `API_KEY=`, `MODEL=` | Groq, LM Studio and others. |

If `.env` holds keys for several providers, the `PROVIDER=` line decides which one is used.

## 3. Getting phones connected

Phones must be able to reach your laptop. Test this at the venue with your own phone before anyone arrives.

1. **Same Wi-Fi.** Phones and laptop on one network. The QR code points to your laptop's local address, for example `http://192.168.1.23:3000`.
2. **Windows Firewall (the most common problem on Windows).** If your phone can't open the link while on the same Wi-Fi, do one of these:
   - Settings → Network & internet → Wi-Fi → *(your network)* → **Network profile type: Private**; or
   - Windows Security → Firewall & network protection → **Allow an app through firewall** → Change settings → tick **Private** and **Public** for "Node.js JavaScript Runtime".

   On a locked-down office laptop you may not be allowed to change this. Use option 3: it needs no firewall change.
3. **Guest or office Wi-Fi often blocks phone-to-laptop traffic** ("client isolation"). Use a public link instead. It only makes *outgoing* connections, so the firewall and isolation don't matter:
   - Windows: `winget install --id Cloudflare.cloudflared` (once, then open a new window), then double-click **`Start demo with public link.bat`**.
   - Mac: `brew install cloudflared` (once), then `npm run tunnel`.

   After a few seconds the QR code on the stage switches to an `https://….trycloudflare.com` link that also works on mobile data.
4. **Last resort: a hotspot.** Windows can share its connection: Settings → Network & internet → **Mobile hotspot** (up to 8 phones). Phones join the laptop's hotspot. Then open **Settings → Join link** on the stage and enter `http://192.168.137.1:3000/`. Or connect the laptop to your phone's hotspot.

If the QR code shows the wrong address (for example a `172.x` address from WSL or a virtual machine), open **Settings** on the stage. It lists every address on the laptop, and you can type the right one into **Join link**.

## 4. Before the talk (checklist)

- [ ] Start the demo at the venue, on the venue network. Scan the QR code with your own phone.
- [ ] Check the console says `OpenRouter key OK` with enough credit left. Send one test message from your phone and check that the stage badge says **Live model: deepseek/deepseek-v4.1-flash**.
- [ ] Run **Results → Run evaluation** once. This checks the key, the model and the rate limits before anyone is watching.
- [ ] **Settings → Reset everything**, then switch the stage to **Join**.
- [ ] Laptop plugged in, and sleep disabled:
  - **Windows:** Settings → System → Power → Screen and sleep → "Never" when plugged in. Also turn off Focus/notifications so pop-ups don't appear on the projector.
  - **Mac:** run `caffeinate -d` in another terminal.
- [ ] Browser zoom so the back row can read the stage (Ctrl + / Ctrl − on Windows, Cmd + / Cmd − on Mac).

## 5. Running the show

| Key | Stage view | When (see the speaker notes) |
|---|---|---|
| `0` | **Join**: big QR code, names appear as people join | Start of the talk |
| `1` | **Tools**: live feed of *model proposes → app checks → code runs → actual result* + team order | Topic 1 |
| `2` | **Rule test**: phones vote, then *Ask the model* vs *Reveal code check* (versions A, B, C) | Topic 2 |
| `3` | **Hallucination**: "spot the hallucination" game + the same question with and without tools | Topic 3 |
| `4` | **Break it**: attack challenge, *Hide an instruction in the menu*, *Make saving fail* | Topic 4 |
| `5` | **Results**: what the system actually did + **Run evaluation** (9 tasks) | Topic 4 / close |

Other keys: `F` full screen · `T` light/dark · `S` settings (join link, hide audience messages, reset).

**The phones follow the stage.** The phone's **Activity** tab is controlled by you, the presenter:

| Stage view | What the audience's Activity tab shows |
|---|---|
| Join (0) / Tools (1) | A short welcome and "ask the bot for a snack" (the chat tab is the main thing here) |
| Rule test (2) | The vote: tick which items qualify (after you click **Open voting**) |
| Hallucination (3) | "Spot the hallucination": label each claim (after you click **Open voting**) |
| Break it (4) | The challenge with ready-made attack buttons |
| Results (5) | A thank-you note |

When you switch to 2, 3 or 4, the phones jump to the Activity tab by themselves. Phones normally update instantly. On networks that hold back live updates (some tunnels and proxies), they catch up within about 4 seconds.

**If someone types something inappropriate:** Settings → *Hide audience messages* hides message text on the big screen. The trace stays visible.

**If the live model is slow or down:** each message falls back to the Simulated model and says so on screen. You can also restart with `Start demo - simulated, no AI.bat` (Mac: `npm run simulated`). Say out loud: *"A fixed stand-in is playing the model now; the checks, the order and the trace are all real."*

## 6. How it works (read this to learn the concepts)

| File | Concept from the talk |
|---|---|
| `src/tools.js` | **Tool contracts.** Names, descriptions and JSON schemas the model sees. The model can only *request* these. |
| `src/executor.js` | **The execution boundary.** Every proposed call is checked (allowed tool? budget? contract? item exists? passed the rule? did the *user* tap Choose?) before any code runs. Failures are reported, never hidden. |
| `src/agent.js` | **The loop.** Request + state → model → proposed call → checks → actual result → back to the model, with limits (4 rounds, 6 tool calls per message), queueing, timeouts, and a check that flags a reply claiming "added!" when the save failed. |
| `src/world.js` | **Application state.** The order sheet is the *truth about actions*. The UI renders it from here, never from the model's sentences. A choice enters state only through a button tap. |
| `src/providers/*` | **Provider adapters.** One small interface; Gemini/OpenAI/Ollama/Claude formats stay inside these files. `simulated.js` is the no-AI stand-in. |
| `src/evals.js` | **Evaluation.** Nine tasks with outcomes defined up front (boundary price, missing price, no write without a tap, idempotent save, failed save, hidden instruction, follow-up limit, unknown item). Run `npm run eval` (or double-click `Run tests.bat`), or `node src/evals.js --trials 3` to see variability. |
| `src/menu.js` | **Synthetic data**, with deliberate gaps (Jhalmuri has no price, Toast biscuit has no rating) and boundaries (Chotpoti is exactly ৳50, Beguni is exactly 4.0). |

## 7. Privacy and cost

- Everything lives in memory. Stopping the server forgets everyone and every message.
- Participants choose a first name or stay "Guest N". The join page asks people not to type personal information.
- Messages go to the model provider you configure. With the Simulated model or Ollama, nothing leaves your laptop.
- Limits keep costs predictable: 25 messages per person, 4 model rounds and 6 tool calls per message, 280 characters per message, and 3 model calls at a time (all adjustable in `.env`).

## 8. Troubleshooting

| Problem | Fix |
|---|---|
| `Port 3000 is busy` | Another copy is running (check for another console window). Close it, or set `PORT=3001` in `.env`. |
| Phones time out opening the link | On Windows, check the firewall first (section 3, step 2). Otherwise it's network isolation: use the public link (section 3, step 3). |
| Phone's Activity tab doesn't change when you switch the stage | Wait about 4 seconds (the phone polls as a fallback). If it still doesn't change, reload the page on the phone; the person stays joined. |
| "Node.js is not installed" from the .bat file | Install Node.js LTS, then **open a new window** (or restart) so Windows picks up the new PATH. |
| PowerShell: "running scripts is disabled on this system" | Use `node server.js` or `npm.cmd start`, or just double-click `Start demo.bat`. |
| QR code shows a `172.x` or other odd address | A virtual adapter (WSL, Hyper-V, VirtualBox, VPN) was picked. Type the right address into stage **Settings → Join link**. |
| Console shows boxes instead of the QR code | Old Windows console font. Use the QR code on the stage page instead; it is the same link. |
| Stage says "Presenter key missing" | Open the exact Stage link printed in the terminal (it ends with `?key=…`). |
| Badge says Simulated although you set a key | Read the terminal: it names the missing setting. Check the key name in `.env`. |
| Many "Live model unavailable (…)" notes | See the table in section 2. For free-tier limits, raise `QUEUE_TIMEOUT_S`, use OpenRouter, or run a local model with Ollama. |
| A model name error (HTTP 404/400) | Set `MODEL=` to a current model name from your provider. |

---
Menu, prices and ratings are invented for teaching. QR code generation uses Kazuhiko Arase's MIT-licensed `qrcode-generator` (`lib/qrcode.js`).
