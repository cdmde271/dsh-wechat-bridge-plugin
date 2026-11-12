import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Real WeChat image message channel: /SendImgMsg on the native hook.
// Unlike the file channel this is available in social mode, because the
// recipient sees an inline image (thumbnail + tap to enlarge), not a file card.
export const IMAGE_SEND_POLICY = Symbol.for('wechatagent.image-send.v1');
const IMAGE_LIMIT = 20 * 1024 * 1024;
const EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const names = ['wechat_image_send'];

const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const fault = code => Object.assign(Error(code), { code });
const digest = (buffer, algorithm) => crypto.createHash(algorithm).update(buffer).digest('hex');
const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};
// Same id derivation as the OneBot adapter (scripts/hook-onebot.mjs).
const onebotId = value =>
  Number(crypto.createHash('sha256').update(String(value)).digest().readBigUInt64BE(0) % 2147483647n + 1n);

export function bindImageTools(agentCtx, root, key, agent, turnFor, { isAllowed = () => true, fetchImpl = fetch, history = null } = {}) {
  const active = () => {
    const turn = turnFor();
    return !!turn && !turn.controller.signal.aborted && isAllowed() === true;
  };
  const settings = () => read(path.join(root, 'config/wechatagent.json'));

  // Private chats: the talker is the person. Groups: resolve the numeric
  // conversation id back to the "@chatroom" wxid through the reader sessions,
  // exactly like the adapter's resolveTarget.
  async function resolveTarget(turn, signal) {
    const direct = turn.targetWxid || turn.sender || '';
    if (!key.startsWith('wechat:group:')) return direct;
    if (direct.includes('@chatroom')) return direct;
    const groupId = key.slice('wechat:group:'.length);
    try {
      const io = read(path.join(root, 'state/wechat-io-config.json'));
      const response = await fetchImpl(new URL(io.reader_base_url).origin + '/api/v1/sessions?limit=500', {
        headers: { Authorization: 'Bearer ' + io.reader_token },
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

  // Best-effort receipt so the turn's own record shows the image. The app owns
  // this file; a later app write may drop the row, which is why failures are
  // swallowed instead of blocking the send.
  function recordReceipt(name, sha256, size) {
    try {
      const file = path.join(root, 'state/social-messages.json');
      if (!fs.existsSync(file)) return;
      const data = read(file);
      const rows = data?.chats?.[key];
      if (!Array.isArray(rows)) return;
      const kind = key.startsWith('wechat:group:') ? 'group' : 'private';
      const io = fs.existsSync(path.join(root, 'state/wechat-io-config.json')) ? read(path.join(root, 'state/wechat-io-config.json')) : {};
      const selfId = typeof io.self_wxid === 'string' ? io.self_wxid : '';
      rows.push({
        id: crypto.randomUUID(),
        platform: 'wechat',
        kind,
        conversation_id: key.slice(('wechat:' + kind + ':').length),
        conversation_name: '',
        sender_id: selfId,
        sender_name: 'AI',
        message_id: 'image-' + sha256.slice(0, 24),
        self_id: selfId,
        work_mode: 'social',
        text: '[图片]',
        timestamp: Math.floor(Date.now() / 1000),
        images: [{ type: 'image', data: { file: 'wechatagent://image/' + sha256, media_id: sha256 } }],
        files: [],
        direct_mention: false,
        outgoing: true,
        processed: true,
        delivery_status: 'confirmed',
      });
      const temporary = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(data), 'utf8');
      fs.renameSync(temporary, file);
    } catch { /* receipt only */ }
    try {
      history?.append(key, {
        id: 'image-' + sha256.slice(0, 24),
        timestamp: Date.now() / 1000,
        sender_name: 'AI',
        outgoing: true,
        delivery_status: 'confirmed',
        text: '[图片]',
      }, { source: 'image-send', fullText: '[图片]' });
    } catch { /* archive only */ }
  }

  const definition = {
    name: 'wechat_image_send',
    description: '把当前工作区里已有的图片作为真正的微信图片消息发送到当前聊天：对方看到缩略图，点开看大图，不是文件卡片。只接受当前工作区的相对路径。generate_image 生成图片后不会自动发送——要让对方看到，必须紧接着调用本工具，path 用生成结果里的工作区相对路径。返回 accepted 仅表示已提交原生发送，未确认前不能声称对方已收到。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', maxLength: 1000 },
        name: { type: 'string', maxLength: 180 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { content: { type: 'string' }, isError: { type: 'boolean' } },
        required: ['content', 'isError'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.content }],
    },
    async execute(args, exec) {
      const turn = turnFor();
      if (!turn || turn.controller.signal.aborted) {
        return { content: JSON.stringify({ status: 'failed', code: 'IMAGE_TURN_UNAVAILABLE', message: '本轮会话上下文未就绪，请重试一次。' }), isError: true };
      }
      if (!args || Object.keys(args).some(field => !['path', 'name'].includes(field))) throw Error('IMAGE_SEND_NOT_ALLOWED');
      const signal = AbortSignal.any([turn.controller.signal, AbortSignal.timeout(25000), ...(exec?.signal ? [exec.signal] : [])]);
      try {
        if (typeof args.path !== 'string' || !args.path || args.path.length > 1000 || path.isAbsolute(args.path) || /^[A-Za-z]:|^[/\\]|\0/.test(args.path)) throw fault('IMAGE_RELATIVE_PATH_REQUIRED');
        const base = fs.realpathSync(agent.session.header.cwd);
        const source = path.resolve(base, args.path);
        if (!inside(base, source) || !fs.existsSync(source) || !fs.statSync(source).isFile()) throw fault('IMAGE_OUTSIDE_WORKSPACE');
        const name = args.name ?? path.basename(source);
        if (!name || name.length > 180 || !EXTENSIONS.has(path.extname(name).toLowerCase())) throw fault('IMAGE_EXTENSION_INVALID');
        const bytes = fs.readFileSync(source);
        if (!bytes.length || bytes.length > IMAGE_LIMIT) throw fault('IMAGE_TOO_LARGE');
        const sha256 = digest(bytes, 'sha256'), md5 = digest(bytes, 'md5');
        const outgoing = path.join(root, 'state', 'images', 'outgoing', sha256);
        fs.mkdirSync(outgoing, { recursive: true });
        const staged = path.join(outgoing, name);
        if (!fs.existsSync(staged) || fs.statSync(staged).size !== bytes.length) fs.writeFileSync(staged, bytes, { mode: 0o600 });
        const token = fs.readFileSync(path.join(root, 'state/hook/native-token.txt'), 'utf8').trim();
        const hook = new URL(settings().hook.baseUrl);
        const destination = await resolveTarget(turn, signal);
        if (!destination) throw fault('IMAGE_TARGET_UNAVAILABLE');
        // The hook validates X-WeChatAgent-Account against its own open database
        // folder name; state/weflow/active-account.json holds a different hash id.
        const health = await fetchImpl(hook.origin + '/WeChatAgent/health', {
          headers: { Authorization: 'Bearer ' + token },
          redirect: 'error',
          signal,
        });
        if (!health.ok) throw fault('IMAGE_HOOK_UNAVAILABLE');
        const status = await health.json();
        const account = Array.isArray(status.databaseAccounts) ? status.databaseAccounts[0] : '';
        if (!account) throw fault('IMAGE_ACCOUNT_NOT_READY');
        const response = await fetchImpl(hook.origin + '/SendImgMsg', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + token,
            'X-WeChatAgent-Account': account,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ wxidorgid: destination, path: staged, md5, size: bytes.length }),
          redirect: 'error',
          signal,
        });
        const text = await response.text();
        let data = {};
        try { data = JSON.parse(text); } catch {}
        if (!response.ok || data.ret !== 0) throw Object.assign(fault('IMAGE_NATIVE_REJECTED'), { detail: `${response.status} ${text.slice(0, 160)}` });
        recordReceipt(name, sha256, bytes.length);
        return {
          content: JSON.stringify({ status: 'accepted', name, size: bytes.length, md5, notice: '已提交微信原生图片消息；送达情况以后续消息记录为准，未确认前不要声称对方已看到。' }),
          isError: false,
        };
      } catch (error) {
        const code = /^IMAGE_[A-Z_]+$/.test(error.code ?? error.message) ? error.code ?? error.message : 'IMAGE_OPERATION_FAILED';
        return {
          content: JSON.stringify({
            status: 'failed',
            code,
            ...(error.detail ? { detail: error.detail } : {}),
            message: code === 'IMAGE_NATIVE_REJECTED'
              ? '微信端拒绝了这次图片发送。'
              : code === 'IMAGE_TARGET_UNAVAILABLE'
                ? '找不到这个聊天的微信目标地址，图片没有发送。'
                : code === 'IMAGE_ACCOUNT_NOT_READY'
                  ? '微信客户端还没有上报已登录账号，稍后再试。'
                  : '本次图片没有发送；文字回复可以继续。',
          }),
          isError: true,
        };
      }
    },
  };

  Object.defineProperty(agentCtx, IMAGE_SEND_POLICY, {
    value: {
      // Always declared: visibility must not depend on the reader-account file.
      // The execute path validates the live turn and the hook before sending.
      names: () => new Set(names),
      check: name => names.includes(name),
      definitions: () => [definition],
    },
    configurable: true,
  });
  const disposers = [definition].map(tool => agentCtx.tools.register(tool));
  return {
    instructions: () => active()
      ? '[微信图片]\n需要把图片真正发到聊天里时，用 wechat_image_send(相对路径)。它发送的是原生图片消息（缩略图 + 点开大图），不是文件卡片。generate_image 只把图存到工作区，不会自动发送；要发就紧接着调本工具，传生成结果里的相对路径。只接受当前工作区里的 png/jpg/jpeg/gif/webp 文件；提交成功不等于对方已看到。'
      : '',
    dispose() {
      for (const dispose of disposers) dispose?.();
      delete agentCtx[IMAGE_SEND_POLICY];
    },
  };
}
