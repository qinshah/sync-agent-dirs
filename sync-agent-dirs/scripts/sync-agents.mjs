#!/usr/bin/env node
// 把各 AI 工具的项目级专有目录统一为 .agents 的软链，并维护 .gitignore 白名单。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CANONICAL = '.agents';
const BACKUP_ROOT = '.agents-backup';
const DEFAULT_DIRS = [
  '.claude', '.cursor', '.codex', '.qoder', '.gemini', '.windsurf', '.cline',
  '.roo', '.kilocode', '.trae', '.continue', '.amp', '.opencode', '.aider-desk',
  '.kiro', '.zed',
];
const DEFAULT_TRACK = ['skills', 'mcp', 'rules', 'commands'];
const NEVER_LINK = new Set(['.git', '.github', '.agents', BACKUP_ROOT]);
const SKIP_NAMES = new Set(['.git', 'node_modules', '.DS_Store', BACKUP_ROOT]);
const BLOCK_BEGIN = '# >>> sync-agent-dirs >>>';
const BLOCK_END = '# <<< sync-agent-dirs <<<';

function usage() {
  console.log(`用法:
  node sync-agents.mjs plan   [--project DIR] [--dirs a,b] [--track a,b] [--create] [--json]
  node sync-agents.mjs show   <dir> <相对路径>   [--project DIR]
  node sync-agents.mjs apply  [--project DIR] --yes [--resolutions FILE] [--dirs a,b] [--track a,b] [--create]
  node sync-agents.mjs status [--project DIR] [--dirs a,b]
  node sync-agents.mjs unlink --dir .claude [--project DIR]`);
}

function parseArgs(argv) {
  const opts = { project: process.cwd(), dirs: null, track: null, create: false, yes: false, json: false, resolutions: null, dir: null, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--project') opts.project = path.resolve(next());
    else if (a === '--dirs') opts.dirs = next().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--track') opts.track = next().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--resolutions') opts.resolutions = path.resolve(next());
    else if (a === '--dir') opts.dir = next();
    else if (a === '--create') opts.create = true;
    else if (a === '--yes') opts.yes = true;
    else if (a === '--json') opts.json = true;
    else if (a.startsWith('--')) throw new Error(`未知参数: ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readTree(root) {
  const out = new Map();
  if (!fs.existsSync(root)) return out;
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (SKIP_NAMES.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const a = path.join(root, r);
      const st = fs.lstatSync(a);
      if (st.isSymbolicLink()) {
        const target = fs.readlinkSync(a);
        out.set(r, { type: 'link', hash: crypto.createHash('sha256').update(target).digest('hex'), size: 0, target });
      } else if (st.isDirectory()) {
        out.set(r, { type: 'dir', size: 0 });
        stack.push(r);
      } else if (st.isFile()) {
        out.set(r, { type: 'file', hash: sha256(a), size: st.size });
      }
    }
  }
  return out;
}

function diffTrees(side, base) {
  const only = [], conflicts = [], typeConflicts = [], sameCount = { n: 0 };
  for (const [rel, info] of side) {
    const b = base.get(rel);
    if (!b) { only.push(rel); continue; }
    if (info.type === 'dir' && b.type === 'dir') continue;
    if (info.type === 'dir' || b.type === 'dir') { typeConflicts.push({ path: rel, agentType: info.type, agentsType: b.type }); continue; }
    if (info.hash === b.hash) { sameCount.n++; continue; }
    conflicts.push({ path: rel, agentSize: info.size, agentsSize: b.size });
  }
  return { only: only.sort(), conflicts, typeConflicts, sameCount: sameCount.n };
}

function analyze(project, dirs) {
  const canonicalAbs = path.join(project, CANONICAL);
  const base = readTree(canonicalAbs);
  const report = { project, canonical: CANONICAL, canonicalExists: fs.existsSync(canonicalAbs), dirs: [] };
  for (const dir of dirs) {
    const abs = path.join(project, dir);
    const item = { dir };
    if (!fs.existsSync(abs)) {
      item.state = 'missing';
      report.dirs.push(item);
      continue;
    }
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(abs);
      item.state = path.resolve(path.dirname(abs), target) === canonicalAbs ? 'linked' : 'foreign-link';
      item.target = target;
      report.dirs.push(item);
      continue;
    }
    if (!st.isDirectory()) {
      item.state = 'not-a-dir';
      report.dirs.push(item);
      continue;
    }
    const { only, conflicts, typeConflicts, sameCount } = diffTrees(readTree(abs), base);
    item.only = only;
    item.conflicts = conflicts;
    item.typeConflicts = typeConflicts;
    item.sameCount = sameCount;
    item.state = conflicts.length || typeConflicts.length ? 'merge' : 'link';
    report.dirs.push(item);
  }
  return report;
}

function fmtBytes(n) { return n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}K`; }

const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
function dwidth(s) { return [...s].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0); }
function dstr(s, w) { return s + ' '.repeat(Math.max(0, w - dwidth(s))); }

function topLevel(paths) {
  const set = new Set(paths);
  return paths.filter(p => {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) if (set.has(parts.slice(0, i).join('/'))) return false;
    return true;
  });
}

function printPlan(report, dirs, track) {
  console.log(`项目: ${report.project}`);
  console.log(`${CANONICAL}: ${report.canonicalExists ? '已存在' : '将创建'}   白名单: ${track.join(', ')}`);
  console.log('');
  const stateMap = {
    linked: '已链接', link: '待链接', merge: '需合并',
    'foreign-link': '指向他处', 'not-a-dir': '不是目录',
  };
  const missing = [];
  const rows = [];
  for (const d of report.dirs) {
    if (d.state === 'missing' && !d.__create) { missing.push(d.dir); continue; }
    rows.push({
      dir: d.dir,
      state: d.__create ? '待创建链接' : (stateMap[d.state] || d.state),
      only: d.only ? `${topLevel(d.only).length} 项` : '-',
      conflict: d.conflicts ? `${d.conflicts.length + d.typeConflicts.length} 项` : '-',
      note: d.state === 'merge' ? '需逐项决定' : d.state === 'foreign-link' ? `→ ${d.target}` : '',
    });
  }
  if (rows.length) {
    const w = [Math.max(6, ...rows.map(r => dwidth(r.dir))) + 2, 12, 10, 6];
    console.log(dstr('目录', w[0]) + dstr('状态', w[1]) + dstr('一侧独有', w[2]) + dstr('冲突', w[3]) + '备注');
    for (const r of rows) {
      console.log(dstr(r.dir, w[0]) + dstr(r.state, w[1]) + dstr(r.only, w[2]) + dstr(r.conflict, w[3]) + r.note);
    }
  }
  if (missing.length) console.log(`\n不存在（加 --create 可提前建链接）: ${missing.join(', ')}`);
  const mergeables = report.dirs.filter(d => d.state === 'merge');
  if (mergeables.length) {
    console.log('\n冲突明细:');
    for (const d of mergeables) {
      for (const c of d.conflicts) {
        console.log(`  ${d.dir}::${c.path}   双方内容不同（${d.dir} ${fmtBytes(c.agentSize)} / ${CANONICAL} ${fmtBytes(c.agentsSize)}）`);
      }
      for (const c of d.typeConflicts) {
        console.log(`  ${d.dir}::${c.path}   类型冲突（${d.dir} 是 ${c.agentType} / ${CANONICAL} 是 ${c.agentsType}）`);
      }
      const only = topLevel(d.only || []);
      if (only.length) console.log(`  ${d.dir}   仅一侧存在、将并入 ${CANONICAL}: ${only.join(', ')}`);
    }
    console.log(`\n查看具体内容: node sync-agents.mjs show <dir> <相对路径>`);
  }
  const untracked = [];
  for (const d of report.dirs) {
    if (!d.only) continue;
    const out = topLevel(d.only).filter(p => !track.includes(p.split('/')[0]));
    if (out.length) untracked.push(`  ${d.dir}: ${out.join(', ')}`);
  }
  if (untracked.length) {
    console.log(`\n注意：以下内容会并入 ${CANONICAL}，但不在白名单内，git 不会追踪它们:`);
    console.log(untracked.join('\n'));
    console.log('若需要版本管理，把上级目录名加进 --track，或在链接前把它们移出该目录。');
  }
}

function mkdirs(abs) { fs.mkdirSync(abs, { recursive: true }); }

function copyPath(src, dest) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    if (fs.existsSync(dest) || isLink(dest)) fs.rmSync(dest, { recursive: true, force: true });
    mkdirs(path.dirname(dest));
    fs.symlinkSync(fs.readlinkSync(src), dest);
  } else if (st.isDirectory()) {
    mkdirs(dest);
    for (const name of fs.readdirSync(src)) copyPath(path.join(src, name), path.join(dest, name));
  } else {
    if (fs.existsSync(dest) && fs.lstatSync(dest).isDirectory()) {
      throw new Error(`类型冲突未解决: ${dest} 期望写入文件，但 .agents 侧是目录`);
    }
    mkdirs(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
}

function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }

function writeGitignore(project, dirs, track) {
  const file = path.join(project, '.gitignore');
  const lines = [
    BLOCK_BEGIN,
    '# 只追踪下列白名单目录，其余一律忽略；别用 .??* 之类的通配，会把 .git 也吃掉',
    `${CANONICAL}/*`,
  ];
  for (const t of track) lines.push(`!${CANONICAL}/${t}/`, `!${CANONICAL}/${t}/**`);
  lines.push(`${BACKUP_ROOT}/`, '');
  for (const d of dirs) lines.push(d);
  lines.push(BLOCK_END);
  const block = lines.join('\n');
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const begin = prev.indexOf(BLOCK_BEGIN);
  const end = prev.indexOf(BLOCK_END);
  let next;
  if (begin !== -1 && end > begin) {
    next = prev.slice(0, begin) + block + prev.slice(end + BLOCK_END.length);
  } else {
    next = prev.replace(/\s*$/, '') + (prev.trim() ? '\n\n' : '') + block + '\n';
  }
  fs.writeFileSync(file, next);
}

function backupDir(project, name) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(project, BACKUP_ROOT, stamp, name);
  mkdirs(path.dirname(dest));
  fs.renameSync(path.join(project, name), dest);
  return path.relative(project, dest);
}

function linkDir(project, name) {
  fs.symlinkSync(CANONICAL, path.join(project, name), 'dir');
}

function apply(project, dirs, track, resolutions, create) {
  const canonicalAbs = path.join(project, CANONICAL);
  const report = analyze(project, dirs);

  const unresolved = [];
  for (const item of report.dirs) {
    if (item.state !== 'merge') continue;
    const conf = resolutions[item.dir] || {};
    if (conf.action === 'leave') continue;
    const need = [...item.conflicts.map(c => c.path), ...item.typeConflicts.map(c => c.path)];
    const missing = need.filter(p => !['agents', 'agent'].includes(conf[p]));
    if (missing.length) unresolved.push({ dir: item.dir, paths: missing });
  }
  if (unresolved.length) {
    console.error('以下冲突尚未决定，未做任何改动:');
    for (const u of unresolved) console.error(`  ${u.dir}: ${u.paths.join(', ')}`);
    console.error('\n请与用户逐项确认后写入 resolutions 文件，再重新执行 apply。');
    return 1;
  }

  mkdirs(canonicalAbs);
  for (const t of track) mkdirs(path.join(canonicalAbs, t));

  const done = [];

  for (const item of report.dirs) {
    const dirAbs = path.join(project, item.dir);
    const conf = resolutions[item.dir] || {};
    if (conf.action === 'leave') { done.push(`${item.dir}: 按决定保持原样（未链接）`); continue; }

    if (item.state === 'linked') { done.push(`${item.dir}: 已是指向 ${CANONICAL} 的链接`); continue; }
    if (item.state === 'not-a-dir') { done.push(`${item.dir}: 不是目录，跳过`); continue; }
    if (item.state === 'foreign-link') { done.push(`${item.dir}: 指向 ${item.target}，非本次管理范围，跳过`); continue; }
    if (item.state === 'missing') {
      if (!create) continue;
      linkDir(project, item.dir);
      done.push(`${item.dir}: 新建链接 → ${CANONICAL}`);
      continue;
    }

    for (const rel of item.only || []) copyPath(path.join(dirAbs, rel), path.join(canonicalAbs, rel));
    for (const c of [...(item.conflicts || []), ...(item.typeConflicts || [])]) {
      if (conf[c.path] !== 'agent') continue;
      const dest = path.join(canonicalAbs, c.path);
      if (fs.existsSync(dest) || isLink(dest)) fs.rmSync(dest, { recursive: true, force: true });
      copyPath(path.join(dirAbs, c.path), dest);
    }

    const backup = backupDir(project, item.dir);
    linkDir(project, item.dir);
    done.push(`${item.dir}: 合并 ${(item.only || []).length} 项 → ${CANONICAL}，原目录备份至 ${backup}，已建立链接`);
  }

  writeGitignore(project, dirs, track);

  if (unresolved.length) {
    console.error('\n以下冲突尚未决定，对应目录保持原样（其余目录可能已处理）:');
    for (const u of unresolved) console.error(`  ${u.dir}: ${u.paths.join(', ')}`);
    console.error('\n请与用户逐项确认后写入 resolutions 文件，再重新执行 apply。');
    return 1;
  }
  console.log(done.join('\n'));
  console.log(`\n.gitignore 白名单已写入（追踪: ${track.join(', ')}）`);
  return 0;
}

function loadResolutions(file) {
  if (!file) return {};
  if (!fs.existsSync(file)) throw new Error(`resolutions 文件不存在: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help') { usage(); return 0; }
  const opts = parseArgs(rest);
  const dirs = (opts.dirs || DEFAULT_DIRS).filter(d => !NEVER_LINK.has(d));
  const track = opts.track || DEFAULT_TRACK;

  if (cmd === 'plan') {
    const report = analyze(opts.project, dirs);
    if (opts.create) for (const d of report.dirs) if (d.state === 'missing') d.__create = true;
    if (opts.json) { console.log(JSON.stringify(report, null, 2)); return 0; }
    printPlan(report, dirs, track);
    return 0;
  }

  if (cmd === 'show') {
    const [dir, rel] = opts.positional;
    if (!dir || !rel) throw new Error('show 需要 <dir> <相对路径>');
    const base = path.join(opts.project, CANONICAL, rel);
    const side = path.join(opts.project, dir, rel);
    for (const [label, p] of [[`${CANONICAL} 侧`, base], [`${dir} 侧`, side]]) {
      console.log(`\n===== ${label} (${p}) =====`);
      if (!fs.existsSync(p)) { console.log('(不存在)'); continue; }
      const st = fs.lstatSync(p);
      if (!st.isFile()) { console.log(`(${st.isDirectory() ? '目录' : '链接'})`); continue; }
      console.log(fs.readFileSync(p, 'utf8'));
    }
    return 0;
  }

  if (cmd === 'status') {
    const report = analyze(opts.project, dirs);
    for (const d of report.dirs) {
      console.log(`${d.dir}\t${d.state}${d.target ? `\t→ ${d.target}` : ''}`);
    }
    return 0;
  }

  if (cmd === 'apply') {
    if (!opts.yes) {
      console.error('apply 会移动目录并建立软链，必须显式加 --yes。先跑 plan 并把冲突项与用户确认。');
      return 1;
    }
    return apply(opts.project, dirs, track, loadResolutions(opts.resolutions), opts.create);
  }

  if (cmd === 'unlink') {
    if (!opts.dir) throw new Error('unlink 需要 --dir <目录名>');
    const abs = path.join(opts.project, opts.dir);
    if (!isLink(abs)) { console.error(`${opts.dir} 不是软链，不做处理`); return 1; }
    fs.unlinkSync(abs);
    const root = path.join(opts.project, BACKUP_ROOT);
    const stamps = fs.existsSync(root) ? fs.readdirSync(root).sort() : [];
    let restored = null;
    for (const s of stamps.reverse()) {
      const candidate = path.join(root, s, opts.dir);
      if (fs.existsSync(candidate)) { fs.renameSync(candidate, abs); restored = path.relative(opts.project, candidate); break; }
    }
    console.log(`${opts.dir}: 已移除链接${restored ? `，从 ${restored} 恢复原目录` : '（无可用备份）'}`);
    return 0;
  }

  throw new Error(`未知子命令: ${cmd}`);
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(`错误: ${err.message}`);
  process.exitCode = 1;
}
