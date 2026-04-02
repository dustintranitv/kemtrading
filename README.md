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

## Utility scripts

- Dry-run invalid message cleanup:
   `npm run db:cleanup:messages`
- Apply invalid message cleanup:
   `npm run db:cleanup:messages:apply`
- Send a local test message to worker:
   `npm run test:ingest`
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
