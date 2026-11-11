// 把 dsh-starmap 以本地目录依赖的方式接进 desktop profile（幂等，可重复跑）。
// 用法：node install-patch.mjs
// 也可以用 DSH_PROFILE_DIR 指向别的 profile 目录。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = 'dsh-starmap';
const here = dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const PROFILE_DIR = process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'desktop');
const PROFILE = join(PROFILE_DIR, 'package.json');

if (!existsSync(PROFILE)) {
  console.error('找不到 profile：' + PROFILE);
  console.error('先启动一次 DSH 桌面端，或设置 DSH_PROFILE_DIR 指向正确的 profile 目录。');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(PROFILE, 'utf8'));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies[PKG] = 'file:' + here;

pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
if (!bundles.includes(PKG)) bundles.push(PKG);
pkg.dsh.profile.bundles = bundles;

writeFileSync(PROFILE, JSON.stringify(pkg, null, 2) + '\n');
console.log('patched', PROFILE);
console.log('dependency:', PKG, '->', 'file:' + here);
console.log('bundles:', bundles.join(', '));
console.log('');
console.log('接下来：');
console.log('  1) 在 profile 目录里 pnpm install（或直接把本目录的 lib/ 复制到');
console.log('     ' + join(PROFILE_DIR, 'node_modules', PKG, 'lib'));
console.log('  2) 重启 DSH 桌面端');
