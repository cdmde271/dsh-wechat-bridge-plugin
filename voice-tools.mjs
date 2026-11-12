import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';

// Real WeChat voice message channel: text -> edge-tts -> silk -> /SendVoiceMsg.
export const VOICE_SEND_POLICY = Symbol.for('wechatagent.voice-send.v1');
const names = ['wechat_voice_send'];
const PYTHON = process.env.WECHATAGENT_PYTHON || '<USER_HOME>\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const DEFAULT_VOICE = process.env.WECHATAGENT_TTS_VOICE || 'zh-CN-XiaoxiaoNeural';
const LIMIT = 60;

const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const fault = code => Object.assign(Error(code), { code });
const run = (args, timeout) => new Promise((resolve, reject) => {
  execFile(PYTHON, args, {timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024}, (error, stdout, stderr) => {
    if (error) { reject(Object.assign(error, {stderr: String(stderr || '')})); return; }
    resolve(String(stdout || ''));
  });
});

export function bindVoiceTools(agentCtx, root, key, agent, turnFor, {fetchImpl = fetch} = {}) {
  const active = () => {
    const turn = turnFor();
    return !!turn && !turn.controller.signal.aborted;
  };
  const settings = () => read(path.join(root, 'config/wechatagent.json'));
  // Private chats: the talker is the person. Groups: resolve the numeric
  // conversation id back to the "@chatroom" wxid through the reader sessions,
  // exactly like the adapter's resolveTarget.
  const onebotId = value =>
    Number(crypto.createHash('sha256').update(String(value)).digest().readBigUInt64BE(0) % 2147483647n + 1n);
  async function resolveTarget(turn, signal) {
    const direct = turn.targetWxid || turn.sender || '';
    if (!key.startsWith('wechat:group:')) return direct;
    if (String(direct).includes('@chatroom')) return direct;
    const groupId = key.slice('wechat:group:'.length);
    try {
      const io = read(path.join(root, 'state/wechat-io-config.json'));
      const response = await fetchImpl(new URL(io.reader_base_url).origin + '/api/v1/sessions?limit=500', {
        headers: {Authorization: 'Bearer ' + io.reader_token},
        redirect: 'error',
        signal,
      });
      if (!response.ok) return '';
      const data = await response.json();
      const match = (data.sessions ?? []).find(session => {
        if (typeof session.username !== 'string' || !session.username.includes('@chatroom')) return false;
        const mapped = Number(session.conversationId);
        const id = Number.isSafeInteger(mapped) && mapped > 0
          ? String(mapped)
          : String(onebotId((session.displayName || session.username).replace(/\s*\(\d+\)\s*$/, '').trim()));
        return id === String(groupId);
      });
      return match ? match.username : '';
    } catch { return ''; }
  }

  const definition = {
    name: 'wechat_voice_send',
    description: '把一段文字用 TTS 合成后，作为**真正的微信语音条**发到当前聊天（对方看到可播放的语音气泡，不是音频文件）。文本会原样朗读，不要放表情符号或 Markdown。返回 accepted 仅表示已提交，未确认前不要声称对方已听到。',
    parameters: {
      type: 'object',
      properties: {
        text: {type: 'string', minLength: 1, maxLength: 300},
        voice: {type: 'string', maxLength: 80},
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {content: {type: 'string'}, isError: {type: 'boolean'}},
        required: ['content', 'isError'],
        additionalProperties: false,
      },
      render: (_args, value) => [{type: 'text', text: value.content}],
    },
    async execute(args) {
      const turn = turnFor();
      if (!turn || turn.controller.signal.aborted) {
        return {content: JSON.stringify({status: 'failed', code: 'VOICE_TURN_UNAVAILABLE'}), isError: true};
      }
      if (!args || typeof args.text !== 'string' || !args.text.trim() || args.text.length > 300) {
        return {content: JSON.stringify({status: 'failed', code: 'VOICE_TEXT_INVALID'}), isError: true};
      }
      try {
        const target = await resolveTarget(turn, turn.controller.signal);
        if (!target) throw fault('VOICE_TARGET_UNAVAILABLE');
        const voicesDir = path.join(root, 'state', 'voices');
        fs.mkdirSync(voicesDir, {recursive: true});
        const stamp = crypto.randomBytes(6).toString('hex');
        const silkPath = path.join(voicesDir, 'tts-' + stamp + '.silk');
        const script = path.join(root, 'scripts', 'voice-tts.py');
        if (!fs.existsSync(script)) throw fault('VOICE_TTS_MISSING');
        await run([script, args.text, silkPath, args.voice || '', process.env.WECHATAGENT_TTS_PROVIDER || 'fish'], 90000);
        if (!fs.existsSync(silkPath)) throw fault('VOICE_TTS_FAILED');
        const bytes = fs.readFileSync(silkPath);
        if (bytes.length < 100) throw fault('VOICE_TTS_EMPTY');
        const sha = crypto.createHash('sha256').update(bytes).digest('hex');
        const staged = path.join(root, 'state', 'voices', 'outgoing', sha);
        fs.mkdirSync(staged, {recursive: true});
        const stagedFile = path.join(staged, 'voice.silk');
        if (!fs.existsSync(stagedFile) || fs.statSync(stagedFile).size !== bytes.length) fs.writeFileSync(stagedFile, bytes);
        const token = fs.readFileSync(path.join(root, 'state/hook/native-token.txt'), 'utf8').trim();
        const hook = new URL(settings().hook.baseUrl);
        const health = await fetchImpl(hook.origin + '/WeChatAgent/health', {headers: {Authorization: 'Bearer ' + token}});
        if (!health.ok) throw fault('VOICE_HOOK_UNAVAILABLE');
        const status = await health.json();
        const account = Array.isArray(status.databaseAccounts) ? status.databaseAccounts[0] : '';
        if (!account) throw fault('VOICE_ACCOUNT_NOT_READY');
        const response = await fetchImpl(hook.origin + '/SendVoiceMsg', {
          method: 'POST',
          headers: {Authorization: 'Bearer ' + token, 'X-WeChatAgent-Account': account, 'Content-Type': 'application/json'},
          body: JSON.stringify({wxidorgid: target, path: stagedFile, duration: Math.max(1000, Math.round(args.text.length / 4) * 1000)}),
        });
        const text = await response.text();
        let data = {};
        try { data = JSON.parse(text); } catch {}
        if (!response.ok || data.ret !== 0) throw Object.assign(fault('VOICE_NATIVE_REJECTED'), {detail: `${response.status} ${text.slice(0, 120)}`});
        try { fs.unlinkSync(silkPath); } catch {}
        return {content: JSON.stringify({status: 'accepted', size: bytes.length, notice: '已提交微信语音消息；未确认前不要声称对方已听到。'}), isError: false};
      } catch (error) {
        const code = /^VOICE_[A-Z_]+$/.test(error.code ?? error.message) ? (error.code ?? error.message) : 'VOICE_OPERATION_FAILED';
        return {content: JSON.stringify({status: 'failed', code, ...(error.detail ? {detail: error.detail} : {})}), isError: true};
      }
    },
  };

  Object.defineProperty(agentCtx, VOICE_SEND_POLICY, {
    value: {names: () => new Set(names), check: name => names.includes(name), definitions: () => [definition]},
    configurable: true,
  });
  const disposers = [definition].map(tool => agentCtx.tools.register(tool));
  return {
    instructions: () => active()
      ? '[微信语音]\n需要“说”而不是“打字”时，用 wechat_voice_send(text)。它用她本人的克隆音色合成真正的中文语音条（可播放的气泡），不是文件。\n对方发来语音、或你想念出来或撒娇时，优先用语音回复。\n文本会被原样朗读：不要放 Markdown、表情符号、括号动作或网址，句子要短、口语化。'
      : '',
    dispose() {
      for (const dispose of disposers) dispose?.();
      delete agentCtx[VOICE_SEND_POLICY];
    },
  };
}
