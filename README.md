# My Avatar

Visitors turn on their webcam and see their avatar come alive:

- **Fantasy avatar**: a 3D animated character generated from the visitor's own photo with Google Gemini
  (styles: 3D Animated, Fantasy Elf, Superhero, Anime). Ready-made characters (fox, robot, alien, bear)
  are available for people who don't want to use their face.
- **Realistic avatar**: the visitor's own photo, animated.

Both follow the visitor's head, eyes and mouth in real time. Subscribers can type text and the avatar reads it
aloud with lip-sync (Piper text-to-speech, English and Persian voices). Subscriptions are paid through ZarinPal.

## How it works

| Part | Where | Notes |
| --- | --- | --- |
| Face tracking | Browser (MediaPipe Face Landmarker) | Video never leaves the browser |
| Avatar animation | Browser (WebGL mesh warp, three.js for ready-made characters) | `public/js/face-avatar.js`, `public/js/fantasy.js` |
| 3D character | Server → Google Gemini | Photo sent once, after the visitor agrees; `server/avatar.js` |
| Text to speech | Server (`tts/server.py`, Piper) | Subscribers only; lip-sync is computed from the audio in the browser |
| Accounts, payments | Server (Express + SQLite) | `server/auth.js`, `server/payment.js` |

## Local development

Requires Node.js 22.13+ (and Python 3 with `pip install piper-tts` for speech).

```bash
npm install
cp .env.example .env   # fill in keys as needed
npm run dev
```

Voice service (optional locally):

```bash
python3 -m venv .venv && .venv/bin/pip install piper-tts==1.8.0
.venv/bin/python -m piper.download_voices --download-dir tts/voices en_US-amy-medium
.venv/bin/python tts/server.py --voices-dir tts/voices
```

Give a registered account a subscription by hand: `npm run grant -- user@example.com 30`.

## Deployment

Running the **Deploy** workflow (GitHub → Actions → Deploy → Run workflow) copies the code to the server and
runs `deploy/install.sh`. The script installs everything under `/opt/avatar`, runs the
app and the voice service with systemd (`avatar-web`, `avatar-tts`), adds an nginx site for the domain only
(existing sites are left untouched; changes are checked with `nginx -t` and rolled back on error) and gets a
Let's Encrypt certificate.

Repository secrets: `SSH_HOST`, `SSH_USER`, `SSH_KEY`, `ZARINPAL_MERCHANT_ID`, `GEMINI_API_KEY`.
Optional repository variables: `DOMAIN` (default `avatar.tamirdesk.ir`), `ZARINPAL_SANDBOX`,
`GEMINI_IMAGE_MODEL`, `PLAN_MONTHLY_TOMAN`, `PLAN_QUARTERLY_TOMAN`, `AVATAR_DAILY_LIMIT`,
`AVATAR_FREE_LIMIT`, `AVATAR_SUBSCRIBER_LIMIT`.

Useful commands on the server:

```bash
journalctl -u avatar-web -f
journalctl -u avatar-tts -f
cat /opt/avatar/shared/.env
```
