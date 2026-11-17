# Privacy

Tiro desktop is Jamie's own assistant app. It runs no servers of its own and has no analytics or telemetry. Data
leaves the computer only for the services below.

## Where data goes

- **The Tiro server** (tiro.jamies.dev, Jamie's home server, reached over Tailscale): what you ask Tiro through its
  `tiro_*` tools (questions, things to save, to-dos, reminders and sends to the phone).
- **The AI you sign in to** (Claude with a subscription or an API key, or another provider you add): your messages
  and the conversation so far, a "live state" block (date, time zone, the app and window in front, saved facts and
  commitments), and screenshots or window text when Tiro looks at the screen to answer.
- **Fish Audio or Google (Gemini)**, whichever speaks the replies: the text of each reply, only with spoken replies on,
  using your own key.
- **GitHub**: checking for and downloading updates (github.com/cijamie/tiro-desktop).
- **Hugging Face**: once, to download the speech model.
- **Wikipedia and websites**: photos for photo cards, site icons for source cards, and pages you or Tiro open or fetch.
- **Search engines**: Anthropic runs web searches on Claude; otherwise DuckDuckGo, then Brave, Bing or Google.

## What stays on the computer

Settings, memory, conversations, logs and the saved voice keys (encrypted with Windows DPAPI for your Windows user)
are in `%USERPROFILE%\.tiro`. Sign-in to the AI providers is in `%USERPROFILE%\.gg\auth.json`. Files that background
agents make are in `%USERPROFILE%\Tiro`. The speech model is in `%LOCALAPPDATA%\Tiro`.
