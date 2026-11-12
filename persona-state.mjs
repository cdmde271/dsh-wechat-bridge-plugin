// Time-aware state line injected into every WeChat turn.
// Derived from Melbourne local time plus a per-conversation counter so she does
// not repeat the same schedule beat ("just ate", "in class") over and over.

import fs from 'node:fs';
import path from 'node:path';

const TIMEZONE = 'Australia/Melbourne';

const PHASES = [
  {from: '23:40', to: '07:00', text: '这个点她基本已经睡了，被吵醒会迷迷糊糊、有点起床气', key: 'sleep'},
  {from: '07:00', to: '08:10', text: '刚起床洗漱，头发乱，人还没完全清醒', key: 'wake'},
  {from: '08:10', to: '12:30', text: '上午在上课，只能趁课间偷偷瞄手机', key: 'class-am'},
  {from: '12:30', to: '13:30', text: '午休时间，人在食堂或宿舍', key: 'lunch'},
  {from: '13:30', to: '15:40', text: '下午还在上课，回得慢是正常的', key: 'class-pm'},
  {from: '15:40', to: '18:00', text: '放学了，在路上或者刚回宿舍', key: 'after-school'},
  {from: '18:00', to: '19:00', text: '在食堂打卡吃饭', key: 'dinner'},
  {from: '19:00', to: '21:30', text: '晚上自由时间，比较放松', key: 'evening'},
  {from: '21:30', to: '23:40', text: '准备洗漱睡觉，语气软一点、容易犯困', key: 'night'},
];

// Beats worth mentioning once per phase only.
const ONCE_ONLY = new Set(['dinner', 'lunch', 'wake', 'after-school']);

const toMinutes = value => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value));
  return match ? Number(match[1]) * 60 + Number(match[2]) : -1;
};

function inPhase(minutes, phase) {
  const from = toMinutes(phase.from), to = toMinutes(phase.to);
  if (from < 0 || to < 0) return false;
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

let root = '';
export function configure(rootDir) {
  root = rootDir;
}

function statePath(key) {
  const name = Buffer.from(String(key || 'default')).toString('hex').slice(0, 32);
  return path.join(root, 'state', 'persona', name + '.json');
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  } catch {}
}

export function personaStateLine(conversationKey = '') {
  const now = new Date();
  let hour = '', minute = '', weekday = '';
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: TIMEZONE, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).formatToParts(now);
    for (const part of parts) {
      if (part.type === 'hour') hour = part.value;
      else if (part.type === 'minute') minute = part.value;
      else if (part.type === 'weekday') weekday = part.value;
    }
  } catch {
    return '';
  }
  if (hour === '24') hour = '00';
  const minutes = Number(hour) * 60 + Number(minute);
  const phase = PHASES.find(item => inPhase(minutes, item));
  if (!phase) return '';

  let repeat = 0;
  if (root && conversationKey) {
    try {
      const file = statePath(conversationKey);
      const state = readState(file);
      repeat = state.key === phase.key ? Number(state.count || 0) : 0;
      writeState(file, {key: phase.key, count: repeat + 1, at: Date.now()});
    } catch {}
  }

  const base = `[状态] 现在是墨尔本时间 ${hour}:${minute}（${weekday}）。${phase.text}。`;
  const once = ONCE_ONLY.has(phase.key) && repeat >= 1
    ? '（这个时段的事今天已经提过了，这一轮不要再重复说自己在吃饭/刚起床/刚放学，换个说法或聊别的。）'
    : '';
  const tail = '按这个时间调整语气和节奏：该困就困、该忙就说忙，不要假装随时都在。时间说法要和之前说过的一致，不能自相矛盾。';
  return base + once + tail;
}
