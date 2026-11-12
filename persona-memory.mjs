// Mood and promise memory for WeChat turns.
// Keeps a tiny per-conversation record so she carries a feeling and remembers
// what she said she would do later.

import fs from 'node:fs';
import path from 'node:path';

let root = '';
export function configureMemory(rootDir) {
  root = rootDir;
}

function fileFor(key) {
  const name = Buffer.from(String(key || 'default')).toString('hex').slice(0, 32);
  return path.join(root, 'state', 'persona', name + '-mood.json');
}

function load(key) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(key), 'utf8'));
  } catch {
    return { mood: 60, updatedAt: 0, promises: [] };
  }
}

function save(key, value) {
  try {
    fs.mkdirSync(path.dirname(fileFor(key)), { recursive: true });
    fs.writeFileSync(fileFor(key), JSON.stringify(value), 'utf8');
  } catch {}
}

const PRAISE = /可爱|喜欢你|想你|厉害|真好|好棒|牛啊|太强|谢谢你|有你真好|懂我/;
const INSULT = /智障|傻逼|傻子|蠢|滚|闭嘴|烦死|讨厌你|别说了/;
const COLD = /^(嗯+|哦+|随便|算了|没事|行吧|好吧)[。！!….\s]*$/;

function clamp(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function moodContext(key, incoming = '') {
  const state = load(key);
  const text = String(incoming || '').trim();
  const now = Date.now();

  // Decay toward neutral while nothing happens.
  if (state.updatedAt) {
    const hours = Math.max(0, (now - state.updatedAt) / 3600000);
    state.mood = state.mood + (55 - state.mood) * Math.min(1, hours * 0.12);
  }
  if (PRAISE.test(text)) state.mood += 7;
  if (INSULT.test(text)) state.mood -= 14;
  if (COLD.test(text)) state.mood -= 5;
  state.mood = clamp(state.mood);
  state.updatedAt = now;
  state.promises = (state.promises || []).filter(item => item && item.due > now);
  save(key, state);

  const band = state.mood >= 75
    ? '心情挺好的，说话可以轻快、主动逗两句'
    : state.mood >= 55
      ? '心情正常'
      : state.mood >= 40
        ? '有点闷，回得短一点，别硬找话'
        : '心情不太好，可以有点冷或敷衍，别装开心';
  return `[心情] ${band}。`;
}

const PROMISE = /(明天|后天|明早|晚上|待会|晚点|一会儿|回去|下课|放学)[^。！？!?\n]{0,18}(我|再)[^。！？!?\n]{0,18}/;

export function recordReply(key, replyText) {
  const text = String(replyText || '');
  if (!text || !PROMISE.test(text)) return;
  const state = load(key);
  const match = PROMISE.exec(text);
  const span = text.slice(Math.max(0, match.index - 8), match.index + match[0].length + 8).replace(/\s+/g, ' ').trim();
  const now = Date.now();
  const due = /明天|明早|后天/.test(match[1]) ? now + 30 * 3600000 : now + 6 * 3600000;
  state.promises = (state.promises || []).filter(item => item && item.due > now);
  if (state.promises.length < 5 && !state.promises.some(item => item.text === span)) {
    state.promises.push({ text: span, due, at: now });
  }
  save(key, state);
}

export function pendingContext(key) {
  const state = load(key);
  const now = Date.now();
  const live = (state.promises || []).filter(item => item && item.due > now);
  if (!live.length) return '';
  return '[待办] 你之前答应过：' + live.map(item => '「' + item.text + '」').join('；') + '。合适的时候要兑现，不要装作没说过。';
}

// --- cross-chat daily topics -------------------------------------------------
function todayFile() {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(root, 'state', 'persona', 'today-' + day + '.json');
}

function readToday() {
  try {
    return JSON.parse(fs.readFileSync(todayFile(), 'utf8'));
  } catch {
    return { items: [] };
  }
}

export function recordTopic(key, text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!clean) return;
  const data = readToday();
  data.items = (data.items || []).filter(item => item && item.key && item.text);
  if (data.items.some(item => item.key === key && item.text === clean)) return;
  data.items.push({ key, text: clean, at: Date.now() });
  data.items = data.items.slice(-12);
  try {
    fs.mkdirSync(path.dirname(todayFile()), { recursive: true });
    fs.writeFileSync(todayFile(), JSON.stringify(data), 'utf8');
  } catch {}
}

export function siblingTopics(key) {
  const data = readToday();
  const other = (data.items || []).filter(item => item.key && item.key !== key).slice(-3);
  if (!other.length) return '';
  const where = value => (String(value).includes(':group:') ? '群里' : '私聊里');
  return '[今天另一个会话] ' + other.map(item => where(item.key) + '聊到「' + item.text + '」').join('；') + '。相关的话可以自然带出来，不用硬提。';
}
