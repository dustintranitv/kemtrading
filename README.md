# Railway Telegram User Worker

Dedicated worker service for ingesting Telegram messages from a Telegram user account (MTProto), parsing trading signals with OpenAI, and storing data in MongoDB.

## Local run

1. Install dependencies:
   `npm install`
2. Create `.env.local` from `.env.example` and set values.
3. Generate a Telegram user string session (one-time):
   `npm run telegram:session`
4. Put generated value into `TELEGRAM_STRING_SESSION` in `.env.local`.
3. Start worker:
   `npm run start`

### Local parser-only test mode

If your Telegram MTProto session is blocked or duplicated but you still want to test `/test/ingest`, start the worker with Telegram ingest disabled:

`DISABLE_TELEGRAM_INGEST=true npm run start`

This keeps MongoDB + HTTP endpoints active while skipping the Telegram connection step.

## Utility scripts

- Dry-run invalid message cleanup:
   `npm run db:cleanup:messages`
- Apply invalid message cleanup:
   `npm run db:cleanup:messages:apply`
- Send a local test message to worker:
   `npm run test:ingest`
- Run Telegram signal scenarios for LONG / SHORT / management-position commands:
   `npm run test:signals`
- Create/update Telegram user session:
   `npm run telegram:session`

## Railway deployment

Use this folder as the Railway service root.

- Root Directory: `worker`
- Start Command: `npm run start`

### GitLab CI variables

To fill `RAILWAY_PROJECT_ID` and `RAILWAY_SERVICE` for GitLab CI:

1. Open your project in the Railway dashboard.
2. Press `Cmd/Ctrl + K` to open the Railway command palette.
3. Search for `Copy project ID` and copy that value into `RAILWAY_PROJECT_ID`.
4. In the same project, open the worker service you want GitLab to deploy.
5. Copy the service name from the service header and put that value into `RAILWAY_SERVICE`.
6. If your Railway dashboard also shows `Copy service ID`, you can use that instead.

`RAILWAY_SERVICE` can be either the service name or the service ID. The service name is usually the easiest option from the dashboard.

## Endpoints

- `GET /health`
- `POST /test/ingest`

## Notes

- Worker listens to incoming Telegram messages via user session, not bot webhook.
- Account must already be in the target groups/channels.

## Troubleshooting

### AUTH_KEY_DUPLICATED on startup

If startup logs show `AUTH_KEY_DUPLICATED`, the same Telegram auth key/session is being used in multiple clients.

1. Stop any other running process/device that is using the same `TELEGRAM_STRING_SESSION`.
2. Generate a fresh session with `npm run telegram:session`.
3. Replace `TELEGRAM_STRING_SESSION` in `.env.local` and restart.

Current worker behavior: if this error happens, the service continues to run HTTP endpoints while disabling Telegram ingest so `/health` and `/test/ingest` still work.
