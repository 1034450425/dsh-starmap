/**
 * dsh-starmap 浏览器半侧：侧栏「星图」入口 + 中栏 3D 星图页。
 *
 * 这个文件是纯副作用脚本（不能有顶层 import / export）：只把 factory 交给宿主模块系统，
 * react / jsx-runtime 一律走 factory 的 require。3D 库按需从同源路由拉一次。
 * @module dsh-starmap/client
 */
(function () {
  var ID = 'dsh-starmap';
  var ROUTE = '/dsh-starmap';
  var VENDOR = ROUTE + '/vendor/3d-force-graph.min.js';

  if (!window || !window.__ModuleLoader__) {
    console.warn('[dsh-starmap] 模块系统不可用，客户端半侧未加载');
    return;
  }

  // factory 必须是「已经调用过一次」的那个 (require) => exports 函数：
  // 宿主是 exports = factory(require)，传 makeFactory 本身会把内层工厂当导出。
  window.__ModuleLoader__.load({ id: ID, factory: makeFactory() });

  function makeFactory() {
    return function (require) {
      var React = require('react');
      var h = require('react/jsx-runtime').jsx;
      var useEffect = React.useEffect;
      var useRef = React.useRef;
      var useState = React.useState;
      var useCallback = React.useCallback;

      /**
       * 主星系：记忆最多的那个工作区。
       * 以前写死 D:\DeepSeek，另加一条 msgs 权重 —— 结果只有 59 条记忆的 DeepSeek
       * 靠聊天消息多压过 220 条的 Feishu，取景和主旋涡一直摆错地方。
       */
      // 主星系：默认挑记忆最多的那一团；主人手动指定过就一直用他指定的。
      var primaryPickId = '';
      try {
        primaryPickId = window.localStorage.getItem('dsh-starmap.primary') || '';
      } catch (eP) {
        primaryPickId = '';
      }
      function pickPrimary(list) {
        if (primaryPickId) {
          for (var pj = 0; pj < list.length; pj += 1) {
            if (list[pj] && list[pj].id === primaryPickId) return list[pj];
          }
        }
        var best = null;
        var i;
        for (i = 0; i < list.length; i += 1) {
          var c = list[i];
          if (!c) continue;
          if (!best) { best = c; continue; }
          var s1 = (c.count || 0) * 1000 + (c.msgs || 0);
          var s2 = (best.count || 0) * 1000 + (best.msgs || 0);
          if (s1 > s2) best = c;
        }
        return best;
      }

      function primaryCluster(clusters) {
        return pickPrimary(clusters);
      }

      /* --------------------------------------------- 四层轨道（银心/恒星/行星） */

      /** 稳定哈希：同一个 id 每次拿到的相位一致，时间轴来回拉行星不会跳相位。 */
      function hash01(str) {
        var h = 2166136261;
        var s = String(str || '');
        for (var i = 0; i < s.length; i += 1) {
          h ^= s.charCodeAt(i);
          h = Math.imul(h, 16777619) >>> 0;
        }
        return h / 4294967296;
      }

      var ORBIT_BASE = 52;   // 最内圈半径
      var ORBIT_DR = 32;     // 圈与圈的间距
      var ORBIT_GAP = 60;    // 同一圈上相邻两颗行星的间距
      var CLUSTER_GAP = 320; // 两个银心之间至少留这么宽的空

      /**
       * 行星轨道：由内向外一圈一圈铺，每圈按周长决定能放几颗。
       * 角速度用开普勒第三定律的简化版（半径越大越慢），内圈才追得上外圈，
       * 看着才像一颗恒星的太阳系，而不是一个整体在转的钢圈。
       */
      function assignOrbits(ids) {
        var out = [];
        var ring = 0;
        var guard = 0;
        while (out.length < ids.length && guard < 90) {
          guard += 1;
          // 圈距随半径长开：内圈挤一点、外圈松一点，看着不像用刻度量出来的
          var r = ORBIT_BASE + ORBIT_DR * Math.pow(ring, 1.14);
          var cap = Math.max(2, Math.floor((Math.PI * 2 * r) / ORBIT_GAP));
          for (var k = 0; k < cap && out.length < ids.length; k += 1) {
            var id = ids[out.length];
            var j = hash01(id);
            var j2 = hash01(id + 'r');
            var j3 = hash01(id + 'p');
            var rr = Math.pow(ring + j2 * 1.25, 1.14);
            // 半径、相位、倾角都掺一点各自的随机：不然每一圈都是同心圆，
            // 远看像一串规整的花环，不像一颗颗记忆自己绕着那颗星飘。
            out.push({
              id: id,
              r: ORBIT_BASE + ORBIT_DR * rr + (j - 0.5) * 16,
              ring: ring,
              phase: ((k + 0.1 + j * 0.8) / cap) * Math.PI * 2 + ring * 2.399963 + (j3 - 0.5) * 0.6,
              // 内圈一圈约 46 秒；半径翻五倍角速度降到四成左右
              omega: (Math.PI * 2 / 30) * Math.pow(ORBIT_BASE / Math.max(ORBIT_BASE, r), 1.1),
              tilt: (j2 - 0.5) * 1.15,
            });
          }
          ring += 1;
        }
        return out;
      }


      /**
       * 恒星在银心盘面里的位置：大系统在中间，小系统往外让。
       * 螺旋搜索 + 最小间距 —— 那个带着 126 颗行星的大家伙不该被小系统压穿。
       * 返回 {pos:{id:{x,y,z}}, radius}。
       */
      function starLayout(stars, isMain) {
        var placed = [];
        var pos = {};
        var maxEdge = 0;
        var arms = 5;
        var armStep = (Math.PI * 2) / arms;
        for (var i = 0; i < stars.length; i += 1) {
          var st = stars[i];
          var best = null;
          // 放不下的时候退而求其次：记下「压得最轻」的位置。
          var bestPen = Infinity;
          for (var attempt = 0; attempt < 1100; attempt += 1) {
            // 沿旋臂往外走：半径长开、角度跟着半径甩出去，几条臂彼此错开一整角。
            // 每颗星的臂号和抖动都来自它自己的 id，所以每次打开都是同一张星图。
            var t = attempt / 900;
            var rad = 100 + 1170 * Math.pow(t, 0.56);
            var arm = (i + Math.floor(attempt / 200)) % arms;
            // 与星团云用同一条对数螺旋：中心缠紧、往外甩开，两者才叠在同一批臂上
            var uu = Math.min(1.1, rad / 430);
            // 缠绕收得更紧：同样半径多转大半圈，才不是三片扇叶
            // 负号 = 旋臂往中心那一侧卷：看着是「往里收」，不是向外甩的扇叶
            var swing = -4.6 * (Math.log(1 + uu * 6.2) / Math.log(7.2));
            var jit = hash01(st.id + ':' + attempt);
            // 越往外越散：尾巴末端甩开，才不会像整块布
            var spread = 0.07 + uu * 0.52;
            // 主团走旋臂；其他团不做旋臂，就撒成一团 —— 形状由这个团自己的 id 决定
            var ang = isMain
              ? arm * armStep + swing + (jit - 0.5) * spread
              : i * 2.399963 + (hash01(st.id + 'na') - 0.5) * 2.2;
            var wob = 1 + (hash01(st.id + 'w') - 0.5) * (0.1 + uu * 0.35);
            var x = Math.cos(ang) * rad * wob;
            var y = Math.sin(ang) * rad * wob;
            var pen = 0;
            for (var p = 0; p < placed.length; p += 1) {
              var q = placed[p];
              var dx = x - q.x;
              var dy = y - q.y;
              var minD = (q.sysR + st.sysR) * 1.02 + 18;
              var dd = Math.sqrt(dx * dx + dy * dy);
              if (dd < minD) pen += minD - dd;
            }
            if (pen <= 0) {
              best = { x: x, y: y };
              break;
            }
            if (pen < bestPen) {
              bestPen = pen;
              best = { x: x, y: y };
            }
          }
          if (!best) best = { x: 0, y: 0 };
          // 盘面统一铺在 xy 平面：星团云的旋臂也在这一面上，两者不会交叉成十字
          // 盘厚：以前只有 ±8，侧着看整片星系像一张纸；随半径长到几十上百，才有体积
          pos[st.id] = { x: best.x, y: best.y, z: (hash01(st.id + 'z') - 0.5) * (5 + rad * 0.03) };
          placed.push({ x: best.x, y: best.y, sysR: st.sysR });
          var edge = Math.sqrt(best.x * best.x + best.y * best.y) + st.sysR;
          if (edge > maxEdge) maxEdge = edge;
        }
        return { pos: pos, radius: Math.max(60, maxEdge * 1.08) };
      }


      /**
       * 银心位置：每个工作区按自己撑出来的大小排，间距 = 两个团半径之和 + 留白。
       * 以前是固定球壳 170，大团小团挤在同一个圈上 —— 那才是「记忆叠在一起」的根子。
       */
      // 星团摆位：主团放原点，其余团沿一圈均匀铺开。
      // 老写法是拿斐波那契角度挨个试位置，团一多（六个工作区）就试不出来，
      // 不是叠在主团身上就是甩到天边；改成先在环上均分，间距由最大团半径算死。
      function clusterCenters(clusters, radii) {
        var out = {};
        if (!clusters.length) return out;
        var list = clusters.slice().sort(function (a, b) {
          return (radii[b.id] || 0) - (radii[a.id] || 0);
        });
        var R0 = radii[list[0].id] || 60;
        out[list[0].id] = { x: 0, y: 0, z: 0 };
        var rest = list.slice(1);
        if (!rest.length) return out;

        var maxR = 0;
        for (var i = 0; i < rest.length; i += 1) {
          maxR = Math.max(maxR, radii[rest[i].id] || 60);
        }
        // 环半径：主团 + 最大团 + 间隙，再留一成余量，免得刚好贴住
        var ringR = (R0 + maxR + CLUSTER_GAP) * 1.06;
        // 一圈塞不下就再开一圈：按周长能装几个算
        var perRing = Math.max(3, Math.floor((TAU * ringR) / (maxR * 2 + CLUSTER_GAP)));
        for (var k = 0; k < rest.length; k += 1) {
          var c = rest[k];
          var R = radii[c.id] || 60;
          var ring = Math.floor(k / perRing);
          var inRing = Math.min(perRing, rest.length - ring * perRing);
          var slot = k - ring * perRing;
          var rr = ringR + ring * (maxR * 2 + CLUSTER_GAP);
          var ang = 0.4 + (slot / Math.max(1, inRing)) * TAU + ring * 0.7;
          // 小团稍微往外挪一点，视觉上跟大团分量相当
          var rad = rr + (maxR - R) * 0.6;
          out[c.id] = { x: Math.cos(ang) * rad, y: Math.sin(ang) * rad, z: 0 };
        }
        return out;
      }

      var TAU = Math.PI * 2;
      var STAR_OMEGA = TAU / 240;   // 恒星绕银心一圈 4 分钟
      var MOON_OMEGA = TAU / 18;    // 卫星贴着一颗行星，一圈 18 秒

      /**
       * 把四层天体一次性摆好：银心在哪儿、每颗恒星绕它转的半径与相位、
       * 每颗行星的轨道参数、每颗卫星贴在哪颗行星旁边。
       * 返回的骨架每帧都能拿 t 重新展开成坐标 —— 所以「公转」不是一段动画，
       * 只是换个 t 再算一遍，暂停就是把 t 停住。
       */
      function buildOrbitLayout(nodes) {
        var clusterNodes = [];
        var starNodes = [];
        var planetsByStar = {};
        var noHost = {};
        var moonsByPlanet = {};
        var dustByCluster = {};
        for (var i = 0; i < nodes.length; i += 1) {
          var n = nodes[i];
          if (n.kind === 'cluster') {
            clusterNodes.push(n);
          } else if (n.kind === 'star') {
            starNodes.push(n);
          } else if (n.kind === 'moon') {
            if (!moonsByPlanet[n.host]) moonsByPlanet[n.host] = [];
            moonsByPlanet[n.host].push(n);
          } else if (n.kind === 'dust') {
            if (!dustByCluster[n.cluster]) dustByCluster[n.cluster] = [];
            dustByCluster[n.cluster].push(n);
          } else if (n.session) {
            if (!planetsByStar[n.session]) planetsByStar[n.session] = [];
            planetsByStar[n.session].push(n);
          } else {
            // 哪次对话都没盖住它：绕银心的核心转，别凭空挂到某颗恒星上
            if (!noHost[n.cluster]) noHost[n.cluster] = [];
            noHost[n.cluster].push(n);
          }
        }

        // 行星按时间排：早的住进内圈，于是「记忆一圈一圈往外长」在盘面上是看得见的
        var byTime = function (a, b) {
          return (a.createdAt || 0) - (b.createdAt || 0);
        };
        var systems = {};
        var starGroup = {};
        for (var si = 0; si < starNodes.length; si += 1) {
          var st = starNodes[si];
          var list = (planetsByStar[st.id] || []).slice().sort(byTime);
          var orbits = assignOrbits(
            list.map(function (p) {
              return p.id;
            }),
          );
          var sysR = 14;
          for (var oi = 0; oi < orbits.length; oi += 1) {
            if (orbits[oi].r > sysR) sysR = orbits[oi].r;
          }
          systems[st.id] = { node: st, orbits: orbits, sysR: sysR + 12 };
          if (!starGroup[st.cluster]) starGroup[st.cluster] = [];
          starGroup[st.cluster].push(st.id);
        }

        // 每个星团：恒星在盘面里排开，撑出这个团自己的半径
        var radii = {};
        var starPos = {};
        var mainCl = pickPrimary(clusterNodes);
        var mainClId = mainCl ? mainCl.id : null;
        for (var ci = 0; ci < clusterNodes.length; ci += 1) {
          var cl = clusterNodes[ci];
          var ids = (starGroup[cl.id] || []).slice().sort(function (a, b) {
            return systems[b].sysR - systems[a].sysR;
          });
          var items = [];
          for (var ii = 0; ii < ids.length; ii += 1) {
            items.push({ id: ids[ii], sysR: systems[ids[ii]].sysR });
          }
          var lay = starLayout(items, cl.id === mainClId);
          // 非主团给一个下限：现在只有一两条记忆，也得先把地方留出来，
          // 不然以后新对话进来，云还是那么小，装不下
          radii[cl.id] = cl.id === mainClId ? lay.radius : Math.max(lay.radius, 240);
          for (var ki = 0; ki < ids.length; ki += 1) starPos[ids[ki]] = lay.pos[ids[ki]];
        }

        // 装饰星：沿旋臂撒的一层光点。它们不属于任何记忆、不参与选取，
        // 只负责把旋臂铺满、让旋涡看起来有厚度 —— 点它不会有任何反应。
        var deco = [];
        for (var dci = 0; dci < clusterNodes.length; dci += 1) {
          var dcl = clusterNodes[dci];
          var dR = radii[dcl.id] || 60;
          var dN = Math.min(420, Math.round(18 + dR * 0.78));
          for (var dni = 0; dni < dN; dni += 1) {
            var dt = Math.pow(hash01(dcl.id + 'dt' + dni), 0.58);
            var isMainDeco = dcl.id === mainClId;
            var darm = dni % 3;
            var drad = isMainDeco ? 0.14 + dt * 1.02 : Math.sqrt(dt) * 1.02;
            var du = Math.min(1.15, drad * 1.02);
            var dwind = Math.log(1 + du * 6.2) / Math.log(7.2);
            var dang = isMainDeco
              ? darm * (TAU / 3) - 4.6 * dwind + (hash01(dcl.id + 'da' + dni) - 0.5) * 0.62
              : hash01(dcl.id + 'da' + dni) * TAU;
            deco.push({
              cluster: dcl.id,
              r: dR * drad,
              a: dang,
              w: (hash01(dcl.id + 'dw' + dni) - 0.5) * dR * 0.05,
              s: 0.55 + hash01(dcl.id + 'ds' + dni) * 1.35,
              ph: hash01(dcl.id + 'dp' + dni) * TAU,
            });
          }
        }
        return {
          centers: clusterCenters(clusterNodes, radii),
          radii: radii,
          deco: deco,
          systems: systems,
          starPos: starPos,
          moonsByPlanet: moonsByPlanet,
          dustByCluster: dustByCluster,
          noHost: noHost,
        };
      }

      /**
       * 按各层自己的时钟把天体推到该在的位置，返回一张 id → 坐标 表。
       * 三个时钟是分开的（star / planet / moon，单位毫秒）：关掉哪一层的转动，
       * 就只是不再推进那一个时钟，画面停住而不是跳回原点。
       * 恒星层是刚体自转（同一个角速度，布局不会自己撞自己）；行星层各自开普勒；
       * 卫星贴着行星；银心不动，尘埃跟着行星时钟慢慢绕。
       */
      function applyOrbit(lay, clk) {
        var c = clk || {};
        var ss = (c.star || 0) / 1000;
        var sp = (c.planet || 0) / 1000;
        var sm = (c.moon || 0) / 1000;
        var out = {};
        var cid;
        for (cid in lay.centers) out[cid] = lay.centers[cid];
        for (var sid in lay.systems) {
          var sys = lay.systems[sid];
          var base = lay.starPos[sid] || { x: 0, y: 0, z: 0 };
          var ctr = lay.centers[sys.node.cluster] || { x: 0, y: 0, z: 0 };
          var r0 = Math.sqrt(base.x * base.x + base.y * base.y);
          var aa = Math.atan2(base.y, base.x) + STAR_OMEGA * ss;
          var sx = ctr.x + Math.cos(aa) * r0;
          var sy = ctr.y + Math.sin(aa) * r0;
          var sz = ctr.z + base.z;
          out[sid] = { x: sx, y: sy, z: sz };
          for (var pi = 0; pi < sys.orbits.length; pi += 1) {
            var orb = sys.orbits[pi];
            var pa = orb.phase + orb.omega * sp;
            // 行星轨道也铺在 xy 平面上，靠 tilt 给每圈一点厚度：整片星系才是一个盘，不是十字
            out[orb.id] = {
              x: sx + Math.cos(pa) * orb.r,
              y: sy + Math.sin(pa) * orb.r * Math.cos(orb.tilt),
              z: sz + Math.sin(pa) * orb.r * Math.sin(orb.tilt),
            };
          }
        }
        for (var pid in lay.moonsByPlanet) {
          var pp = out[pid];
          if (!pp) continue;
          var moons = lay.moonsByPlanet[pid];
          for (var mi = 0; mi < moons.length; mi += 1) {
            var mn = moons[mi];
            var mh = hash01(mn.id);
            var mr = 7 + hash01(mn.id + 'r') * 4.5;
            var ma = mh * TAU + (MOON_OMEGA / (1 + mi * 0.35)) * sm;
            out[mn.id] = {
              x: pp.x + Math.cos(ma) * mr,
              y: pp.y + Math.sin(ma) * mr * 0.55,
              z: pp.z + Math.sin(ma) * mr * 0.85,
            };
          }
        }
        for (var nid in lay.noHost) {
          var arr = lay.noHost[nid];
          var cc = lay.centers[nid] || { x: 0, y: 0, z: 0 };
          for (var ni = 0; ni < arr.length; ni += 1) {
            var nb = arr[ni];
            var nh = hash01(nb.id);
            var nr = 9 + hash01(nb.id + 'r') * 26;
            var na = nh * TAU + (TAU / 240) * sp;
            out[nb.id] = {
              x: cc.x + Math.cos(na) * nr,
              y: cc.y + Math.sin(na) * nr,
              z: cc.z + (nh - 0.5) * 8,
            };
          }
        }
        for (var did in lay.dustByCluster) {
          var darr = lay.dustByCluster[did];
          var dc = lay.centers[did] || { x: 0, y: 0, z: 0 };
          var R = lay.radii[did] || 60;
          for (var di = 0; di < darr.length; di += 1) {
            var dn = darr[di];
            var dh = hash01(dn.id);
            var dr = R * (0.35 + hash01(dn.id + 'r') * 0.58);
            var da = dh * TAU + (TAU / 700) * sp;
            out[dn.id] = {
              x: dc.x + Math.cos(da) * dr,
              y: dc.y + Math.sin(da) * dr,
              z: dc.z + (dh - 0.5) * R * 0.07,
            };
          }
        }
        // 装饰星：只跟银心的自转走（不跟行星），位置单独一张表，绘制时直接用
        var decoPos = [];
        var dlist = lay.deco || [];
        for (var dq = 0; dq < dlist.length; dq += 1) {
          var dd = dlist[dq];
          var dctr = lay.centers[dd.cluster];
          if (!dctr) continue;
          var dda = dd.a + STAR_OMEGA * ss * 0.55;
          decoPos.push({
            x: dctr.x + Math.cos(dda) * dd.r,
            y: dctr.y + Math.sin(dda) * dd.r * 0.94,
            z: dctr.z + dd.w,
            s: dd.s,
            ph: dd.ph,
          });
        }
        lay.decoPos = decoPos;
        return out;
      }

      function loadVendor() {
        if (window.ForceGraph3D) return Promise.resolve();
        if (loadVendor.pending) return loadVendor.pending;
        // 先走插件自带的本地副本；万一宿主那边 vendor 路由出问题，退回公共 CDN，
        // 至少不会因为一个 404 把整块面板变成"加载失败"。
        var CDN = 'https://fastly.jsdelivr.net/npm/3d-force-graph@1/dist/3d-force-graph.min.js';
        var inject = function (src) {
          return new Promise(function (resolve, reject) {
            var el = document.createElement('script');
            el.src = src;
            el.async = true;
            el.onload = function () {
              window.ForceGraph3D ? resolve() : reject(new Error('no-export'));
            };
            el.onerror = function () {
              reject(new Error('load-failed'));
            };
            document.head.appendChild(el);
          });
        };
        loadVendor.pending = inject(VENDOR)
          .catch(function () {
            return inject(CDN);
          })
          .catch(function () {
            throw new Error('3d-force-graph 加载失败');
          });
        return loadVendor.pending;
      }

      function fmtTime(ms) {
        if (!ms) return '未知';
        var d = new Date(ms);
        var p = function (v) {
          return v < 10 ? '0' + v : '' + v;
        };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
      }

      function fmtDay(ms) {
        if (!ms || !isFinite(ms)) return '—';
        var d = new Date(ms);
        var p = function (v) {
          return v < 10 ? '0' + v : '' + v;
        };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
      }

      /* --------------------------------------------------------- 过滤 */

      /**
       * 把「时间轴」和「搜索」揉成一个谓词，再统一产出节点与边。
       * 这里是 tideglass 那个 bug 的正面修法：它把时间轴和类型筛选各写一处、
       * 都去改 visibility，后写的把先写的覆盖掉；这里只有一份 keep 判定。
       */
      function relTime(ms) {
        if (!ms || !isFinite(ms)) return '—';
        var d = Date.now() - ms;
        if (d < 60000) return '刚刚';
        var m = Math.round(d / 60000);
        if (m < 60) return m + ' 分';
        var h = Math.round(m / 60);
        if (h < 24) return h + ' 时';
        var day = Math.round(h / 24);
        if (day < 30) return day + ' 天';
        return Math.round(day / 30) + ' 月';
      }

      /**
       * 光点分类：宿主已经直接给了 cat（runtime/doc/space/entity），直接信它；
       * 老数据只带 preset 的才靠字符串猜，兜底归到 runtime。
       */
      function catOf(star) {
        if (star.kind === 'dust') return 'dust';
        if (star.cat === 'runtime' || star.cat === 'doc' || star.cat === 'space' || star.cat === 'entity') return star.cat;
        if (star.kind === 'memory') {
          var src = String(star.preset || '');
          if (src.indexOf('文档') >= 0) return 'doc';
          if (src.indexOf('空间') >= 0) return 'space';
          if (src.indexOf('实体') >= 0) return 'entity';
          return 'runtime';
        }
        return 'session';
      }

      function buildView(data, filters) {
        var q = (filters.query || '').trim().toLowerCase();
        var timeT = typeof filters.timeT === 'number' ? filters.timeT : 1;

        var minC = Infinity;
        var maxC = -Infinity;
        for (var i = 0; i < data.stars.length; i += 1) {
          var c = data.stars[i].createdAt || 0;
          if (c > 0) {
            if (c < minC) minC = c;
            if (c > maxC) maxC = c;
          }
        }
        if (!isFinite(minC)) {
          minC = Date.now() - 86400000;
          maxC = Date.now();
        }
        var cutoff = timeT >= 0.999 ? Infinity : minC + (maxC - minC) * timeT;

        var nodes = [];
        var links = [];
        var kept = {};
        var totalStars = 0;
        var visibleStars = 0;
        var matched = 0;
        var perCluster = {};
        var cats = { session: 0, runtime: 0, doc: 0, space: 0, entity: 0, dust: 0 };
        var catFilter = filters.cat || '';
        var fadeOn = !!filters.fade;
        var nowMs = Date.now();
        /** 卫星 id → 它绕的那颗行星；行星没显示时，卫星也一起收起来。 */
        var moonPlanet = {};
        /** 记忆 id → 它绕的那颗恒星；归不上宿主的记忆还连银心。 */
        var hostOf = {};
        /** 星团 id → 颜色，恒星借用所在星团的色，一眼看得出是哪个工作区。 */
        var clColor = {};

        for (var s = 0; s < data.stars.length; s += 1) {
          var star = data.stars[s];
          var isDust = star.kind === 'dust';
          var cat = catOf(star);
          cats[cat] = (cats[cat] || 0) + 1;
          if (catFilter && cat !== catFilter) continue;
          if (cutoff !== Infinity && (star.createdAt || 0) > cutoff) continue;
          var textOk = !q || String(star.label || '').toLowerCase().indexOf(q) >= 0;
          kept[star.id] = true;
          if (!isDust) {
            totalStars += 1;
            visibleStars += 1;
            if (q && textOk) matched += 1;
            perCluster[star.cluster] = (perCluster[star.cluster] || 0) + 1;
          }
          // 褪色：越久没被碰过的记忆越暗，但不隐藏——比时间轴温和
          var fadeV = 1;
          if (fadeOn && !isDust) {
            var ageD = (nowMs - (star.lastAt || star.createdAt || nowMs)) / 86400000;
            fadeV = 1 - 0.74 * Math.min(1, Math.max(0, ageD / 45));
          }
          nodes.push({
            id: star.id,
            kind: star.kind === 'memory' ? 'memory' : isDust ? 'dust' : 'star',
            cat: cat,
            fade: fadeV,
            label: star.label,
            text: star.text || '',
            importance: star.importance || 'normal',
            weight: typeof star.weight === 'number' ? star.weight : 1,
            category: star.category || '',
            cluster: star.cluster,
            color: star.color,
            msgs: star.msgs,
            turns: star.turns,
            createdAt: star.createdAt,
            lastAt: star.lastAt,
            preset: star.preset,
            cwd: '',
            count: 0,
            dust: 0,
            // 这颗记忆绕哪颗恒星转、有没有卫星跟着它（宿主按时间窗算好的）
            session: star.session || '',
            moon: star.moon || '',
            dim: !!(q && !textOk),
          });
          if (star.moon) moonPlanet[star.moon] = star.id;
          if (star.session) hostOf[star.id] = star.session;
        }

        for (var k = 0; k < data.clusters.length; k += 1) {
          var cl = data.clusters[k];
          kept[cl.id] = true;
          clColor[cl.id] = cl.color;
          nodes.push({
            id: cl.id,
            kind: 'cluster',
            label: cl.label,
            cluster: cl.id,
            color: cl.color,
            msgs: cl.msgs,
            turns: 0,
            createdAt: 0,
            lastAt: cl.lastAt,
            preset: '',
            cwd: cl.cwd,
            count: perCluster[cl.id] || 0,
            dust: cl.dust || 0,
            dim: false,
          });
        }

        // 恒星 = 一次对话，卫星 = 我派出去干活的那个子代理。
        // 时间轴和类型筛选都不动它们：它们是容器，不是内容。只有搜索会压暗，
        // 否则把时间轴往回拉一格，天上就会漂着一堆没有行星的空轨道。
        var sessions = data.sessions || [];
        for (var si = 0; si < sessions.length; si += 1) {
          var se = sessions[si];
          if (se.kind !== 'star') continue;
          kept[se.id] = true;
          var seQ = String(se.title || '').toLowerCase();
          nodes.push({
            id: se.id,
            kind: 'star',
            cat: 'session',
            fade: 1,
            label: se.title || '未命名对话',
            text: se.title || '',
            importance: 'normal',
            weight: 2 + Math.log(1 + (se.count || 0)),
            category: '',
            cluster: se.cluster,
            color: clColor[se.cluster] || '#cfe0ff',
            msgs: se.users || 0,
            turns: se.asst || 0,
            createdAt: se.createdAt,
            lastAt: se.lastAt,
            preset: '对话',
            cwd: '',
            count: se.count || 0,
            dust: 0,
            dim: !!(q && seQ.indexOf(q) < 0),
          });
        }
        for (var mi = 0; mi < sessions.length; mi += 1) {
          var mo = sessions[mi];
          if (mo.kind !== 'moon') continue;
          var hostPlanet = moonPlanet[mo.id];
          if (!hostPlanet) continue;
          kept[mo.id] = true;
          nodes.push({
            id: mo.id,
            kind: 'moon',
            cat: 'moon',
            fade: 1,
            label: mo.title || '子代理',
            text: mo.title || '',
            importance: 'low',
            weight: 0.6,
            category: '',
            cluster: mo.cluster,
            color: '#9fb4d8',
            msgs: mo.users || 0,
            turns: mo.asst || 0,
            createdAt: mo.createdAt,
            lastAt: mo.lastAt,
            preset: '子代理',
            cwd: '',
            count: 0,
            dust: 0,
            host: hostPlanet,
            dim: !!(q && String(mo.title || '').toLowerCase().indexOf(q) < 0),
          });
        }

        for (var e = 0; e < data.edges.length; e += 1) {
          var edge = data.edges[e];
          if (!kept[edge.from] || !kept[edge.to]) continue;
          // 归属线原本从记忆直连银心；现在改接到它的恒星上，轨道才连得起来。
          // 恒星恰好不在图上（被搜索压暗不算）就退回银心，别留一根断线。
          var target = edge.to;
          if (edge.kind === 'belongs' && hostOf[edge.from]) {
            var hostId = hostOf[edge.from];
            if (kept[hostId]) target = hostId;
          }
          links.push({ source: edge.from, target: target, kind: edge.kind, width: edge.width });
        }

        // 银心 ← 恒星 ← 卫星：层级得有线连着，悬停高亮和小地图才走得通。
        for (var ni = 0; ni < nodes.length; ni += 1) {
          var nd = nodes[ni];
          if (nd.kind === 'star' && kept[nd.cluster]) {
            links.push({ source: nd.id, target: nd.cluster, kind: 'orbit', width: 0.3 });
          } else if (nd.kind === 'moon' && kept[nd.host]) {
            links.push({ source: nd.id, target: nd.host, kind: 'moon', width: 0.18 });
          }
        }

        // 恒星之间的「对话链」：同一个工作区里，按开始时间把相邻两次对话串起来，
        // 像一条时间线；线上再跑光点，看着就是记忆在往前传。
        var starsOf = {};
        for (var ski = 0; ski < nodes.length; ski += 1) {
          var skn = nodes[ski];
          if (skn.kind === 'star' && kept[skn.id]) {
            if (!starsOf[skn.cluster]) starsOf[skn.cluster] = [];
            starsOf[skn.cluster].push(skn);
          }
        }
        Object.keys(starsOf).forEach(function (cid) {
          var arr = starsOf[cid].slice().sort(function (a, b) {
            return (a.createdAt || 0) - (b.createdAt || 0);
          });
          for (var ai = 0; ai + 1 < arr.length; ai += 1) {
            links.push({ source: arr[ai].id, target: arr[ai + 1].id, kind: 'chain', width: 0.22 });
          }
        });

        return {
          nodes: nodes,
          links: links,
          totalStars: totalStars,
          visibleStars: visibleStars,
          matched: matched,
          cats: cats,
          cutoff: cutoff,
          minC: minC,
          maxC: maxC,
        };
      }

      /* ----------------------------------------------------------- CSS */

      var CSS = [
        // 不要用 position:absolute + inset:0：宿主的中栏容器如果没有定位上下文，
        // 绝对定位会一路穿到视口上去，把侧栏整块盖住。撑满父容器 + 兜底最小高度更稳。
        '.sm-root{position:relative;width:100%;height:100%;min-height:420px;display:flex;flex-direction:column;background:#05070f;color:#dfe7ff;overflow:hidden}',
        '.sm-canvas{position:relative;flex:1 1 auto;min-height:0;background:#04060e}',
        '.sm-canvas canvas{display:block}',
        // 天穹：一整张按容器尺寸生成的星空图（星云 + 恒星），不是平铺的小贴图。
        '.sm-sky{position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;background-color:#04060e;display:block}',
        // 3D 画布压在星空之上（它自己背景透明），这样鼠标事件落在画布上，连线也能看见。
        '.sm-stage{position:absolute;inset:0;z-index:1}',
        // 星点：3D 场景里的球体全部透明，改由这层 canvas 画成发光的光点。
        '.sm-points{position:absolute;inset:0;pointer-events:none;z-index:2}',
        '.sm-labels{position:absolute;inset:0;pointer-events:none;z-index:3;overflow:hidden}',
        '.sm-label{position:absolute;left:0;top:0;transform:translate3d(-50%,-50%,0);font-size:11px;letter-spacing:.1em;color:#e6eeff;text-shadow:0 0 10px rgba(96,156,255,.95),0 0 22px rgba(60,110,220,.6);white-space:nowrap;opacity:0;transition:opacity .25s;font-variant-numeric:tabular-nums}',
        '.sm-label small{display:block;font-size:9px;letter-spacing:.06em;color:#9fb2dc;text-align:center;text-shadow:0 0 8px rgba(40,70,140,.9)}',
        '.sm-hud{position:absolute;left:16px;top:14px;display:flex;flex-direction:column;gap:8px;pointer-events:none;z-index:3}',
        '.sm-title{font-size:15px;font-weight:600;letter-spacing:.02em}',
        '.sm-sub{font-size:11px;color:#8a96b8;font-variant-numeric:tabular-nums}',
        '.sm-actions{display:flex;gap:8px;pointer-events:auto;margin-top:2px}',        '.sm-btn{appearance:none;cursor:pointer;font:inherit;font-size:12px;line-height:1;color:#cfd9f5;background:rgba(110,140,220,.14);border:1px solid rgba(140,170,255,.32);border-radius:8px;padding:7px 11px}',
        '.sm-btn:hover{background:rgba(120,160,255,.24);color:#fff}',
        '.sm-btn:disabled{opacity:.5;cursor:default}',
        '.sm-btn-on{background:rgba(120,200,255,.26);border-color:rgba(150,220,255,.6);color:#fff}',
        // 顶栏读数
        '.sm-stats{position:absolute;left:50%;top:12px;transform:translateX(-50%);display:flex;gap:20px;z-index:3;pointer-events:none}',
        '.sm-stat{text-align:center;line-height:1.25}',
        '.sm-stat b{display:block;font-size:15px;font-weight:600;color:#eaf1ff;font-variant-numeric:tabular-nums}',
        '.sm-stat span{font-size:9px;color:#7c8db3;letter-spacing:.1em}',
        // 记忆构成
        '.sm-mix{margin-top:4px;pointer-events:auto;width:212px;background:rgba(9,14,30,.62);border:1px solid rgba(110,140,220,.2);border-radius:10px;padding:9px 10px}',
        '.sm-mix-h{display:flex;justify-content:space-between;font-size:10px;letter-spacing:.1em;color:#8a9ac0;margin-bottom:7px}',
        '.sm-mix-bar{display:flex;height:4px;border-radius:2px;overflow:hidden;margin-bottom:8px;background:rgba(120,150,220,.12)}',
        '.sm-mix-row{display:flex;align-items:center;gap:7px;font-size:11px;color:#a9b6d6;padding:2px 0;cursor:pointer;border-radius:6px}',
        '.sm-mix-row:hover{color:#e6eeff;background:rgba(120,160,255,.1)}',
        '.sm-mix-row.on{color:#fff;background:rgba(120,200,255,.18)}',
        '.sm-mix-row b{margin-left:auto;font-weight:500;font-variant-numeric:tabular-nums;color:#cfdcf8}',
        // 小地图
        '.sm-mini{position:absolute;right:16px;bottom:16px;z-index:3;background:rgba(9,14,30,.66);border:1px solid rgba(110,140,220,.22);border-radius:10px;padding:6px}',
        '.sm-mini canvas{display:block;border-radius:6px}',
        '.sm-mini-h{font-size:9px;letter-spacing:.12em;color:#7c8db3;margin-bottom:5px;text-align:center}',
        // 认知流
        '.sm-flow{position:absolute;left:16px;bottom:16px;z-index:3;width:226px;background:rgba(9,14,30,.66);border:1px solid rgba(110,140,220,.2);border-radius:10px;padding:9px 10px}',
        '.sm-flow-h{display:flex;justify-content:space-between;font-size:10px;letter-spacing:.1em;color:#8a9ac0;margin-bottom:7px}',
        '.sm-flow-row{display:flex;gap:6px;align-items:baseline;font-size:11px;color:#a9b6d6;padding:3px 0;cursor:pointer;border-radius:6px}',
        '.sm-flow-row:hover{color:#e6eeff;background:rgba(120,160,255,.1)}',
        '.sm-flow-row i{font-style:normal;color:#5f6d8f;font-size:9px;flex:0 0 auto}',
        '.sm-flow-row span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.sm-settings{position:absolute;right:16px;top:130px;z-index:4;width:248px;background:rgba(9,14,30,.9);border:1px solid rgba(120,150,230,.28);border-radius:12px;padding:12px 14px;backdrop-filter:blur(10px);box-shadow:0 14px 36px rgba(0,0,0,.5)}',
        '.sm-set-title{font-size:12px;font-weight:600;color:#dfe7fb;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center}',
        '.sm-set-row{display:grid;grid-template-columns:62px 1fr 38px;align-items:center;gap:8px;font-size:11px;color:#9fb0d4;margin-bottom:9px}',
        '.sm-set-row input[type="range"]{width:100%;height:3px;accent-color:#7fb0ff}',
        '.sm-set-val{text-align:right;color:#cfe0ff;font-variant-numeric:tabular-nums}',
        '.sm-set-foot{display:flex;justify-content:flex-end;margin-top:4px}',
        '.sm-search{pointer-events:auto;display:flex;align-items:center;gap:8px;margin-top:2px}',
        '.sm-input{font:inherit;font-size:12px;color:#dfe7ff;background:rgba(14,20,40,.82);border:1px solid rgba(140,170,255,.3);border-radius:8px;padding:7px 10px;width:200px;outline:none}',
        '.sm-input:focus{border-color:rgba(160,200,255,.65)}',
        '.sm-input::placeholder{color:#6d7896}',
        '.sm-time{pointer-events:auto;display:flex;flex-direction:column;gap:4px;margin-top:2px;width:236px}',
        '.sm-time-top{display:flex;justify-content:space-between;font-size:10px;color:#7d88a8;font-variant-numeric:tabular-nums}',
        '.sm-range{-webkit-appearance:none;appearance:none;width:100%;height:16px;background:transparent;cursor:pointer}',
        '.sm-range::-webkit-slider-runnable-track{height:3px;border-radius:2px;background:linear-gradient(90deg,rgba(120,170,255,.75),rgba(120,170,255,.15))}',
        '.sm-range::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;margin-top:-4.5px;border-radius:50%;background:#cfe2ff;box-shadow:0 0 8px rgba(140,190,255,.85);border:none}',
        '.sm-legend{position:absolute;right:16px;top:14px;display:flex;flex-direction:column;gap:6px;z-index:3;max-width:230px}',
        '.sm-legend-row{display:flex;align-items:center;gap:7px;font-size:11px;color:#a9b5d6;cursor:pointer}',
        '.sm-dot{width:8px;height:8px;border-radius:50%;flex:none;box-shadow:0 0 8px currentColor}',
        '.sm-card{position:absolute;left:16px;bottom:226px;z-index:3;max-width:360px;background:rgba(10,16,34,.86);border:1px solid rgba(120,150,230,.28);border-radius:12px;padding:12px 14px;backdrop-filter:blur(8px);box-shadow:0 12px 32px rgba(0,0,0,.45)}',
        '.sm-card-title{font-size:13px;font-weight:600;margin-bottom:6px;word-break:break-all}',
        '.sm-card-row{font-size:11px;color:#9aa7c9;line-height:1.7;word-break:break-all}',
        '.sm-card-body{font-size:11px;color:#cfd9f2;line-height:1.65;max-height:190px;overflow:auto;white-space:pre-wrap;word-break:break-word}',
        '.sm-state{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;font-size:12px;color:#8a96b8;z-index:2;text-align:center;padding:24px}',
        '.sm-err{color:#ff9a9a;max-width:520px;word-break:break-all;line-height:1.7}',
        '.sm-empty{color:#8a96b8}',
      ].join('\n');

      function injectCss() {
        var tagId = 'dsh-starmap/base.css';
        if (document.querySelector('style[data-plugin-css="' + tagId + '"]')) return;
        var tag = document.createElement('style');
        tag.dataset.plugin = ID;
        tag.dataset.pluginCss = tagId;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }

      /* --------------------------------------------------------- 星空 */

      // 一整张天穹图：底色渐变 + 几团星云 + 银道带 + 按面积铺的恒星（亮星带十字星芒）。
      // —— 天球贴图：等距柱状投影，按相机 yaw/pitch 取样，
      //    转动视角时背景真的会换，像寰宇盒而不是一张贴死的图。
      var skyTex = null;
      function buildSkyTex() {
        if (skyTex) return skyTex;
        var W = 2048;
        var H = 1024;
        var cv = document.createElement('canvas');
        cv.width = W;
        cv.height = H;
        var g = cv.getContext('2d');
        var rnd = mulberry32(20261108);
        var base = g.createLinearGradient(0, 0, 0, H);
        base.addColorStop(0, '#04060d');
        base.addColorStop(0.34, '#070c1c');
        base.addColorStop(0.5, '#0a1024');
        base.addColorStop(0.68, '#070b18');
        base.addColorStop(1, '#03050b');
        g.fillStyle = base;
        g.fillRect(0, 0, W, H);
        for (var b = 0; b < 3; b += 1) {
          var band = g.createLinearGradient(0, H * 0.34, 0, H * 0.66);
          band.addColorStop(0, 'rgba(120,150,230,0)');
          band.addColorStop(0.5, 'rgba(150,180,245,' + (0.05 - b * 0.012).toFixed(3) + ')');
          band.addColorStop(1, 'rgba(120,150,230,0)');
          g.fillStyle = band;
          g.fillRect(0, H * 0.34, W, H * 0.32);
        }
        for (var n2 = 0; n2 < 26; n2 += 1) {
          var cx2 = rnd() * W;
          var cy2 = H * 0.2 + rnd() * H * 0.6;
          var r2 = 40 + rnd() * 150;
          var hv = rnd();
          var hue = hv < 0.3 ? '110,150,255' : hv < 0.5 ? '160,110,220' : hv < 0.65 ? '90,200,190' : hv < 0.82 ? '220,110,90' : '235,170,110';
          var rg = g.createRadialGradient(cx2, cy2, 0, cx2, cy2, r2);
          rg.addColorStop(0, 'rgba(' + hue + ',0.10)');
          rg.addColorStop(0.5, 'rgba(' + hue + ',0.04)');
          rg.addColorStop(1, 'rgba(' + hue + ',0)');
          g.fillStyle = rg;
          var wrapX = [cx2, cx2 < r2 * 1.6 ? cx2 + W : cx2 > W - r2 * 1.6 ? cx2 - W : null];
          for (var wx2 = 0; wx2 < wrapX.length; wx2 += 1) {
            if (wrapX[wx2] === null) continue;
            var rg2 = g.createRadialGradient(wrapX[wx2], cy2, 0, wrapX[wx2], cy2, r2);
            rg2.addColorStop(0, 'rgba(' + hue + ',0.10)');
            rg2.addColorStop(0.5, 'rgba(' + hue + ',0.04)');
            rg2.addColorStop(1, 'rgba(' + hue + ',0)');
            g.fillStyle = rg2;
            g.beginPath();
            g.arc(wrapX[wx2], cy2, r2, 0, Math.PI * 2);
            g.fill();
          }
        }
        for (var i2 = 0; i2 < 3200; i2 += 1) {
          var x2 = rnd() * W;
          var y2 = rnd() * H;
          var r3 = 0.35 + Math.pow(rnd(), 3) * 1.5;
          g.fillStyle = 'rgba(255,255,255,' + (0.25 + rnd() * 0.7).toFixed(2) + ')';
          var xs = [x2];
          if (x2 < 40) xs.push(x2 + W);
          if (x2 > W - 40) xs.push(x2 - W);
          for (var xi = 0; xi < xs.length; xi += 1) {
            g.beginPath();
            g.arc(xs[xi], y2, r3, 0, Math.PI * 2);
            g.fill();
          }
        }
        skyTex = cv;
        return cv;
      }

      var meteorList = [];
      var lastMeteor = 0;

      // 每帧把天球按当前朝向铺到背景画布上，顺便撒几颗流星
      function drawSkybox(el, w, h, graph) {
        if (!el || !w || !h) return;
        var ctx2 = el.getContext('2d');
        if (!ctx2) return;
        if (el.width !== w || el.height !== h) {
          el.width = w;
          el.height = h;
        }
        var tex = buildSkyTex();
        var cam = null;
        try {
          cam = graph.camera();
        } catch (e) {
          cam = null;
        }
        var yaw = 0;
        var pitch = 0;
        if (cam && cam.position) {
          try {
            var Vv = cam.position.constructor;
            var dv = cam.getWorldDirection(new Vv(0, 0, 0));
            yaw = Math.atan2(dv.x, dv.z);
            pitch = Math.asin(Math.max(-1, Math.min(1, dv.y)));
          } catch (e) {
            yaw = 0;
            pitch = 0;
          }
        }
        var spanW = Math.max(0.3, Math.min(1, (cam && cam.fov ? cam.fov : 55) / 95));
        var scale = w / (tex.width * spanW);
        var drawW = tex.width * scale;
        var drawH = tex.height * scale;
        var yawNorm = (((yaw / (Math.PI * 2)) % 1) + 1) % 1;
        var ox = -yawNorm * drawW;
        var oy = -(tex.height * 0.5 - (pitch / (Math.PI / 2)) * tex.height * 0.62) * scale + h / 2;
        ctx2.clearRect(0, 0, w, h);
        // 两层：远层更慢更淡，转视角时和前层错开，就有了纵深
        ctx2.globalAlpha = 0.5;
        var oxFar = -(yawNorm * 0.62) * drawW * 1.55;
        for (var kf = -1; kf <= 2; kf += 1) {
          ctx2.drawImage(tex, 0, 0, tex.width, tex.height, oxFar + kf * drawW * 1.55, oy - h * 0.06, drawW * 1.55, drawH * 1.55);
        }
        ctx2.globalAlpha = 1;
        for (var k = 0; k < 3; k += 1) {
          ctx2.drawImage(tex, 0, 0, tex.width, tex.height, ox + k * drawW, oy, drawW, drawH);
        }
        var now = Date.now();
        if (now - lastMeteor > 900 && meteorList.length < 6) {
          lastMeteor = now;
          meteorList.push({
            x: Math.random() * w * 1.3 - w * 0.15,
            y: Math.random() * h * 0.55,
            vx: (Math.random() > 0.5 ? 1 : -1) * (2.8 + Math.random() * 2.4),
            vy: 1.2 + Math.random() * 1.5,
            life: 0,
            max: 55 + Math.random() * 45,
          });
        }
        for (var m2 = meteorList.length - 1; m2 >= 0; m2 -= 1) {
          var mt = meteorList[m2];
          mt.life += 1;
          if (mt.life > mt.max) {
            meteorList.splice(m2, 1);
            continue;
          }
          mt.x += mt.vx;
          mt.y += mt.vy;
          var spd = Math.sqrt(mt.vx * mt.vx + mt.vy * mt.vy) || 1;
          var tail = 74;
          var tx = (mt.vx / spd) * tail;
          var ty = (mt.vy / spd) * tail;
          var a3 = Math.sin((mt.life / mt.max) * Math.PI) * 0.85;
          var lg = ctx2.createLinearGradient(mt.x, mt.y, mt.x - tx, mt.y - ty);
          lg.addColorStop(0, 'rgba(214,240,255,' + a3.toFixed(2) + ')');
          lg.addColorStop(1, 'rgba(214,240,255,0)');
          ctx2.strokeStyle = lg;
          ctx2.lineWidth = 1.5;
          ctx2.beginPath();
          ctx2.moveTo(mt.x, mt.y);
          ctx2.lineTo(mt.x - tx, mt.y - ty);
          ctx2.stroke();
          ctx2.fillStyle = 'rgba(240,250,255,' + (a3 * 0.9).toFixed(2) + ')';
          ctx2.beginPath();
          ctx2.arc(mt.x, mt.y, 1.5, 0, Math.PI * 2);
          ctx2.fill();
        }
      }


      // ——— GPU 星云层：把「雾」搬到显卡上，粒子在顶点着色器里绕各自的核心差速公转 ———
      var gpuState = { started: false, enabled: false, THREE: null, root: null, byId: {}, error: null };

      var GPU_VERT = [
        'attribute vec3 aColor;',
        'attribute float aSize;',
        'attribute float aU;',
        'attribute float aPh;',
        'attribute float aAlpha;',
        'uniform float uTime;',
        'varying vec3 vColor;',
        'varying float vA;',
        'void main() {',
        '  float wob = 0.22 * sin(uTime * (1.0 / (0.35 + aU * 1.3)) + aPh);',
        '  float c = cos(wob);',
        '  float s = sin(wob);',
        '  vec3 p = vec3(position.x * c - position.y * s, position.x * s + position.y * c, position.z);',
        '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
        '  gl_Position = projectionMatrix * mv;',
        '  gl_PointSize = aSize * (330.0 / max(1.0, -mv.z));',
        '  vColor = aColor;',
        '  vA = aAlpha;',
        '}',
      ].join('\n');

      var GPU_FRAG = [
        'varying vec3 vColor;',
        'varying float vA;',
        'void main() {',
        '  vec2 d = gl_PointCoord - vec2(0.5);',
        '  float r = length(d) * 2.0;',
        '  if (r > 1.0) discard;',
        '  float f = exp(-r * r * 3.6);',
        '  gl_FragColor = vec4(vColor, 1.0) * f * vA;',
        '}',
      ].join('\n');

      function gpuStart(graph) {
        if (!gpuState.enabled || gpuState.started) return;
        gpuState.started = true;
        try {
          var threeUrl = (typeof window !== 'undefined' && window.__STARMAP_THREE__) || '/dsh-starmap/vendor/three.module.min.js';
          var threeCdn = 'https://fastly.jsdelivr.net/npm/three@0.160.1/build/three.module.min.js';
          // 本地副本优先；取不到就退回 CDN（import() 支持 https 说明符）
          import(threeUrl)
            .catch(function () {
              return import(threeCdn);
            })
            .then(function (T) {
              gpuState.THREE = T;
              gpuState.root = new T.Group();
              gpuState.root.frustumCulled = false;
              graph.scene().add(gpuState.root);
            })
            .catch(function (e) {
              gpuState.error = String((e && e.message) || e);
            });
        } catch (e) {
          gpuState.error = String((e && e.message) || e);
        }
      }

      function rgbTriple(c) {
        var s2 = String(c || '');
        if (s2.charAt(0) === '#') {
          var h = s2.slice(1);
          if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
          var n = parseInt(h, 16);
          if (!isFinite(n)) return [0.8, 0.85, 1];
          return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
        }
        var parts = s2.split(',').map(function (x) {
          return parseFloat(x);
        });
        if (parts.length >= 3 && isFinite(parts[0])) return [parts[0] / 255, parts[1] / 255, parts[2] / 255];
        return [0.8, 0.85, 1];
      }

      function gpuBuildCluster(T, cl, cloud) {
        var puffs = cloud.puffs || [];
        if (!puffs.length) return null;
        var n = puffs.length;
        var pos = new Float32Array(n * 3);
        var col = new Float32Array(n * 3);
        var siz = new Float32Array(n);
        var us = new Float32Array(n);
        var ph = new Float32Array(n);
        var al = new Float32Array(n);
        for (var i = 0; i < n; i += 1) {
          var p = puffs[i];
          pos[i * 3] = p.x;
          pos[i * 3 + 1] = p.y;
          pos[i * 3 + 2] = p.z;
          var c3 = p.dark ? [0.02, 0.03, 0.06] : rgbTriple(p.c);
          col[i * 3] = c3[0];
          col[i * 3 + 1] = c3[1];
          col[i * 3 + 2] = c3[2];
          siz[i] = p.r * 7.5;
          us[i] = Math.min(1.2, Math.sqrt(p.x * p.x + p.y * p.y) / 44);
          ph[i] = Math.random() * Math.PI * 2;
          al[i] = p.dark ? 0 : (p.a || 1) * 0.34;
        }
        var geo = new T.BufferGeometry();
        geo.setAttribute('position', new T.BufferAttribute(pos, 3));
        geo.setAttribute('aColor', new T.BufferAttribute(col, 3));
        geo.setAttribute('aSize', new T.BufferAttribute(siz, 1));
        geo.setAttribute('aU', new T.BufferAttribute(us, 1));
        geo.setAttribute('aPh', new T.BufferAttribute(ph, 1));
        geo.setAttribute('aAlpha', new T.BufferAttribute(al, 1));
        var mat = new T.ShaderMaterial({
          uniforms: { uTime: { value: 0 } },
          vertexShader: GPU_VERT,
          fragmentShader: GPU_FRAG,
          transparent: true,
          depthWrite: false,
          depthTest: false,
          blending: T.AdditiveBlending,
        });
        var pts = new T.Points(geo, mat);
        pts.frustumCulled = false;
        return { points: pts, mat: mat };
      }

      function gpuSync(graph, clNodes, cloudFor, tSec) {
        var T = gpuState.THREE;
        if (!T || !gpuState.root) return;
        for (var i = 0; i < clNodes.length; i += 1) {
          var cl = clNodes[i];
          var entry = gpuState.byId[cl.id];
          if (!entry) {
            var cloud = cloudFor(cl);
            if (!cloud) continue;
            entry = gpuBuildCluster(T, cl, cloud);
            if (!entry) continue;
            gpuState.byId[cl.id] = entry;
            gpuState.root.add(entry.points);
          }
          entry.points.position.set(cl.x || 0, cl.y || 0, cl.z || 0);
          entry.points.visible = !cl.dim;
          entry.mat.uniforms.uTime.value = tSec;
        }
      }

      function makeSky(w, h) {
        var canvas = document.createElement('canvas');
        var W = Math.max(320, Math.round(w));
        var H = Math.max(240, Math.round(h));
        canvas.width = W;
        canvas.height = H;
        var g = canvas.getContext('2d');

        var base = g.createLinearGradient(0, 0, W * 0.25, H);
        base.addColorStop(0, '#05070f');
        base.addColorStop(0.42, '#070b19');
        base.addColorStop(0.72, '#050813');
        base.addColorStop(1, '#03050c');
        g.fillStyle = base;
        g.fillRect(0, 0, W, H);

        // 星云：大而淡的椭圆，用屏幕混合叠，像气团不是色块。
        g.globalCompositeOperation = 'screen';
        var blobs = [
          [0.74, 0.16, 0.42, 0.30, '86,128,255', 0.16],
          [0.24, 0.74, 0.36, 0.26, '150,88,220', 0.13],
          [0.52, 0.46, 0.50, 0.34, '40,86,190', 0.10],
          [0.88, 0.80, 0.26, 0.22, '60,170,210', 0.08],
          [0.12, 0.20, 0.24, 0.20, '90,120,255', 0.07],
        ];
        for (var b = 0; b < blobs.length; b += 1) {
          var bl = blobs[b];
          var cx = bl[0] * W;
          var cy = bl[1] * H;
          var rx = bl[2] * W;
          var ry = bl[3] * H;
          var blob = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
          blob.addColorStop(0, 'rgba(' + bl[4] + ',' + bl[5] + ')');
          blob.addColorStop(0.55, 'rgba(' + bl[4] + ',' + (bl[5] * 0.36).toFixed(3) + ')');
          blob.addColorStop(1, 'rgba(' + bl[4] + ',0)');
          g.save();
          g.translate(cx, cy);
          g.scale(1, ry / Math.max(rx, ry));
          g.translate(-cx, -cy);
          g.fillStyle = blob;
          g.fillRect(cx - rx, cy - Math.max(rx, ry), rx * 2, Math.max(rx, ry) * 2);
          g.restore();
        }

        // 银道带：一条倾斜的朦胧亮带，带一点点颗粒感
        g.save();
        g.translate(W * 0.5, H * 0.52);
        g.rotate(-0.42);
        var band = g.createLinearGradient(0, -H * 0.2, 0, H * 0.2);
        band.addColorStop(0, 'rgba(120,150,230,0)');
        band.addColorStop(0.38, 'rgba(140,168,240,0.04)');
        band.addColorStop(0.5, 'rgba(180,205,255,0.062)');
        band.addColorStop(0.62, 'rgba(140,168,240,0.04)');
        band.addColorStop(1, 'rgba(120,150,230,0)');
        g.fillStyle = band;
        g.fillRect(-W, -H * 0.2, W * 2, H * 0.4);
        g.restore();

        // 恒星：密度按面积走，冷白为主，掺少量暖黄与蓝白
        var count = Math.round((W * H) / 1500);
        for (var i = 0; i < count; i += 1) {
          var x = Math.random() * W;
          var y = Math.random() * H;
          var pick = Math.random();
          var tint = pick > 0.94 ? '255,226,180' : pick > 0.8 ? '205,222,255' : '240,246,255';
          var r = Math.random() < 0.9 ? 0.35 + Math.random() * 0.55 : 0.8 + Math.random() * 0.9;
          var a = 0.22 + Math.random() * 0.62;
          g.globalCompositeOperation = 'source-over';
          g.beginPath();
          g.arc(x, y, r, 0, Math.PI * 2);
          g.fillStyle = 'rgba(' + tint + ',' + a.toFixed(2) + ')';
          g.fill();
          if (r > 1.15) {
            var halo = g.createRadialGradient(x, y, 0, x, y, r * 6);
            halo.addColorStop(0, 'rgba(' + tint + ',' + (a * 0.42).toFixed(2) + ')');
            halo.addColorStop(0.4, 'rgba(' + tint + ',' + (a * 0.12).toFixed(2) + ')');
            halo.addColorStop(1, 'rgba(' + tint + ',0)');
            g.fillStyle = halo;
            g.beginPath();
            g.arc(x, y, r * 6, 0, Math.PI * 2);
            g.fill();
          }
        }

        // 亮星：十字星芒，数量很少，一下就"真"了
        var bright = Math.max(6, Math.round(count / 240));
        for (var k = 0; k < bright; k += 1) {
          var bx = Math.random() * W;
          var by = Math.random() * H;
          var len = 6 + Math.random() * 16;
          var sp = g.createLinearGradient(bx - len, by, bx + len, by);
          sp.addColorStop(0, 'rgba(255,255,255,0)');
          sp.addColorStop(0.5, 'rgba(255,255,255,0.5)');
          sp.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = sp;
          g.fillRect(bx - len, by - 0.5, len * 2, 1);
          var sp2 = g.createLinearGradient(bx, by - len, bx, by + len);
          sp2.addColorStop(0, 'rgba(255,255,255,0)');
          sp2.addColorStop(0.5, 'rgba(255,255,255,0.5)');
          sp2.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = sp2;
          g.fillRect(bx - 0.5, by - len, 1, len * 2);
          g.beginPath();
          g.arc(bx, by, 1.6, 0, Math.PI * 2);
          g.fillStyle = 'rgba(255,255,255,0.95)';
          g.fill();
        }

        g.globalCompositeOperation = 'source-over';
        return canvas.toDataURL('image/jpeg', 0.86);
      }

      // 天穹按容器尺寸重画：窗口/中栏一变，星空跟着换一张，不会拉伸成马赛克。

      function paintSky(el, w, h) {
        if (!el) return;
        if (!w || !h) return;
        var key = Math.round(w) + 'x' + Math.round(h);
        if (el.dataset.skyKey === key) return;
        try {
          // 天穹按 0.72 倍分辨率生成再由 CSS 铺满：星点本来就软，画得更大只是白烧内存
          el.style.backgroundImage = 'url(' + makeSky(w * 0.72, h * 0.72) + ')';
          // 铺满不重复：默认 repeat 会把这张小图拼成格子，接缝一眼就能看见
          el.style.backgroundSize = '100% 100%';
          el.style.backgroundRepeat = 'no-repeat';
          el.dataset.skyKey = key;
        } catch (e) {
          /* 画布生成失败就留底色 */
        }
      }

      // 光点贴图：白核 + 有色光晕，按节点颜色缓存，绘制时只做 drawImage。
      var spriteCache = {};
      function spriteFor(color) {
        var key = String(color || '#ffffff');
        if (spriteCache[key]) return spriteCache[key];
        var size = 64;
        var canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        var g = canvas.getContext('2d');
        var c = key;
        var m = /^#?([0-9a-f]{6})$/i.exec(key);
        if (m) {
          var n = parseInt(m[1], 16);
          c = 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',';
        } else if (key.slice(0, 4) === 'rgb(') {
          c = key.replace('rgb(', 'rgba(').replace(')', ',');
        } else {
          c = 'rgba(220,232,255,';
        }
        var core = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        core.addColorStop(0, 'rgba(255,255,255,1)');
        core.addColorStop(0.12, 'rgba(255,255,255,0.92)');
        core.addColorStop(0.26, c + '0.75)');
        core.addColorStop(0.52, c + '0.20)');
        core.addColorStop(1, c + '0)');
        g.fillStyle = core;
        g.fillRect(0, 0, size, size);
        spriteCache[key] = canvas;
        return canvas;
      }

      // ── 星系形状 ──
      // 每个星团是一团真的 3D 星云：核心、旋臂、电离氢区全部放在世界坐标里，
      // 每帧投影到屏幕再画。于是转视角有视差、近处清楚、远处自然糊成雾。
      var galaxyCache = {};
      function rgbOf(hex) {
        var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
        if (!m) return '150,180,255';
        var n = parseInt(m[1], 16);
        return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255);
      }
      function mulberry32(a) {
        return function () {
          a |= 0;
          a = (a + 0x6d2b79f5) | 0;
          var t = Math.imul(a ^ (a >>> 15), 1 | a);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }
      function hashStr(s) {
        var h = 2166136261;
        for (var i = 0; i < s.length; i += 1) {
          h ^= s.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        return h >>> 0;
      }
      var puffCache = {};
      function puffSprite(rgbIn) {
        var rgb = String(rgbIn || '').charAt(0) === '#' ? rgbOf(rgbIn) : String(rgbIn || '150,180,255');
        var key = 'p:' + rgb;        if (puffCache[key]) return puffCache[key];
        var S = 96;
        var C = S / 2;
        var cv = document.createElement('canvas');
        cv.width = S;
        cv.height = S;
        var g = cv.getContext('2d');
        var grd = g.createRadialGradient(C, C, 0, C, C, C);
        grd.addColorStop(0, 'rgba(' + rgb + ',0.46)');
        grd.addColorStop(0.22, 'rgba(' + rgb + ',0.26)');
        grd.addColorStop(0.5, 'rgba(' + rgb + ',0.1)');
        grd.addColorStop(1, 'rgba(' + rgb + ',0)');
        g.fillStyle = grd;
        g.fillRect(0, 0, S, S);
        puffCache[key] = cv;
        return cv;
      }

      // 造一团星系：形状由 id 的哈希决定，因此每个星团长得都不一样，刷新也不变。
      // radius 由布局给（这个团要装下多少颗恒星、每颗恒星带多宽的盘），
      // 于是星团能真的把里面的光点裹住，而不是固定 72 像素的贴纸。
      function buildGalaxyCloud(id, color, isPrimary, radius) {
        var seed = hashStr(String(id));
        var rand = mulberry32(seed);
        var base = rgbOf(color);
        var pink = rgbOf('#ff86b4');
        var blue = rgbOf('#a8ccff');
        var warm = rgbOf('#ffe2b0');
        var shape = seed % 5;
        var puffs = [];
        var stars = [];
        var hazes = [];
        var R = Math.max(40, radius || (isPrimary ? 72 : 44)) * 1.05;
        var ARMS = 3;
        var TWIST = 2.55;

        function puff(x, y, z, r, c, a, dark) {
          puffs.push({ x: x, y: y, z: z, r: r, c: c, a: a === undefined ? 1 : a, dark: !!dark });
        }
        function star(x, y, z, s, c) {
          var rn = Math.sqrt(x * x + y * y) / (R || 1);
          stars.push({ x: x, y: y, z: z, s: s, c: c, u: Math.min(1.4, rn), ph: rand() * Math.PI * 2 });
        }
        // 对数螺旋：手臂在中心缠得紧、往外甩得开。云臂、恒星、装饰星全用这一条公式，
        // 三者才叠在同一批旋臂上 —— 否则云在转、星星在另一条曲线上，看着就是散点图。
        function armAt(u, arm, jit) {
          var wind = Math.log(1 + u * 6.2) / Math.log(7.2);
          var th = arm * ((Math.PI * 2) / ARMS) + TWIST * 0.92 * wind + jit;
          var r = 6 + u * R;
          return { x: Math.cos(th) * r, y: Math.sin(th) * r * 0.94, r: r, th: th };
        }

        var pad;
        var pa2;

        // 1) 星云主体：几团絮状气体围着中心堆起来。形状由 id 的哈希决定，
        //    每个星团长得都不一样 —— 但都是「一团发光的云」，不是旋臂。
        var nebula = Math.min(1800, Math.round(isPrimary ? 240 + R * 1.5 : 320 + R * 2.0));
        var squash = 0.72 + rand() * 0.5;
        // 主团是规整的星云；其他团做成不规则的团块，形状随机、摊得更开，
        // 半径照样铺满 —— 以后新对话、新记忆进来还有地方放
        var lumps = isPrimary ? 2 + (seed % 4) : 5 + (seed % 4);
        var blobs = [];
        for (var lb = 0; lb < lumps; lb += 1) {
          var la = rand() * Math.PI * 2;
          var lr = Math.pow(rand(), 0.7) * R * (isPrimary ? 0.88 : 0.95);
          blobs.push({ x: Math.cos(la) * lr, y: Math.sin(la) * lr * squash, r: R * (isPrimary ? 0.2 + rand() * 0.24 : 0.26 + rand() * 0.34) });
        }
        for (var np2 = 0; np2 < nebula; np2 += 1) {
          var bl = blobs[np2 % blobs.length];
          var ga = rand() * Math.PI * 2;
          var gr = Math.pow(rand(), 0.62) * bl.r;
          var nx = bl.x + Math.cos(ga) * gr;
          var ny = bl.y + Math.sin(ga) * gr * squash;
          pad = 3 + rand() * (8 + R * 0.02);
          pa2 = rand() < 0.62 ? base : rand() < 0.55 ? blue : warm;
          // 非主团没有旋臂撑着画面，云本身要更实一点，才看得出是一团
          puff(nx, ny, (rand() - 0.5) * (5 + R * 0.048), pad + rand() * (6 + R * 0.03), pa2, (isPrimary ? 0.04 : 0.075) + rand() * (isPrimary ? 0.08 : 0.12));
        }

        // 2) 暗尘：几块压暗的絮，把星云的层次托出来
        var dusts = Math.min(600, Math.round(50 + R * 0.7));
        for (var dk2 = 0; dk2 < dusts; dk2 += 1) {
          var db = blobs[dk2 % blobs.length];
          var da = rand() * Math.PI * 2;
          var dr = Math.pow(rand(), 0.6) * db.r * 0.9;
          puff(db.x + Math.cos(da) * dr, db.y + Math.sin(da) * dr * squash, (rand() - 0.5) * 6,
            4 + rand() * (6 + R * 0.02), '6,10,16', 0.12 + rand() * 0.16, true);
        }

        // 3) 中心核：星云中间那团白热
        puff(0, 0, 0, Math.min(34, 15 + R * 0.035), warm, 0.1);
        puff(0, 0, 0, Math.min(20, 9 + R * 0.022), '#ffffff', 0.08);

        // 4) 弥散星：星云里那些细碎的小星
        for (var ms = 0; ms < Math.min(700, Math.round(160 + R * 0.9)); ms += 1) {
          var mb = blobs[ms % blobs.length];
          var ma = rand() * Math.PI * 2;
          var mr = Math.pow(rand(), 0.5) * mb.r * 1.15;
          star(mb.x + Math.cos(ma) * mr, mb.y + Math.sin(ma) * mr * squash, (rand() - 0.5) * 16,
            0.35 + rand() * 0.7, rand() < 0.5 ? base : rand() < 0.55 ? warm : '255,255,255');
        }

        // 5) 旋臂淡雾：星星走旋臂，气体只跟着拖一层很淡的尾巴。
        //    单独一层、颜色压得很低，才不会抢星团本身的戏。
        var armHaze = isPrimary ? Math.min(1600, Math.round(200 + R * 1.9)) : 0;
        var HAZE_ARMS = 5;
        var hazeStep = (Math.PI * 2) / HAZE_ARMS;
        for (var hz = 0; hz < armHaze; hz += 1) {
          var harm = hz % HAZE_ARMS;
          var hu = Math.pow(rand(), 0.8) * 1.08;
          var hwind = Math.log(1 + hu * 6.2) / Math.log(7.2);
          var hth = harm * hazeStep - 4.6 * hwind + (rand() - 0.5) * (0.11 + hu * 0.62);
          // 与恒星同一条半径曲线：雾才不会和星星错开成两个环
          var hr2 = 46 + 470 * Math.pow(hu, 0.58);
          hazes.push({
            x: Math.cos(hth) * hr2,
            y: Math.sin(hth) * hr2 * 0.94,
            z: (rand() - 0.5) * (5 + R * 0.034),
            r: 6 + rand() * (10 + R * 0.03),
            c: rand() < 0.7 ? base : blue,
            a: 0.05 + rand() * 0.06,
          });
        }

        // 6) 臂间弥散雾：旋臂之间也铺一层极淡的气，越往外越稀
        var gapFog = Math.min(760, Math.round(120 + R * 0.95));
        for (var gf = 0; gf < gapFog; gf += 1) {
          var gth = rand() * Math.PI * 2;
          var grad = 40 + 480 * Math.pow(rand(), 0.62) * (0.55 + rand() * 0.55);
          hazes.push({
            x: Math.cos(gth) * grad,
            y: Math.sin(gth) * grad * 0.94,
            z: (rand() - 0.5) * (4 + R * 0.027),
            r: 9 + rand() * (14 + R * 0.03),
            c: base,
            a: 0.028 + rand() * 0.04,
          });
        }

        // 7) 雾丝：沿旋臂切向拉出一小串细丝，像被旋臂扯着一起转
        var threads = isPrimary ? Math.min(140, Math.round(24 + R * 0.13)) : 0;
        for (var tt = 0; tt < threads; tt += 1) {
          var thArm = tt % HAZE_ARMS;
          var tu = 0.12 + rand() * 0.85;
          var tn = 6 + Math.floor(rand() * 7);
          var tspan = 0.05 + rand() * 0.11;
          for (var ti = 0; ti < tn; ti += 1) {
            var tuu = Math.min(1.15, tu + (ti / tn) * tspan);
            var twind = Math.log(1 + tuu * 6.2) / Math.log(7.2);
            var tth = thArm * hazeStep - 4.6 * twind;
            var tr = 46 + 470 * Math.pow(tuu, 0.58);
            hazes.push({
              x: Math.cos(tth) * tr + (rand() - 0.5) * 7,
              y: Math.sin(tth) * tr * 0.94 + (rand() - 0.5) * 7,
              z: (rand() - 0.5) * (6 + R * 0.04),
              r: 2.5 + rand() * (5 + R * 0.02),
              c: rand() < 0.55 ? base : blue,
              a: 0.05 + rand() * 0.07,
            });
          }
        }

        // 倾斜：让盘面不是正对着屏幕，看着才有立体感
        var tiltX = (rand() - 0.5) * 0.55;
        var tiltY = (rand() - 0.5) * 0.42;
        var cx0 = Math.cos(tiltX);
        var sx0 = Math.sin(tiltX);
        var cy0 = Math.cos(tiltY);
        var sy0 = Math.sin(tiltY);
        var tilt = function (list) {
          for (var q = 0; q < list.length; q += 1) {
            var it = list[q];
            var y1 = it.y * cx0 - it.z * sx0;
            var z1 = it.y * sx0 + it.z * cx0;
            it.y = y1;
            it.z = z1;
            var x1 = it.x * cy0 - it.z * sy0;
            var z2 = it.x * sy0 + it.z * cy0;
            it.x = x1;
            it.z = z2;
          }
        };
        tilt(puffs);
        tilt(stars);
        tilt(hazes);
        // 给盘面一点厚度：纯平的盘子从侧面看会塌成一条线
        var thick = function (list, amt) {
          for (var q2 = 0; q2 < list.length; q2 += 1) {
            list[q2].z += (rand() - 0.5) * amt;
          }
        };
        thick(puffs, R * 0.34);
        thick(stars, R * 0.3);
        thick(hazes, R * 0.3);

        // 盘面法线：正面看是 1，侧着看是 0，用来在侧视时补亮度
        var nTmp = [{ x: 0, y: 0, z: 1 }];
        tilt(nTmp);
        var cloud = { puffs: puffs, stars: stars, haze: hazes, shape: shape, normal: nTmp[0], spin: (rand() - 0.5) * 0.00006 };
        return cloud;
      }

      // 星团之间流动的星尘：每个星团连最近的邻居，粒子沿曲线飘过去。
      function buildStreams(clusters) {
        var list = [];
        for (var i = 0; i < clusters.length; i += 1) {
          var a = clusters[i];
          var best = null;
          var bestD = Infinity;
          for (var j = 0; j < clusters.length; j += 1) {
            if (i === j) continue;
            var b = clusters[j];
            var d = (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) + (a.z - b.z) * (a.z - b.z);
            if (d < bestD) {
              bestD = d;
              best = b;
            }
          }
          if (!best) continue;
          var key = a.id < best.id ? a.id + '|' + best.id : best.id + '|' + a.id;
          if (list.some(function (s) { return s.key === key; })) continue;
          list.push({ key: key, a: a, b: best, n: 16, seed: hashStr(key) });
        }
        return list;
      }

      var dustSpriteCache = null;
      function dustSprite() {
        if (dustSpriteCache) return dustSpriteCache;
        var S = 96;
        var C = S / 2;
        var cv = document.createElement('canvas');
        cv.width = S;
        cv.height = S;
        var g = cv.getContext('2d');
        var grd = g.createRadialGradient(C, C, 0, C, C, C);
        grd.addColorStop(0, 'rgba(3,7,11,0.92)');
        grd.addColorStop(0.45, 'rgba(3,7,11,0.6)');
        grd.addColorStop(0.75, 'rgba(3,7,11,0.22)');
        grd.addColorStop(1, 'rgba(3,7,11,0)');
        g.fillStyle = grd;
        g.fillRect(0, 0, S, S);
        dustSpriteCache = cv;
        return cv;
      }

      var flareCache = {};
      /** 星芒贴图：不同颜色各缓存一张（运行时记忆金、项目档案紫、记忆空间青）。 */
      function flareSprite(rgb) {
        var key = String(rgb || '255,222,168');
        if (flareCache[key]) return flareCache[key];
        var S = 128;
        var C = S / 2;
        var cv = document.createElement('canvas');
        cv.width = S;
        cv.height = S;
        var g = cv.getContext('2d');
        // 十字星芒：长轴 + 短轴 + 淡淡斜向，像真星星被镜头拍出来的那四道光
        var rays = [
          [C, 0, C, S, 1],
          [0, C, S, C, 1],
          [C * 0.35, C * 0.35, C * 1.65, C * 1.65, 0.35],
          [C * 1.65, C * 0.35, C * 0.35, C * 1.65, 0.35],
        ];
        for (var r = 0; r < rays.length; r += 1) {
          var it = rays[r];
          var lg = g.createLinearGradient(it[0], it[1], it[2], it[3]);
          lg.addColorStop(0, 'rgba(' + key + ',0)');
          lg.addColorStop(0.4, 'rgba(' + key + ',' + 0.42 * it[4] + ')');
          lg.addColorStop(0.5, 'rgba(255,252,240,' + 0.92 * it[4] + ')');
          lg.addColorStop(0.6, 'rgba(' + key + ',' + 0.42 * it[4] + ')');
          lg.addColorStop(1, 'rgba(' + key + ',0)');
          g.strokeStyle = lg;
          g.lineWidth = 2.4;
          g.beginPath();
          g.moveTo(it[0], it[1]);
          g.lineTo(it[2], it[3]);
          g.stroke();
        }
        var core = g.createRadialGradient(C, C, 0, C, C, C * 0.34);
        core.addColorStop(0, 'rgba(255,255,255,1)');
        core.addColorStop(0.3, 'rgba(' + key + ',0.9)');
        core.addColorStop(1, 'rgba(' + key + ',0)');
        g.fillStyle = core;
        g.fillRect(0, 0, S, S);
        flareCache[key] = cv;
        return cv;
      }

      var starCache = {};
      function starSprite(rgb) {
        var key = 's:' + rgb;
        if (starCache[key]) return starCache[key];
        var S = 24;
        var C = S / 2;
        var cv = document.createElement('canvas');
        cv.width = S;
        cv.height = S;
        var g = cv.getContext('2d');
        var grd = g.createRadialGradient(C, C, 0, C, C, C);
        grd.addColorStop(0, 'rgba(255,255,255,1)');
        grd.addColorStop(0.34, 'rgba(255,255,255,0.92)');
        grd.addColorStop(0.4, 'rgba(' + rgb + ',0.85)');
        grd.addColorStop(0.6, 'rgba(' + rgb + ',0.3)');
        grd.addColorStop(1, 'rgba(' + rgb + ',0)');
        g.fillStyle = grd;
        g.fillRect(0, 0, S, S);
        starCache[key] = cv;
        return cv;
      }

      // 深色节点在暗底上几乎没有发光感，把颜色往白里提一点。
      function glow(hex, amount) {
        var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
        if (!m) return hex;
        var n = parseInt(m[1], 16);
        var k = amount === undefined ? 0.18 : amount;
        var mix = function (v) {
          return Math.round(v + (255 - v) * k);
        };
        return 'rgb(' + mix((n >> 16) & 255) + ',' + mix((n >> 8) & 255) + ',' + mix(n & 255) + ')';
      }

      var CAM_KEY = 'dsh-starmap:cam';
      var DEFAULT_CAM = {
        rotate: 0.72,
        pan: 0.9,
        zoom: 1.1,
        damping: 0.075,
        minDistance: 2,
        maxDistance: 20000,
        autoRotate: false,
        autoRotateSpeed: 0.35,
      };

      function loadCam() {
        var out = Object.assign({}, DEFAULT_CAM);
        try {
          var raw = JSON.parse(window.localStorage.getItem(CAM_KEY) || '{}');
          for (var k in out) {
            if (typeof raw[k] === typeof out[k]) out[k] = raw[k];
          }
        } catch (e) {
          /* 存的东西坏了就当没存过 */
        }
        return out;
      }

      function saveCam(cam) {
        try {
          window.localStorage.setItem(CAM_KEY, JSON.stringify(cam));
        } catch (e) {
          /* 隐私模式下写不进去，忽略 */
        }
      }

      function camRow(label, value, min, max, step, onChange) {
        var digits = step < 0.01 ? 3 : 2;
        return h('div', {
          className: 'sm-set-row',
          children: [
            h('span', { children: label }),
            h('input', {
              type: 'range',
              min: min,
              max: max,
              step: step,
              value: value,
              onInput: function (e) {
                onChange(Number(e.target.value));
              },
            }),
            h('span', { className: 'sm-set-val', children: Number(value).toFixed(digits) }),
          ],
        });
      }

      var miniTick = 0;
      /**
       * 小地图：俯视投影，把星团、恒星和当前视点位置画在一张小画布上。
       * 只用真实节点坐标，不画"视野框"——那个得反推相机视锥，反而容易骗人。
       */
      function paintMini(cv, nodes, target) {
        if (!cv || !nodes || !nodes.length) return;
        var g = cv.getContext('2d');
        var W = cv.width;
        var H = cv.height;
        var pad = 7;
        var minX = Infinity;
        var maxX = -Infinity;
        var minY = Infinity;
        var maxY = -Infinity;
        for (var i = 0; i < nodes.length; i += 1) {
          var n = nodes[i];
          if (!isFinite(n.x) || !isFinite(n.y)) continue;
          if (n.x < minX) minX = n.x;
          if (n.x > maxX) maxX = n.x;
          if (n.y < minY) minY = n.y;
          if (n.y > maxY) maxY = n.y;
        }
        if (!isFinite(minX) || maxX === minX || maxY === minY) return;
        var spanX = maxX - minX || 1;
        var spanY = maxY - minY || 1;
        var scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);
        var ox = (W - spanX * scale) / 2;
        var oy = (H - spanY * scale) / 2;
        var px = function (x) {
          return ox + (x - minX) * scale;
        };
        var py = function (y) {
          return oy + (y - minY) * scale;
        };

        g.clearRect(0, 0, W, H);
        g.fillStyle = 'rgba(5,9,20,0.55)';
        g.fillRect(0, 0, W, H);
        for (var j = 0; j < nodes.length; j += 1) {
          var m = nodes[j];
          if (!isFinite(m.x) || !isFinite(m.y)) continue;
          if (m.kind === 'dust') continue;
          if (m.kind === 'cluster') continue;
          g.beginPath();
          g.arc(px(m.x), py(m.y), m.kind === 'memory' ? 1.8 : 1.1, 0, Math.PI * 2);
          g.fillStyle = m.kind === 'memory' ? 'rgba(255,217,138,.9)' : 'rgba(150,180,240,.55)';
          g.fill();
        }
        for (var k = 0; k < nodes.length; k += 1) {
          var c = nodes[k];
          if (c.kind !== 'cluster') continue;
          g.beginPath();
          g.arc(px(c.x), py(c.y), 3, 0, Math.PI * 2);
          g.fillStyle = c.color || '#8fb6ff';
          g.globalAlpha = 0.95;
          g.fill();
          g.globalAlpha = 1;
        }
        if (target && isFinite(target.x) && isFinite(target.y)) {
          var tx = px(target.x);
          var ty = py(target.y);
          g.strokeStyle = 'rgba(180,215,255,.9)';
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(tx - 4, ty);
          g.lineTo(tx + 4, ty);
          g.moveTo(tx, ty - 4);
          g.lineTo(tx, ty + 4);
          g.stroke();
          g.beginPath();
          g.arc(tx, ty, 3.2, 0, Math.PI * 2);
          g.strokeStyle = 'rgba(180,215,255,.45)';
          g.stroke();
        }
      }

      /* --------------------------------------------------------- 面板 */

      function StarmapPanel() {
        var boxRef = useRef(null);
        var graphRef = useRef(null);
        var applyRef = useRef(null);
        var skyRef = useRef(null);
        var pointsRef = useRef(null);
        var labelRef = useRef(null);
        var miniRef = useRef(null);
        var [state, setState] = useState({ status: 'loading', data: null, error: '' });
        var [selected, setSelected] = useState(null);
        // 选中的那颗要一眼能认出来：绘制循环里给它套一圈星芒
        var selRef = useRef(null);
        selRef.current = selected;
        var [dust, setDust] = useState(true);
        var [query, setQuery] = useState('');
        var [timeT, setTimeT] = useState(1);
        var [view, setView] = useState({ totalStars: 0, visibleStars: 0, matched: 0, minC: 0, maxC: 0, cats: {} });
        var camInit = useState(loadCam);
        var cam = camInit[0];
        var setCamState = camInit[1];
        var camRef = useRef(cam);
        camRef.current = cam;
        var [settingsOpen, setSettingsOpen] = useState(false);
        // 主星系手动指定：''=自动（记忆最多那团）
        var [primaryId, setPrimaryId] = useState(function () {
          try {
            return window.localStorage.getItem('dsh-starmap.primary') || '';
          } catch (eP) {
            return '';
          }
        });
        useEffect(function () {
          primaryPickId = primaryId || '';
          try {
            if (primaryId) window.localStorage.setItem('dsh-starmap.primary', primaryId);
            else window.localStorage.removeItem('dsh-starmap.primary');
          } catch (eP) {
            /* 存不进去也能用，只是下次打开要重选 */
          }
        }, [primaryId]);
        var [cat, setCat] = useState('');
        var [fade, setFade] = useState(true);
        var [breathOn, setBreathOn] = useState(true);
        var breathRef = useRef(true);
        breathRef.current = breathOn;
        var hoverRef = useRef(null);
        // 三层公转的开关：恒星星团自转 / 行星绕恒星 / 卫星绕行星。
        // 存 ref 而不是 state，是因为动画循环每帧要读它，不该为它重渲染。
        var orbitRef = useRef({ star: true, planet: true, moon: true });
        // 复位视角：effect 里的 frameNow 挂在这里，按钮点一下就回到主星团跟前
        var frameRef = useRef(null);
        var [orbitOn, setOrbitOn] = useState({ star: true, planet: true, moon: true });
        var toggleOrbit = function (key) {
          var next = {
            star: orbitOn.star,
            planet: orbitOn.planet,
            moon: orbitOn.moon,
          };
          next[key] = !next[key];
          orbitRef.current = next;
          setOrbitOn(next);
        };

        // 把当前相机参数写进 OrbitControls（控制器可能晚于状态创建）
        var applyCam = function () {
          var g = graphRef.current;
          if (!g) return;
          var ctl = null;
          try {
            ctl = g.controls();
          } catch (e) {
            ctl = null;
          }
          if (!ctl) return;
          var c = camRef.current;
          ctl.enableDamping = c.damping > 0;
          ctl.dampingFactor = c.damping;
          ctl.rotateSpeed = c.rotate;
          ctl.zoomSpeed = c.zoom;
          ctl.panSpeed = c.pan;
          ctl.minDistance = c.minDistance;
          ctl.maxDistance = c.maxDistance;
          ctl.autoRotate = !!c.autoRotate;
          ctl.autoRotateSpeed = c.autoRotateSpeed;
        };

        var patchCam = function (patch) {
          var next = Object.assign({}, camRef.current, patch);
          camRef.current = next;
          setCamState(next);
          saveCam(next);
          applyCam();
        };

        // 渲染期就把最新筛选条件挂到 ref 上：重布局时不依赖闭包里的旧值。
        var filtersRef = useRef({ query: '', timeT: 1 });
        filtersRef.current = { query: query, timeT: timeT, cat: cat, fade: fade };

        var load = useCallback(
          function (refresh) {
            setState(function (prev) {
              return { status: 'loading', data: prev.data, error: '' };
            });
            var qs = [];
            if (refresh) qs.push('refresh=1');
            if (dust) qs.push('dust=1');
            var url = ROUTE + '/api/graph' + (qs.length ? '?' + qs.join('&') : '');
            return fetch(url, { credentials: 'same-origin' })
              .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
              })
              .then(function (data) {
                // 宿主半侧还是旧的「会话版」时，拿到的图没有 meta.memoryRoot，会画成一堆空壳星
                if (!data || !data.meta || !data.meta.memoryRoot) {
                  setState({
                    status: 'error',
                    data: null,
                    error: '宿主半侧还是旧版本（读的是会话）。重启一次 DSH 桌面端，它才会换成记忆数据源。',
                  });
                  return;
                }
                setState({ status: 'ready', data: data, error: '' });
              })
              .catch(function (err) {
                setState({ status: 'error', data: null, error: String((err && err.message) || err) });
              });
          },
          [dust],
        );

        useEffect(
          function () {
            load(false);
          },
          [load],
        );

        // 图只建一次（每次数据变化重建），筛选只换数据，不重建相机。
        useEffect(
          function () {
            if (state.status !== 'ready' || !state.data || !boxRef.current) return undefined;
            var box = boxRef.current;
            var data = state.data;
            var disposed = false;
            var graph = null;
            var fitSize = null;
            var settleTimers = [];
            var raf = 0;
            var repaint = null;
            var detachInput = null;
            // 公转骨架：布局在 applyView 里随筛选一起重建；三个时钟各走各的，
            // 关掉哪一层就只是那一层的时钟不再推进。
            var orbitLay = null;
            var clocks = { star: 0, planet: 0, moon: 0 };
            var clockPrev = 0;

            loadVendor()
              .then(function () {
                if (disposed) return;
                graph = window.ForceGraph3D()(box);
                graphRef.current = graph;

                var fit = function () {
                  var w = box.clientWidth || (box.parentElement && box.parentElement.clientWidth) || window.innerWidth;
                  var hh =
                    box.clientHeight ||
                    (box.parentElement && box.parentElement.clientHeight) ||
                    Math.max(360, window.innerHeight - 120);
                  if (w > 0 && hh > 0) graph.width(w).height(hh);
                  if (repaint) repaint();
                };
                fit();
                fitSize = fit;
                window.addEventListener('resize', fit);

                graph
                  .backgroundColor('rgba(0,0,0,0)')
                  .showNavInfo(false)
                  .nodeRelSize(3.2)
                  .nodeResolution(18)
                  .nodeVal(function (n) {
                    if (n.kind === 'cluster') return 30;
                    if (n.kind === 'dust') return 0.0001; // 尘埃只活在 2D 光点层，3D 球体缩到看不见
                    if (n.kind === 'memory') return 8 + (n.weight || 1) * 4;
                    return 4 + Math.log2(1 + (n.msgs || 0)) * 2.8;
                  })
                  // 球体只用来做拾取（点击/悬停命中），画面上由 2D 光点层负责发光
                  .nodeOpacity(0)
                  .nodeColor(function (n) {
                    if (n.kind === 'memory') return n.dim ? '#151b2c' : '#ffe0a0';
                    return n.dim ? '#151b2c' : glow(n.color, n.kind === 'cluster' ? 0.26 : 0.16);
                  })
                  // 悬停/选中都走 2D 投影（见下面的 pointermove / pointerup）：
                  // 3D 球体只拿来给画面占位，它的 raycast 在密集区选中的是
                  // 「离相机最近」的那颗，于是鼠标和选中位置对不上。
                  .onNodeHover(function () {
                    /* 由 onPickMove 接管 */
                  })
                  .nodeLabel(function (n) {
                    if (n.kind === 'cluster') return n.label + ' · ' + n.count + ' 条记忆';
                    // 尘埃只是氛围，没有名字：鼠标划过不出提示，避免满屏"未命名/子代理"
                    if (n.kind === 'dust') return '';
                    if (n.kind === 'memory') {
                      var preview = String(n.text || n.label || '').replace(/\s+/g, ' ');
                      return (n.label || '记忆') + '｜' + (preview.length > 90 ? preview.slice(0, 90) + '…' : preview);
                    }
                    return n.label;
                  })
                  .linkColor(function (l) {
                    if (l.kind === 'dust') return 'rgba(120,140,200,0.08)';
                    return l.kind === 'sequence' ? 'rgba(130,180,255,0.42)' : 'rgba(150,165,220,0.18)';
                  })
                  .linkWidth(function (l) {
                    return l.width || 0.6;
                  })
                  .linkDirectionalParticles(function (l) {
                    return l.kind === 'sequence' ? 2 : 0;
                  })
                  .linkDirectionalParticleWidth(0.5)
                  .linkDirectionalParticleSpeed(0.006)
                  .onNodeClick(function () {
                    /* 由 onPickUp 接管 */
                  })
                  .onBackgroundClick(function () {
                    /* 由 onPickUp 接管：空处点击才清选中 */
                  })
                  .d3AlphaDecay(0.022)
                  .d3VelocityDecay(0.28);
                // 手感对齐 Unity 场景视图：右键转视角、中键平移、滚轮朝光标推拉，
                // 左键只用来点选（Unity 里左键也是选择）。
                var enforceCtl = function () {
                  var ctl = null;
                  try {
                    ctl = graph.controls();
                  } catch (e) {
                    ctl = null;
                  }
                  if (!ctl) return;
                  try {
                    // 左键转视角、右键平移、中键拖星团 —— 跟大部分三维星图/模型查看器一致。
                    // 之前是左键平移右键转，左手那只「想转一转看看」的直觉每次都被按成拖动。
                    ctl.mouseButtons = { LEFT: 0, MIDDLE: null, RIGHT: 2 };
                  } catch (e) {
                    /* 老版本 OrbitControls 没有 mouseButtons */
                  }
                  try {
                    ctl.touches = { ONE: 0, TWO: 2 };
                  } catch (e) {
                    /* ignore */
                  }
                  ctl.enableDamping = camRef.current.damping > 0;
                  ctl.dampingFactor = camRef.current.damping;
                  ctl.rotateSpeed = camRef.current.rotate;
                  ctl.zoomSpeed = camRef.current.zoom;
                  ctl.panSpeed = camRef.current.pan;
                  ctl.screenSpacePanning = true;
                  // 缩放以屏幕中心为准：开着 zoomToCursor 时鼠标偏一点，
                  // 滚轮每转一格画面就跟着往那边漂，看久了头晕
                  ctl.zoomToCursor = false;
                  ctl.minDistance = camRef.current.minDistance;
                  ctl.maxDistance = camRef.current.maxDistance;
                  ctl.autoRotate = !!camRef.current.autoRotate;
                  ctl.autoRotateSpeed = camRef.current.autoRotateSpeed;
                  ctl.autoRotate = false;
                };
                enforceCtl();

                // 3d-force-graph 内层的 DragControls 我们够不着（外层是 Kapsule 包装），
                // 它默认 LEFT/MIDDLE/RIGHT 全都算「拖节点」，于是右键落在星团上就不旋转相机了。
                // 干脆把内置拖拽关掉，自己实现「中键拖节点」——左键平移、右键旋转全归相机。
                graph.enableNodeDrag(false);

                var dragNode = null;
                var dragStart = null;
                var screenOf = function (n) {
                  try {
                    return graph.graph2ScreenCoords(n.x || 0, n.y || 0, n.z || 0);
                  } catch (e) {
                    return null;
                  }
                };
                var hitNode = function (lx, ly) {
                  var best = null;
                  var bestD = Infinity;
                  var nodes = graph.graphData().nodes;
                  for (var i = 0; i < nodes.length; i += 1) {
                    var n = nodes[i];
                    if (n.kind === 'dust') continue;
                    var p = screenOf(n);
                    if (!p) continue;
                    var dxh = p.x - lx;
                    var dyh = p.y - ly;
                    var d = Math.sqrt(dxh * dxh + dyh * dyh);
                    // 恒星亮核大、卫星只是个小点，用同一个阈值就会「点这颗选中那颗」
                    var lim = n.kind === 'cluster' ? 52 : n.kind === 'star' ? 28 : n.kind === 'moon' ? 10 : 16;
                    if (d <= lim && d < bestD) {
                      bestD = d;
                      best = n;
                    }
                  }
                  return best;
                };
                var onDragDown = function (e) {
                  if (!e || e.button !== 1 || dragNode) return;
                  var rect = box.getBoundingClientRect();
                  var hit = hitNode(e.clientX - rect.left, e.clientY - rect.top);
                  if (!hit) return;
                  dragNode = hit;
                  dragStart = { x: e.clientX, y: e.clientY, fx: hit.x || 0, fy: hit.y || 0, fz: hit.z || 0 };
                  try {
                    e.preventDefault();
                  } catch (err) {
                    /* ignore */
                  }
                };
                var onDragMove = function (e) {
                  if (!dragNode || !dragStart) return;
                  var cam = graph.camera();
                  if (!cam) return;
                  var V = cam.position.constructor;
                  var nodePos = new V(dragStart.fx, dragStart.fy, dragStart.fz);
                  var dist = cam.position.distanceTo(nodePos) || 1;
                  var h = box.clientHeight || window.innerHeight || 600;
                  var wpp = (2 * Math.tan(((cam.fov || 55) * Math.PI) / 360) * dist) / h;
                  var fwd = cam.getWorldDirection(new V(0, 0, 0));
                  // 右 = 前 × 上（上×前会得到反方向，之前就是这么把左右拖反的）
                  var right = new V().crossVectors(fwd, cam.up).normalize();
                  var upv = new V().crossVectors(right, fwd).normalize();
                  if (!isFinite(wpp) || wpp <= 0) return;
                  var dx = (e.clientX - dragStart.x) * wpp;
                  var dy = (e.clientY - dragStart.y) * wpp;
                  // fx/fy/fz 一钉，力导向就不会把节点弹回去
                  dragNode.fx = dragStart.fx + right.x * dx - upv.x * dy;
                  dragNode.fy = dragStart.fy + right.y * dx - upv.y * dy;
                  dragNode.fz = dragStart.fz + right.z * dx - upv.z * dy;
                  dragNode.x = dragNode.fx;
                  dragNode.y = dragNode.fy;
                  dragNode.z = dragNode.fz;
                };
                var onDragUp = function () {
                  if (!dragNode) return;
                  dragNode.fx = undefined;
                  dragNode.fy = undefined;
                  dragNode.fz = undefined;
                  dragNode = null;
                  dragStart = null;
                };
                box.addEventListener('pointerdown', onDragDown, true);
                window.addEventListener('pointermove', onDragMove, true);
                window.addEventListener('pointerup', onDragUp, true);

                // 选中和悬停都按 2D 光点层的投影算：所有可见光点都写着自己的屏幕坐标，
                // 谁离鼠标最近就是谁，点击位置和选中位置天然一致。
                var pickDown = null;
                var onPickDown = function (e) {
                  if (!e || e.button !== 0) return;
                  pickDown = { x: e.clientX, y: e.clientY };
                };
                var onPickUp = function (e) {
                  if (!e || e.button !== 0 || !pickDown) return;
                  var ddx = e.clientX - pickDown.x;
                  var ddy = e.clientY - pickDown.y;
                  pickDown = null;
                  // 左键还兼着平移，拖动超过 6px 就不算点选
                  if (Math.sqrt(ddx * ddx + ddy * ddy) > 6) return;
                  var rc = box.getBoundingClientRect();
                  var picked = hitNode(e.clientX - rc.left, e.clientY - rc.top);
                  setSelected(picked && picked.kind !== 'dust' ? picked : null);
                };
                var hoverTick = 0;
                var onPickMove = function (e) {
                  var nowT = Date.now();
                  if (nowT - hoverTick < 60) return;
                  hoverTick = nowT;
                  var rc2 = box.getBoundingClientRect();
                  var over = hitNode(e.clientX - rc2.left, e.clientY - rc2.top);
                  hoverRef.current = over ? over.id : null;
                  box.style.cursor = over ? 'pointer' : '';
                };
                // 右键现在归相机平移用，浏览器自己的右键菜单得按住
                var onCtxMenu = function (e) {
                  if (e && e.preventDefault) e.preventDefault();
                  return false;
                };
                box.addEventListener('contextmenu', onCtxMenu);

                box.addEventListener('pointerdown', onPickDown, true);
                window.addEventListener('pointerup', onPickUp, true);
                window.addEventListener('pointermove', onPickMove, true);

                // 两件小事交给一个自定义力：
                // 坐标全由公转时钟给：力导向整段卸掉，simulation 冷下来。
                // 力学算出来的位移每帧都会被覆盖，留着只是白烧 CPU，还会让星点抖一下。
                graph.d3Force('fineTune', null);
                graph.d3Force('cluster', null);
                graph.d3Force('charge', null);
                graph.d3Force('link', null);
                var controls = graph.controls();
                if (controls) {
                  // 镜头不自动绕圈：星体自己就在转，镜头再转会把盘面转到侧视，整片星系压成一条线
                  controls.autoRotate = false;
                  controls.autoRotateSpeed = 0;
                }
                // 力都用不上（位置是我们自己算的），别让引擎空转 15 秒才吐出 onEngineStop
                try {
                  graph.cooldownTicks(40);
                  graph.cooldownTime(700);
                } catch (e) {
                  /* 老版本没有这两个开关 */
                }

                // 首帧就把相机摆到主星团跟前。以前等 onEngineStop 再搬，
                // 画面先按默认机位画一帧，「一打开镜头跳一下」就是这么来的。
                var frameNow = function () {
                  if (!orbitLay) return;
                  var pc = pickPrimary((data && data.clusters) || []);
                  if (!pc) return;
                  var ctr = (orbitLay.centers || {})[pc.id] || { x: 0, y: 0, z: 0 };
                  var rr = (orbitLay.radii || {})[pc.id] || 260;
                  var dist = Math.max(430, rr * 2.75);
                  try {
                    var cam = graph.camera();
                    if (!cam) return;
                    // 俯角 0.5 / 0.87：正对盘面只是一张平面星图，压太狠又看不见旋涡
                    cam.position.set(ctr.x, ctr.y + dist * 0.5, dist * 0.87);
                    var ct = graph.controls();
                    if (ct) {
                      ct.target.set(ctr.x, ctr.y, 0);
                      ct.update();
                    }
                    cam.lookAt(ctr.x, ctr.y, 0);
                  } catch (e) {
                    /* 相机还没就绪：下一帧再说 */
                  }
                };

                frameRef.current = frameNow;

                // 唯一的数据入口：时间轴 + 搜索在这里合成一份 keep 判定。
                var applyView = function () {
                  if (disposed) return;
                  var built = buildView(data, filtersRef.current);
                  // 筛选变了等于星体集合变了，轨道得跟着重排；坐标也先按当前时钟摆好，
                  // 不然新节点会从上一个位置「飞」过来。
                  orbitLay = buildOrbitLayout(built.nodes);
                  var pos0 = applyOrbit(orbitLay, clocks);
                  for (var pi0 = 0; pi0 < built.nodes.length; pi0 += 1) {
                    var np0 = built.nodes[pi0];
                    var pp0 = pos0[np0.id];
                    if (!pp0) continue;
                    np0.x = pp0.x;
                    np0.y = pp0.y;
                    np0.z = pp0.z;
                    np0.vx = 0;
                    np0.vy = 0;
                    np0.vz = 0;
                  }
                  graph.graphData({ nodes: built.nodes, links: built.links });
                  // 第一次出图就把机位钉好；之后筛选变化不再动镜头
                  if (!framed) {
                    framed = true;
                    frameNow();
                  }
                  setView({
                    totalStars: built.totalStars,
                    visibleStars: built.visibleStars,
                    matched: built.matched,
                    minC: built.minC,
                    maxC: built.maxC,
                    cats: built.cats,
                  });
                  return built;
                };
                applyRef.current = applyView;
                applyView();

                // 天穹按容器尺寸生成；星点用一层 2D canvas 画，3D 球体本身全部透明。
                paintSky(skyRef.current, box.clientWidth, box.clientHeight || 600);
                var pcv = pointsRef.current;
                var pctx = pcv ? pcv.getContext('2d') : null;
                // 光点层是满屏 canvas，DPR 封在 1.25：再高只是白烧 GPU（光晕本来就模糊）
                var dpr = Math.min(1.25, window.devicePixelRatio || 1);
                var sizePoints = function () {
                  if (!pcv) return;
                  var w = box.clientWidth || 1;
                  var hgt = box.clientHeight || 1;
                  var cw = Math.max(1, Math.round(w * dpr));
                  var ch = Math.max(1, Math.round(hgt * dpr));
                  if (pcv.width !== cw || pcv.height !== ch) {
                    pcv.width = cw;
                    pcv.height = ch;
                    pcv.style.width = w + 'px';
                    pcv.style.height = hgt + 'px';
                  }
                  if (pctx) pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                };
                sizePoints();
                repaint = function () {
                  paintSky(skyRef.current, box.clientWidth || 800, box.clientHeight || 600);
                  sizePoints();
                };
                var labelEls = [];
                var lastDraw = 0;
                var streams = [];
                var streamKey = '';
                var syncLabels = function (ts) {
                  // 30fps 封顶 + 页面不在前台就整个跳过：满屏 canvas 每帧重画很吃 GPU
                  var now = ts || 0;
                  if (document.hidden || (now && lastDraw && now - lastDraw < 32)) {
                    raf = window.requestAnimationFrame(syncLabels);
                    return;
                  }
                  lastDraw = now;
                  var host = labelRef.current;
                  if (disposed || !graph) return;
                  var all = graph.graphData().nodes;
                  // 公转：把三个时钟往前推，然后照新时钟重新摆一遍坐标。
                  // dt 封在 100ms 以内 —— 切标签页回来时不要让天体一下跳到别处。
                  var tick = now || (window.performance && window.performance.now ? window.performance.now() : Date.now());
                  // 相机拉到很远时，卫星这一层已经小到看不见了：那就别再推进它的时钟，
                  // 省下的就是省下的。行星照转 —— 那是这张图的主角，远近都得转。
                  var camD = 0;
                  try {
                    var cpos = graph.camera().position;
                    camD = Math.sqrt(cpos.x * cpos.x + cpos.y * cpos.y + cpos.z * cpos.z);
                  } catch (e) {
                    camD = 0;
                  }
                  var farR = 260;
                  if (orbitLay) {
                    var fpc = pickPrimary(data.clusters || []);
                    farR = (fpc && orbitLay.radii[fpc.id]) || 260;
                  }
                  var farLod = camD > farR * 2.4;
                  if (clockPrev) {
                    var dt = Math.min(100, Math.max(0, tick - clockPrev));
                    var on = orbitRef.current || {};
                    if (on.star !== false) clocks.star += dt;
                    if (on.planet !== false) clocks.planet += dt;
                    if (on.moon !== false && !farLod) clocks.moon += dt;
                  }
                  clockPrev = tick;
                  if (orbitLay) {
                    var posNow = applyOrbit(orbitLay, clocks);
                    for (var pi1 = 0; pi1 < all.length; pi1 += 1) {
                      var np1 = all[pi1];
                      var pp1 = posNow[np1.id];
                      if (!pp1) continue;
                      np1.x = pp1.x;
                      np1.y = pp1.y;
                      np1.z = pp1.z;
                      np1.vx = 0;
                      np1.vy = 0;
                      np1.vz = 0;
                    }
                  }
                  // 悬停高亮：鼠标停在哪颗星上，就点亮它和它的邻居，其余压暗
                  var hi = hoverRef.current;
                  var hiSet = null;
                  if (hi) {
                    hiSet = {};
                    hiSet[hi] = 1;
                    var lks = graph.graphData().links || [];
                    for (var li = 0; li < lks.length; li += 1) {
                      var lk = lks[li];
                      var sId = lk.source && lk.source.id ? lk.source.id : lk.source;
                      var tId = lk.target && lk.target.id ? lk.target.id : lk.target;
                      if (sId === hi) hiSet[tId] = 1;
                      else if (tId === hi) hiSet[sId] = 1;
                    }
                  }
                  // 小地图每 6 帧刷一次就够了
                  miniTick += 1;
                  if (miniTick % 6 === 0 && miniRef.current) {
                    var tgt = null;
                    try {
                      tgt = graph.controls().target;
                    } catch (e) {
                      tgt = null;
                    }
                    paintMini(miniRef.current, all, tgt);
                  }
                  // 星尘流：只连各团最近的邻居；星团集合变了才重建
                  var clKey = '';
                  for (var ck = 0; ck < all.length; ck += 1) {
                    if (all[ck].kind === 'cluster') clKey += all[ck].id + ',';
                  }
                  if (clKey !== streamKey) {
                    streamKey = clKey;
                    var clList = [];
                    for (var ck2 = 0; ck2 < all.length; ck2 += 1) {
                      if (all[ck2].kind === 'cluster') clList.push(all[ck2]);
                    }
                    streams = buildStreams(clList);
                  }
                  if (pctx) {
                    pctx.clearRect(0, 0, pcv.width, pcv.height);
                    drawSkybox(skyRef.current, pcv.width, pcv.height, graph);
                    var t = now || Date.now();
                    // 主星系 = 主人指定的工作区（现在固定在原点，画得更大更细）
                    var clNodes = [];
                    for (var pc = 0; pc < all.length; pc += 1) {
                      if (all[pc].kind === 'cluster') clNodes.push(all[pc]);
                    }
                    // 画家算法：远的先画、近的后画，否则几个星系叠在一起就是一团色块
                    try {
                      var camSort = graph.camera().position;
                      clNodes.sort(function (a, b) {
                        var da = Math.pow((a.x || 0) - camSort.x, 2) + Math.pow((a.y || 0) - camSort.y, 2) + Math.pow((a.z || 0) - camSort.z, 2);
                        var db = Math.pow((b.x || 0) - camSort.x, 2) + Math.pow((b.y || 0) - camSort.y, 2) + Math.pow((b.z || 0) - camSort.z, 2);
                        return db - da;
                      });
                    } catch (e) {
                      /* 排序失败就按原顺序 */
                    }
                    var cloudFor = function (cc) {
                      var rr = (orbitLay && orbitLay.radii[cc.id]) || 0;
                      var key = cc.id + '@' + Math.round(rr / 8);
                      var cld = galaxyCache[key];
                      if (!cld) {
                        try {
                          cld = buildGalaxyCloud(cc.id, cc.color, cc.id === primaryId, rr);
                          galaxyCache[key] = cld;
                        } catch (e) {
                          return null;
                        }
                      }
                      return cld;
                    };
                    if (gpuState.enabled && gpuState.THREE) gpuSync(graph, clNodes, cloudFor, t / 1000);
                    var prim = pickPrimary(clNodes);
                    var primaryId = prim ? prim.id : '';
                    // 先铺星系：每个星团就是一团小旋涡星系，旋臂慢慢自转
                    pctx.globalCompositeOperation = 'source-over';
                    for (var cq = 0; cq < clNodes.length; cq += 1) {
                      var cl = clNodes[cq];
                      var cp = null;
                      try {
                        cp = graph.graph2ScreenCoords(cl.x || 0, cl.y || 0, cl.z || 0);
                      } catch (e) {
                        cp = null;
                      }
                      if (!cp || !isFinite(cp.x) || !isFinite(cp.y)) continue;
                      var edge = null;
                      try {
                        edge = graph.graph2ScreenCoords((cl.x || 0) + 12, cl.y || 0, cl.z || 0);
                      } catch (e) {
                        edge = null;
                      }
                      var rad = edge && isFinite(edge.x) ? Math.abs(edge.x - cp.x) : 30;
                      var unit = rad / 12; // 每世界单位多少屏幕像素
                      if (!isFinite(unit) || unit <= 0) continue;
                      var celR = (orbitLay && orbitLay.radii[cl.id]) || 0;
                      var celKey = cl.id + '@' + Math.round(celR / 8);
                      var cloud = galaxyCache[celKey];
                      if (!cloud) {
                        cloud = buildGalaxyCloud(cl.id, cl.color, cl.id === primaryId, celR);
                        galaxyCache[celKey] = cloud;
                      }
                      // 还没有记忆的工作区：不画星云，只留一个很淡的虚线圈。
                      // 否则一团没有星星、也没名字的雾飘在那儿，看着像画错了。
                      if ((cl.count || 0) === 0) {
                        var emptyR = celR * unit * 1.02;
                        if (isFinite(emptyR) && emptyR > 6 && emptyR < 6000) {
                          pctx.save();
                          pctx.globalAlpha = 0.3;
                          pctx.strokeStyle = 'rgba(' + rgbOf(cl.color) + ',0.55)';
                          pctx.lineWidth = 1.1;
                          pctx.setLineDash([5, 9]);
                          pctx.beginPath();
                          pctx.arc(cp.x, cp.y, emptyR, 0, TAU);
                          pctx.stroke();
                          pctx.restore();
                          // 一颗暗红的小核：这里还没记忆，但也是个已经开张的坑
                          var coreSz = Math.max(6, emptyR * 0.16);
                          pctx.globalAlpha = 0.5;
                          pctx.drawImage(puffSprite('150,44,58'), cp.x - coreSz, cp.y - coreSz, coreSz * 2, coreSz * 2);
                          pctx.globalAlpha = 0.75;
                          pctx.fillStyle = 'rgba(198,78,90,0.9)';
                          pctx.beginPath();
                          pctx.arc(cp.x, cp.y, Math.max(1.4, coreSz * 0.17), 0, TAU);
                          pctx.fill();
                          pctx.globalAlpha = 1;
                        }
                        continue;
                      }
                      // 呼吸：近期活跃的星团脉动得明显，闲置的几乎不动
                      var ageDays = cl.lastAt ? (Date.now() - cl.lastAt) / 86400000 : 999;
                      var act = Math.max(0, Math.min(1, 1 - ageDays / 10));
                      var breath = breathRef.current
                        ? 1 + 0.055 * act * Math.sin(t * (0.0009 + act * 0.0017) + (hashStr(cl.id) % 628) / 100)
                        : 1;
                      // 星团自己慢慢转；旋臂雾和恒星层共用同一个钟，才会贴着恒星走
                      var hazeSeed = ((hashStr(cl.id) % 100) / 100) * TAU;
                      var spin = (t / 1000) * 0.008 + hazeSeed;
                      var spinArm = (clocks.star / 1000) * STAR_OMEGA + hazeSeed;
                      var cs = Math.cos(spin);
                      var sn = Math.sin(spin);
                      var dimmed = !!cl.dim;
                      var cx0 = cl.x || 0;
                      var cy0 = cl.y || 0;
                      var cz0 = cl.z || 0;
                      // 侧视补光：盘面越侧着，雾就越亮、越厚，避免塌成一条暗线
                      var edgeBoost = 1;
                      try {
                        var camPe = graph.camera().position;
                        var ex = cx0 - camPe.x;
                        var ey = cy0 - camPe.y;
                        var ez = cz0 - camPe.z;
                        var elen = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1;
                        var nrm = cloud.normal || { x: 0, y: 0, z: 1 };
                        var dotv = Math.abs((nrm.x * ex + nrm.y * ey + nrm.z * ez) / elen);
                        edgeBoost = 1 + (1 - dotv) * 0.45;
                      } catch (e) {
                        edgeBoost = 1;
                      }
                      // 贴太近的时候，雾要退场：不然滚一格轮就成了满屏白光
                      var fogFade = Math.min(1, Math.max(0, 1 - (unit - 3) / 5));
                      // 离得越近雾越淡：不然怼到脸上就是一片白粉，什么都看不出来
                      var nearDim = 1 / (1 + Math.max(0, unit - 3) * 0.95);
                      // 雾：一团团柔和的光斑，按距离缩放，近处自然是清楚的
                      var puffScale = (dimmed ? 0.55 : 1) * edgeBoost;
                      // 打底：整团染上本星团自己的颜色，否则那么多白雾叠起来就全白了
                      var haloR = (orbitLay && orbitLay.radii[cl.id]) || 150;
                      var halo = Math.min(5200, Math.max(90, haloR * 1.45 * unit * breath));
                      var haloFade = Math.max(0, 1 - Math.max(0, unit - 4.5) / 5);
                      if (isFinite(halo) && halo > 4 && halo < 9000 && haloFade > 0) {
                        pctx.globalAlpha = Math.min(0.16, (dimmed ? 0.014 : 0.022) * (0.6 + act * 0.5) * edgeBoost) * nearDim * haloFade;
                        pctx.drawImage(puffSprite(dimmed ? '42,54,88' : rgbOf(cl.color)), cp.x - halo / 2, cp.y - halo / 2, halo, halo);
                      }
                      // 旋臂雾：只贴旋臂走的一层淡光，跟恒星一起转
                      if (cloud.haze && cloud.haze.length) {
                        var hca = Math.cos(spinArm);
                        var hsa = Math.sin(spinArm);
                        var hzA = (dimmed ? 0.06 : 1) * fogFade * (0.55 + act * 0.6) * nearDim;
                        pctx.globalCompositeOperation = 'lighter';
                        for (var hq = 0; hq < cloud.haze.length; hq += 1) {
                          var h0 = cloud.haze[hq];
                          var hx = cx0 + (h0.x * hca - h0.y * hsa);
                          var hy = cy0 + (h0.x * hsa + h0.y * hca);
                          var hsp = null;
                          try {
                            hsp = graph.graph2ScreenCoords(hx, hy, cz0 + h0.z);
                          } catch (e) {
                            hsp = null;
                          }
                          if (!hsp || !isFinite(hsp.x) || !isFinite(hsp.y)) continue;
                          var hsz = h0.r * unit * 3.2 * breath;
                          if (!isFinite(hsz) || hsz < 1.5 || hsz > 300) continue;
                          pctx.globalAlpha = h0.a * hzA;
                          pctx.drawImage(puffSprite(String(h0.c).charAt(0) === '#' ? rgbOf(h0.c) : h0.c), hsp.x - hsz, hsp.y - hsz, hsz * 2, hsz * 2);
                        }
                        pctx.globalCompositeOperation = 'source-over';
                      }
                      // 两遍：先铺光，再铺暗尘——暗尘后画才能"挡住"光，压出层次
                      for (var pass = 0; pass < 2 && !(gpuState.enabled && gpuState.THREE); pass += 1) {
                        for (var pf = 0; pf < cloud.puffs.length; pf += 1) {
                          var pp0 = cloud.puffs[pf];
                          if (!!pp0.dark !== (pass === 1)) continue;
                          // 缓慢流动：每个气团按自己的相位轻轻挪，整片雾看着像在漂
                          var fbx = Math.sin(t * 0.00042 + pp0.z * 0.7) * 2.4;
                          var fby = Math.cos(t * 0.00037 + pp0.x * 0.5) * 2.1;
                          var wx = (pp0.x + fbx) * cs - (pp0.y + fby) * sn;
                          var wy = (pp0.x + fbx) * sn + (pp0.y + fby) * cs;
                          var sp = null;
                          try {
                            sp = graph.graph2ScreenCoords(cx0 + wx, cy0 + wy, cz0 + pp0.z);
                          } catch (e) {
                            sp = null;
                          }
                          if (!sp || !isFinite(sp.x) || !isFinite(sp.y)) continue;
                          // 大团的云团也要跟着放大：只加粒子数不加尺寸，远看就是一层灰蒙蒙的噪点
                          var sizeScale = Math.pow(Math.max(1, haloR / 72), 0.3);
                          var dsz = pp0.r * unit * 3.6 * breath * sizeScale;
                          if (!isFinite(dsz) || dsz < 2) continue;
                          // 近看时气团会被放大到铺满整屏，几千个叠起来就是一层白幕；
                          // 超过这个尺寸就不画了 —— 靠近了本来就该看星星，不是看雾
                          if (dsz > 300) continue;
                          pctx.globalAlpha = pp0.dark
                            ? (dimmed ? 0.06 : 0.2) * pp0.a * fogFade
                            : (dimmed ? 0.035 : 0.27) * pp0.a * puffScale * fogFade * nearDim;
                          pctx.drawImage(
                            pp0.dark
                              ? dustSprite()
                              : puffSprite(dimmed ? '42,54,88' : String(pp0.c).charAt(0) === '#' ? rgbOf(pp0.c) : pp0.c),
                            sp.x - dsz / 2,
                            sp.y - dsz / 2,
                            dsz,
                            dsz,
                          );
                        }
                      }
                      // 银心：每个星团中心一团很亮的核心，越靠近越亮
                      var coreR = Math.max(6, Math.min(320, unit * (14 + haloR * 0.16) * breath));
                      if (isFinite(coreR) && coreR > 2) {
                        var cg = pctx.createRadialGradient(cp.x, cp.y, 0, cp.x, cp.y, coreR);
                        var cgA = dimmed ? 0.08 : 0.24;
                        cg.addColorStop(0, 'rgba(255,252,240,' + cgA + ')');
                        cg.addColorStop(0.16, 'rgba(255,240,210,' + (0.34 * cgA) + ')');
                        cg.addColorStop(0.45, 'rgba(255,225,180,' + (0.12 * cgA) + ')');
                        cg.addColorStop(0.6, 'rgba(' + rgbOf(cl.color) + ',' + (0.2 * cgA) + ')');
                        cg.addColorStop(1, 'rgba(' + rgbOf(cl.color) + ',0)');
                        pctx.globalCompositeOperation = 'lighter';
                        pctx.globalAlpha = 1;
                        pctx.fillStyle = cg;
                        pctx.beginPath();
                        pctx.arc(cp.x, cp.y, coreR, 0, Math.PI * 2);
                        pctx.fill();
                      }
                      // 星：真正的点，随缩放变大变小，所以近处锐、远处糊
                      pctx.globalCompositeOperation = 'lighter';
                      for (var st = 0; st < cloud.stars.length; st += 1) {
                        var q0 = cloud.stars[st];
                        // 差速自转：内侧转得快、外侧转得慢，每颗星还有自己的相位
                        var uw = q0.u === undefined ? 0.6 : q0.u;
                        var wob = 0.24 * Math.sin(t * (0.0016 / (0.35 + uw * 1.3)) + (q0.ph || 0));
                        var w2 = wob * wob;
                        var bx2 = q0.x * cs - q0.y * sn;
                        var by2 = q0.x * sn + q0.y * cs;
                        var sx = bx2 * (1 - w2 * 0.5) - by2 * wob;
                        var sy = bx2 * wob + by2 * (1 - w2 * 0.5);
                        var sp2 = null;
                        try {
                          sp2 = graph.graph2ScreenCoords(cx0 + sx, cy0 + sy, cz0 + q0.z);
                        } catch (e) {
                          sp2 = null;
                        }
                        if (!sp2 || !isFinite(sp2.x) || !isFinite(sp2.y)) continue;
                        var near = Math.min(1, unit / 3.2); // 越近，星点越亮越锐
                        var dsz2 = Math.max(1.2, q0.s * unit * (0.34 + near * 0.28));
                        pctx.globalAlpha = (dimmed ? 0.04 : 0.06 + near * 0.15) * (0.6 + q0.s * 0.4);
                        pctx.drawImage(starSprite(dimmed ? '60,72,104' : q0.c), sp2.x - dsz2 / 2, sp2.y - dsz2 / 2, dsz2, dsz2);
                        // 最亮的那一小撮加十字星芒（像大口径望远镜拍出来的衍射十字）
                        if (!dimmed && q0.s > 1.02) {
                          var fls = dsz2 * 5.5;
                          pctx.globalAlpha = 0.22 * Math.min(1, q0.s - 0.9);
                          pctx.drawImage(flareSprite(), sp2.x - fls / 2, sp2.y - fls / 2, fls, fls);
                        }
                      }
                      pctx.globalCompositeOperation = 'source-over';
                    }
                    // 星团之间飘的星尘
                    pctx.globalCompositeOperation = 'lighter';
                    for (var sk = 0; sk < streams.length; sk += 1) {
                      var stm = streams[sk];
                      var ax = stm.a.x || 0;
                      var ay = stm.a.y || 0;
                      var az = stm.a.z || 0;
                      var bx2 = stm.b.x || 0;
                      var by2 = stm.b.y || 0;
                      var bz2 = stm.b.z || 0;
                      for (var pi = 0; pi < stm.n; pi += 1) {
                        var pr = ((t * 0.00006 + pi / stm.n + (stm.seed % 100) / 100) % 1 + 1) % 1;
                        var bulge = Math.sin(pr * Math.PI) * 14;
                        var px2 = ax + (bx2 - ax) * pr;
                        var py2 = ay + (by2 - ay) * pr + bulge;
                        var pz2 = az + (bz2 - az) * pr;
                        var spp = null;
                        try {
                          spp = graph.graph2ScreenCoords(px2, py2, pz2);
                        } catch (e) {
                          spp = null;
                        }
                        if (!spp || !isFinite(spp.x) || !isFinite(spp.y)) continue;
                        var fade = Math.sin(pr * Math.PI);
                        pctx.globalAlpha = 0.2 * fade;
                        var ssz = 7 + fade * 4;
                        pctx.drawImage(puffSprite('188,214,255'), spp.x - ssz / 2, spp.y - ssz / 2, ssz, ssz);
                      }
                    }
                    pctx.globalCompositeOperation = 'source-over';
                    // 再铺恒星与尘埃：加法混合，越叠越亮
                    pctx.globalCompositeOperation = 'lighter';
                    // 相机每帧只取一次（原来每颗都 graph.camera()，几百次没必要）
                    var camP = null;
                    try {
                      var camNow = graph.camera();
                      camP = camNow && camNow.position ? camNow.position : null;
                    } catch (e) {
                      camP = null;
                    }
                    /**
                     * 视角远近 → 光点大小：拉近变大、拉远变小。
                     * 260 是「刚好把整张星图塞进画面」的取景距离，zf=1 就定在那儿；
                     * 再近会放大到 3 倍左右，拉远则缩到三分之一。
                     */
                    var zoomAt = function (nd) {
                      if (!camP) return 1;
                      var zdx = camP.x - (nd.x || 0);
                      var zdy = camP.y - (nd.y || 0);
                      var zdz = camP.z - (nd.z || 0);
                      var zdist = Math.sqrt(zdx * zdx + zdy * zdy + zdz * zdz);
                      if (!isFinite(zdist) || zdist <= 1) return 1.4;
                      return Math.min(3, Math.max(0.22, (zoomBase || 260) / zdist));
                    };
                    // 名字留到最后统一画：这样能压住互相重叠的那些，不会糊成一片
                    var labels = [];
                    // 景深分级：相机离得越远，越小的天体越先省掉。
                    // lod 0 = 全画；1 = 卫星不画；2 = 卫星不画 + 行星收一点，但名字照留（认路要靠它）。
                    var camDist = 0;
                    if (camP) camDist = Math.sqrt(camP.x * camP.x + camP.y * camP.y + camP.z * camP.z);
                    // 星团越大镜头自然越远：阈值跟着主星团半径走，不然大团永远停在「远景」档
                    var baseR = 260;
                    if (orbitLay) {
                      var pbase = pickPrimary(data.clusters || []);
                      baseR = (pbase && orbitLay.radii[pbase.id]) || 260;
                    }
                    var zoomBase = baseR * 1.6;
                    var lod = camDist > baseR * 4.6 ? 2 : camDist > baseR * 2.4 ? 1 : 0;
                    // 装饰星：不属于任何记忆，只把旋臂铺满；拾取时会被跳过，点它没有反应
                    var decoList = (orbitLay && orbitLay.decoPos) || [];
                    if (decoList.length) {
                      for (var dk = 0; dk < decoList.length; dk += 1) {
                        var dq2 = decoList[dk];
                        var dp2 = null;
                        try {
                          dp2 = graph.graph2ScreenCoords(dq2.x, dq2.y, dq2.z);
                        } catch (e) {
                          dp2 = null;
                        }
                        if (!dp2 || !isFinite(dp2.x) || !isFinite(dp2.y)) continue;
                        var dzf = zoomAt(dq2);
                        var dtw = 0.55 + 0.45 * Math.sin(t * 0.0011 + dq2.ph);
                        pctx.globalAlpha = 0.1 + 0.26 * dtw;
                        pctx.fillStyle = '#c8dcff';
                        pctx.beginPath();
                        pctx.arc(dp2.x, dp2.y, Math.max(0.35, dq2.s * dzf * 0.75), 0, TAU);
                        pctx.fill();
                      }
                      pctx.globalAlpha = 1;
                    }
                    for (var q = 0; q < all.length; q += 1) {
                      var nd2 = all[q];
                      if (nd2.kind === 'cluster') continue;
                      var pp = null;
                      try {
                        pp = graph.graph2ScreenCoords(nd2.x || 0, nd2.y || 0, nd2.z || 0);
                      } catch (e) {
                        pp = null;
                      }
                      if (!pp || !isFinite(pp.x) || !isFinite(pp.y)) continue;
                      var zf = zoomAt(nd2);
                      // 近了以后星点会放大；几十个放大的光斑叠在一起就是一片白，所以同步压亮度
                      var nearA = 1 / (1 + Math.max(0, zf - 1.4) * 1.4);
                      if (nd2.kind === 'moon') {
                        // 卫星：贴着行星的一小粒，拉远就不画了
                        if (lod >= 1) continue;
                        var mSz = Math.max(1.4, Math.min(9, 2.4 * zf));
                        var mHiW = hiSet && !hiSet[nd2.id] ? 0.18 : 1;
                        var mTint = nd2.dim ? '#28304a' : '#9fb4d8';
                        pctx.globalAlpha = (nd2.dim ? 0.12 : 0.5) * mHiW;
                        pctx.drawImage(spriteFor(mTint), pp.x - mSz, pp.y - mSz, mSz * 2, mSz * 2);
                        continue;
                      }
                      if (nd2.kind === 'star') {
                        // 恒星：一颗对话就是一颗太阳，带一圈自己星团的颜色
                        var sW = typeof nd2.weight === 'number' ? nd2.weight : 2;
                        var sHiW = hiSet && !hiSet[nd2.id] ? 0.28 : 1;
                        var sTint = nd2.dim ? '#28304a' : nd2.color || '#ffd98a';
                        var sSz = Math.max(9, Math.min(46, (14 + sW * 3.2) * zf));
                        pctx.globalAlpha = (nd2.dim ? 0.08 : 0.4) * sHiW * Math.max(0.35, nearA);
                        pctx.drawImage(spriteFor(sTint), pp.x - sSz * 0.7, pp.y - sSz * 0.7, sSz * 1.4, sSz * 1.4);
                        pctx.globalAlpha = (nd2.dim ? 0.06 : 0.2) * sHiW * Math.max(0.3, nearA);
                        pctx.drawImage(flareSprite(rgbOf(sTint)), pp.x - sSz * 0.9, pp.y - sSz * 0.9, sSz * 1.8, sSz * 1.8);
                        if (!nd2.dim) {
                          pctx.globalAlpha = 0.8 * sHiW;
                          pctx.beginPath();
                          pctx.arc(pp.x, pp.y, Math.max(1.6, sSz * 0.1), 0, Math.PI * 2);
                          pctx.fillStyle = '#fffdf6';
                          pctx.fill();
                        }
                        // 恒星的名字一直挂着：它是这一层里的锚，认路全靠它
                        if (nd2.label && !nd2.dim) {
                          labels.push({
                            x: pp.x,
                            y: pp.y + sSz * 0.5 + 4,
                            r: sSz * 0.5 + 3,
                            text: String(nd2.label),
                            color: sTint,
                            alpha: Math.min(1, 0.55 + zf * 0.25) * sHiW,
                            k: Math.max(zf, 0.9),
                            w: sW,
                          });
                        }
                        continue;
                      }
                      if (nd2.kind === 'memory') {
                        // 记忆星：星芒 + 一圈彩色柔光（颜色按来源分：运行时记忆金、项目档案紫、记忆空间青）
                        var wv = typeof nd2.weight === 'number' ? nd2.weight : 1;
                        var mHiW = hiSet && !hiSet[nd2.id] ? 0.25 : 1;
                        var fsz = (8 + wv * 4.4) * zf + 2 * Math.sin(t * 0.0022 + q * 1.7);
                        fsz = Math.max(7, Math.min(34, fsz)) * (lod >= 2 ? 0.85 : 1);
                        var tint = nd2.dim ? '#28304a' : nd2.color || '#ffd98a';
                        var tintRgb = rgbOf(tint);
                        pctx.globalAlpha = (nd2.dim ? 0.06 : 0.36) * mHiW * Math.max(0.3, nearA);
                        pctx.drawImage(spriteFor(tint), pp.x - fsz * 0.68, pp.y - fsz * 0.68, fsz * 1.36, fsz * 1.36);
                        pctx.globalAlpha = (nd2.dim ? 0.06 : 0.16) * mHiW * Math.max(0.3, nearA);
                        pctx.drawImage(flareSprite(tintRgb), pp.x - fsz * 0.95, pp.y - fsz * 0.95, fsz * 1.9, fsz * 1.9);
                        // 中间一点白：不点这颗白点，彩色光晕会显得发虚
                        if (!nd2.dim) {
                          pctx.globalAlpha = 0.52 * mHiW;
                          pctx.beginPath();
                          pctx.arc(pp.x, pp.y, Math.max(1, fsz * 0.06), 0, Math.PI * 2);
                          pctx.fillStyle = '#ffffff';
                          pctx.fill();
                        }
                        // 名字：凑近了浮出来；默认视角下只给亮一点的那些让位，远了不糊成一片
                        var lfade = Math.min(1, Math.max(0, (zf - 0.72) / 0.5));
                        if (lfade > 0.03 && nd2.label && !nd2.dim && fsz >= 11) {
                          labels.push({
                            x: pp.x,
                            y: pp.y + fsz * 0.42 + 3,
                            r: fsz * 0.5 + 3,
                            text: String(nd2.label),
                            color: nd2.color,
                            alpha: lfade * mHiW,
                            k: zf,
                            w: wv,
                          });
                        }
                        continue;
                      }
                      // 剩下的只有尘埃（旧数据的会话星也走这条）：尘埃是背景，不宜跟着放大
                      var size = nd2.kind === 'dust'
                        ? 2.1 + 1.5 * zf
                        : (6.5 + Math.log2(1 + (nd2.msgs || 0)) * 1.4) * (0.55 + zf * 0.55);
                      if (nd2.dim) size *= 0.72;
                      if (!isFinite(size) || size <= 0) continue;
                      // 尘埃是背景雾，别用星团色抢戏：统一压成冷灰蓝
                      var spr = spriteFor(nd2.dim ? '#28304a' : nd2.kind === 'dust' ? '#8ea6d0' : nd2.color);
                      // 星星会眨眼：每颗按自己的相位轻轻呼吸
                      var twinkle = 0.86 + 0.14 * Math.sin(t * 0.0022 + q * 2.1);
                      var hiW = hiSet && !hiSet[nd2.id] ? 0.16 : 1;
                      pctx.globalAlpha = nd2.dim
                        ? 0.26
                        : (nd2.kind === 'dust'
                            ? 0.2 * (0.7 + 0.3 * Math.sin(t * 0.0013 + q * 0.9))
                            : twinkle * (nd2.fade === undefined ? 1 : nd2.fade)) * hiW;
                      pctx.drawImage(spr, pp.x - size / 2, pp.y - size / 2, size, size);
                      var coreR = Math.min(7, size * 0.13 + Math.min(2.4, zf * 0.6));
                      if (!nd2.dim && nd2.kind !== 'dust' && coreR > 0.8) {
                        pctx.globalCompositeOperation = 'lighter';
                        pctx.globalAlpha = 0.85;
                        pctx.beginPath();
                        pctx.arc(pp.x, pp.y, coreR, 0, Math.PI * 2);
                        pctx.fillStyle = '#ffffff';
                        pctx.fill();
                        pctx.globalCompositeOperation = 'source-over';
                      }
                      // 选中的那颗再套一圈星芒，飞过去之后一眼就看见"就是它"
                      if (selRef.current && selRef.current.id === nd2.id && !nd2.dim) {
                        var ringSize = size * 3.4;
                        pctx.globalAlpha = 0.55;
                        pctx.drawImage(flareSprite(), pp.x - ringSize / 2, pp.y - ringSize / 2, ringSize, ringSize);
                        pctx.globalAlpha = 1;
                      }
                    }
                    // 光点名字：重的先占位（大事不能被小事盖住），近的画得大一点，互相压住的让位
                    if (labels.length) {
                      labels.sort(function (a, b) {
                        if (Math.abs(b.w - a.w) > 0.05) return b.w - a.w;
                        return b.k - a.k;
                      });
                      pctx.globalCompositeOperation = 'source-over';
                      pctx.textAlign = 'center';
                      pctx.textBaseline = 'top';
                      pctx.shadowColor = 'rgba(2,5,12,0.92)';
                      pctx.shadowBlur = 4;
                      pctx.shadowOffsetY = 1;
                      var placed = [];
                      for (var li = 0; li < labels.length; li += 1) {
                        var lb = labels[li];
                        if (placed.length >= 70) break;
                        var fs2 = Math.max(9, Math.min(16, 10.5 * (0.7 + lb.k * 0.42)));
                        pctx.font = '600 ' + fs2.toFixed(1) + 'px "Segoe UI","Microsoft YaHei",system-ui,sans-serif';
                        var tw = pctx.measureText(lb.text).width;
                        var box = { x: lb.x - tw / 2, y: lb.y, w: tw, h: fs2 * 1.15 };
                        var clash = false;
                        for (var pj = 0; pj < placed.length; pj += 1) {
                          var pb = placed[pj];
                          if (box.x < pb.x + pb.w + 4 && box.x + box.w + 4 > pb.x && box.y < pb.y + pb.h + 3 && box.y + box.h + 3 > pb.y) {
                            clash = true;
                            break;
                          }
                        }
                        if (clash) continue;
                        placed.push(box);
                        var rgb = rgbOf(lb.color || '#ffd98a');
                        pctx.globalAlpha = Math.min(1, lb.alpha * 1.15);
                        pctx.fillStyle = 'rgba(' + (rgb || '255,217,138') + ',1)';
                        pctx.fillText(lb.text, lb.x, lb.y);
                      }
                      pctx.shadowColor = 'rgba(0,0,0,0)';
                      pctx.shadowBlur = 0;
                      pctx.shadowOffsetY = 0;
                      pctx.globalAlpha = 1;
                    }
                    pctx.globalAlpha = 1;
                    pctx.globalCompositeOperation = 'source-over';
                    // 数据流：记忆沿着「行星 → 自己的恒星」往上传，对话之间沿时间链往下传。
                    // 3D 的线太细，看不见；在这一层补一条淡线 + 一串往前跑的光点。
                    if (!lod || lod < 2) {
                      var flowData = graph.graphData();
                      var flowLks = flowData.links || [];
                      var flowNodes = {};
                      var flowNl = flowData.nodes || [];
                      for (var fni = 0; fni < flowNl.length; fni += 1) flowNodes[flowNl[fni].id] = flowNl[fni];
                      var flowT = t * 0.00055;

                      pctx.globalCompositeOperation = 'lighter';
                      pctx.lineWidth = 0.9;
                      for (var fl = 0; fl < flowLks.length; fl += 1) {
                        var FL = flowLks[fl];
                        if (FL.kind !== 'belongs' && FL.kind !== 'chain') continue;
                        var fSrcId = FL.source && FL.source.id ? FL.source.id : FL.source;
                        var fTgtId = FL.target && FL.target.id ? FL.target.id : FL.target;
                        var FA = flowNodes[fSrcId] || null;
                        var FB = flowNodes[fTgtId] || null;
                        if (!FA || !FB) continue;
                        if (hiSet && !(hiSet[FA.id] || hiSet[FB.id])) continue;
                        var fpa = null;
                        var fpb = null;
                        try {
                          fpa = graph.graph2ScreenCoords(FA.x || 0, FA.y || 0, FA.z || 0);
                          fpb = graph.graph2ScreenCoords(FB.x || 0, FB.y || 0, FB.z || 0);
                        } catch (e) {
                          continue;
                        }
                        if (!fpa || !fpb) continue;
                        var fdx = fpb.x - fpa.x;
                        var fdy = fpb.y - fpa.y;
                        var flen = Math.sqrt(fdx * fdx + fdy * fdy);
                        if (flen < 16 || flen > 2400) continue;
                        var hiW = hiSet ? 1 : 0.55;
                        // 线本身：淡到刚好能看出「有根线牵着」
                        pctx.globalAlpha = (FL.kind === 'chain' ? 0.17 : 0.13) * hiW;
                        pctx.strokeStyle = FL.kind === 'chain' ? 'rgba(200,220,255,1)' : 'rgba(255,205,220,1)';
                        pctx.beginPath();
                        pctx.moveTo(fpa.x, fpa.y);
                        pctx.lineTo(fpb.x, fpb.y);
                        pctx.stroke();
                        // 光点：三个一串，后面的小一点暗一点，像拖着尾巴
                        var fph = (flowT + (hashStr(FA.id) % 1000) / 1000) % 1;
                        for (var fi = 0; fi < 3; fi += 1) {
                          var fu = (fph - fi * 0.05 + 1) % 1;
                          var fade2 = Math.sin(fu * Math.PI);
                          var tail = 1 - fi * 0.3;
                          var fsz3 = Math.max(1.2, Math.min(6, (1.7 + flen * 0.005) * tail));
                          pctx.globalAlpha = 0.7 * fade2 * tail * hiW;
                          pctx.drawImage(spriteFor(FA.color || '#ffffff'), fpa.x + fdx * fu - fsz3, fpa.y + fdy * fu - fsz3, fsz3 * 2, fsz3 * 2);
                        }
                      }
                      pctx.globalAlpha = 1;
                      pctx.globalCompositeOperation = 'source-over';
                    }
                    // 悬停时把「它连着的线」画出来：比改 3D 线颜色省事，也更亮
                    if (hiSet) {
                      var lks3 = graph.graphData().links || [];
                      pctx.globalCompositeOperation = 'lighter';
                      pctx.lineWidth = 1.2;
                      pctx.strokeStyle = 'rgba(160,200,255,0.55)';
                      for (var lj = 0; lj < lks3.length; lj += 1) {
                        var L3 = lks3[lj];
                        var A3 = L3.source && L3.source.id ? L3.source : null;
                        var B3 = L3.target && L3.target.id ? L3.target : null;
                        if (!A3 || !B3) continue;
                        if (A3.id !== hi && B3.id !== hi) continue;
                        var pA = null;
                        var pB = null;
                        try {
                          pA = graph.graph2ScreenCoords(A3.x || 0, A3.y || 0, A3.z || 0);
                          pB = graph.graph2ScreenCoords(B3.x || 0, B3.y || 0, B3.z || 0);
                        } catch (e) {
                          continue;
                        }
                        if (!pA || !pB) continue;
                        pctx.globalAlpha = 0.5;
                        pctx.beginPath();
                        pctx.moveTo(pA.x, pA.y);
                        pctx.lineTo(pB.x, pB.y);
                        pctx.stroke();
                      }
                      pctx.globalAlpha = 1;
                      pctx.globalCompositeOperation = 'source-over';
                    }
                  }
                  if (!host) {
                    raf = window.requestAnimationFrame(syncLabels);
                    return;
                  }
                  var want = [];
                  for (var i = 0; i < all.length; i += 1) {
                    if (all[i].kind === 'cluster' && !all[i].dim) want.push(all[i]);
                  }
                  while (labelEls.length < want.length) {
                    var el = document.createElement('div');
                    el.className = 'sm-label';
                    el.innerHTML = '<span></span><small></small>';
                    host.appendChild(el);
                    labelEls.push(el);
                  }
                  for (var j = 0; j < labelEls.length; j += 1) {
                    var node = want[j];
                    var tag = labelEls[j];
                    if (!node) {
                      tag.style.opacity = '0';
                      continue;
                    }
                    var p = null;
                    try {
                      p = graph.graph2ScreenCoords(node.x || 0, node.y || 0, node.z || 0);
                    } catch (e) {
                      p = null;
                    }
                    if (!p || !isFinite(p.x) || !isFinite(p.y)) {
                      tag.style.opacity = '0';
                      continue;
                    }
                    var text = node.label + '|' + node.count;
                    if (tag.dataset.text !== text) {
                      tag.dataset.text = text;
                      tag.firstChild.textContent = node.label;
                      tag.lastChild.textContent = node.count + ' 条记忆';
                    }
                    // 标签浮在光点上方；星团光点画 58px，标签就抬到它外沿再留一点空
                    tag.style.transform =
                      'translate3d(' + Math.round(p.x) + 'px,' + Math.round(p.y - 42) + 'px,0)';
                    tag.style.opacity = p.x > 40 && p.y > 40 ? '1' : '0';
                  }
                  raf = window.requestAnimationFrame(syncLabels);
                };
                raf = window.requestAnimationFrame(syncLabels);

                // 不再排任何「自动摆正」。只在引擎第一次停下来、而且主人还没碰过相机时，
                // 给一次瞬时的初始取景（zoomToFit 的 duration 传 0 = 不带动画），之后就再也不动镜头。
                var userTouched = false;
                var framed = false;
                var onTakeOver = function () {
                  userTouched = true;
                  var ctl = null;
                  try {
                    ctl = graph.controls();
                  } catch (e) {
                    ctl = null;
                  }
                  if (ctl) ctl.autoRotate = false;
                };
                box.addEventListener('pointerdown', onTakeOver, true);
                box.addEventListener('wheel', onTakeOver, { capture: true, passive: true });
                detachInput = function () {
                  box.removeEventListener('pointerdown', onTakeOver, true);
                  box.removeEventListener('wheel', onTakeOver, { capture: true });
                  box.removeEventListener('pointerdown', onDragDown, true);
                  window.removeEventListener('pointermove', onDragMove, true);
                  window.removeEventListener('pointerup', onDragUp, true);
                  box.removeEventListener('contextmenu', onCtxMenu);
                  box.removeEventListener('pointerdown', onPickDown, true);
                  window.removeEventListener('pointerup', onPickUp, true);
                  window.removeEventListener('pointermove', onPickMove, true);
                };
                gpuStart(graph);
                graph.onEngineStop(function () {
                  // 兜底：数据来得比引擎慢时，这里补最后一枪。正常路径上 framed 早就为 true 了，
                  // 不再像以前那样 0 / 400 / 1400ms 连搬三次 —— 那三次就是「镜头跳一下」。
                  if (disposed || framed || userTouched || (graph && graph.__userTouched)) return;
                  framed = true;
                  frameNow();
                });
              })
              .catch(function (err) {
                if (!disposed) setState({ status: 'error', data: null, error: String((err && err.message) || err) });
              });

            return function () {
              // 卸载路径必须一条都不能抛：这个面板挂在 'main' 槽里，
              // 只要 cleanup 抛一次，宿主会把整个 shell 卸载掉（整屏 UI 消失）。
              try {
                disposed = true;
                applyRef.current = null;
                if (raf) window.cancelAnimationFrame(raf);
                if (detachInput) detachInput();
                if (labelRef.current) labelRef.current.innerHTML = '';
                settleTimers.forEach(function (t) {
                  clearTimeout(t);
                });
                if (fitSize) window.removeEventListener('resize', fitSize);
                if (graph && typeof graph._destructor === 'function') {
                  try {
                    graph._destructor();
                  } catch (e) {
                    /* 卸载期异常忽略 */
                  }
                }
                graphRef.current = null;
                if (box) box.innerHTML = '';
              } catch (e) {
                /* 卸载期任何异常都不许冒到宿主 */
              }
            };
          },
          [state.status, state.data],
        );

        // 筛选变化只推数据：不重建 3D 场景，所以时间轴和搜索可以同时生效。
        useEffect(
          function () {
            if (applyRef.current) applyRef.current();
          },
          [query, timeT, cat, fade, state.data],
        );

        var flyTo = function (text) {
          var graph = graphRef.current;
          var q = String(text || '').trim().toLowerCase();
          if (!graph || !q) return;
          var nodes = graph.graphData().nodes;
          var hit = null;
          for (var i = 0; i < nodes.length; i += 1) {
            var nd = nodes[i];
            if (nd.kind === 'cluster' || nd.dim) continue;
            if (String(nd.label || '').toLowerCase().indexOf(q) >= 0) {
              hit = nd;
              break;
            }
          }
          if (!hit) return;
          // 落点距离要跟着这颗星的体量走：固定距离会让小星星飞过去只剩一个点
          var msgs = hit.msgs || 0;
          var dist = hit.kind === 'memory' ? 26 : 26 + Math.log2(1 + msgs) * 3.2;
          if (!isFinite(dist) || dist <= 0) dist = 30;
          dist = Math.max(26, Math.min(dist, 42));
          try {
            graph.__userTouched = true; // 手动飞过去就别再被初始取景拽回全景
          } catch (e) {
            /* ignore */
          }
          // 相机在随后几帧里会被阻尼、自动取景继续搬，所以钉几次而不是钉一次
          var pin = function () {
            var live = graphRef.current;
            if (!live) return;
            var cam = null;
            try {
              cam = live.camera();
            } catch (e) {
              cam = null;
            }
            if (!cam || !cam.position) return;
            var V = cam.position.constructor;
            var tx = hit.x || 0;
            var ty = hit.y || 0;
            var tz = hit.z || 0;
            var dir = new V(cam.position.x - tx, cam.position.y - ty, cam.position.z - tz);
            var len = dir.length();
            if (!isFinite(len) || len < 0.001) dir.set(0.4, 0.3, 1);
            dir.normalize();
            var ctl2 = null;
            try {
              ctl2 = live.controls();
            } catch (e) {
              ctl2 = null;
            }
            if (ctl2 && ctl2.target) {
              ctl2.target.set(tx, ty, tz);
              cam.position.set(tx + dir.x * dist, ty + dir.y * dist, tz + dir.z * dist);
              if (typeof ctl2.update === 'function') ctl2.update();
            }
          };
          pin();
          [350, 800, 1500].forEach(function (ms) {
            window.setTimeout(pin, ms);
          });
          setSelected(hit);
        };

        var meta = state.data && state.data.meta;
        var clusters = (state.data && state.data.clusters) || [];
        var cutoffLabel = timeT >= 0.999 ? '全部' : fmtDay(view.minC + (view.maxC - view.minC) * timeT);
        var matchText =
          query.trim() === ''
            ? ''
            : view.matched > 0
              ? ' · 命中 ' + view.matched + ' 颗'
              : ' · 没有命中';

        var cats = view.cats || { runtime: 0, doc: 0, space: 0, entity: 0, dust: 0 };
        var memTotal = (cats.runtime || 0) + (cats.doc || 0) + (cats.space || 0) + (cats.entity || 0);
        var linkTotal = (state.data && state.data.edges ? state.data.edges.length : 0);
        var spanDays =
          view.maxC && view.minC ? Math.max(1, Math.round((view.maxC - view.minC) / 86400000)) : 0;
        var mixRows = [
          { key: '', label: '全部', n: memTotal, color: '#8fb6ff' },
          { key: 'runtime', label: '运行时记忆', n: cats.runtime || 0, color: '#ffd98a' },
          { key: 'doc', label: '项目档案', n: cats.doc || 0, color: '#c9a7ff' },
          { key: 'space', label: '记忆空间', n: cats.space || 0, color: '#6fe0ff' },
        ];
        if (cats.dust) mixRows.push({ key: 'dust', label: '尘埃', n: cats.dust, color: '#8fa3c8' });
        var mixSum = memTotal + (cats.dust || 0) || 1;

        // 认知流：最近动过的几颗星，按时间倒序
        var flow = [];
        if (state.data && state.data.stars) {
          flow = state.data.stars
            .filter(function (s) {
              return s.kind !== 'dust';
            })
            .slice()
            .sort(function (a, b) {
              return (b.lastAt || b.createdAt || 0) - (a.lastAt || a.createdAt || 0);
            })
            .slice(0, 7);
        }

        return h('div', {
          className: 'sm-root',
          children: [
            h('div', {
              className: 'sm-canvas',
              children: [
                h('div', { ref: boxRef, className: 'sm-stage' }),
                h('canvas', { ref: skyRef, className: 'sm-sky' }),
                h('canvas', { ref: pointsRef, className: 'sm-points' }),
                h('div', { ref: labelRef, className: 'sm-labels' }),
                h('div', {
                  className: 'sm-hud',
                  children: [
                    h('div', { className: 'sm-title', children: '记忆星图' }),
                    h('div', {
                      className: 'sm-sub',
                      children: meta
                        ? meta.clusters +
                          ' 个星团 · ' +
                          view.visibleStars +
                          '/' +
                          view.totalStars +
                          ' 个光点' +
                          (meta.dust ? ' · ' + meta.dust + ' 粒尘埃' : '') +
                          matchText
                        : '正在读记忆系统 …',
                    }),
                    h('div', {
                      className: 'sm-search',
                      children: h('input', {
                        className: 'sm-input',
                        type: 'search',
                        placeholder: '搜记忆名字，回车飞过去',
                        value: query,
                        onInput: function (e) {
                          setQuery(e.target.value);
                        },
                        onKeyDown: function (e) {
                          if (e.key === 'Enter') flyTo(e.target.value.trim());
                          if (e.key === 'Escape') setQuery('');
                        },
                      }),
                    }),
                    h('div', {
                      className: 'sm-time',
                      children: [
                        h('div', {
                          className: 'sm-time-top',
                          children: [
                            h('span', { children: '时间轴' }),
                            h('span', { children: cutoffLabel }),
                          ],
                        }),
                        h('input', {
                          className: 'sm-range',
                          type: 'range',
                          min: 0,
                          max: 100,
                          value: Math.round(timeT * 100),
                          disabled: !view.maxC,
                          onInput: function (e) {
                            setTimeT(Number(e.target.value) / 100);
                          },
                        }),
                      ],
                    }),
                    h('div', {
                      className: 'sm-actions',
                      children: [
                        h('button', {
                          className: 'sm-btn',
                          disabled: state.status === 'loading',
                          onClick: function () {
                            setSelected(null);
                            load(true);
                          },
                          children: state.status === 'loading' ? '刷新中…' : '重新读取',
                        }),
                        h('button', {
                          className: 'sm-btn' + (dust ? ' sm-btn-on' : ''),
                          disabled: state.status === 'loading',
                          title: '尘埃：记忆里提到过的实体名词，只是背景星尘',
                          onClick: function () {
                            setSelected(null);
                            setDust(!dust);
                          },
                          children: dust ? '尘埃层：开' : '尘埃层：关',
                        }),
                        h('button', {
                          className: 'sm-btn' + (orbitOn.star ? ' sm-btn-on' : ''),
                          title: '恒星绕着银心转（整团自转，慢）',
                          onClick: function () {
                            toggleOrbit('star');
                          },
                          children: orbitOn.star ? '恒星自转：开' : '恒星自转：停',
                        }),
                        h('button', {
                          className: 'sm-btn' + (orbitOn.planet ? ' sm-btn-on' : ''),
                          title: '记忆绕着对话转，内圈快、外圈慢',
                          onClick: function () {
                            toggleOrbit('planet');
                          },
                          children: orbitOn.planet ? '记忆公转：开' : '记忆公转：停',
                        }),
                        h('button', {
                          className: 'sm-btn' + (orbitOn.moon ? ' sm-btn-on' : ''),
                          title: '子代理会话贴着它写的记忆转',
                          onClick: function () {
                            toggleOrbit('moon');
                          },
                          children: orbitOn.moon ? '卫星公转：开' : '卫星公转：停',
                        }),
                        h('button', {
                          className: 'sm-btn',
                          title: '把镜头拉回主星团跟前',
                          onClick: function () {
                            if (frameRef.current) frameRef.current();
                          },
                          children: '复位视角',
                        }),
                        h('button', {
                          className: 'sm-btn' + (settingsOpen ? ' sm-btn-on' : ''),
                          title: '左键平移 · 右键转视角 · 中键拖星团',
                          onClick: function () {
                            setSettingsOpen(!settingsOpen);
                          },
                          children: '手感设置',
                        }),
                        h('button', {
                          className: 'sm-btn' + (fade ? ' sm-btn-on' : ''),
                          title: '越久没被碰过的记忆越暗，但不隐藏',
                          onClick: function () {
                            setFade(!fade);
                          },
                          children: fade ? '褪色：开' : '褪色：关',
                        }),
                      ],
                    }),
                    h('div', {
                      className: 'sm-mix',
                      children: [
                        h('div', {
                          className: 'sm-mix-h',
                          children: [
                            h('span', { children: '记忆构成' }),
                            h('span', { children: '点一行只留那一类' }),
                          ],
                        }),
                        h('div', {
                          className: 'sm-mix-bar',
                          children: mixRows
                            .filter(function (r) {
                              return r.key && r.n;
                            })
                            .map(function (r) {
                              return h('span', {
                                key: r.key,
                                style: {
                                  width: (r.n / mixSum) * 100 + '%',
                                  background: r.color,
                                  opacity: 0.85,
                                },
                              });
                            }),
                        }),
                        mixRows.map(function (r) {
                          return h('div', {
                            key: r.key || 'all',
                            className: 'sm-mix-row' + (cat === r.key ? ' on' : ''),
                            onClick: function () {
                              setSelected(null);
                              setCat(cat === r.key ? '' : r.key);
                            },
                            children: [
                              h('span', {
                                className: 'sm-dot',
                                style: { color: r.color, background: r.color },
                              }),
                              h('span', { children: r.label }),
                              h('b', { children: r.n }),
                            ],
                          });
                        }),
                      ],
                    }),
                  ],
                }),
                h('div', {
                  className: 'sm-stats',
                  children: [
                    { v: memTotal, k: '记忆点' },
                    { v: linkTotal, k: '连线' },
                    { v: clusters.length, k: '星团' },
                    { v: spanDays, k: '天跨度' },
                  ].map(function (s) {
                    return h('div', {
                      key: s.k,
                      className: 'sm-stat',
                      children: [h('b', { children: s.v }), h('span', { children: s.k })],
                    });
                  }),
                }),
                h('div', {
                  className: 'sm-legend',
                  children: clusters.map(function (c) {
                    return h('div', {
                      key: c.id,
                      className: 'sm-legend-row',
                      title: c.cwd,
                      children: [
                        h('span', { className: 'sm-dot', style: { color: c.color, background: c.color } }),
                        h('span', {
                          children: c.label + ' · ' + c.count + ' 条' + (dust && c.dust ? ' · ' + c.dust + '尘' : ''),
                        }),
                      ],
                    });
                  }),
                }),
                h('div', {
                  className: 'sm-flow',
                  children: [
                    h('div', {
                      className: 'sm-flow-h',
                      children: [h('span', { children: '认知流' }), h('span', { children: '最近 7 颗' })],
                    }),
                  ].concat(
                    flow.map(function (f, idx) {
                      return h('div', {
                        key: f.id,
                        className: 'sm-flow-row',
                        title: f.text || f.label,
                        onClick: function () {
                          setSelected(null);
                          flyTo(f.label);
                        },
                        children: [
                          h('i', { children: relTime(f.lastAt || f.createdAt) }),
                          h('span', {
                            children: f.label,
                          }),
                        ],
                      });
                    }),
                  ),
                }),
                h('div', {
                  className: 'sm-mini',
                  children: [
                    h('div', { className: 'sm-mini-h', children: '俯视 · 我在哪' }),
                    h('canvas', { ref: miniRef, width: 158, height: 100 }),
                  ],
                }),
                settingsOpen
                  ? h('div', {
                      className: 'sm-settings',
                      children: [
                        h('div', {
                          className: 'sm-set-title',
                          children: [
                            h('span', { children: '手感设置' }),
                            h('span', { style: { fontSize: '10px', color: '#7c8db3' }, children: '自动保存' }),
                          ],
                        }),
                        h('div', {
                          className: 'sm-set-row',
                          children: [
                            h('span', { children: '主星系' }),
                            h('select', {
                              value: primaryId,
                              title: '挑一团当主星系：镜头默认框它，它画成旋涡，其余团画成团状',
                              style: {
                                gridColumn: '2 / 4',
                                width: '100%',
                                background: 'rgba(14,20,40,.82)',
                                color: '#dfe7ff',
                                border: '1px solid rgba(140,170,255,.3)',
                                borderRadius: '6px',
                                padding: '3px 6px',
                                fontSize: '11px',
                                outline: 'none',
                              },
                              onChange: function (e) {
                                var v = e.target.value || '';
                                // 先改模块变量再重排：applyView 读的是它，等 useEffect 就晚了
                                primaryPickId = v;
                                setPrimaryId(v);
                                if (applyRef.current) applyRef.current();
                                window.setTimeout(function () {
                                  if (frameRef.current) frameRef.current();
                                }, 80);
                              },
                              children: [h('option', { value: '', children: '自动（记忆最多那团）' })].concat(clusters.map(function (cl) {
                                return h('option', { value: cl.id, children: cl.label + '（' + (cl.count || 0) + ' 条）' });
                              })),
                            }),
                          ],
                        }),
                        camRow('平移速度', cam.pan, 0.05, 3, 0.05, function (v) {
                          patchCam({ pan: v });
                        }),
                        camRow('旋转速度', cam.rotate, 0.05, 3, 0.05, function (v) {
                          patchCam({ rotate: v });
                        }),
                        camRow('缩放速度', cam.zoom, 0.1, 3, 0.05, function (v) {
                          patchCam({ zoom: v });
                        }),
                        camRow('阻尼', cam.damping, 0, 0.4, 0.005, function (v) {
                          patchCam({ damping: v });
                        }),
                        camRow('最近距离', cam.minDistance, 1, 2000, 1, function (v) {
                          patchCam({ minDistance: v });
                        }),
                        camRow('最远距离', cam.maxDistance, 400, 20000, 100, function (v) {
                          patchCam({ maxDistance: v });
                        }),
                        h('div', {
                          className: 'sm-set-row',
                          children: [
                            h('span', { children: '自动旋转' }),
                            h('label', {
                              style: { display: 'flex', alignItems: 'center', gap: '6px' },
                              children: [
                                h('input', {
                                  type: 'checkbox',
                                  checked: !!cam.autoRotate,
                                  onChange: function (e) {
                                    patchCam({ autoRotate: e.target.checked });
                                  },
                                }),
                                h('span', { style: { fontSize: '10px', color: '#7c8db3' }, children: '慢慢转' }),
                              ],
                            }),
                            h('span', { className: 'sm-set-val' }),
                          ],
                        }),
                        h('div', {
                          className: 'sm-set-row',
                          children: [
                            h('span', { children: '呼吸动效' }),
                            h('label', {
                              style: { display: 'flex', alignItems: 'center', gap: '6px' },
                              children: [
                                h('input', {
                                  type: 'checkbox',
                                  checked: !!breathOn,
                                  onChange: function (e) {
                                    setBreathOn(e.target.checked);
                                  },
                                }),
                                h('span', { style: { fontSize: '10px', color: '#7c8db3' }, children: '星团脉动' }),
                              ],
                            }),
                            h('span', { className: 'sm-set-val' }),
                          ],
                        }),
                        h('div', {
                          className: 'sm-set-foot',
                          children: h('button', {
                            className: 'sm-btn',
                            onClick: function () {
                              patchCam(DEFAULT_CAM);
                            },
                            children: '恢复默认',
                          }),
                        }),
                      ],
                    })
                  : null,
                state.status === 'loading' && !state.data
                  ? h('div', { className: 'sm-state', children: '正在读记忆系统 …' })
                  : null,
                state.status === 'error'
                  ? h('div', {
                      className: 'sm-state',
                      children: [
                        h('div', { className: 'sm-err', children: '星图数据加载失败：' + state.error }),
                        h('button', {
                          className: 'sm-btn',
                          onClick: function () {
                            load(true);
                          },
                          children: '重试',
                        }),
                      ],
                    })
                  : null,
                selected
                  ? h('div', {
                      className: 'sm-card',
                      children: [
                        h('div', {
                          className: 'sm-card-title',
                          children: selected.kind === 'dust' ? '实体 · ' + selected.label : selected.label,
                        }),
                        selected.kind === 'memory'
                          ? h('div', {
                              className: 'sm-card-row',
                              children: [
                                h('div', {
                                  className: 'sm-card-body',
                                  children: String(selected.text || selected.label || ''),
                                }),
                                h('br', {}),
                                (selected.preset || '记忆') + ' · ' + fmtTime(selected.createdAt),
                              ],
                            })
                          : selected.kind === 'cluster'
                          ? h('div', {
                              className: 'sm-card-row',
                              children: [
                                '工作区：' + selected.cwd,
                                h('br', {}),
                                '记忆 ' + selected.count + ' 条',
                                selected.dust ? h('br', {}) : null,
                                selected.dust ? '实体尘埃 ' + selected.dust + ' 粒' : null,
                                h('br', {}),
                                '最近活动：' + fmtTime(selected.lastAt),
                              ],
                            })
                          : selected.kind === 'star'
                          ? h('div', {
                              className: 'sm-card-row',
                              children: [
                                '一次对话 · 记忆 ' + (selected.count || 0) + ' 条绕着它转',
                                h('br', {}),
                                '用户发言 ' + (selected.msgs || 0) + ' 条 · 轮次 ' + (selected.turns || 0),
                                h('br', {}),
                                '开始：' + fmtTime(selected.createdAt),
                                h('br', {}),
                                '最近：' + fmtTime(selected.lastAt),
                              ],
                            })
                          : h('div', {
                              className: 'sm-card-row',
                              children: [
                                '用户发言 ' + (selected.msgs || 0) + ' 条 · 轮次 ' + (selected.turns || 0),
                                h('br', {}),
                                '开始：' + fmtTime(selected.createdAt),
                                h('br', {}),
                                '最近：' + fmtTime(selected.lastAt),
                                selected.preset ? h('br', {}) : null,
                                selected.preset ? '预设：' + selected.preset : null,
                              ],
                            }),
                      ],
                    })
                  : null,
              ],
            }),
          ],
        });
      }

      function StarmapIcon() {
        return h('svg', {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          children: [
            h('circle', { cx: 4.5, cy: 5, r: 1.5, fill: 'currentColor' }),
            h('circle', { cx: 11.5, cy: 4.5, r: 1.2, fill: 'currentColor', opacity: 0.75 }),
            h('circle', { cx: 8.2, cy: 11, r: 1.7, fill: 'currentColor' }),
            h('circle', { cx: 12.4, cy: 10.6, r: 0.9, fill: 'currentColor', opacity: 0.6 }),
            h('path', {
              d: 'M5.7 5.9 7.3 9.7M10.6 5.2 9.1 9.6M9.2 10.4 11.6 10.6',
              stroke: 'currentColor',
              strokeWidth: 0.9,
              opacity: 0.5,
              strokeLinecap: 'round',
            }),
          ],
        });
      }

      var PANEL_ID = 'dsh-starmap';

      function apply(ctx) {
                injectCss();
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 30,
              label: function () {
                return '记忆星图';
              },
            },
            StarmapIcon,
          );
        });
        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: PANEL_ID }, StarmapPanel);
        });
      }

      return { name: 'starmap', inject: ['slots'], apply: apply };
    };
  }
})();
