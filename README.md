# Trust Contract Bot

Privacy-first Discord bot for the `Trust Contract` server.

## What it does

- Opens private client job rooms from tier-specific desk panels
- Publishes anonymized public opportunity posts authored by the bot
- Accepts private developer applications via buttons and modals
- Generates shortlist summaries inside the client's private room
- Stores developer profiles and publishes official talent posts to level forums
- Uses bot-managed marketplace access for `client` / `developer` identity, instead of visible Discord identity roles

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
   Use neutral network roles such as `Gold Network`, `Silver Network`, and `Copper Network`.
   Do not use visible `client` / `developer` Discord roles for marketplace identity.
4. Install dependencies:

```bash
npm install
```

5. Run the bot in development:

```bash
npm run dev
```

6. Use `/deploy-panels` once the bot is online.
7. Use `/access-set` to grant hidden marketplace access:
   - `client`
   - `developer`
   - `both`
   - `revoke`

## Notes

- This project uses a JSON store so you can run it immediately.
- For production, swap the storage layer to PostgreSQL.
- The bot is designed so public opportunity posts never reveal the client.
- Each market tier now has its own client desk and developer desk.
- A job belongs to one exact market tier, based on the desk where it was created.
- Higher-tier users can use lower-tier desks, but each desk only manages that exact market.
- This version does not require deal-room categories yet.
- Neutral network roles are still used for coarse Discord channel access where needed, but marketplace identity is now stored in the bot.
