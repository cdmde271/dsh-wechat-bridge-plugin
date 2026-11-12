# dsh-wechat-bridge-plugin (persona modules)

Persona-side modules for a WeChat chat bot built on
[DeepSeek Harness](https://deepseek.com) and the DSH social bridge plugin.

These are the pieces I wrote on top of the bridge: they make the bot keep a
schedule, hold a mood, remember promises, and stop fragmenting its replies.

## Files

| File | What it does |
|---|---|
| `persona-state.mjs` | Injects the current local time and life phase (class / dinner / bedtime) into every turn. Counts repeats per conversation so the bot does not say "I just ate" three times in a row. |
| `persona-memory.mjs` | Mood value (praise raises, insults lower, decays toward neutral) and a small promise store extracted from its own replies. Also shares day topics across conversations. |
| `reply-layout-policy.mjs` | Rewritten reply-splitting notice: consecutive user messages are read as one thought, replies stay at N parts with a blank-line separator, and the over-limit parts get merged instead of truncated. |
| `voice-tools.mjs` | `wechat_voice_send` tool: clone-voice text-to-silk and send as a real WeChat voice bubble. |
| `image-tools.mjs` | `wechat_image_send` tool: send a local image to a private chat or a group. |

## Wiring

The bridge exposes a per-turn context hook. In your `native-context.mjs`
(or wherever the turn context is assembled):

```js
import {personaStateLine, configure as configurePersonaState} from './persona-state.mjs';
import {configureMemory, moodContext, pendingContext, recordReply, recordTopic, siblingTopics} from './persona-memory.mjs';

configurePersonaState(root);
configureMemory(root);

// before the turn
const extraContext = [
  personaStateLine(key),
  moodContext(key, message),
  pendingContext(key),
  siblingTopics(key),
  ...otherContext,
].filter(Boolean).join('\n');

// after the turn resolves
recordReply(key, output.text);
```

## Notes

- Everything is derived from local time plus small JSON state files under
  `state/persona/`. No extra model calls, no network, no secrets.
- All account ids, wxids, paths and tokens were stripped from this copy; the
  placeholders (`<OWNER_WXID>`, `<WECHATAGENT_HOME>`, ...) are filled in by your
  own configuration.
- Built and tested against WeChat 4.1.10.27 on Windows.

MIT licensed.
