# WhatsApp bridge

The Go program behind WhatsApp in this app. It uses [whatsmeow](https://github.com/tulir/whatsmeow) to link one WhatsApp number as a device (like WhatsApp Web), forwards incoming messages to a webhook, and takes sends over a small REST API on localhost. The app builds it with `npm run build:wa-bridge` and starts one per live number (see `src/lib/wa/numbers.ts`); you do not run it by hand.

The session, the QR code (`store/.qr-code.txt`) and the bearer token (`store/.bridge-token`) live in `store/` under the folder it runs in.

## Environment

| Name | What it does |
|---|---|
| `WHATSAPP_BRIDGE_PORT` | Port for the REST API. Default `8080`. |
| `WHATSAPP_BRIDGE_TOKEN` | Bearer token REST callers must send (16 characters or more). Unset: made once and kept in `store/.bridge-token`. |
| `WEBHOOK_URL` | Where incoming messages are POSTed. Default `http://localhost:8769/whatsapp/webhook`. |
| `WHATSAPP_INBOUND_ALLOWLIST` | Numbers and group JIDs whose messages reach the webhook (DMs from these senders, groups only when the account is @-mentioned). Unset: falls back to `WHATSAPP_SEND_ALLOWLIST`. |
| `WHATSAPP_AMBIENT_GROUPS` | Groups (also in the inbound list) that forward every message, mention or not. |
| `WHATSAPP_SEND_ALLOWLIST` | Recipients `/api/send`, `/api/react` and `/api/typing` may target. Unset: anyone. |
| `WHATSAPP_MEDIA_ROOTS` | Absolute folders (`:`-separated) that `media_path` in `/api/send` must be under. Default `~/.local/share/whatsapp-mcp/outbox`. |
| `FORWARD_SELF` | Forward messages sent from this account to the webhook too (`true`/`false`). Default `true`. |
| `WHATSAPP_LOG_LEVEL` | Log level, for example `INFO` or `DEBUG` (DEBUG logs message content). Default `INFO`. |

Lists are comma- or space-separated phone numbers (`15550000004`) and/or full JIDs (`120363000000000002@g.us`). A list that is set but empty stops the bridge at startup. With neither allow-list set, every incoming message is forwarded.

## Checks

```bash
go vet ./... && go test ./...
```
