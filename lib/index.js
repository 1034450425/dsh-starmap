/**
 * dsh-starmap 宿主半侧：把 mnemon 记忆仓索引成「工作区 = 星团 / 记忆 = 光点」的图。
 *
 * 数据源只有三样东西，全在记忆系统里：
 *   运行时记忆  runtime/memories.json（+ MEMORY.md / USER.md）
 *   项目档案    documents/index.json 里 active 的那批
 *   记忆空间    data/<space>/mnemon.db 里的 insights（+ 实体）
 *
 * 只读：不写回任何记忆，只在 ~/.dsh/dsh-starmap/ 下留一份工作区映射缓存。
 * @module dsh-starmap/host
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';

/** 插件行 id（与 cordis.patch.yml 一致） */
export const name = 'starmap';
/** 只依赖宿主 webServer：路由由它托管，客户端只走同源 fetch。 */
export const inject = ['webServer'];

const ROUTE = '/dsh-starmap';
const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = join(LIB_DIR, 'vendor');
const SESSIONS_DIR = process.env.DSH_STARMAP_SESSIONS || join(homedir(), '.dsh', 'sessions');
const CACHE_DIR = process.env.DSH_STARMAP_CACHE || join(homedir(), '.dsh', 'dsh-starmap');
/** 工作区哈希 → 真实路径的映射缓存（不是星图数据，只是「这串 hex 是谁」）。 */
const WS_MAP_FILE = join(CACHE_DIR, 'workspaces.json');
/** Unity / 外部程序读这个文件拿当前地址：宿主端口每次重启都会变，写下来最省事。 */
const ENDPOINT_FILE = join(CACHE_DIR, 'endpoint.json');

/** 记忆仓根：mnemon 的 storageScope=workspaces 时落在 F:\Memory，其次 ~/.mnemon。 */
const MEMORY_ROOT =
  process.env.DSH_STARMAP_MEMORY || (existsSync('F:\\Memory') ? 'F:\\Memory' : join(homedir(), '.mnemon'));

/** 三类记忆的配色与命名，客户端图例也认这三样。 */
const CATS = {
  runtime: { label: '运行时记忆', color: '#ffd98a' },
  doc: { label: '项目档案', color: '#c9a7ff' },
  space: { label: '记忆空间', color: '#6fe0ff' },
  entity: { label: '实体', color: '#8ea6d0' },
};

/* ------------------------------------------------------- 对外地址（给 Unity） */

let lastEndpoint = '';

/** 把「本机当前的星图 API 地址」落到磁盘，端口变了才重写。 */
function writeEndpoint(url) {
  if (!url || url === lastEndpoint) return;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      ENDPOINT_FILE,
      JSON.stringify({
        url,
        graph: url + '/api/graph',
        updatedAt: new Date().toISOString(),
        plugin: 'dsh-starmap',
      }),
    );
    lastEndpoint = url;
  } catch {
    /* 写不了就算了，不影响面板 */
  }
}

/** 从宿主 webServer 上尽量把端口挖出来；挖不到就等第一次请求的 Host 头。 */
function guessOrigin(ctx) {
  try {
    const ws = ctx?.webServer;
    if (!ws) return '';
    const pick = (o) => {
      if (!o) return 0;
      if (typeof o.port === 'number' && o.port > 0) return o.port;
      if (typeof o.address === 'function') {
        const a = o.address();
        if (a && typeof a.port === 'number') return a.port;
      }
      return 0;
    };
    const port = pick(ws) || pick(ws.server) || pick(ws.httpServer) || pick(ws.listener);
    return port ? `http://127.0.0.1:${port}/dsh-starmap` : '';
  } catch {
    return '';
  }
}

/** 星团配色：按工作区出现顺序取用，超出后循环。 */
// 配色按工作区 id 的哈希取，所以这里换位置会影响谁拿哪个颜色：
// 索引 1 留给粉色，Feishu 哈希正好落在 1 上。
const PALETTE = ['#6f9dff', '#ff7a9c', '#ffb86b', '#7fe3c0', '#c08bff', '#6fe0ff', '#e8d45b', '#9be07b'];

/* ------------------------------------------------------------ 小工具 */

function listDir(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function fnv1a(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** mnemon 的工作区身份：canonicalWorkspacePath 的 sha256（resolve + 逐级 realpath）。 */
function canonicalPath(workspacePath) {
  let parent = makeAbsolute(workspacePath);
  const suffix = [];
  for (;;) {
    let real;
    try {
      // realpathSync.native 在 Windows 上连 8.3 短名、junction 一起解掉，
      // mnemon 算工作区 id 用的就是这一个。
      real = realpathSync.native(parent);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const next = parent.replace(/[\\/][^\\/]*$/, '');
      if (!next || next === parent) throw error;
      suffix.unshift(basename(parent));
      parent = next;
      continue;
    }
    if (suffix.length > 0 && !statSync(real).isDirectory()) throw new Error('not a directory');
    return [real, ...suffix].join('\\');
  }
}

function makeAbsolute(p) {
  const raw = String(p || '');
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) return raw;
  throw new Error('workspace path must be absolute');
}

function workspaceHash(cwd) {
  try {
    return createHash('sha256').update(canonicalPath(cwd)).digest('hex');
  } catch {
    return '';
  }
}

/* ------------------------------------------------ 工作区哈希 → 真实路径 */

/** ~/.dsh/sessions 的目录名是路径换码：`--D-DeepSeek-Feishu--`，非 ASCII 用 ~XXXX 表示。 */
function decodeSessionDir(dirName) {
  const body = String(dirName).replace(/^--/, '').replace(/--$/, '');
  if (!/^[A-Za-z]-/.test(body)) return '';
  const text = body.replace(/~([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const parts = text.split('-');
  const drive = parts.shift();
  return drive + ':\\' + parts.join('\\');
}

/** 只解一份会话的头行，拿真实 cwd（比目录名解码更权威，占位符多的时候靠它）。 */
function readSessionHeadCwd(file) {
  try {
    const raw = readFileSync(file);
    const text = raw[0] === 0x7b /* { */ ? raw.toString('utf8') : zstdDecompressSync(raw).toString('utf8');
    const nl = text.indexOf('\n');
    const head = JSON.parse(nl > 0 ? text.slice(0, nl) : text);
    return head && head.type === 'session' && typeof head.cwd === 'string' ? head.cwd : '';
  } catch {
    return '';
  }
}

/** 每个 sessions 子目录只翻最新一份会话的头行：一个工作区一次解压，够快。 */
function sessionWorkspacePaths() {
  const out = new Set();
  for (const dir of listDir(SESSIONS_DIR)) {
    const guess = decodeSessionDir(dir);
    if (guess && existsSync(guess)) out.add(guess);
    const base = join(SESSIONS_DIR, dir);
    let best = null;
    let bestMt = -1;
    for (const session of listDir(base)) {
      const file = join(base, session, 'session.v4.jsonl.zstd');
      try {
        const st = statSync(file);
        if (st.mtimeMs > bestMt) {
          bestMt = st.mtimeMs;
          best = file;
        }
      } catch {
        /* 这份会话没有正文文件：跳过 */
      }
    }
    if (best) {
      const cwd = readSessionHeadCwd(best);
      if (cwd) out.add(cwd);
    }
  }
  return [...out];
}

/**
 * 记忆仓里的 workspaces/<hex> 到底是谁：先用缓存，再用 sessions 目录名 / 会话头行补，
 * 补到了就记下来，下次不再翻文件。
 */
function resolveWorkspaceMap(hashes) {
  const cached = readJson(WS_MAP_FILE);
  const map = {};
  if (cached && cached.version === 1 && cached.map) {
    for (const [h, cwd] of Object.entries(cached.map)) if (typeof cwd === 'string') map[h] = cwd;
  }
  if (hashes.some((h) => !map[h])) {
    for (const cwd of sessionWorkspacePaths()) {
      const h = workspaceHash(cwd);
      if (h && !map[h]) map[h] = cwd;
    }
  }
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(WS_MAP_FILE, JSON.stringify({ version: 1, at: Date.now(), map }));
  } catch {
    /* 写不进去不影响出图 */
  }
  return map;
}

/* --------------------------------------- 会话索引（对话 = 恒星 / 子代理 = 卫星） */

/**
 * 会话索引：把 ~/.dsh/sessions 里每个会话读成一条「天体」记录。
 *
 * 只读头行 + 标题 + 消息计数，不碰正文里的工具参数 —— 1308 个会话解一遍约 2 秒，
 * 所以按「所有会话文件的 size+mtime 指纹」缓存到 CACHE_DIR，指纹不变就不重扫。
 */
const SESSION_INDEX_FILE = join(CACHE_DIR, 'sessions.json');
const SESSION_INDEX_VERSION = 4;

/** 所有会话文件的指纹：任何一个会话写入了内容，这个值就变。 */
function sessionStamp() {
  let stamp = '';
  for (const dir of listDir(SESSIONS_DIR)) {
    const base = join(SESSIONS_DIR, dir);
    for (const name of listDir(base)) {
      const file = join(base, name, 'session.v4.jsonl.zstd');
      try {
        const st = statSync(file);
        stamp += st.size.toString(36) + '.' + Math.round(st.mtimeMs).toString(36) + ';';
      } catch {
        /* 没有正文文件的会话目录：不算 */
      }
    }
    stamp += '|';
  }
  return fnv1a(stamp) + ':' + stamp.length;
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 会话日志是「一帧一条」追加写的 zstd。宿主里的 zstdDecompressSync 只肯解第一帧，
 * 整段丢进去只会拿回开头那行 head —— 于是所有会话的发言数都是 0、标题全空，
 * 人类对话一条都认不出来。所以按帧切开逐个解，再拼回整份文本。
 */
function zstdFrames(buf) {
  const parts = [];
  let pos = 0;
  let guard = 0;
  while (pos < buf.length && guard < 8000) {
    guard += 1;
    const next = buf.indexOf(ZSTD_MAGIC, pos + 4);
    const end = next > 0 ? next : buf.length;
    try {
      parts.push(zstdDecompressSync(buf.subarray(pos, end)).toString('utf8'));
    } catch {
      /* 坏帧跳过，别为一条日志丢掉整份会话 */
    }
    if (next <= 0) break;
    pos = next;
  }
  return parts.join('');
}

function readSessionFile(file) {
  let raw = null;
  try {
    raw = readFileSync(file);
  } catch {
    return null;
  }
  let mtime = 0;
  try {
    mtime = statSync(file).mtimeMs || 0;
  } catch {
    /* 拿不到 mtime 就退回事件时间 */
  }
  const plain = raw[0] === 0x7b; /* { */
  // 先只解第一帧：head 一定在最前面，而子代理会话占了绝大多数，
  // 它们只需要「存在过」这件事，不必为它们解整份日志。
  const second = plain ? -1 : raw.indexOf(ZSTD_MAGIC, 4);
  let headText = '';
  try {
    headText = plain
      ? raw.toString('utf8')
      : zstdDecompressSync(raw.subarray(0, second > 0 ? second : raw.length)).toString('utf8');
  } catch {
    return null;
  }
  let head = null;
  for (const line of headText.split('\n')) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && ev.type === 'session') {
        head = ev;
        break;
      }
    } catch {
      /* 坏行忽略 */
    }
  }
  if (!head || !head.id) return null;
  const origin = String(head.origin || '');
  const base = {
    id: String(head.id),
    cwd: String(head.cwd || ''),
    // 空字符串 = 你我直接对话；'subagent' = 我派出去干活的子代理
    origin,
    parent: String(head.parentSession || ''),
    preset: String(head.agentPreset || ''),
    createdAt: Number(head.createdAt) || 0,
    lastAt: mtime,
  };
  if (origin === 'subagent') return { ...base, users: 0, asst: 0, tools: 0, title: '' };
  let text = headText;
  if (!plain) {
    const full = zstdFrames(raw);
    if (full) text = full;
  }
  let title = '';
  let users = 0;
  let asst = 0;
  let tools = 0;
  let lastAt = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let ev = null;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const type = ev && ev.type;
    if (type === 'session/title') title = (ev.data && ev.data.title) || title;
    else if (type === 'user/message') {
      // 系统注入的消息（提醒、后台通知）不算一次对话轮次
      if (!(ev.data && ev.data.source && ev.data.source.kind === 'system')) users += 1;
    } else if (type === 'assistant/message') asst += 1;
    else if (type === 'tool/call') tools += 1;
    if (typeof ev.time === 'number' && ev.time > lastAt) lastAt = ev.time;
  }
  return { ...base, lastAt: lastAt || mtime, users, asst, tools, title };
}

/** 进程内缓存：磁盘缓存写不进去（只读环境）时，至少同一进程里别重扫。 */
let sessionCache = null;
let sessionCacheStamp = '';
let sessionCacheVersion = 0;

function sessionIndex() {
  const stamp = sessionStamp();
  if (sessionCache && sessionCacheStamp === stamp && sessionCacheVersion === SESSION_INDEX_VERSION)
    return sessionCache;
  const cached = readJson(SESSION_INDEX_FILE);
  if (
    cached &&
    cached.version === SESSION_INDEX_VERSION &&
    cached.stamp === stamp &&
    Array.isArray(cached.sessions)
  ) {
    sessionCache = cached.sessions;
    sessionCacheStamp = stamp;
    sessionCacheVersion = SESSION_INDEX_VERSION;
    return sessionCache;
  }
  const sessions = [];
  for (const dir of listDir(SESSIONS_DIR)) {
    const base = join(SESSIONS_DIR, dir);
    for (const name of listDir(base)) {
      const rec = readSessionFile(join(base, name, 'session.v4.jsonl.zstd'));
      if (rec) sessions.push(rec);
    }
  }
  sessions.sort((a, b) => a.createdAt - b.createdAt);
  sessionCache = sessions;
  sessionCacheStamp = stamp;
  sessionCacheVersion = SESSION_INDEX_VERSION;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      SESSION_INDEX_FILE,
      JSON.stringify({ version: SESSION_INDEX_VERSION, stamp, at: Date.now(), sessions }),
    );
  } catch {
    /* 写不进去就下次重扫，不影响出图 */
  }
  return sessions;
}

/* ------------------------------------------------------------ 记忆读取 */

/** memories.json：结构化热记忆。 */
function readRuntimeJson(file) {
  const raw = readJson(file);
  const entries = Array.isArray(raw?.entries) ? raw.entries : Array.isArray(raw) ? raw : [];
  return entries
    .map((e) => ({
      text: String(e.content || '').trim(),
      target: String(e.target || 'memory'),
      importance: String(e.importance || 'normal'),
      createdAt: Date.parse(e.updated_at || e.created_at || '') || null,
    }))
    .filter((e) => e.text);
}

/**
 * MEMORY.md / USER.md：`[created=3d; updated=3d]` 头 + 正文，块之间用单独一行的 § 分隔。
 * 和 memories.json 常常是同一批内容 —— 交给去重按「先来的赢」处理。
 */
function readMemoryMarkdown(file, target) {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  if (!text.trim()) return [];
  const out = [];
  for (const block of text.split(/^\s*§\s*$/m)) {
    let body = block.trim();
    if (!body) continue;
    let importance = 'normal';
    const meta = /^\[([^\]]*)\]\s*/.exec(body);
    if (meta) {
      const imp = /importance\s*=\s*([a-z]+)/i.exec(meta[1]);
      if (imp) importance = imp[1].toLowerCase();
      body = body.slice(meta[0].length).trim();
    }
    if (body) out.push({ text: body, target, importance, createdAt: null });
  }
  return out;
}

/** 项目档案：documents/index.json 里 active 的那批（archived 不上图）。 */
function readDocIndex(file) {
  const raw = readJson(file);
  const docs = Array.isArray(raw) ? raw : Array.isArray(raw?.documents) ? raw.documents : [];
  const out = [];
  for (const d of docs) {
    if (!d || (d.status && d.status !== 'active')) continue;
    const title = String(d.title || '').trim();
    const desc = String(d.description || '').trim();
    if (!title && !desc) continue;
    out.push({
      id: String(d.id || d.filename || title),
      title,
      text: [title, desc].filter(Boolean).join('｜'),
      createdAt: Date.parse(d.updatedAt || d.createdAt || '') || null,
      sizeBytes: Number(d.sizeBytes) || 0,
      // 写这份档案的那次会话：多数是 mnemon 派出去的子代理（= 卫星），
      // 少数是直接对话。恒星要靠它再往前推一层。
      sessions: Array.isArray(d.sessionIds) ? d.sessionIds.map(String) : [],
    });
  }
  return out;
}

let sqliteApi = null;
try {
  sqliteApi = await import('node:sqlite');
} catch {
  sqliteApi = null;
}

function queryInsights(dbFile) {
  const db = new sqliteApi.DatabaseSync(dbFile, { readOnly: true });
  try {
    const rows = db
      .prepare(
        'select id, content, category, importance, entities, created_at from insights where deleted_at is null',
      )
      .all();
    let rawEdges = [];
    try {
      rawEdges = db.prepare('select source_id, target_id, edge_type, weight from edges').all();
    } catch {
      rawEdges = [];
    }
    return { rows, rawEdges };
  } finally {
    try {
      db.close();
    } catch {
      /* 关不上不影响结果 */
    }
  }
}

/**
 * 记忆空间：一个 space 一个 sqlite 库。
 * 正在被 mnemon 写的那份库有时连只读都打不开（WAL 的 -shm 建不出来），
 * 那就把库连同 -wal/-shm 复制到临时目录再读，读完删掉 —— 绝不碰原库。
 */
function readSpaceDb(dbFile) {
  if (!sqliteApi || !existsSync(dbFile)) return { insights: [], links: [], entities: [] };
  let data = null;
  try {
    data = queryInsights(dbFile);
  } catch {
    data = null;
  }
  if (!data) {
    let tmp = '';
    try {
      tmp = mkdtempSync(join(tmpdir(), 'starmap-db-'));
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(dbFile + suffix)) copyFileSync(dbFile + suffix, join(tmp, 'mnemon.db' + suffix));
      }
      data = queryInsights(join(tmp, 'mnemon.db'));
    } catch {
      data = null;
    } finally {
      if (tmp) {
        try {
          rmSync(tmp, { recursive: true, force: true });
        } catch {
          /* 临时目录清不掉就留着，不阻塞出图 */
        }
      }
    }
  }
  if (!data) return { insights: [], links: [], entities: [] };

  const insights = [];
  const entities = new Map();
  for (const row of data.rows) {
    const text = String(row.content || '').trim();
    if (!text) continue;
    const sid = String(row.id ?? '');
    const id = 'i:' + fnv1a(sid);
    insights.push({
      id,
      sid,
      text,
      category: String(row.category || ''),
      importance: String(row.importance || 'normal'),
      createdAt: Date.parse(row.created_at || '') || null,
    });
    let names = [];
    try {
      names = JSON.parse(row.entities || '[]');
    } catch {
      names = String(row.entities || '').split(/[,、]/);
    }
    for (const raw of Array.isArray(names) ? names : []) {
      const name = String(raw ?? '').trim();
      if (!name) continue;
      const eid = 'e:' + fnv1a(name.toLowerCase());
      if (!entities.has(eid)) entities.set(eid, { id: eid, name, count: 0 });
      entities.get(eid).count += 1;
    }
  }
  const known = new Set(insights.map((i) => i.sid));
  const links = [];
  for (const e of data.rawEdges) {
    const from = String(e.source_id ?? '');
    const to = String(e.target_id ?? '');
    if (!known.has(from) || !known.has(to)) continue;
    links.push({
      fromSid: from,
      toSid: to,
      kind: 'related',
      label: String(e.edge_type || '关联'),
      width: Number(e.weight) || 0.8,
    });
  }
  return { insights, links, entities: [...entities.values()] };
}

/* --------------------------------------------------- 提炼：几个字的名字 */

/** 泛泛的分类标题，光看见它等于没看见内容。 */
const GENERIC_HEAD =
  /^(主人(偏好|画像|习惯|情况)?|偏好|画像|结论|要点|注意|备注|说明|背景|观察|规则|约定|经验|教训|总结|做法|问题|现象|原因|状态|进度|记录|备忘|待办|关键结论|调查结论)$/;
/** 句首的动词/连词，留着只会白占字数。 */
const LEAD_VERB =
  /^(不要|别|务必|记得|需要|要|请|可以|应该|把|为|在|给|用|将|自动|尽量|已经|已|本机|目前|现在|后续|以后|接下来|同时|另外|还有|然后|所以|因此|于是|但|不过|而|且|并且|或者|以及)+/;

function tidy(raw) {
  return String(raw || '')
    .replace(/`{1,3}|\*{1,3}|_{1,2}(?=\S)/g, '')
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .replace(/[「」『』《》【】"'“”‘’]/g, '')
    .replace(/[:：]+/g, ' ')
    .replace(/[，,、；;。!！?？]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cjkLen(s) {
  return (String(s).match(/[\u4e00-\u9fa5]/g) || []).length;
}

/** 句尾是动词的话，它大概是半句话，不是名字。 */
const VERB_TAIL =
  /(出现|发现|看到|检查|查看|排查|处理|确认|核对|修复|解决|实现|改成|改为|接入|安装|配置|运行|使用|调用|读取|写入|涉及|包括|以及|然后|时候|之后|之前)$/;
/** 句尾是「今年 / 是 / 放在 / 要求」这类半截话，说明信息还在后面。 */
const HEAD_TAIL =
  /(今年|目前|现在|是|有|要|会|能|把|被|在|放在|放了|用|叫|让|想|说|觉得|认为|希望|要求|喜欢|不喜欢|不爱|决定|表示|沿革|偏好|习惯)$/;
/** 句首是虚词的话，它只是个碎片。 */
const PARTICLE_HEAD = /^(的|了|是|在|把|被|先|再|就|还|也|都|要|会|可|能|没|不|对|从|向|并|其|该|这|那|它)$/;

/** 一句短语里挑信息量最大的词块：长度贴近 5 个字、位置靠前、不像半句的优先。 */
function bestChunk(phrase) {
  const raw = String(phrase || '');
  const chunks = raw
    .split(/[\s·|/，,、；;。！!？?「」『』（）()【】:：]+/)
    .map((c) => c.replace(/[`*_]+/g, '').trim())
    .filter((c) => {
      const body = c.replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+|[^\u4e00-\u9fa5A-Za-z0-9]+$/g, '');
      if (body.length < 2 || /^[-_=.:0-9]+$/.test(body)) return false;
      // 路径不是名字：`D:\DeepSeek\鲸鱼娘的日记` 这种整段跳过
      if (/[\\/]/.test(body) || /^[A-Za-z]:$/.test(body)) return false;
      return true;
    });
  if (!chunks.length) return '';
  let best = '';
  let bestScore = -Infinity;
  chunks.forEach((c, i) => {
    const cjk = cjkLen(c);
    if (cjk === 0) return;
    let score = 4 - Math.abs(cjk - 5) + (i === 0 ? 1.6 : Math.max(0, 0.9 - i * 0.3));
    if (PARTICLE_HEAD.test(c)) score -= 3;
    if (VERB_TAIL.test(c)) score -= 2.6;
    if (HEAD_TAIL.test(c)) score -= 3.2;
    if (/[了的时后里着呢吧吗]$/.test(c)) score -= 2;
    if (cjk > 10) score -= (cjk - 10) * 0.8;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  });
  if (best) return best;
  const ascii = chunks.find((c) => /[A-Za-z0-9]/.test(c));
  return ascii || chunks[0];
}

/**
 * 按字数截断：允许略超一点（宁长勿断在半句上），断点优先取 的/、/， 这类真接缝，
 * 其次才是靠后的空格；最后再避开把英文单词切成两半。
 */
function clip(s, max) {
  const str = String(s).trim();
  if (str.length <= max) return str;
  const limit = max + 3;
  if (str.length <= limit) return str;
  const head = str.slice(0, limit);
  let cut = -1;
  for (const ch of ['的', '、', '，', '与', '和']) {
    const i = head.lastIndexOf(ch);
    const floor = ch === '与' || ch === '和' ? Math.floor(max * 0.5) : Math.floor(max * 0.4);
    if (i >= Math.max(3, floor) && i > cut) cut = i;
  }
  if (cut < 0) {
    const space = head.lastIndexOf(' ');
    if (space >= Math.max(3, Math.ceil(limit * 0.5))) cut = space;
  }
  if (cut <= 0) cut = limit;
  while (cut > 1 && cut < str.length && /[A-Za-z0-9]/.test(str[cut]) && /[A-Za-z0-9]/.test(str[cut - 1])) cut -= 1;
  return str.slice(0, cut).trim();
}

/**
 * 把一条记忆压成「几个字」的名字：
 * 有标题就用标题（标题自带「X：Y」时取冒号前半截）；
 * 否则抓第一个冒号前那句短语；再否则按词块打分挑最有信息量的一段。
 */
export function digestLabel(text, title) {
  if (title) {
    // 括号里的补充说明先拿掉：`ColorGame（Unity 6.3）项目` → `ColorGame 项目`
    const t = tidy(String(title).split(/[：:]/)[0].replace(/[（(][^）)]*[）)]/g, ' '));
    if (t) return clip(t, 14);
  }
  const s = String(text || '').trim();
  // 括号换成空格而不是删掉，否则「子代理残留（…）自动挂」会粘成一个词
  const flat = s.replace(/[（(][^）)]*[）)]/g, ' ');
  const colon = /^(.{2,26}?)[：:]/.exec(flat);
  if (colon && !/[\\/]/.test(colon[1]) && !/[A-Za-z]$/.test(colon[1])) {
    const head = tidy(colon[1]);
    if (head && !GENERIC_HEAD.test(head)) return clip(head, 14);
    const body = flat.slice(colon[0].length).replace(LEAD_VERB, '').trim();
    const chunk = bestChunk(body) || bestChunk(flat);
    if (chunk) return clip(chunk, 12);
  }
  const first = flat.split(/[。；;！!？?\n]/)[0] || flat;
  const chunk = bestChunk(first) || bestChunk(flat);
  return clip(chunk || tidy(flat), 12) || '一条记忆';
}

/* ------------------------------------------------------------ 去重 */

/** 只留汉字/字母/数字：同一句记忆换个标点写法就算了同一条。 */
function norm(text) {  return String(text || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
}

/**
 * 「筛选一些重复的」：同一句记忆会在 memories.json、MEMORY.md、各工作区里反复出现，
 * 只留先来的那一份（先来的更有结构：带时间、带 importance）；前缀互相包含且够长的也算重复。
 */
function dedupe(items) {
  const kept = [];
  let dropped = 0;
  for (const item of items) {
    const n = norm(item.text);
    if (n.length < 4) {
      dropped += 1;
      continue;
    }
    let dup = false;
    for (let i = 0; i < kept.length; i += 1) {
      const other = kept[i].norm;
      if (other === n) {
        dup = true;
        break;
      }
      const short = n.length <= other.length ? n : other;
      const long = n.length <= other.length ? other : n;
      if (short.length >= 16 && long.startsWith(short)) {
        dup = true;
        break;
      }
    }
    if (dup) {
      dropped += 1;
      continue;
    }
    kept.push({ ...item, norm: n });
  }
  return { items: kept, dropped };
}

/* ------------------------------------------------------------ 建图 */

function importanceWeight(importance) {
  const v = String(importance || '').toLowerCase();
  if (v === 'critical' || v === 'high') return 2.4;
  if (v === 'low') return 0.8;
  return 1.4;
}

/** 一个工作区（或全局）的记忆仓：三样东西各读各的。 */
function workspaceMemories(base) {
  const runtime = [];
  for (const e of readRuntimeJson(join(base, 'runtime', 'memories.json'))) {
    runtime.push({ ...e, from: e.target === 'user' ? '主人画像' : '运行时记忆' });
  }
  for (const e of readMemoryMarkdown(join(base, 'runtime', 'MEMORY.md'), 'memory')) {
    runtime.push({ ...e, from: '运行时记忆' });
  }
  for (const e of readMemoryMarkdown(join(base, 'runtime', 'USER.md'), 'user')) {
    runtime.push({ ...e, from: '主人画像' });
  }

  const docs = readDocIndex(join(base, 'documents', 'index.json'));

  const spaces = [];
  const dataDir = join(base, 'data');
  for (const space of listDir(dataDir)) {
    const dbFile = join(dataDir, space, 'mnemon.db');
    if (!existsSync(dbFile)) continue;
    const read = readSpaceDb(dbFile);
    if (read.insights.length === 0) continue;
    spaces.push({ space, ...read });
  }

  return { runtime, docs, spaces };
}

/** 建图本体；测试脚本也用它，所以单独导出。 */
/** 同一个星团里撞名（两条记忆提炼出同样的几个字）时，给后来者换个更要得开的写法。 */
function spreadLabels(items) {
  const used = new Map();
  for (const item of items) {
    if (!used.has(item.cluster)) used.set(item.cluster, new Set());
    const taken = used.get(item.cluster);
    let label = item.label;
    if (taken.has(label)) {
      const raw = String(item.title || item.text || '');
      const head = raw.split(/[：:|｜]/)[0];
      for (const max of [16, 20, 24]) {
        const cand = clip(tidy(head), max);
        if (cand && cand !== label && !taken.has(cand)) {
          label = cand;
          break;
        }
      }
      if (taken.has(label)) {
        // 标题本身就重复的那批：从正文里再挑一小段，凑出能区分的名字
        const rest = raw.split(/[：:|｜]/).slice(1).join(' ');
        const extra = bestChunk(tidy(rest));
        if (extra && cjkLen(extra) >= 3) {
          const cand = clip(label + ' ' + clip(extra, 6), 24);
          if (!taken.has(cand)) label = cand;
        }
      }
      const base = label;
      let n = 2;
      while (taken.has(label) && n <= 40) {
        label = base + ' ·' + n;
        n += 1;
      }
    }
    item.label = label;
    taken.add(label);
  }
}

/** 工作区 / 会话的 cwd 归一化：大小写、结尾斜杠都不算区别。 */
function pathKey(p) {
  return String(p || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
}

/**
 * 一条记忆该绕哪颗恒星转：在「时间窗盖住它」的对话里，挑跨度最短的那颗。
 *
 * 越短的对话越具体；跨十几天的长会话会自然排到最后。
 * 时间点可以给多个（先看写这份档案的子代理会话出生时间，再看记忆自己的时间）。
 * 一个都盖不住就返回 null —— 这条记忆挂到银心核星上。
 */
function ownerSession(spans, times) {
  let best = null;
  let bestSpan = Infinity;
  for (const t of times) {
    if (!t) continue;
    for (const sp of spans) {
      if (t < sp.from || t > sp.to) continue;
      if (sp.span < bestSpan) {
        bestSpan = sp.span;
        best = sp.s;
      }
    }
    // 早一点的信息更贴近「当时在聊什么」，命中了就不再往更晚的时间点退
    if (best) return best;
  }
  // 没有一个窗口盖得住：退一步，挂到「时间上最接近」的那次对话上。
  // 记忆总归是在某次对话里攒下的，绕银心飘着反而看不出它属于谁。
  let near = null;
  let nearGap = Infinity;
  for (const t of times) {
    if (!t) continue;
    for (const sp of spans) {
      const mid = (sp.from + sp.to) / 2;
      const gap = Math.abs(t - mid);
      if (gap < nearGap) {
        nearGap = gap;
        near = sp.s;
      }
    }
    if (near) return near;
  }
  return null;
}

// 主人在侧栏里给工作区改名（Feishu → Main）时，路径是不变的，
// 所以记忆仓的 hash、会话的 cwd 全都不受影响；但要显示成他起的名字，就得读这张表。
const DSH_WORKSPACE_FILE = join(homedir(), '.dsh', 'storages', 'workspace.json');
let wsTitleCache = null;
let wsTitleStamp = 0;
function workspaceTitles() {
  try {
    const st = statSync(DSH_WORKSPACE_FILE);
    if (wsTitleCache && wsTitleStamp === st.mtimeMs) return wsTitleCache;
    const j = JSON.parse(readFileSync(DSH_WORKSPACE_FILE, 'utf8'));
    const out = new Map();
    const tbl = j && j.tables && j.tables.workspaces;
    if (tbl && typeof tbl === 'object') {
      for (const k of Object.keys(tbl)) {
        const w = tbl[k];
        if (w && w.path && w.title) out.set(pathKey(w.path), String(w.title));
      }
    }
    wsTitleCache = out;
    wsTitleStamp = st.mtimeMs;
    return out;
  } catch {
    return wsTitleCache || new Map();
  }
}

export function buildMemoryGraph(withDust) {
  const wsRoot = join(MEMORY_ROOT, 'workspaces');
  const hashes = listDir(wsRoot);
  const wsMap = resolveWorkspaceMap(hashes);

  const targets = [{ id: 'mem:global', label: '全局记忆', cwd: '', base: MEMORY_ROOT }];
  for (const h of hashes) {
    const cwd = wsMap[h] || '';
    targets.push({
      id: 'ws:' + (cwd || h),
      label: cwd ? basename(cwd) || cwd : '记忆仓 ' + h.slice(0, 6),
      cwd: cwd || 'memory://' + h,
      base: join(wsRoot, h),
    });
  }

  // 真的开过对话的工作区：记忆仓里还没建目录的，也要在星图上占一个团，
  // 否则侧栏列着五个工作区，天上只有三个，看着就像漏了几个。
  const activeCwds = new Set();
  try {
    for (const se of sessionIndex()) {
      if (!se || !se.cwd || se.origin === 'subagent') continue;
      activeCwds.add(se.cwd);
    }
  } catch {
    /* 会话索引读不出来就先不补空团 */
  }
  {
    const knownCwd = new Set();
    for (const t of targets) {
      if (t.cwd && t.cwd.indexOf('memory://') !== 0) knownCwd.add(pathKey(t.cwd));
    }
    for (const cwd of activeCwds) {
      const k = pathKey(cwd);
      if (!cwd || knownCwd.has(k)) continue;
      knownCwd.add(k);
      targets.push({ id: 'ws:' + cwd, label: basename(cwd) || cwd, cwd, base: '' });
    }
  }

  // 侧栏里的名字优先：改过名的工作区，星团跟着改口
  {
    const titles = workspaceTitles();
    for (const t of targets) {
      if (!t.cwd || t.cwd.indexOf('memory://') === 0) continue;
      const nm = titles.get(pathKey(t.cwd));
      if (nm) t.label = nm;
    }
  }

  const pending = [];
  const spaceLinks = [];
  const clusters = [];
  let colorIdx = 0;
  /** cluster id → 真实 cwd：会话按 cwd 归到工作区，得先记住每个星团是谁。 */
  const clusterCwd = new Map();

  for (const target of targets) {
    const mem = target.base
      ? workspaceMemories(target.base)
      : { runtime: [], docs: [], spaces: [] };
    const total =
      mem.runtime.length + mem.docs.length + mem.spaces.reduce((n, s) => n + s.insights.length, 0);
    // 一条记忆都没有、又解不出真实工作区（只有记忆仓目录名）的，才真的不画。
    // 有 cwd 的空工作区要留着 —— 它里面还会有对话，只是还没攒下记忆。
    const realCwd = !!target.cwd && target.cwd.indexOf('memory://') !== 0;
    // 空团只在「这个工作区真的开过对话」时保留：纯记忆仓目录、系统残留目录都不画
    const hasTalk = realCwd && activeCwds.has(target.cwd);
    if (total === 0 && !hasTalk) continue;

    // 颜色跟着工作区 id 走：以前按出现顺序轮流取色，多添一个工作区，
    // 所有星团的颜色会整体挪一格，昨天认得的粉色今天变成紫色。
    const color = PALETTE[parseInt(fnv1a(target.id), 16) % PALETTE.length];

    for (const e of mem.runtime) {
      pending.push({
        cluster: target.id,
        color,
        cat: 'runtime',
        text: e.text,
        label: digestLabel(e.text, ''),
        createdAt: e.createdAt || 0,
        preset: e.from,
        importance: e.importance,
        weight: importanceWeight(e.importance),
        origin: target.label,
      });
    }
    for (const d of mem.docs) {
      pending.push({
        cluster: target.id,
        color,
        cat: 'doc',
        text: d.text,
        label: digestLabel(d.text, d.title),
        title: d.title,
        createdAt: d.createdAt || 0,
        preset: '项目档案',
        importance: 'normal',
        weight: 1.9,
        origin: target.label,
        docId: d.id,
        docSessions: d.sessions || [],
      });
    }
    for (const space of mem.spaces) {
      const spaceKey = target.id + '|' + space.space;
      for (const row of space.insights) {
        pending.push({
          cluster: target.id,
          color,
          cat: 'space',
          text: row.text,
          label: digestLabel(row.text, ''),
          createdAt: row.createdAt || 0,
          preset: '记忆空间',
          importance: row.importance,
          weight: importanceWeight(row.importance) + 0.6,
          origin: target.label,
          category: row.category,
          spaceKey,
          sid: row.sid,
        });
      }
      for (const link of space.links) spaceLinks.push({ spaceKey, ...link });
      if (withDust) {
        for (const ent of space.entities) {
          pending.push({
            cluster: target.id,
            color,
            cat: 'entity',
            dust: true,
            text: ent.name,
            label: ent.name,
            createdAt: 0,
            preset: '实体',
            importance: 'low',
            weight: 0.5,
            origin: target.label,
            spaceKey,
          });
        }
      }
    }

    clusters.push({
      id: target.id,
      label: target.label,
      cwd: target.cwd,
      color,
      count: 0,
      perCat: { runtime: 0, doc: 0, space: 0 },
      msgs: 0,
      lastAt: 0,
    });
    clusterCwd.set(target.id, target.cwd || '');
  }

  // 对话 = 恒星，子代理会话 = 卫星。恒星按工作区 cwd 归组；
  // 记忆靠「时间窗最短包含」落到某颗恒星上（档案自带的 sessionIds 多半指向子代理，不够用）。
  const allSessions = sessionIndex();
  const sessionById = new Map();
  const starsByCwd = new Map();
  for (const s of allSessions) {
    sessionById.set(s.id, s);
    if (s.origin === 'subagent' || !s.users) continue;
    const key = pathKey(s.cwd);
    if (!starsByCwd.has(key)) starsByCwd.set(key, []);
    starsByCwd.get(key).push(s);
  }
  const spansByCwd = new Map();
  const spansFor = (cwd) => {
    const key = pathKey(cwd);
    if (spansByCwd.has(key)) return spansByCwd.get(key);
    const list = (starsByCwd.get(key) || []).map((s) => {
      const from = s.createdAt || 0;
      const to = Math.max(s.lastAt || 0, from + 60000);
      return { s, from, to, span: to - from };
    });
    spansByCwd.set(key, list);
    return list;
  };
  /** 卫星 id → 它绕的那颗行星所在的 cluster（输出卫星记录时要用）。 */
  const moonCluster = new Map();
  /** 子代理会话 → 卫星读数（消息数、工具调用数）。 */
  const moonMeta = new Map();

  const { items, dropped } = dedupe(pending);
  spreadLabels(items);
  const stars = [];
  const edges = [];
  const byCluster = new Map();
  const sidToStar = new Map();
  const dustIds = new Set();
  let memoryCount = 0;

  for (const item of items) {
    const isDust = !!item.dust;
    const starId = isDust
      ? 'e:' + fnv1a(item.cluster + '|' + item.label.toLowerCase())
      : 'm:' + fnv1a(item.cluster + '|' + item.norm.slice(0, 48)) + ':' + fnv1a(item.label);
    // 这颗记忆绕哪颗恒星转、身边有没有卫星
    let host = null;
    let moon = null;
    if (!isDust) {
      const times = [];
      for (const sid of item.docSessions || []) {
        const s = sessionById.get(sid);
        if (!s) continue;
        if (s.origin === 'subagent') {
          // 写这份档案的子代理 = 卫星：绕着这颗行星，同时它的出生时间是最好的归属线索
          if (!moon) moon = s;
          times.push(s.createdAt || 0);
        } else if (s.users > 0) {
          // 直接对话写下的记忆，会话本身就是恒星，不用再猜
          host = s;
        }
      }
      times.push(item.createdAt || 0);
      if (!host) host = ownerSession(spansFor(clusterCwd.get(item.cluster)), times);
      if (moon) {
        moonCluster.set(moon.id, item.cluster);
        moonMeta.set(moon.id, moon);
      }
    }
    stars.push({
      id: starId,
      label: item.label,
      cluster: item.cluster,
      // 颜色按来源分，不按星团：运行时记忆金、项目档案紫、记忆空间青，一眼看得出这块是什么
      color: isDust ? '#8ea6d0' : (CATS[item.cat] ? CATS[item.cat].color : item.color),
      kind: isDust ? 'dust' : 'memory',
      cat: item.cat,
      text: item.text,
      preset: item.preset,
      importance: item.importance,
      weight: item.weight,
      createdAt: item.createdAt,
      lastAt: item.createdAt,
      origin: item.origin,
      category: item.category || '',
      docId: item.docId || '',
      session: host ? host.id : '',
      moon: moon ? moon.id : '',
      msgs: 0,
      turns: 0,
    });
    edges.push({
      from: starId,
      to: item.cluster,
      kind: isDust ? 'dust' : 'belongs',
      label: isDust ? '实体' : '归属',
      width: isDust ? 0.15 : 0.6,
    });
    if (isDust) dustIds.add(starId);
    else {
      memoryCount += 1;
      if (item.sid) sidToStar.set(item.spaceKey + '#' + item.sid, starId);
    }
    if (!byCluster.has(item.cluster)) byCluster.set(item.cluster, []);
    byCluster.get(item.cluster).push({ starId, item, isDust });
  }

  // 记忆空间里的关联（insight 之间的边），两端都还在图上才画
  for (const link of spaceLinks) {
    const from = sidToStar.get(link.spaceKey + '#' + link.fromSid);
    const to = sidToStar.get(link.spaceKey + '#' + link.toSid);
    if (!from || !to) continue;
    edges.push({ from, to, kind: link.kind, label: link.label, width: link.width });
  }

  // 星团读数 + 同类记忆按时间顺承（记忆的流动靠这条线看得出来）
  const clusterById = new Map(clusters.map((c) => [c.id, c]));
  for (const [clusterId, list] of byCluster) {
    const cl = clusterById.get(clusterId);
    if (!cl) continue;
    const memories = list
      .filter((x) => !x.isDust)
      .sort((a, b) => (a.item.createdAt || 0) - (b.item.createdAt || 0));
    cl.count = memories.length;
    cl.lastAt = memories.reduce((n, x) => Math.max(n, x.item.createdAt || 0), 0);
    for (const x of memories) cl.perCat[x.item.cat] = (cl.perCat[x.item.cat] || 0) + 1;
    for (let i = 1; i < memories.length; i += 1) {
      const a = memories[i - 1].item;
      const b = memories[i].item;
      if (a.cat !== 'runtime' || b.cat !== 'runtime') continue;
      edges.push({ from: memories[i - 1].starId, to: memories[i].starId, kind: 'sequence', label: '顺承', width: 0.35 });
    }
  }

  clusters.sort((a, b) => b.count - a.count);

  // 恒星读数：每颗恒星带了几颗行星、哪颗卫星归它；另有几条记忆谁都盖不住（挂银心核星）
  const hostCount = new Map();
  const moonCount = new Map();
  const moonHost = new Map();
  let unowned = 0;
  for (const st of stars) {
    if (st.kind !== 'memory') continue;
    if (st.session) hostCount.set(st.session, (hostCount.get(st.session) || 0) + 1);
    else unowned += 1;
    if (st.moon) {
      moonCount.set(st.moon, (moonCount.get(st.moon) || 0) + 1);
      if (!moonHost.has(st.moon)) moonHost.set(st.moon, st.id);
    }
  }
  const sessions = [];
  for (const cl of clusters) {
    for (const s of starsByCwd.get(pathKey(cl.cwd)) || []) {
      sessions.push({
        id: s.id,
        cluster: cl.id,
        kind: 'star',
        title: s.title || '',
        createdAt: s.createdAt,
        lastAt: s.lastAt,
        users: s.users,
        asst: s.asst,
        tools: s.tools,
        // 行星数在时间轴筛选后由前端重算，这里给的是全量
        count: hostCount.get(s.id) || 0,
      });
    }
  }
  for (const [id, n] of moonCount) {
    const s = moonMeta.get(id);
    if (!s) continue;
    sessions.push({
      id: s.id,
      cluster: moonCluster.get(id) || '',
      kind: 'moon',
      title: s.title || '',
      createdAt: s.createdAt,
      lastAt: s.lastAt,
      users: s.users,
      asst: s.asst,
      tools: s.tools,
      count: n,
      host: moonHost.get(id) || '',
    });
  }

  return {
    generatedAt: Date.now(),
    root: MEMORY_ROOT,
    clusters,
    sessions,
    stars,
    edges,
    meta: {
      memoryRoot: MEMORY_ROOT,
      clusters: clusters.length,
      stars: memoryCount,
      memories: memoryCount,
      dust: dustIds.size,
      duplicates: dropped,
      sqlite: Boolean(sqliteApi),
      withDust,
      sessions: sessions.filter((s) => s.kind === 'star').length,
      moons: sessions.filter((s) => s.kind === 'moon').length,
      unowned,
      route: ROUTE,
      cats: CATS,
    },
  };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendVendor(res, name) {
  let buf = null;
  try {
    const safe = String(name || '').replace(/[^\w.-]/g, '');
    buf = readFileSync(join(VENDOR_DIR, safe));
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh-starmap: vendor bundle missing');
    return;
  }
  res.writeHead(200, {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': 'public, max-age=86400',
    'content-length': buf.length,
  });
  res.end(buf);
}

let cachedGraph = null;
let cachedGraphWithDust = null;
let cachedAt = 0;

function handler(req, res) {
  let url;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    sendJson(res, 400, { ok: false, error: 'bad-url' });
    return;
  }
  const rest = url.pathname.slice(ROUTE.length);
  // 任何一次请求都带着 Host，顺手把对外地址记下来（Unity 靠它找过来）
  try {
    const host = req.headers?.host;
    if (host) writeEndpoint(`http://${host}${ROUTE}`);
  } catch {
    /* 忽略 */
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
    return;
  }
  if (rest.indexOf('/vendor/') === 0) {
    sendVendor(res, rest.slice('/vendor/'.length));
    return;
  }
  if (rest === '/api/graph') {
    const force = url.searchParams.get('refresh') === '1';
    const withDust = url.searchParams.get('dust') === '1';
    const now = Date.now();
    if (force || now - cachedAt > 20000) {
      cachedGraph = null;
      cachedGraphWithDust = null;
    }
    const data = withDust
      ? (cachedGraphWithDust ??= buildMemoryGraph(true))
      : (cachedGraph ??= buildMemoryGraph(false));
    cachedAt = now;
    sendJson(res, 200, data);
    return;
  }
  if (rest === '/api/ping') {
    sendJson(res, 200, { ok: true, plugin: 'dsh-starmap', root: MEMORY_ROOT });
    return;
  }
  sendJson(res, 404, { ok: false, error: 'not-found' });
}

/** Cordis 入口：把前缀路由挂到宿主 webServer，随插件卸载自动摘除。 */
export function apply(ctx) {
  const origin = guessOrigin(ctx);
  if (origin) writeEndpoint(origin);

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async (req, res) => {
          try {
            handler(req, res);
          } catch (error) {
            if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal-error' });
            console.warn('[dsh-starmap] route failed:', error instanceof Error ? error.message : String(error));
          }
        },
      }),
    'dsh-starmap: route',
  );
}
