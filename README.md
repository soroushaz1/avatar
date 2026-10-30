# My Avatar

Visitors turn on their webcam and see their avatar come alive:

- **Fantasy avatar**: a 3D animated character generated from the visitor's own photo with Google Gemini
  (styles: 3D Animated, Fantasy Elf, Superhero, Anime). Ready-made characters (fox, robot, alien, bear)
  are available for people who don't want to use their face.
- **Realistic avatar**: the visitor's own photo, talking with real frames of their mouth (recorded once with an
  on-screen guide, one per mouth shape).

Once made, the avatar stays in place (it only blinks and sways slightly on its own) and does not copy the
visitor's head; the camera is only used to capture the face and record the mouth shapes, and turns off
afterwards. Subscribers can type text and the avatar reads it
aloud with lip-sync (Piper text-to-speech, English and Persian voices), and download it as a video (portrait,
square or landscape, with optional subtitles). Everyone can hear a free demo sentence. Subscriptions are paid
through ZarinPal.

### Voices

Piper voices run on the server for free: Persian (Amir, Gyro, both male) and English (Amy, Ryan). Piper has no
female Persian voice, so Google's Gemini voices (Leda, Kore, Aoede, Zephyr; Persian and English, about $0.02 per
minute of speech, `GEMINI_TTS_MODEL`) add them. Gemini reports no phoneme timings: Piper reads the same text in
parallel and its timings are carried over by aligning the two recordings (MFCC + dynamic time warping,
`server/align.js`). The deploy adds the phoneme-timing output to the Piper voice files once, so the voice service
never has to patch a model in memory (which needs ~300 MB at load time).

### Lip-sync

Every sound maps to one of nine mouth shapes (visemes, `public/js/visemes.js`): closed lips (m/b/p), f/v, s/t,
"e", "a", "ɑ/آ", "i", "o" and "u". Piper reports when each phoneme is spoken; the browser turns that into a
track of mouth shapes with coarticulation (lips anticipate the next vowel) and undershoot on short vowels
(`public/js/speech.js`). The avatar keeps one image per shape (Gemini-made for 3D characters, webcam frames for
the realistic avatar) and morphs between them: the lips and jaw of the portrait move towards each image's mouth
by its weight, and only the lips and the inside of the mouth are taken from the images (aligned on the base of the
nose and colour-matched), so the nose and skin never flicker (`public/js/face-avatar.js`).

## How it works

| Part | Where | Notes |
| --- | --- | --- |
| Face tracking | Browser (MediaPipe Face Landmarker) | Video never leaves the browser |
| Avatar animation | Browser (WebGL mesh warp, three.js for ready-made characters) | `public/js/face-avatar.js`, `public/js/fantasy.js` |
| 3D character | Server → Google Gemini | Photo sent once, after the visitor agrees; `server/avatar.js` |
| Text to speech | Server (`tts/server.py`, Piper + ffmpeg) | Subscribers only (plus a demo sentence); returns MP3 and phoneme timings |
| Video | Browser (canvas + MediaRecorder) | MP4 where the browser supports it, otherwise WebM; `public/js/recorder.js` |
| Accounts, payments | Server (Express + SQLite) | `server/auth.js`, `server/payment.js` |

## Local development

Requires Node.js 22.13+ (and Python 3 with `pip install piper-tts onnx`, plus ffmpeg, for speech).

```bash
npm install
cp .env.example .env   # fill in keys as needed
npm run dev
```

Voice service (optional locally):

```bash
python3 -m venv .venv && .venv/bin/pip install piper-tts==1.8.0 onnx
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
`AVATAR_FREE_LIMIT`, `AVATAR_SUBSCRIBER_LIMIT`. Optional secret: `AVATAR_UNLIMITED_LOGINS` (comma-separated
logins with no daily character limit, e.g. the site owner's; a secret so the addresses stay private).

Useful commands on the server:

```bash
journalctl -u avatar-web -f
journalctl -u avatar-tts -f
cat /opt/avatar/shared/.env
```
