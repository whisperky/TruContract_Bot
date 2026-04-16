# Trust Contract Bot

Privacy-first Discord bot for the `Trust Contract` server.

## What it does

- Opens private client job rooms from a single client desk
- Publishes anonymized public job posts authored by the bot
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
3. In the Discord Developer Portal, enable privileged intents:
   - `Message Content Intent` for transcript exports
   - `Server Members Intent` for accurate tier member count channels
4. Copy `.env.example` to `.env` and fill the IDs.
   Use neutral network roles such as `Gold Network`, `Silver Network`, and `Bronze Network`.
   Do not use visible `client` / `developer` Discord roles for marketplace identity.
5. Install dependencies:

```bash
npm install
```

6. Run the bot in development:

```bash
npm run dev
```

7. Use `/deploy-panels` once the bot is online.
8. Use `/access-set` to grant hidden marketplace access:
   - `client`
   - `developer`
   - `both`
   - `revoke`
9. Optional tier counter channels in the channel list:
   - Create one locked voice channel in each network category
   - Set `NETWORK_GOLD_COUNT_CHANNEL_ID`, `NETWORK_SILVER_COUNT_CHANNEL_ID`, `NETWORK_COPPER_COUNT_CHANNEL_ID`
   - The bot auto-renames them to `Members: N`
   - Use `/tier-counts-sync` to force a manual refresh
10. Developer resume upload:
   - Create/update developer profile from the desk panel
   - Use `/profile-resume` with an attachment to upload or replace your resume
   - The published profile thread will show the latest resume link

## Notes

- This project uses a JSON store so you can run it immediately.
- For production, swap the storage layer to PostgreSQL.
- The bot is designed so public job posts never reveal the client.
- Set `JOBS_FORUM_ID` to publish all jobs into one public jobs forum. If it is omitted, the bot falls back to the older tier-specific opportunity forums.
- Use one `CLIENT_DESK_CHANNEL_ID` for clients. The client chooses the required developer access tier during the `New Job` flow.
- Developer access is shown as `Bronze`, `Silver`, and `Gold`. The internal enum still uses `copper` for Bronze compatibility.
- Higher-tier clients can create jobs for lower developer access tiers.
- This version does not require deal-room categories yet.
- Neutral network roles are still used for coarse Discord channel access where needed, but marketplace identity is now stored in the bot.
- Tier counter channel updates are debounced with `NETWORK_TIER_COUNT_UPDATE_DEBOUNCE_MS` (default `15000` ms).
