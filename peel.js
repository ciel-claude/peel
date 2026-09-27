// 撕纸展示引擎：展示页和工作台的预览共用
// Peel.mount(stage, work)，work = { width, height, bg, full, pieces: [[x1,y1,x2,y2]...], style }
(function () {
  const CSS = `
  .peel-stage {
    position: relative;
    width: min(100vw, calc(100dvh * var(--ar)));
    aspect-ratio: var(--ar);
    background: center / 100% 100% no-repeat;
    user-select: none; -webkit-user-select: none; touch-action: none;
  }
  .peel-stage.done { animation: peel-glow 1.6s ease-out; }
  @keyframes peel-glow {
    0% { filter: brightness(1); }
    30% { filter: brightness(1.45) saturate(1.2); }
    100% { filter: brightness(1); }
  }
  .peel-reveal {
    position: absolute; inset: 0; background: center / 100% 100% no-repeat;
    opacity: 0; transition: opacity 1s ease-out; pointer-events: none;
  }
  .peel-stage.done .peel-reveal { opacity: 1; }
  .peel-hole {
    position: absolute; pointer-events: none; background-repeat: no-repeat;
    -webkit-mask-size: 100% 100%; mask-size: 100% 100%;
  }
  .peel-piece {
    position: absolute; cursor: grab;
    filter: drop-shadow(0 0 1px rgba(255,255,255,var(--rim))) drop-shadow(0 1px 2px rgba(0,0,0,var(--sh)));
    transition: filter .2s;
  }
  .peel-piece.active {
    z-index: 10; cursor: grabbing;
    filter: drop-shadow(0 0 1px rgba(255,255,255,var(--rim))) drop-shadow(0 4px 8px rgba(0,0,0,.6));
  }
  .peel-piece.gone { pointer-events: none; transition: transform .55s cubic-bezier(.3,.6,.4,1), opacity .55s; opacity: 0; }
  .peel-stuck, .peel-flap { position: absolute; inset: 0; -webkit-mask-size: 100% 100%; mask-size: 100% 100%; }
  .peel-stuck { background-repeat: no-repeat; }
  .peel-flap { display: none; transform-origin: 0 0; background-color: #ece4d2; }
  /* 角落里的小玻璃件：左下提示、右下重来，都避开中间的纸片 */
  .peel-hint, .peel-again {
    position: absolute; bottom: 3%; z-index: 20;
    color: rgba(255,255,255,.82);
    background: rgba(12,14,16,.38); border: 1px solid rgba(255,255,255,.14);
    -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
    transition: opacity .6s, background .2s;
  }
  .peel-hint {
    left: 3%; pointer-events: none; white-space: nowrap;
    padding: .45em 1.1em .45em 1.4em; border-radius: 99px;
    font-size: clamp(11px, 1.3vw, 14px); letter-spacing: .35em;
  }
  .peel-again {
    right: 3%; width: clamp(34px, 4vw, 44px); aspect-ratio: 1; border-radius: 50%; padding: 0;
    display: grid; place-items: center; cursor: pointer; opacity: 0; pointer-events: none;
  }
  .peel-again.show { opacity: .85; pointer-events: auto; }
  .peel-again:hover { opacity: 1; background: rgba(12,14,16,.55); }
  .peel-again svg { width: 46%; height: 46%; }`;
  const REPLAY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';

  const PULL = 1.15;     // 纸角跟手的比例，>1 撕得比手快一点
  const DETACH = 0.55;   // 折痕走过多少就整张脱落

  const pct = (v, total) => (v / total * 100) + '%';
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

  function injectCSS() {
    if (document.getElementById('peel-css')) return;
    const s = document.createElement('style');
    s.id = 'peel-css'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  // 邮票齿孔遮罩：实心矩形沿边挖半圆
  function stampMask(w, h, r, gap) {
    const s = Math.min(1, 800 / Math.max(w, h));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * s)); cv.height = Math.max(1, Math.round(h * s));
    const ctx = cv.getContext('2d');
    ctx.scale(s, s);
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-out';
    const holes = (len, at) => {
      const n = Math.max(2, Math.round(len / gap));
      for (let i = 0; i <= n; i++) {
        const [x, y] = at(len * i / n);
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
    };
    holes(w, t => [t, 0]); holes(w, t => [t, h]);
    holes(h, t => [0, t]); holes(h, t => [w, t]);
    return `url(${cv.toDataURL()})`;
  }

  // 多边形裁切：保留 f(q) >= 0 的部分
  function clipPoly(poly, f) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const fa = f(a), fb = f(b);
      if (fa >= 0) out.push(a);
      if ((fa >= 0) !== (fb >= 0)) {
        const t = fa / (fa - fb);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return out;
  }
  const cssPoly = pts => pts.length < 3 ? 'polygon(0 0,0 0,0 0)'
    : 'polygon(' + pts.map(p => `${p[0].toFixed(1)}px ${p[1].toFixed(1)}px`).join(',') + ')';

  // 往 u 方向撕时，从哪个角起、整张有多长
  function geom(w, h, u) {
    const corners = [[0, 0], [w, 0], [w, h], [0, h]];
    let C = corners[0];
    for (const q of corners) if (dot(q, u) < dot(C, u)) C = q;
    let span = 0;
    for (const q of corners) span = Math.max(span, dot([q[0] - C[0], q[1] - C[1]], u));
    return { corners, C, span };
  }

  // 按拖动向量 v 画出：还粘着的部分 + 翻过来的纸背。返回折痕走过的比例
  function render(p, vx, vy) {
    const w = p.el.clientWidth, h = p.el.clientHeight;
    const len = Math.hypot(vx, vy);
    if (len < 0.5) {
      p.stuck.style.clipPath = 'none';
      p.flap.style.display = 'none';
      return 0;
    }
    const u = [vx / len, vy / len];
    const { corners, C, span } = geom(w, h, u);
    const d = len * PULL / 2;
    const M = [C[0] + u[0] * d, C[1] + u[1] * d];
    const side = q => (q[0] - M[0]) * u[0] + (q[1] - M[1]) * u[1];

    p.stuck.style.clipPath = cssPoly(clipPoly(corners, side));
    p.flap.style.clipPath = cssPoly(clipPoly(corners, q => -side(q)));
    p.flap.style.display = 'block';

    // 沿折痕镜像
    const k = 2 * dot(M, u);
    const a = 1 - 2 * u[0] * u[0], b = -2 * u[0] * u[1], dd = 1 - 2 * u[1] * u[1];
    p.flap.style.transform = `matrix(${a},${b},${b},${dd},${k * u[0]},${k * u[1]})`;

    // 纸背靠折痕处暗一点，越往纸角越亮
    const n = [-u[0], -u[1]];
    const ang = Math.atan2(n[0], -n[1]);
    const L = Math.abs(w * Math.sin(ang)) + Math.abs(h * Math.cos(ang));
    const t0 = ((M[0] - w / 2) * n[0] + (M[1] - h / 2) * n[1]) / L + 0.5;
    p.flap.style.backgroundImage =
      `linear-gradient(${ang}rad, rgba(80,60,30,.28) ${t0 * 100}%, rgba(255,255,255,.35) ${(t0 + .35) * 100}%)`;

    return d / span;
  }

  function mount(stage, work) {
    injectCSS();
    const W = work.width, H = work.height;
    const st = Object.assign({ holeR: W * 0.0035, holeGap: W * 0.0117, rim: 0.5, shadow: 0.55 }, work.style || {});

    stage.innerHTML = '';
    stage.classList.add('peel-stage');
    stage.classList.remove('done');
    stage.style.setProperty('--ar', W / H);
    stage.style.setProperty('--rim', st.rim);
    stage.style.setProperty('--sh', st.shadow);
    stage.style.backgroundImage = `url(${work.bg})`;

    const reveal = document.createElement('div');
    reveal.className = 'peel-reveal';
    reveal.style.backgroundImage = `url(${work.full})`;
    const hint = document.createElement('div');
    hint.className = 'peel-hint';
    hint.textContent = '撕开看看';
    const again = document.createElement('button');
    again.className = 'peel-again';
    again.innerHTML = REPLAY_ICON;
    again.title = '再来一次'; again.setAttribute('aria-label', '再来一次');
    stage.append(reveal, hint, again);

    let left = 0, alive = true, touched = false, teaseTimer = 0;
    const all = [];

    function tween(p, to, ms, done) {
      const from = p.v.slice(), t0 = performance.now();
      const step = now => {
        if (!alive) return;
        const t = Math.min((now - t0) / ms, 1), e = 1 - Math.pow(1 - t, 3);
        p.v = [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e];
        render(p, p.v[0], p.v[1]);
        if (t < 1) p.raf = requestAnimationFrame(step); else done && done();
      };
      cancelAnimationFrame(p.raf);
      p.raf = requestAnimationFrame(step);
    }

    function finish() {
      stage.classList.add('done');
      setTimeout(() => { if (alive) again.classList.add('show'); }, 1800);
    }

    // 没人动的时候，隔一会儿让随机一块纸片的角自己翘一下再落回去，示意能撕
    function tease() {
      if (!alive || touched) return;
      const idle = all.filter(p => !p.gone);
      if (idle.length) {
        const p = idle[Math.random() * idle.length | 0];
        const ang = Math.PI / 4 + Math.floor(Math.random() * 4) * Math.PI / 2;
        const L = Math.min(p.el.clientWidth, p.el.clientHeight) * .32 / PULL;
        p.el.classList.add('active');
        tween(p, [Math.cos(ang) * L, Math.sin(ang) * L], 520,
          () => tween(p, [0, 0], 420, () => p.el.classList.remove('active')));
      }
      teaseTimer = setTimeout(tease, 3200);
    }

    // 撕到底，然后飞走
    function detach(p, dir, ms) {
      if (p.gone) return;
      p.gone = true;
      hint.style.opacity = 0;
      const len = Math.hypot(dir[0], dir[1]);
      const u = [dir[0] / len, dir[1] / len];
      const { span } = geom(p.el.clientWidth, p.el.clientHeight, u);
      const full = span * 2.05 / PULL;
      tween(p, [u[0] * full, u[1] * full], ms, () => {
        const fly = stage.clientWidth * .35;
        p.el.classList.add('gone');
        p.el.style.transform = `translate(${u[0] * fly}px, ${u[1] * fly - 40}px) rotate(${(Math.random() - .5) * 40}deg)`;
        if (--left === 0) setTimeout(finish, 500);
      });
    }

    function bind(p) {
      let start = null, id = null, moved = 0;
      p.el.addEventListener('pointerdown', e => {
        if (p.gone) return;
        touched = true; clearTimeout(teaseTimer);
        cancelAnimationFrame(p.raf);
        id = e.pointerId; moved = 0;
        start = [e.clientX - p.v[0], e.clientY - p.v[1]];
        p.el.setPointerCapture(id);
        p.el.classList.add('active');
      });
      p.el.addEventListener('pointermove', e => {
        if (e.pointerId !== id || p.gone) return;
        p.v = [e.clientX - start[0], e.clientY - start[1]];
        moved = Math.max(moved, Math.hypot(p.v[0], p.v[1]));
        if (render(p, p.v[0], p.v[1]) > DETACH) { id = null; detach(p, p.v, 180); }
      });
      const up = e => {
        if (e.pointerId !== id) return;
        id = null;
        if (moved < 6) {
          // 点一下：从随机一个角往对角撕开
          const ang = Math.PI / 4 + Math.floor(Math.random() * 4) * Math.PI / 2 + (Math.random() - .5) * .5;
          detach(p, [Math.cos(ang), Math.sin(ang)], 650);
        } else {
          // 没撕够，松手贴回去
          tween(p, [0, 0], 260, () => p.el.classList.remove('active'));
        }
      };
      p.el.addEventListener('pointerup', up);
      p.el.addEventListener('pointercancel', up);
    }

    function build() {
      all.forEach(p => cancelAnimationFrame(p.raf));
      all.length = 0;
      stage.querySelectorAll('.peel-piece, .peel-hole').forEach(el => el.remove());
      left = work.pieces.length;
      for (const [x1, y1, x2, y2] of work.pieces) {
        const w = x2 - x1, h = y2 - y1;
        const box = { left: pct(x1, W), top: pct(y1, H), width: pct(w, W), height: pct(h, H) };
        const bgSize = `${W / w * 100}% ${H / h * 100}%`;
        const bgPos = `${W === w ? 0 : x1 / (W - w) * 100}% ${H === h ? 0 : y1 / (H - h) * 100}%`;
        const mask = stampMask(w, h, st.holeR, st.holeGap);

        // 纸片底下的窗：撕开的地方才看得到人物
        const hole = document.createElement('div');
        hole.className = 'peel-hole';
        Object.assign(hole.style, box, {
          backgroundImage: `url(${work.full})`, backgroundSize: bgSize, backgroundPosition: bgPos,
          webkitMaskImage: mask, maskImage: mask,
        });
        reveal.after(hole);

        const el = document.createElement('div');
        el.className = 'peel-piece';
        Object.assign(el.style, box);
        const stuck = document.createElement('div');
        stuck.className = 'peel-stuck';
        Object.assign(stuck.style, { backgroundImage: `url(${work.bg})`, backgroundSize: bgSize, backgroundPosition: bgPos });
        const flap = document.createElement('div');
        flap.className = 'peel-flap';
        for (const m of [stuck, flap]) { m.style.webkitMaskImage = mask; m.style.maskImage = mask; }
        el.append(stuck, flap);
        stage.insertBefore(el, hint);

        const p = { el, stuck, flap, v: [0, 0], gone: false, raf: 0 };
        all.push(p);
        bind(p);
      }
      hint.style.opacity = 1;
      again.classList.remove('show');
      stage.classList.remove('done');
      touched = false;
      clearTimeout(teaseTimer);
      teaseTimer = setTimeout(tease, 1500);
    }

    again.addEventListener('click', build);
    build();

    return {
      destroy() {
        alive = false;
        clearTimeout(teaseTimer);
        all.forEach(p => cancelAnimationFrame(p.raf));
        stage.innerHTML = '';
      },
    };
  }

  window.Peel = { mount };
})();
