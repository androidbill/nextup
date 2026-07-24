# Next Up ⏭

The shout-it-out party guessing game — like Heads Up, but nobody holds a phone to their forehead.

Everyone joins a room on their own phone with a 4-letter code. Each round the game randomly
picks a **Guesser** (phone face down!) and a **Scorekeeper**. Everyone else sees the secret
word on their own screen and shouts clues. The Scorekeeper taps ✓ / ✗ to score guesses and
advance to the next word. 60-second rounds, per-player scores, everyone gets a turn.

## Tech

- Plain HTML/CSS/JS PWA (no build step) in `public/`
- Firebase Firestore for real-time room sync, Firebase Hosting for the app
- Firebase project: `next-up-party-8317`

## Deploy

```
firebase deploy
```

**Important:** bump `APP_VERSION` in `public/app.js` (format `YYYY.MM.DD.NN`) on every
change, or installed PWAs will keep serving the old cached version.
