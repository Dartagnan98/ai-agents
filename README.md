# AI Agents

A team of AI agents you run on your own computer. Chat with them, give them tasks and routines, connect your apps, and see everything that needs you in one Inbox.

It starts with a small team ready to go:

| Agent | What it does |
|---|---|
| **Assistant** | Your main agent. Answers quick questions, plans, and hands work to the right teammate. |
| **Researcher** | Digs into a topic and comes back with a sourced brief. |
| **Writer** | Drafts emails, posts, docs and summaries in your voice. Never sends anything itself. |
| **Operations** | Runs the routines, works the task board, and reports what failed. |

It also comes with six skills (`/research-brief`, `/summarize`, `/meeting-notes`, `/write-email`, `/weekly-report`, `/plan-project`) and two routines that are switched on: a **Morning brief** (weekdays, 8:00) and a **Weekly review** (Mondays, 9:00).

Everything stays on your machine, in one folder (`./data`).

---

## What you need

- **Node.js 22 or newer** (check with `node -v`).
- **A way to run the AI.** Pick one:
  - A **Claude subscription** (Pro or Max) with [Claude Code](https://claude.com/claude-code) installed and signed in. This is the default and needs no API key.
  - Or an **API key**: Anthropic, OpenAI, xAI (Grok) or OpenRouter.
- Optional: the [Composio](https://composio.dev) CLI, if you want the agents to use apps like Gmail, Calendar, Slack or Notion.

## Install and run

```bash
git clone https://github.com/Dartagnan98/ai-agents.git
cd ai-agents
npm install
npm run setup
npm run dev
```

Then open **http://localhost:3000**.

`npm run setup` makes `.env.local` (with a random sign-in secret) and the `./data` folder. It never overwrites an existing `.env.local`, so it is safe to run again.

## First run

1. **Make your login.** The first visit opens a page that creates the owner account. Pick a username and a password of at least 10 characters.
2. **Sign in** with it.
3. **Connect the AI.** Go to **Settings › AI connections**:
   - **Claude subscription:** if Claude Code is signed in on this computer (`claude` in a terminal), the agents use it straight away. Or paste a token from `claude setup-token`.
   - **API keys:** paste an Anthropic, OpenAI, xAI or OpenRouter key instead.
4. **Say hello.** Open **AI** and ask the Assistant "What can you and the team do?"

If an agent replies with an error about signing in, run `claude` in a terminal, sign in again, and retry.

## How to use it

### The menu

| Section | Pages | What it is for |
|---|---|---|
| **Inbox** | | Everything that needs you: approvals the agents ask for, tasks that are blocked or have no agent, lessons the agents learned, notes that disagree, and the latest routine runs. |
| **AI** | Chat | Talk to any agent. Pick the agent at the top. Attach files (pictures, PDFs, Word, Excel, text). Agents can answer with tables and charts. |
| **Agents** | Agents, Tasks, Comms, Tests | Your team. Edit each agent's instructions, model, tools, role card and daily spend cap. **Tasks** is a board the agents work through on their own. **Comms** shows what agents ask and hand to each other. **Tests** scores each agent's answers. |
| **Automation** | Routines, Automations | **Routines** are jobs an agent runs on a schedule or when something happens; results land in a conversation and in the Inbox. **Automations** lists what else runs on this computer. |
| **Performance** | Fleet health, Analytics, Strategy | **Fleet health**: what ran, what failed, what is waiting. **Analytics**: AI use by agent and model. **Strategy**: your north star, bottleneck, focus and goals. Every agent reads it and works toward it. |
| **Memory** | Memory, Graph, Skills | **Memory** is what the agents remember: your notes, decisions, lessons, conversation summaries. **Graph** maps who and what is mentioned together. **Skills** are reusable instructions you run with `/name`. |
| **Library** | Knowledge, Wiki, Experiments | **Knowledge**: documents the agents can search (SOPs, offers, FAQs). **Wiki**: the team's notes. **Experiments**: a log of what you are testing and what you learned. |
| **Settings** | AI connections, Connectors, Users, Allowed roots, Appearance | See below. |

### Things to try

- "Research the three best note-taking apps for a small team and compare them." The Assistant hands it to Researcher.
- "Draft a friendly follow-up email to a client who went quiet."
- `/plan-project` launch a newsletter by next month. The steps go on the task board, each with an agent.
- "Make a routine that checks my inbox every morning and lists anything urgent." (Needs Gmail linked in Connectors.)
- "Remember that I like short answers with the number first." The agents keep it in memory and follow it from then on.

### Tasks

Put a task on **Agents › Tasks** (or ask an agent to). Give it an agent, or leave it empty and the Assistant takes it. Two tasks run at a time. A task that gets stuck shows as **Blocked** and lands in your Inbox.

### Routines

**Automation › Routines › New routine**: pick an agent, write what it should do, and set when (for example "every weekday at 8"). Leave the schedule empty and pick an event (a task gets blocked, a routine fails) to run it when that happens. Turn a routine off with its switch.

### Approvals

Agents ask before anything that changes the outside world: posting to Slack, using a saved key with a new site, running an app action. The ask shows as a card under their reply and in your Inbox. Say yes or no there.

### Skills

**Memory › Skills** holds the built-in skills and your own. Type `/` in the chat to run one. Make your own with **New skill**, or ask an agent to "save this as a skill". A skill can have extra files (templates, examples).

### Memory

Agents recall what matters before every answer. You can see and edit everything on **Memory**: retire a wrong note, keep a lesson, or add a decision ("we never discount below 20%"). The nightly pass tidies duplicates and writes short profiles of the people the agents hear about.

## Settings

- **AI connections**: how the agents run (Claude subscription, ChatGPT or SuperGrok plan, or API keys), plus talking to your agents from **Telegram**, **Slack** or **WhatsApp**. An optional OpenRouter key gives memory better search (OpenAI embeddings). Without it, memory uses a small model that runs on your computer.
- **Connectors**: the apps the agents can use, through Composio. It suggests Gmail, Google Calendar, Drive, Docs, Sheets, Slack, Notion, GitHub, Linear and Outlook; **Connect an app** opens the full catalog. Install the Composio CLI first (see docs.composio.dev/cli; the app looks for it in `~/.composio`, or set `COMPOSIO_CLI` to its path), sign in from this page, then link each app with one click. Reads run straight away; actions that change something ask you first.
- **Users**: add people. **Owner**: everything. **Admin**: everything except changing owners. **Member**: chats with the agents only, with their own notes and files.
- **Allowed roots**: folders on this computer the agents may read and send files from.
- **Appearance**: light or dark.

## WhatsApp

Each WhatsApp number is linked to this computer as a device, like WhatsApp Web: add the number in **Settings › AI connections** and scan the QR with the phone. The link runs through a small Go program, the bridge, in [`whatsapp-bridge/`](whatsapp-bridge/) (built on [whatsmeow](https://github.com/tulir/whatsmeow)).

- **You need** Go 1.26 or newer ([go.dev/dl](https://go.dev/dl/)) and a C compiler (the bridge's SQLite driver uses cgo: Xcode Command Line Tools on a Mac, `build-essential` on Debian/Ubuntu).
- **Build it** with `npm run build:wa-bridge`. That makes `whatsapp-bridge/whatsapp-bridge`. `npm run setup` builds it too when Go is installed. Run it again after pulling bridge changes.
- **Another place:** set `WA_BRIDGE_BIN` in `.env.local` to the path of a bridge binary built elsewhere.
- **You do not start it yourself.** The app starts one bridge per live number and restarts it if it stops. Each number's WhatsApp session lives in `data/wa/<agency>/<number key>/store`. Delete that folder (or the number) to unlink.


Everything lives in `./data`: the databases, uploaded files, memory and the agents' workspace.

- **Back up:** copy the `data` folder (and `.env.local`) somewhere safe.
- **Start over:** stop the app, delete `data`, and run `npm run setup` again.
- **Forgot the password:** `npm run set-password` (add a login name after `--` to pick one, for example `npm run set-password -- sam`).

Never commit `.env.local` or `data/`. Both are in `.gitignore`.

## Settings in `.env.local`

| Name | What it does |
|---|---|
| `AUTH_SECRET` | Signs the sign-in cookies. Made for you by `npm run setup`. |
| `CTX_ROOT` | Where the data lives. Default `./data`. |
| `APP_URL`, `AUTH_URL`, `NEXTAUTH_URL` | The address you open the app at. Change all three if you use another port or a domain. |
| `APP_NAME` | The app's name in the header and tab. Default "AI Agents". |
| `APP_TZ` | Time zone for routines and reports, for example `America/New_York`. Default: your computer's. |
| `FLEET_SETUP_TOKEN` | Optional. Requires this code on the first-run page, if others can reach the app before you make the owner. |
| `FLEET_NO_JOBS=1` | Switches off the background clock (routines, tasks, memory passes). Pages still work. |
| `AI_BROWSER_BIN` | Optional, Linux server only (it runs beside the script workspace). Path to Playwright's MCP server (`npm i -g @playwright/mcp`, then `npx playwright install chromium`), so agents can browse the web. |

## Run it for real

```bash
npm run build
npm run start
```

To reach it from other devices, put it behind a reverse proxy with HTTPS (Caddy or nginx) and set `APP_URL`, `AUTH_URL` and `NEXTAUTH_URL` to that address. Set `TRUST_PROXY=true` when the proxy sets `X-Forwarded-For`.

## Good to know

- **Script workspace:** the `workspace_*` tools (agents running Python and shell scripts in a sandbox) need a Linux server with systemd and a `fleetwork` user. On a Mac or Windows laptop they stay off; everything else works.
- **WhatsApp** needs the bridge built once (see [WhatsApp](#whatsapp)). Telegram and Slack work with just their bot tokens.
- **Costs:** with a Claude subscription, the agents use your plan's limits. With API keys, you pay per use. Set a daily cap per agent on **Agents** to stay in control.

## Development

```bash
npm test             # the test suite (Vitest)
npx tsc --noEmit     # type check
```

The app is Next.js 16 with SQLite (better-sqlite3). The agents' code is in `src/lib/ai`, the pages in `src/app/(dashboard)`, and the screens in `src/components`.

## License

MIT. See [LICENSE](LICENSE).
