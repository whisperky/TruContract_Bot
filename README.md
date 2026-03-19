# Trust Contract Bot

Privacy-first Discord bot for the `Trust Contract` server.

## What it does

- Opens private client job rooms from a desk panel
- Publishes anonymized public opportunity posts authored by the bot
- Accepts private developer applications via buttons and modals
- Generates shortlist summaries inside the client's private room
- Stores developer profiles and publishes official talent posts to level forums

## Why the architecture looks like this

Your server design requires:

- client identity must stay private
- client search history must stay private
- developers should see jobs, not client profiles
- clients should see developer profiles, not other clients

Because of that, clients should never post their jobs directly in public forums. The bot owns public job posts.

## Setup

1. Create a Discord application and bot in the Discord Developer Portal.
2. Invite the bot with permissions to:
   - Manage Channels
   - View Channels
   - Send Messages
   - Embed Links
   - Attach Files
   - Read Message History
   - Manage Threads
   - Use Slash Commands
3. Copy `.env.example` to `.env` and fill the IDs.
4. Install dependencies:

```bash
npm install
```

5. Run the bot in development:

```bash
npm run dev
```

6. Use `/deploy-panels` once the bot is online.

## Notes

- This project uses a JSON store so you can run it immediately.
- For production, swap the storage layer to PostgreSQL.
- The bot is designed so public opportunity posts never reveal the client.
- This version does not require deal-room categories yet.
