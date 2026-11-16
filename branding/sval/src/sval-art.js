/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// Sval brand art generator: vector masters
class Art {
  mesh(seed, n) {
    const key = seed + ':' + n;
    if (this._mk === key) return this._mesh;
    let s = seed >>> 0;
    const rnd = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const g = (1 + Math.sqrt(5)) / 2;
    const V = [[-1,g,0],[1,g,0],[-1,-g,0],[1,-g,0],[0,-1,g],[0,1,g],[0,-1,-g],[0,1,-g],[g,0,-1],[g,0,1],[-g,0,-1],[-g,0,1]];
    const F = [[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],[3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];
    const norm = p => { const l = Math.hypot(p[0], p[1], p[2]); return [p[0]/l, p[1]/l, p[2]/l]; };
    const verts = [], map = {}, tris = [];
    const vid = p => { p = norm(p); const k = p.map(x => x.toFixed(4)).join(','); if (map[k] === undefined) { map[k] = verts.length; verts.push(p); } return map[k]; };
    F.forEach(([a, b, c]) => {
      const A = V[a], B = V[b], C = V[c], P = {};
      for (let i = 0; i <= n; i++) for (let j = 0; i + j <= n; j++) P[i+','+j] = vid([0,1,2].map(k => A[k] + (B[k]-A[k])*i/n + (C[k]-A[k])*j/n));
      for (let i = 0; i < n; i++) for (let j = 0; i + j < n; j++) {
        tris.push([P[i+','+j], P[(i+1)+','+j], P[i+','+(j+1)]]);
        if (i + j < n - 1) tris.push([P[(i+1)+','+j], P[(i+1)+','+(j+1)], P[i+','+(j+1)]]);
      }
    });
    const amp = 0.12 / n, ax = 0.55, ay = 0.35, az = 0.18;
    const rv = verts.map(p => {
      let [x, y, z] = norm([p[0] + (rnd()-.5)*2*amp, p[1] + (rnd()-.5)*2*amp, p[2] + (rnd()-.5)*2*amp]);
      [y, z] = [y*Math.cos(ax) - z*Math.sin(ax), y*Math.sin(ax) + z*Math.cos(ax)];
      [x, z] = [x*Math.cos(ay) + z*Math.sin(ay), -x*Math.sin(ay) + z*Math.cos(ay)];
      [x, y] = [x*Math.cos(az) - y*Math.sin(az), x*Math.sin(az) + y*Math.cos(az)];
      return [x, y, z];
    });
    const L = norm([0.5, 0.62, 0.6]);
    const faces = tris.map(t => {
      const [a, b, c] = t.map(i => rv[i]);
      const u = [b[0]-a[0], b[1]-a[1], b[2]-a[2]], w = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
      let nn = norm([u[1]*w[2]-u[2]*w[1], u[2]*w[0]-u[0]*w[2], u[0]*w[1]-u[1]*w[0]]);
      const ce = [(a[0]+b[0]+c[0])/3, (a[1]+b[1]+c[1])/3, (a[2]+b[2]+c[2])/3];
      if (nn[0]*ce[0] + nn[1]*ce[1] + nn[2]*ce[2] < 0) nn = nn.map(x => -x);
      const lit = nn[0]*L[0] + nn[1]*L[1] + nn[2]*L[2];
      return { pts: [a, b, c], nz: nn[2], lit, noise: (rnd() - .5) * 0.1 };
    });
    this._mk = key; this._mesh = faces;
    return faces;
  }
  ramp(stops, t) {
    t = Math.max(0, Math.min(1, t));
    const h = x => [1,3,5].map(i => parseInt(x.slice(i, i+2), 16));
    const f = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(f)), k = f - i;
    const a = h(stops[i]), b = h(stops[i+1]);
    return '#' + a.map((v, j) => Math.round(v + (b[j]-v)*k).toString(16).padStart(2, '0')).join('');
  }
  polys2(faces, colorFn, edge, ew) {
    const R = 400;
    return faces.filter(f => f.nz > 0).map(f => {
      const pts = f.pts.map(p => (512 + p[0]*R).toFixed(1) + ',' + (512 - p[1]*R).toFixed(1)).join(' ');
      const fill = colorFn(f);
      return `<polygon points="${pts}" fill="${fill}" stroke="${edge || fill}" stroke-width="${edge ? ew : 1.2}" stroke-linejoin="round"/>`;
    }).join('');
  }
  svg3(v, size, seed) {
    const p = 'sval' + v.id, b = v.b;
    const main = v.main || ['#16106a', '#2430c8', '#1f6bff', '#1fa8ff', '#6ee6ff'];
    const land = v.landC || ['#0b5a3c', '#1f9a55', '#4fcf6a', '#b8f08a'];
    const shade = f => 0.14 + 0.86 * Math.max(0, f.lit) + f.noise;
    const faces = this.mesh(seed, v.meshN || 3).map(f => Object.assign({}, f, { c: [0,1,2].map(k => (f.pts[0][k] + f.pts[1][k] + f.pts[2][k]) / 3) }));
    const lOld = c => Math.sin(2.7*c[0] + 1.1) * Math.cos(2.3*c[1] - 0.4) + 0.6*Math.sin(3.9*c[2] + 2.1*c[0]);
    const lNew = c => Math.sin(3.3*c[0] + 1.1) * Math.cos(2.9*c[1] - 0.4) + 0.7*Math.sin(5.1*c[2] + 2.3*c[0] + 0.7) + 0.5*Math.sin(7.3*c[1] + 4.1*c[2] - 1.2) + 0.35*Math.sin(9.7*c[0] - 6.1*c[1] + 0.5);
    const isLand = v.land4 ? c => 0.78*lOld(c) + 0.22*lNew(c) > 0.16 : v.land3 ? c => 0.55*lOld(c) + 0.45*lNew(c) > 0.14 : v.land2 ? c => Math.sin(3.3*c[0] + 1.1) * Math.cos(2.9*c[1] - 0.4) + 0.7*Math.sin(5.1*c[2] + 2.3*c[0] + 0.7) + 0.5*Math.sin(7.3*c[1] + 4.1*c[2] - 1.2) + 0.35*Math.sin(9.7*c[0] - 6.1*c[1] + 0.5) > 0.05 : c => Math.sin(2.7*c[0] + 1.1) * Math.cos(2.3*c[1] - 0.4) + 0.6*Math.sin(3.9*c[2] + 2.1*c[0]) > 0.18;
    const colorFn = f => isLand(f.c) ? this.ramp(land, shade(f) + 0.08) : this.ramp(main, shade(f));
    const bS = (col, extra) => !b ? '' : `<g transform="translate(${b.cx} 512) skewX(${b.skew}) translate(${-b.cx} -512)" fill="none" stroke="${col}" stroke-width="${b.w + extra}" stroke-linecap="round"><line x1="${b.sx}" y1="${b.top}" x2="${b.sx}" y2="${b.bot}"/><circle cx="${b.bx}" cy="${b.by}" r="${b.r}"/></g>`;
    const U = 'maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"';
    const defs = `<defs>
<mask id="${p}cut" ${U}><rect width="1024" height="1024" fill="#fff"/>${bS('#000', 0)}</mask>
<clipPath id="${p}disc"><circle cx="512" cy="512" r="401"/></clipPath>
<radialGradient id="${p}plate" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="${(v.plateC || ['#13328f'])[0]}"/><stop offset="1" stop-color="${(v.plateC || [0, '#060a2e'])[1]}"/></radialGradient>
<radialGradient id="${p}glow" cx="50%" cy="50%" r="50%"><stop offset=".86" stop-color="${v.glowC || '#3f9dff'}" stop-opacity="0"/><stop offset=".91" stop-color="${v.glowC || '#3f9dff'}" stop-opacity=".55"/><stop offset="1" stop-color="${v.glowC || '#3f9dff'}" stop-opacity="0"/></radialGradient>
<radialGradient id="${p}limb" cx="58%" cy="36%" r="66%"><stop offset=".55" stop-color="#040628" stop-opacity="0"/><stop offset="1" stop-color="#040628" stop-opacity=".5"/></radialGradient>
<linearGradient id="${p}gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".6"/><stop offset=".55" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<linearGradient id="${p}rim" x1="0" y1="0" x2="0" y2="1"><stop offset=".6" stop-color="#7fe6ff" stop-opacity="0"/><stop offset="1" stop-color="#7fe6ff" stop-opacity=".7"/></linearGradient>
<linearGradient id="${p}ring" ${v.ringAxis ? 'gradientUnits="userSpaceOnUse" x1="40" y1="512" x2="984" y2="512"' : `x1="0" y1="0" x2="${v.ringStops ? 1 : 0}" y2="1"`}>${(v.ringStops || [[0, '#e6f2ff'], [1, '#8db6ea']]).map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient>
<linearGradient id="${p}white" gradientUnits="userSpaceOnUse" x1="0" y1="240" x2="0" y2="800"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d4e5ff"/></linearGradient>
<linearGradient id="${p}gel" gradientUnits="userSpaceOnUse" x1="0" y1="240" x2="0" y2="800"><stop offset="0" stop-color="#9ef0ff"/><stop offset=".5" stop-color="#3fa2ff"/><stop offset="1" stop-color="#1f5cf0"/></linearGradient>
<clipPath id="${p}front" clipPathUnits="userSpaceOnUse"><rect x="0" y="512" width="1024" height="512"/></clipPath>
${v.bmask ? [-40, -14, 0, 8, 14, 26, 40].map(k => `<mask id="${p}bm${k}" ${U}><rect width="1024" height="1024" fill="#000"/><g transform="${v.tf}">${v.bmask(k)}</g></mask>`).join('') + `<filter id="${p}halo" filterUnits="userSpaceOnUse" x="180" y="140" width="700" height="780"><feGaussianBlur stdDeviation="12"/></filter><linearGradient id="${p}ice" gradientUnits="userSpaceOnUse" x1="0" y1="250" x2="0" y2="800"><stop offset="0" stop-color="#ffffff"/><stop offset=".5" stop-color="#c9e6ff"/><stop offset="1" stop-color="#8cc2ff"/></linearGradient><linearGradient id="${p}sky" gradientUnits="userSpaceOnUse" x1="0" y1="250" x2="0" y2="800"><stop offset="0" stop-color="#e4f7ff"/><stop offset=".45" stop-color="#7fd0ff"/><stop offset="1" stop-color="#2f7dff"/></linearGradient><linearGradient id="${p}diag" gradientUnits="userSpaceOnUse" x1="300" y1="260" x2="760" y2="800"><stop offset="0" stop-color="#ffffff"/><stop offset=".5" stop-color="#bfe2ff"/><stop offset="1" stop-color="#4b9dff"/></linearGradient><linearGradient id="${p}bev" gradientUnits="userSpaceOnUse" x1="0" y1="250" x2="0" y2="800"><stop offset="0" stop-color="#cfeaff"/><stop offset="1" stop-color="#6fb4ff"/></linearGradient><linearGradient id="${p}nIce" gradientUnits="userSpaceOnUse" x1="0" y1="250" x2="0" y2="800"><stop offset="0" stop-color="#ffffff"/><stop offset="0.5" stop-color="#8ff0ff"/><stop offset="1" stop-color="#2fb8ff"/></linearGradient><linearGradient id="${p}nElec" gradientUnits="userSpaceOnUse" x1="0" y1="250" x2="0" y2="800"><stop offset="0" stop-color="#ffffff"/><stop offset="0.35" stop-color="#5fe2ff"/><stop offset="0.75" stop-color="#2a6bff"/><stop offset="1" stop-color="#6a3cff"/></linearGradient><linearGradient id="${p}nLaser" gradientUnits="userSpaceOnUse" x1="0" y1="250" x2="0" y2="800"><stop offset="0" stop-color="#f0fdff"/><stop offset="0.5" stop-color="#00e1ff"/><stop offset="1" stop-color="#0a8cff"/></linearGradient><linearGradient id="${p}nRev" gradientUnits="userSpaceOnUse" x1="0" y1="250" x2="0" y2="800"><stop offset="0" stop-color="#2f5cff"/><stop offset="0.55" stop-color="#36a8ff"/><stop offset="1" stop-color="#6ff3ff"/></linearGradient>${v.stops ? `<linearGradient id="${p}cust" gradientUnits="userSpaceOnUse" x1="0" y1="250" x2="0" y2="800">${v.stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient>` : ''}<radialGradient id="${p}hglow"><stop offset="0" stop-color="#fff3a0" stop-opacity=".95"/><stop offset=".4" stop-color="#ffc22a" stop-opacity=".55"/><stop offset="1" stop-color="#ff8a1a" stop-opacity="0"/></radialGradient><radialGradient id="${p}moon" cx="38%" cy="35%" r="70%"><stop offset="0" stop-color="#fffbe6"/><stop offset=".5" stop-color="#ffd23f"/><stop offset="1" stop-color="#e2650e"/></radialGradient>${v.ringBlur ? `<filter id="${p}rblur" filterUnits="userSpaceOnUse" x="-100" y="-100" width="1224" height="1224"><feGaussianBlur stdDeviation="${v.ringBlur}"/></filter>` : ''}<filter id="${p}neon" filterUnits="userSpaceOnUse" x="140" y="100" width="780" height="860"><feGaussianBlur stdDeviation="18"/></filter><filter id="${p}soft" filterUnits="userSpaceOnUse" x="180" y="140" width="720" height="800"><feGaussianBlur stdDeviation="16"/></filter><linearGradient id="${p}gold" gradientUnits="userSpaceOnUse" x1="0" y1="240" x2="0" y2="800"><stop offset="0" stop-color="#ffe27a"/><stop offset=".55" stop-color="#ffb52e"/><stop offset="1" stop-color="#f08a12"/></linearGradient><linearGradient id="${p}inner" gradientUnits="userSpaceOnUse" x1="0" y1="240" x2="0" y2="800"><stop offset="0" stop-color="#030620"/><stop offset="1" stop-color="#0d1f6a"/></linearGradient>` : ''}
</defs>`;
    const S = (col, k = 0) => `<rect width="1024" height="1024" fill="${col}" mask="url(#${p}bm${k})"/>`;
    const craters = () => !v.craters ? '' : v.craters.map(([x, y, r]) => { const dx = x - 512, dy = y - 512, d = Math.hypot(dx, dy), k = Math.sqrt(Math.max(0.08, 1 - (d / 400) ** 2)), a = Math.atan2(dy, dx) * 180 / Math.PI;
      return `<g transform="translate(${x} ${y}) rotate(${a.toFixed(1)})"><ellipse rx="${(r * k).toFixed(1)}" ry="${r}" fill="${v.craterC || '#0a0f24'}" opacity=".28"/><ellipse cx="${(-r * k * .14).toFixed(1)}" rx="${(r * k * .8).toFixed(1)}" ry="${(r * .8).toFixed(1)}" fill="${v.craterC || '#0a0f24'}" opacity=".22"/><ellipse rx="${(r * k).toFixed(1)}" ry="${r}" fill="none" stroke="#ffffff" stroke-width="${Math.max(2, r * .09).toFixed(1)}" opacity=".22" transform="translate(${(-r * k * .06).toFixed(1)} 0)"/></g>`; }).join('');
    const phase = () => !v.phase ? '' : `<defs><filter id="${p}term" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${v.phase.soft || 34}"/></filter><mask id="${p}ph" ${U}><rect width="1024" height="1024" fill="#fff"/><circle cx="${512 + v.phase.dx}" cy="${512 + (v.phase.dy || 0)}" r="${v.phase.r || 420}" fill="#000" filter="url(#${p}term)"/></mask></defs><rect width="1024" height="1024" fill="${v.phase.c || '#03061a'}" opacity="${v.phase.o || .82}" mask="url(#${p}ph)"/>`;
    const globe = `${this.polys2(faces, colorFn, v.edgeC || 'rgba(200,235,255,.22)', v.edgeW || 2.5)}<g clip-path="url(#${p}disc)">${craters()}<circle cx="512" cy="512" r="401" fill="url(#${p}limb)"/><circle cx="512" cy="512" r="396" fill="none" stroke="url(#${p}rim)" stroke-width="10"/>${v.frost ? `<circle cx="512" cy="512" r="401" fill="#efeaff" opacity="${v.frost}"/>` : ''}<ellipse cx="470" cy="300" rx="300" ry="185" fill="url(#${p}gloss)" opacity="${v.glossO ?? 1}"/>${phase()}${v.overlay ? v.overlay(p) : ''}</g>${v.outer ? v.outer(p) : ''}`;
    const dust = front => {
      const d = v.dust; let s = 4242; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
      const gauss = () => (r() + r() + r() - 1.5) / 1.5;
      const cols = ['#fff36b', '#ffc22a', '#f47a12', '#c2410a']; let out = '';
      for (let i = 0; i < d.n; i++) {
        const t = r() * Math.PI * 2, w = d.taper ? 0.15 + 0.85 * Math.pow((1 + Math.cos(t - 0.9)) / 2, 1.4) : 1;
        if (d.taper && r() > 0.25 + 0.75 * w) continue;
        const off = gauss() * d.spread * (d.taper ? 0.6 + 1.2 * (1 - w) : 1);
        const x = 512 + (480 + off * 0.4) * Math.cos(t), y = 512 + (112 + off) * Math.sin(t);
        if ((y > 512) !== front) continue;
        const big = r() < d.big;
        const rad = big ? 10 + r() * 6 : 3 + Math.pow(r(), 1.6) * 6;
        out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(rad * (d.taper ? 0.5 + 0.7 * w : 1)).toFixed(1)}" fill="${this.ramp(cols, (x - 40) / 944)}" opacity="${(0.6 + 0.4 * r()).toFixed(2)}"/>`;
      }
      const core = d.core ? `<ellipse cx="512" cy="512" rx="480" ry="112" fill="none" stroke="url(#${p}ring)" stroke-width="${d.core}" opacity="${front ? .7 : .5}" ${front ? `clip-path="url(#${p}front)"` : ''}/>` : '';
      return `<g transform="rotate(-18 512 512)">${core}${out}</g>`;
    };
const erode = (front, part = 'all') => {
      const e = v.erode; let s = 777; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
      const pk = e.peak ?? 0.5, br = u => e.from + (e.to - e.from) * (0.5 - 0.5 * Math.cos(2 * Math.PI * (u - pk + 0.5)));
      const clip = front ? `clip-path="url(#${p}front)"` : '';
      let lanes = '';
      [-14, 0, 14].forEach((o, li) => {
        const rx = 480 + o, ry = 112 + o, h = ((rx - ry) / (rx + ry)) ** 2;
        const Lc = Math.PI * (rx + ry) * (1 + 3 * h / (10 + Math.sqrt(4 - 3 * h)));
        const da = []; let pos = 0;
        while (pos < Lc) { const b = Math.min(.95, br(pos / Lc) * (li === 1 ? 0.7 : 1.25)); const dl = 14 + r() * 70 * (1 - b); const gl = dl * b / (1 - b) * (0.4 + r() * 1.2); da.push(dl.toFixed(1), gl.toFixed(1)); pos += dl + gl; }
        lanes += `<ellipse cx="512" cy="512" rx="${rx}" ry="${ry}" fill="none" stroke="url(#${p}ring)" stroke-width="21" stroke-linecap="round" stroke-dasharray="${da.join(' ')}" opacity="${front ? 1 : .8}" ${clip}/>`;
      });
      const cols = ['#fff36b', '#ffc22a', '#f47a12', '#c2410a']; let dots = '';
      if (e.wide) {
        const g = () => (r() + r() + r() + r() - 2) / 0.58;
        let placed = 0;
        for (let i = 0; i < (e.shape ? 40000 : 7000) && !(e.shape && placed >= e.n); i++) {
          const t = r() * Math.PI * 2, b = br(t / (2 * Math.PI));
          if (r() > Math.min(1, b * 1.6)) continue;
          if ((Math.sin(t) > 0) !== front) continue;
          const sg = 800 * b / 4; let ox = g() * sg, oy = g() * sg;
          if (e.disk) { const an = r() * Math.PI * 2, rr = Math.sqrt(r()) * 800 * b * 0.5 * e.disk; ox = rr * Math.cos(an) * (e.ax || 1); oy = rr * Math.sin(an) * (e.ay || 1); } if (e.shape && Math.cos(t) < -0.5) ox = Math.abs(ox); if (e.shape && Math.cos(t) > 0.5) ox = -Math.abs(ox); const dist = Math.hypot(ox, oy) / (e.disk ? 400 * b * e.disk : sg * 2.2);
          const x = 512 + 480 * Math.cos(t) + ox, y = 512 + 112 * Math.sin(t) + oy;
          const a = -18 * Math.PI / 180, gx = 512 + (x - 512) * Math.cos(a) - (y - 512) * Math.sin(a), gy = 512 + (x - 512) * Math.sin(a) + (y - 512) * Math.cos(a);
          const m = Math.min(gx - 40, 984 - gx, gy - 40, 984 - gy), fall = Math.min(1, m / 140);
          if (m < 0 || r() > fall) continue;
          const rad = (r() < .05 ? 8 + r() * 6 : 2.2 + Math.pow(r(), 1.7) * 6) * (1 - 0.45 * Math.min(1, dist)) * (0.5 + 0.5 * fall);
          const op = Math.max(0.25, 1 - 0.7 * Math.min(1, dist)) * (0.75 + 0.25 * r()) * (0.4 + 0.6 * fall);
          const col = this.ramp(cols, (x - 40) / 944);
          if (e.shape) {
            placed++;
            const dd = Math.min(1, dist), sz = (e.min + Math.pow(r(), e.pow) * (e.max - e.min)) * (1 - (e.grad || 0.3) * dd) * (0.6 + 0.4 * fall), rot = r() * Math.PI * 2;
            const kind = e.shape === 'mix' ? (r() < .6 ? 'tri' : 'dia') : e.shape;
            const n = kind === 'tri' ? 3 : 4, pts = [];
            for (let k = 0; k < n; k++) { const an = rot + k * 2 * Math.PI / n + (r() - .5) * (kind === 'tri' ? 0.9 : 0.25), rr = sz * (kind === 'dia' && k % 2 ? 0.55 : 0.8 + r() * 0.4); pts.push([x + rr * Math.cos(an), y + rr * Math.sin(an)]); }
            const P = q => q.map(z => z[0].toFixed(1) + ',' + z[1].toFixed(1)).join(' ');
            const bc = this.ramp(['#fff36b', '#ffc22a', '#ff9a1f', '#f47a12'], (x - 40) / 944);
            const lit = `<polygon points="${P([[x, y], pts[0], pts[1]])}" fill="#ffffff" opacity=".5"/>`, shd = `<polygon points="${P([[x, y], pts[n - 2], pts[n - 1]])}" fill="#e2560e" opacity=".35"/>`;
            dots += `<g><polygon points="${P(pts)}" fill="${bc}"/>${sz > 16 ? lit + shd : sz > 9 ? lit : ''}</g>`;
          } else dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad.toFixed(1)}" fill="${col}" opacity="${op.toFixed(2)}"/>`;
        }
      }
      for (let i = 0; i < (e.wide ? 0 : 2600); i++) {
        const t = r() * Math.PI * 2, b = br(t / (2 * Math.PI));
        if (r() > b * 1.5) continue;
        const off = (r() + r() + r() - 1.5) / 1.5 * (24 + 70 * b);
        const x = 512 + (480 + off * 0.5) * Math.cos(t), y = 512 + (112 + off) * Math.sin(t);
        if ((y > 512) !== front) continue;
        { const a = -18 * Math.PI / 180, gx = 512 + (x - 512) * Math.cos(a) - (y - 512) * Math.sin(a), gy = 512 + (x - 512) * Math.sin(a) + (y - 512) * Math.cos(a); if (gx < 70 || gx > 954 || gy < 70 || gy > 954) continue; }
        const rad = r() < .05 ? 9 + r() * 6 : 2.5 + Math.pow(r(), 1.6) * 6;
        dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad.toFixed(1)}" fill="${this.ramp(cols, (x - 40) / 944)}" opacity="${(0.6 + 0.4 * r()).toFixed(2)}"/>`;
      }
      const front2 = e.shape && front;
      return `<g transform="rotate(-18 512 512)">${part !== 'dots' ? lanes : ''}${(part === 'dots' || !front2) ? dots : ''}</g>`;
    };
const rings = front => {
      const kind = v.rings, F = n => n.toFixed(1), clip = front ? `clip-path="url(#${p}front)"` : '', op = front ? 1 : .85;
      const band = (wf, t0, t1, N = 220) => { const o = [], i = []; for (let k = 0; k <= N; k++) { const t = t0 + (t1 - t0) * k / N, w = wf(k / N, t) / 2; o.push(F(512 + (480 + w) * Math.cos(t)) + ',' + F(512 + (112 + w) * Math.sin(t))); i.push(F(512 + (480 - w) * Math.cos(t)) + ',' + F(512 + (112 - w) * Math.sin(t))); } return 'M' + o.join(' L') + ' L' + i.reverse().join(' L') + ' Z'; };
      const star = (x, y, s, rot = 0) => `<path transform="translate(${F(x)} ${F(y)}) rotate(${rot})" d="M0 ${-s} Q0 0 ${s} 0 Q0 0 0 ${s} Q0 0 ${-s} 0 Q0 0 0 ${-s} Z" fill="#fff6c8"/>`;
      const at = (t, o = 0) => [512 + (480 + o) * Math.cos(t), 512 + (112 + o) * Math.sin(t)];
      const head = 0.1 * Math.PI, len = 1.7 * Math.PI;
      let out = '', extra = '';
      if (kind === 'saturn') {
        out = [[-34, 12, .75], [-6, 26, 1], [24, 12, .85], [46, 5, .55]].map(([o, w, a]) => `<ellipse cx="512" cy="512" rx="${480 + o}" ry="${112 + o}" fill="none" stroke="url(#${p}ring)" stroke-width="${w}" opacity="${a * op}" ${clip}/>`).join('');
      } else if (kind === 'comet' || kind === 'sparkle') {
        out = `<path d="${band((u) => 3 + 58 * Math.pow(u, 1.8), head - len, head)}" fill="url(#${p}ring)" opacity="${op}" ${clip}/>`;
        if (front) { const [hx, hy] = at(head); extra += `<circle cx="${F(hx)}" cy="${F(hy)}" r="46" fill="url(#${p}hglow)"/><circle cx="${F(hx)}" cy="${F(hy)}" r="17" fill="#fff8d6"/>`; }
        if (kind === 'sparkle') [[0.18, 26, 30], [0.32, 18, -40], [0.47, 30, 50], [0.6, 14, -20], [0.74, 20, 10]].forEach(([u, s, o]) => { const t = head - len * (1 - u) - 0.0, pt = at(t, o); if ((Math.sin(t) > 0) === front) extra += star(pt[0], pt[1], s, 15); });
      } else if (kind === 'orbit') {
        const n = 16; for (let k = 0; k < n; k++) { const u = k / (n - 1), t1 = head - len * (1 - u), seg = 0.05 + 0.16 * u, w = 8 + 26 * u; out += `<path d="${band(() => w, t1 - seg, t1, 24)}" fill="url(#${p}ring)" opacity="${op}" ${clip}/>`; }
        if (front) { const [hx, hy] = at(head + 0.12); extra += `<circle cx="${F(hx)}" cy="${F(hy)}" r="70" fill="url(#${p}hglow)"/><circle cx="${F(hx)}" cy="${F(hy)}" r="34" fill="url(#${p}moon)"/>`; }
      } else if (kind === 'rib') {
        const q = v.rib, wf = (u, t) => q.min + (q.max - q.min) * Math.pow(0.5 + 0.5 * Math.sin(t + (q.phase || 0)), q.pow);
        out = `<path d="${band(wf, 0, 2 * Math.PI, 360)}" fill="url(#${p}ring)" ${v.ribOutline ? `stroke="${v.ribOutline}" stroke-width="7" stroke-linejoin="round"` : ''} opacity="${op}" ${clip}/>`;
        if (q.inner) out += `<path d="${band((u, t) => wf(u, t) * 0.38, 0, 2 * Math.PI, 360)}" fill="#fff4b8" opacity="${.75 * op}" ${clip}/>`;
        if (q.edge) out += `<g ${clip}><path d="${band((u, t) => 4, 0, 2 * Math.PI, 360).replace(/./g, c => c)}" fill="none"/></g><ellipse cx="512" cy="512" rx="${480 + q.edge}" ry="${112 + q.edge}" fill="none" stroke="#fff8d6" stroke-width="3.5" opacity="${.7 * op}" ${clip}/>`;
      } else if (kind === 'ribbon') {
        out = `<path d="${band((u, t) => 10 + 52 * Math.pow(0.5 + 0.5 * Math.sin(t), 1.6), 0, 2 * Math.PI, 360)}" fill="url(#${p}ring)" opacity="${op}" ${clip}/><ellipse cx="512" cy="512" rx="486" ry="118" fill="none" stroke="#fff8d6" stroke-width="4" opacity="${.6 * op}" ${clip}/>`;
      }
      return `<g transform="rotate(-18 512 512)">${out}${extra}</g>`;
    };
    const ring = front => v.noRing ? '' : v.rings ? rings(front) : v.erode ? erode(front) : v.dust ? dust(front) : `<g transform="rotate(-18 512 512)" ${v.ringBlur ? `filter="url(#${p}rblur)"` : ''}><ellipse cx="512" cy="512" rx="480" ry="112" fill="none" stroke="url(#${p}ring)" stroke-width="${v.ringW || 16}" opacity="${front ? (v.ringStops ? 1 : .55) : (v.ringStops ? .8 : .3)}" ${front ? `clip-path="url(#${p}front)"` : ''}/></g>`;
    const starfield = () => { if (!v.stars || v.noStars || v.unplated) return ''; const q = v.stars; let s = 2026; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; let o = '';
      const spark = (x, y, k, rot) => `<path transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot})" d="M0 ${-k} Q0 0 ${k} 0 Q0 0 0 ${k} Q0 0 ${-k} 0 Q0 0 0 ${-k} Z" fill="#ffffff"/>`;
      let placed = 0;
      for (let i = 0; i < 4000 && placed < q.n; i++) { const x = 30 + r() * 964, y = 30 + r() * 964; if (Math.hypot(x - 512, y - 512) < 425) continue; placed++; const big = r() < q.big; const rad = big ? 2.6 + r() * 2 : 1 + Math.pow(r(), 2) * 2.2; const warm = r() < .18; o += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad.toFixed(1)}" fill="${warm ? '#fff1c2' : '#dceaff'}" opacity="${(0.45 + 0.55 * r()).toFixed(2)}"/>`; }
      (q.sparks || []).forEach(([x, y, k]) => { o += `<circle cx="${x}" cy="${y}" r="${k * 1.1}" fill="url(#${p}sglow)"/>` + spark(x, y, k, 0) + `<g opacity=".7">${spark(x, y, k * 0.55, 45)}</g>`; });
      return `<radialGradient id="${p}sglow"><stop offset="0" stop-color="#cfe6ff" stop-opacity=".7"/><stop offset="1" stop-color="#cfe6ff" stop-opacity="0"/></radialGradient>` + o; };
    let body = starfield() + (v.light ? '' : `<circle cx="512" cy="512" r="440" fill="url(#${p}glow)"/>`) + ring(false);
    const gs = globe + ring(true);
    const shSoft = (o = .55) => `<g transform="translate(8 18)" opacity="${o}" filter="url(#${p}soft)">${S('#020830', 14)}</g>`;
    const shHard = `<g transform="translate(14 20)" opacity=".6">${S('#04103f', 14)}</g>`;
    const shine = `<g transform="translate(-6 -12)" opacity=".5">${S('#ffffff', -40)}</g>`;
    const bfacets = () => { let s = 11; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
      const N = 8, x0 = 220, y0 = 220, cw = 600 / N, ch = 620 / N, P = [];
      for (let i = 0; i <= N; i++) { P[i] = []; for (let j = 0; j <= N; j++) { const e = i === 0 || j === 0 || i === N || j === N; P[i][j] = [x0 + j*cw + (e ? 0 : (r()-.5)*cw*.7), y0 + i*ch + (e ? 0 : (r()-.5)*ch*.7)]; } }
      const ramp = ['#7fbfff', '#bfe0ff', '#eef8ff', '#ffffff']; let out = '';
      const tri = (a, b, c) => { const cy = (a[1]+b[1]+c[1])/3, cx = (a[0]+b[0]+c[0])/3; const t = 1 - (cy - 220)/700 * .8 - (cx - 220)/600 * .25 + (r()-.5)*.35; const col = this.ramp(ramp, t); out += `<polygon points="${[a,b,c].map(q => q[0].toFixed(1)+','+q[1].toFixed(1)).join(' ')}" fill="${col}" stroke="${col}" stroke-width="1.5" stroke-linejoin="round"/>`; };
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const a = P[i][j], b = P[i][j+1], c = P[i+1][j+1], d = P[i+1][j]; if ((i + j) % 2) { tri(a, b, c); tri(a, c, d); } else { tri(a, b, d); tri(b, c, d); } }
      return `<g mask="url(#${p}bm0)">${out}</g>`; };
    const glow = (c, k, o) => `<g filter="url(#${p}neon)" opacity="${o}">${S(c, k)}</g>`;
    if (v.fx === 'cust' && v.bOnly) { body = `<circle cx="512" cy="512" r="470" fill="#1f6bff" opacity=".18"/><g transform="translate(512 512) scale(1.5) translate(-520 -522)">${shSoft(.8)}${S('#ffffff', 8)}${S(`url(#${p}cust)`)}</g>`; }
    else if (v.fx === 'cust') { const deb = v.erode && v.erode.shape ? erode(true, 'dots') : ''; body += gs + (v.bFront ? deb : '') + shSoft(.7) + (v.glow ? glow(v.glow, 14, .9) : '') + (v.bKey ? S(v.bKey, 8) : '') + S(`url(#${p}cust)`) + (v.bFront ? '' : deb); }
    else if (v.fx === 'nIce') body += gs + shSoft(.7) + S(`url(#${p}nIce)`);
    else if (v.fx === 'nElec') body += gs + shSoft(.75) + S('#ffffff', 8) + S(`url(#${p}nElec)`);
    else if (v.fx === 'nGlow') body += gs + shSoft(.7) + glow('#00e5ff', 14, .95) + S(`url(#${p}ice)`);
    else if (v.fx === 'nEdge') body += gs + shSoft(.7) + glow('#00d4ff', 8, .8) + S('#00d8ff', 14) + S(`url(#${p}ice)`);
    else if (v.fx === 'nLaser') body += gs + shSoft(.7) + glow('#00c8ff', 14, .85) + S(`url(#${p}nLaser)`) + `<g opacity=".85">${S('#ffffff', -40)}</g>`;
    else if (v.fx === 'nRev') body += gs + shSoft(.75) + S('#ffffff', 8) + S(`url(#${p}nRev)`);
    else if (v.fx === 'ice') body += gs + shSoft(.7) + S(`url(#${p}ice)`);
    else if (v.fx === 'sky') body += gs + shSoft(.75) + S('#eaf8ff', 8) + S(`url(#${p}sky)`);
    else if (v.fx === 'diag') body += gs + shSoft(.7) + S(`url(#${p}diag)`);
    else if (v.fx === 'facet') body += gs + shSoft(.7) + bfacets();
    else if (v.fx === 'bevel') body += gs + shSoft(.7) + `<g transform="translate(7 9)">${S('#1f5fd6')}</g><g transform="translate(-5 -6)">${S('#f2faff')}</g>` + S(`url(#${p}bev)`, -14);
    else if (v.fx === 'clean') body += gs + shSoft(.7) + S(`url(#${p}white)`);
    else if (v.fx === 'diecut') body += gs + shHard + S('#ffffff', 40) + S('#0a1f6e', 26) + S(`url(#${p}white)`);
    else if (v.fx === 'gel') body += gs + shSoft() + S('#ffffff', 14) + S(`url(#${p}gel)`) + shine;
    else if (v.fx === 'gold') body += gs + shSoft() + S('#0a1f6e', 14) + S(`url(#${p}gold)`) + shine;
    else if (v.fx === 'hole') body += gs + `<g filter="url(#${p}halo)" opacity=".8">${S('#bff4ff', 26)}</g>` + S('#e8fbff', 14) + S(`url(#${p}inner)`);
    else if (v.fx === 'navy') body += gs + `<g filter="url(#${p}halo)" opacity=".9">${S('#bff4ff', 40)}</g>` + S('#ffffff', 14) + S('#0a1f6e');
    else if (v.fx === 'halo') {
      body += globe + ring(true) + `<g transform="translate(10 16)" opacity=".45">${S('#04103f', 14)}</g><g filter="url(#${p}halo)" opacity=".85">${S('#bff4ff', 26)}</g>${S('#0a1f6e', 14)}${S(`url(#${p}white)`)}`;
    } else if (v.fx === 'rim') {
      body += `<g mask="url(#${p}cut)">${globe}${ring(true)}${bS('#c4f6ff', 34)}</g>`;
    } else if (v.fx === 'sticker') {
      body += globe + ring(true) + `<g transform="translate(12 18)" opacity=".5">${bS('#04103f', 30)}</g>${bS('#0a1f6e', 30)}${bS(`url(#${p}white)`, 0)}`;
    } else {
      body += globe + ring(true) + `<g transform="translate(10 16)" opacity=".45">${bS('#04103f', 32)}</g>${bS('#ffffff', 32)}${bS(`url(#${p}gel)`, 0)}<g opacity=".55">${bS('#ffffff', -Math.round(b.w * 0.72))}</g>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="${size}" height="${size}">${defs}${v.unplated ? '' : `<rect width="1024" height="1024" fill="url(#${p}plate)"/>`}${body}</svg>`;
  }
}

const A = new Art();
let uid = 0;
const SEED = 7;
const KARM = (w = 148, sw = 112) => k => `<g fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round"><path d="M368 280 L368 770 M436 616 L676 770" stroke-width="${sw + 2 * k}"/><path d="M652 446 L436 616" stroke-width="${w + 2 * k}"/></g>`;
const SPATH = 'M700 370 C670 322 614 300 542 300 C452 300 394 344 394 410 C394 476 454 504 540 522 C636 542 696 576 696 640 C696 708 632 750 536 750 C456 750 398 726 368 676';
const SMASK = (w = 144, cap = 'round') => k => `<path d="${SPATH}" fill="none" stroke="#fff" stroke-width="${w + 2 * k}" stroke-linecap="${cap}" stroke-linejoin="round"/>`;
const BMASK = k => `<path d="M368 280 L368 770 M652 446 L436 616 L676 770" fill="none" stroke="#fff" stroke-width="${112 + 2 * k}" stroke-linecap="round" stroke-linejoin="round"/>`;
const SWEEP = [[0, '#fff36b'], [.35, '#ffc22a'], [.7, '#f47a12'], [1, '#c2410a']];
const BASE = {
  fx: 'cust', stops: [[0, '#ffffff'], [.42, '#5cf2ff'], [1, '#0aa0ff']], land4: true, bmask: BMASK,
  tf: 'translate(56 0) translate(512 512) skewX(-12) translate(-534 -525)',
  ringStops: SWEEP, ringAxis: true, rings: 'rib', rib: { min: 9, max: 92, pow: 2.2, phase: -0.75, edge: 8 },
  stars: { n: 110, big: 0.1, sparks: [[150, 160, 18], [884, 870, 14]] }
};
const PRIVATE = {
  main: ['#0e0730', '#24145e', '#42309e', '#6a55d6', '#a99bff'],
  landC: ['#160d40', '#2c1f6a', '#4a3b9a', '#7c6fd0'],
  plateC: ['#2a1660', '#06031a'], glowC: '#8f7bff', edgeC: 'rgba(225,215,255,.38)', frost: 0.16,
  stops: [[0, '#ffffff'], [.45, '#ddd4ff'], [1, '#9a86ff']],
  ringStops: [[0, '#f6f1ff'], [.4, '#cbbcff'], [.75, '#8d70f2'], [1, '#5a3cc8']]
};
export const PALETTE = [
  { name: 'Sval Blue', hex: '#1F6BFF', use: 'Primary brand blue: UI accents, wordmark, glyphs' },
  { name: 'Sky', hex: '#0AA0FF', use: 'Foot of the "S" gradient' },
  { name: 'Neon', hex: '#5CF2FF', use: 'Middle of the "S" gradient, highlights' },
  { name: 'Rim Mint', hex: '#5FF2E0', use: 'Cool rim light and glow on the moon' },
  { name: 'Night', hex: '#13328F', use: 'Plate and background centre' },
  { name: 'Midnight', hex: '#060A2E', use: 'Plate and background edge' },
  { name: 'Flare', hex: '#FFF36B', use: 'Installer arrow start' },
  { name: 'Ember', hex: '#F47A12', use: 'PDF cue, installer arrow, jump-list badges' },
  { name: 'Moon', hex: '#4F7CBC', use: 'Moon facets (icon only)' },
  { name: 'Private Violet', hex: '#6352B4', use: 'Private-browsing moon' }
];
const CRATERS = [[250, 330, 46], [178, 540, 30], [292, 712, 58], [470, 166, 34], [690, 214, 52], [812, 390, 38], [826, 612, 60], [640, 846, 40], [430, 864, 28], [222, 430, 18], [770, 770, 26], [586, 290, 20], [880, 500, 16]];
const MOON = { noRing: true, craters: CRATERS, glossO: .55, edgeC: 'rgba(255,255,255,.16)' };
const BREEZE = p => { const g = (id, a) => `<linearGradient id="${p}${id}" gradientUnits="userSpaceOnUse" x1="${a[0]}" y1="0" x2="${a[1]}" y2="0"><stop offset="0" stop-color="#e6fdff" stop-opacity="0"/><stop offset=".35" stop-color="#e6fdff" stop-opacity=".95"/><stop offset=".8" stop-color="#9ff0ff" stop-opacity=".9"/><stop offset="1" stop-color="#9ff0ff" stop-opacity="0"/></linearGradient>`;
  const L = [['M40 610 C250 560 430 680 660 630 C790 602 870 540 990 556', 34, [40, 990]], ['M120 724 C320 694 480 780 690 744 C800 726 870 690 940 698', 20, [120, 940]], ['M80 340 C240 312 360 380 540 356', 16, [80, 540]]];
  return `<defs>${L.map((l, i) => g('bz' + i, l[2])).join('')}</defs><g fill="none" stroke-linecap="round">${L.map((l, i) => `<path d="${l[0]}" stroke="url(#${p}bz${i})" stroke-width="${l[1]}"/>`).join('')}</g>`; };
const RIMF = (c0, c1, c2, sw = 16) => p => `<defs><radialGradient id="${p}rim" cx="78%" cy="20%" r="70%"><stop offset="0" stop-color="${c0}" stop-opacity=".55"/><stop offset=".45" stop-color="${c1}" stop-opacity=".18"/><stop offset="1" stop-color="${c1}" stop-opacity="0"/></radialGradient><linearGradient id="${p}rimS" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c2}"/><stop offset=".5" stop-color="${c1}" stop-opacity=".5"/><stop offset="1" stop-color="${c1}" stop-opacity="0"/></linearGradient></defs><rect width="1024" height="1024" fill="url(#${p}rim)"/><circle cx="512" cy="512" r="392" fill="none" stroke="url(#${p}rimS)" stroke-width="${sw}"/>`;
const RIM = RIMF('#b8fff4', '#5ff2e0', '#d6fff8'), RIM_P = RIMF('#f1e8ff', '#b8a4ff', '#f4eeff');
export const MOONS = {
  silver: Object.assign({}, MOON, { main: ['#20242f', '#4d5465', '#8e95a6', '#cdd2dc', '#f3f5f9'], landC: ['#1c2029', '#323846', '#525a6b', '#767e90'], glowC: '#cfdcff' }),
  warm: Object.assign({}, MOON, { main: ['#2e2218', '#6b5640', '#b09670', '#e6d2ad', '#fff6e2'], landC: ['#2a1f17', '#47382a', '#6a5641', '#8f7a60'], glowC: '#ffd79a', craterC: '#2a1608' }),
  blue: Object.assign({}, MOON, { main: ['#10173a', '#2d3a78', '#6177c0', '#a6b9f0', '#e9f0ff'], landC: ['#0f1534', '#1f295c', '#344486', '#5465a8'], glowC: '#8fb4ff' }),
  ice: Object.assign({}, MOON, { main: ['#0d2a46', '#2a6690', '#68b4d8', '#b6e8f6', '#f2fdff'], landC: ['#0b2238', '#184466', '#2c6a90', '#4b8fb4'], glowC: '#a8f4ff', craterC: '#062036', edgeC: 'rgba(230,252,255,.3)', glossO: .8 }),
  breeze: Object.assign({}, MOON, { main: ['#10173a', '#2d3a78', '#6177c0', '#a6b9f0', '#e9f0ff'], landC: ['#0f1534', '#1f295c', '#344486', '#5465a8'], glowC: '#9fe8ff', outer: BREEZE }),
  aurora: Object.assign({}, MOON, { main: ['#0c1a3c', '#24407a', '#4f7cbc', '#98c6ec', '#e6faff'], landC: ['#0c1834', '#1b3460', '#2d5288', '#4874a8'], glowC: '#5ff2e0', overlay: RIM }),
  auroraLight: Object.assign({}, MOON, { main: ['#56779f', '#7393bd', '#94b2d8', '#b4cde9', '#cfe2f3'], landC: ['#5e7ea8', '#7592ba', '#8daacc', '#a6c0dc'], glowC: '#5ff2e0', craterC: '#33507a', overlay: RIMF('#b8fff4', '#5ff2e0', '#d6fff8', 3), glossO: .25, meshN: 6, edgeW: .7, edgeC: 'rgba(225,240,255,.22)', craters: [[300, 150, 14], [420, 128, 9], [560, 140, 12], [690, 162, 10], [250, 200, 8], [780, 205, 13], [360, 190, 6], [610, 186, 7], [470, 210, 11], [180, 260, 10], [850, 270, 9]] }),
  crescent: Object.assign({}, MOON, { main: ['#20242f', '#4d5465', '#8e95a6', '#cdd2dc', '#f3f5f9'], landC: ['#1c2029', '#323846', '#525a6b', '#767e90'], glowC: '#cfdcff', phase: { dx: -250, dy: 70, r: 440, o: .8 } })
};
const PRIVATE_MOON = { main: ['#140b38', '#33246e', '#6352b4', '#a597e8', '#ece6ff'], landC: ['#120a30', '#25195a', '#3e3088', '#5d50aa'], glowC: '#b8a4ff', overlay: RIM_P };
const LIGHT = {
  light: true, bKey: '#0A1F6E', ribOutline: '#6B2205',
  stops: [[0, '#E8FBFF'], [.4, '#4FD6FF'], [1, '#1466E8']],
  ringStops: [[0, '#FFC61A'], [.35, '#FF9B14'], [.7, '#E2560E'], [1, '#A3300A']],
  rib: Object.assign({}, BASE.rib, { edge: 0 })
};
// Defaults to the Sval mark (SVAL: cool-rim moon, upright-ish S). opts.legacy: true for the earlier kuu/planet art.
// opts.moon: 'silver' | 'warm' | 'blue' | 'crescent', a moon exploration (no ribbon, cratered globe)
// opts.blueK: keep the standard blue k gradient (e.g. on the private palette)
// opts.kY: vertical offset of the k in 1024 units (negative = up)
// opts.glyph: 'S' swaps the k for an S (Sval exploration); gX/kY nudge it; skew (deg, default 12) and cap ('round'|'butt') tone it down
// opts.kW: stroke width of the whole k (default 112)
// opts.armW: stroke width of the k's upper arm (default 112, same as the stem)
// opts.unplated: no plate, no starfield (transparent background)
// opts.light: tuned for light backgrounds: deeper "k" with a navy keyline, deeper ribbon with a dark outline, no outer glow
export const SVAL = { moon: 'aurora', glyph: 'S', skew: 6, kW: 124 };
export function icon(tier = 'full', priv = false, opts = {}) {
  if (!opts.legacy) opts = Object.assign({}, SVAL, opts);
  const v = Object.assign({}, BASE, priv ? PRIVATE : {},
    tier === 'small' ? { noStars: true } : {},
    tier === 'tiny' ? { noStars: true, noRing: true, bOnly: true } : {},
    opts.moon ? Object.assign({}, MOONS[opts.moon], priv ? PRIVATE_MOON : {}) : {},
    opts.armW || opts.kW ? { bmask: KARM(opts.armW || opts.kW, opts.kW || 112) } : {},
    opts.blueK ? { stops: BASE.stops } : {},
    opts.kY ? { tf: BASE.tf.replace('translate(56 0)', `translate(56 ${opts.kY})`) } : {},
    opts.glyph === 'S' ? { bmask: SMASK(opts.kW || 144, opts.cap), tf: `translate(${opts.gX ?? (opts.skew === 0 ? -6 : 12)} ${opts.kY || 0}) translate(512 512) skewX(${-(opts.skew ?? 12)}) translate(-534 -525)` } : {},
    opts.noLetter ? { bmask: () => '' } : {},
    opts.unplated ? { unplated: true } : {},
    opts.light ? LIGHT : {},
    { id: 'i' + (uid++) });
  return A.svg3(v, 1024, SEED);
}
const strip = s => s.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const wrap = (w, h, body, vb) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${vb || `0 0 ${w} ${h}`}">${body}</svg>`;
function place(svg, x, y, size, r, id) {
  return `<defs><clipPath id="${id}"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}"/></clipPath></defs><g clip-path="url(#${id})"><g transform="translate(${x} ${y}) scale(${size / 1024})">${strip(svg)}</g></g>`;
}
const WM = [
  'M368 280 L368 770 M652 446 L436 616 L676 770',
  'M866 446 L866 604 C866 700 936 770 1032 770 C1128 770 1198 700 1198 604 M1198 446 L1198 770',
  'M1396 446 L1396 604 C1396 700 1466 770 1562 770 C1658 770 1728 700 1728 604 M1728 446 L1728 770'
];
const WCX = 936;
export const WM_LIGHT = [[0, '#2fd0ff'], [.5, '#1f6bff'], [1, '#1446c8']];
export const WM_DARK = [[0, '#ffffff'], [.42, '#5cf2ff'], [1, '#0aa0ff']];
export const WM_SVAL = [
  'M694 352 C664 302 608 280 536 280 C446 280 384 324 384 396 C384 466 446 496 534 516 C634 538 696 574 696 646 C696 722 628 770 530 770 C448 770 390 744 360 692',
  'M750 446 L906 770 L1062 446',
  'M1460 604 C1460 508 1392 446 1296 446 C1200 446 1130 516 1130 608 C1130 700 1200 770 1296 770 C1392 770 1460 700 1460 604 M1460 446 L1460 770',
  'M1592 280 L1592 770'
];
// S→v ligature: the S's top stroke runs into the v. 'flow' is the master wordmark (WM_SVAL is the unligated version)
export const WM_LIG = {
  flow: ['M1062 446 L906 770 L795 540 C730 405 650 280 536 280 C446 280 384 324 384 396 C384 466 446 496 534 516 C634 538 696 574 696 646 C696 722 628 770 530 770 C448 770 390 744 360 692', 'M1460 604 C1460 508 1392 446 1296 446 C1200 446 1130 516 1130 608 C1130 700 1200 770 1296 770 C1392 770 1460 700 1460 604 M1460 446 L1460 770', 'M1592 280 L1592 770'],
  canopy: ['M750 446 L906 770 L1062 446 C1097 374 1060 280 940 280 L536 280 C446 280 384 324 384 396 C384 466 446 496 534 516 C634 538 696 574 696 646 C696 722 628 770 530 770 C448 770 390 744 360 692', 'M1460 604 C1460 508 1392 446 1296 446 C1200 446 1130 516 1130 608 C1130 700 1200 770 1296 770 C1392 770 1460 700 1460 604 M1460 446 L1460 770', 'M1592 280 L1592 770']
};
// The ™ after the l, drawn in the letters' ink at a thinner stroke
export const WM_TM = ['M1700 296 L1752 296', 'M1726 296 L1726 366', 'M1774 366 L1774 296', 'M1774 296 L1803 342', 'M1803 342 L1832 296', 'M1832 296 L1832 366'];
const WM_TM_SW = 14;
// The lockup is placed by x 1036 of glyph space, so the word and ™ together sit where the word alone sat by WCX; the skew still pivots on WCX
const WM_TM_CX = 1036;
export const wordmarkLig = (fill, kind, h = 92) => wrap(372, 99, wordmarkG(fill, 186, 49.5, h, WM_LIG[kind], WCX));
export function wordmarkG(fill, cx, cy, h, G = WM_LIG.flow, WCX = 936, o = { skew: 6, sw: 100 }) {
  const s = h / 602, id = 'wm' + (uid++), grad = Array.isArray(fill), PX = WCX + WM_TM_CX - 936;
  const def = grad ? `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="224" x2="0" y2="826">${fill.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient></defs>` : '';
  return `${def}<g transform="translate(${cx} ${cy}) scale(${s}) translate(${-PX} -525)"><g transform="translate(${WCX} 525) skewX(${-(o.skew ?? 12)}) translate(${-WCX} -525)" fill="none" stroke="${grad ? `url(#${id})` : fill}" stroke-width="${o.sw || 112}" stroke-linecap="${o.cap || 'round'}" stroke-linejoin="round">${G.map(d => `<path d="${d}"/>`).join('')}${WM_TM.map(d => `<path d="${d}" stroke-width="${WM_TM_SW}"/>`).join('')}</g></g>`;
}
export const wordmark = fill => wrap(372, 99, wordmarkG(fill, 186, 49.5, 92));
function strokeOutline(d, hw, T) {
  const tk = d.match(/[MLC]|-?\d*\.?\d+/g); let i = 0, cmd, cur, sub = null; const subs = [];
  const num = () => +tk[i++];
  while (i < tk.length) {
    if (/[MLC]/.test(tk[i])) cmd = tk[i++];
    if (cmd === 'M') { cur = [num(), num()]; sub = []; subs.push(sub); cmd = 'L'; continue; }
    if (cmd === 'L') { const q = [num(), num()], t = [q[0] - cur[0], q[1] - cur[1]]; sub.push({ p: cur, t }, { p: q, t }); cur = q; }
    else if (cmd === 'C') {
      const c1 = [num(), num()], c2 = [num(), num()], e = [num(), num()], a = cur, N = 48;
      for (let j = 0; j <= N; j++) { const u = j / N, m = 1 - u;
        const p = [0, 1].map(k => m*m*m*a[k] + 3*m*m*u*c1[k] + 3*m*u*u*c2[k] + u*u*u*e[k]);
        const t = [0, 1].map(k => 3*m*m*(c1[k]-a[k]) + 6*m*u*(c2[k]-c1[k]) + 3*u*u*(e[k]-c2[k]));
        sub.push({ p, t }); }
      cur = e;
    }
  }
  return subs.map(s => {
    const nn = s.map(({ p, t }) => { const l = Math.hypot(t[0], t[1]); const tx = t[0] / l, ty = t[1] / l; return { p, tx, ty, nx: -ty, ny: tx }; });
    const L = nn.map(o => [o.p[0] + o.nx * hw, o.p[1] + o.ny * hw]), Rr = nn.map(o => [o.p[0] - o.nx * hw, o.p[1] - o.ny * hw]);
    const cap = (o, sgn) => { const out = []; for (let k = 1; k < 16; k++) { const an = Math.PI * k / 16; out.push([o.p[0] + sgn * hw * (o.nx * Math.cos(an) + o.tx * Math.sin(an)), o.p[1] + sgn * hw * (o.ny * Math.cos(an) + o.ty * Math.sin(an))]); } return out; };
    const poly = [...L, ...cap(nn[nn.length - 1], 1), ...Rr.reverse(), ...cap(nn[0], -1)].map(T);
    return 'M' + poly.map(q => q[0].toFixed(2) + ' ' + q[1].toFixed(2)).join(' L') + ' Z';
  }).join(' ');
}
// Single-colour wordmark for themed pages: every shape is fill="context-fill"; no gradients, filters, transforms or colours
export function wordmarkContextFill() {
  const s = 92 / 602, k = Math.tan(-6 * Math.PI / 180);
  const T = ([x, y]) => [186 + s * ((x - WM_TM_CX) + k * (y - 525)), 49.5 + s * (y - 525)];
  return wrap(372, 99, `<path fill="context-fill" fill-opacity="context-fill-opacity" d="${[...WM_LIG.flow.map(d => strokeOutline(d, 50, T)), ...WM_TM.map(d => strokeOutline(d, WM_TM_SW / 2, T))].join(' ')}"/>`);
}

const PAGE = 'M272 96 H636 L828 288 V884 Q828 928 784 928 H272 Q228 928 228 884 V140 Q228 96 272 96 Z';
function pageBase(id) {
  return `<defs><linearGradient id="${id}pg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e9eff9"/></linearGradient><filter id="${id}sh" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="18"/></filter></defs>
<path d="${PAGE}" transform="translate(0 18)" fill="#061650" opacity=".28" filter="url(#${id}sh)"/>
<path d="${PAGE}" fill="url(#${id}pg)" stroke="#c3cee2" stroke-width="6" stroke-linejoin="round"/>
<path d="M636 96 V244 Q636 288 680 288 H828 Z" fill="#d6e0f1" stroke="#c3cee2" stroke-width="6" stroke-linejoin="round"/>`;
}
export function documentIcon() {
  const id = 'd' + (uid++);
  return wrap(1024, 1024, pageBase(id) + `<rect x="312" y="196" width="250" height="20" rx="10" fill="#d3dcec"/><rect x="312" y="244" width="170" height="20" rx="10" fill="#d3dcec"/>` + place(icon('small'), 316, 392, 392, 88, id + 'c'));
}
export function pdfIcon() {
  const id = 'p' + (uid++);
  const L = [['M0 100 L0 0 L35 0 C60 0 72 14 72 30 C72 46 60 60 35 60 L0 60', 72], ['M0 0 L0 100 L28 100 C60 100 76 80 76 50 C76 20 60 0 28 0 Z', 76], ['M60 0 L0 0 L0 100 M0 48 L48 48', 60]];
  let x = 0, letters = '';
  L.forEach(([d, w]) => { letters += `<path transform="translate(${x} 0)" d="${d}"/>`; x += w + 34; });
  const total = x - 34, sc = 1.05;
  const g = `<g transform="translate(${528 - total * sc / 2} ${778 - 50 * sc}) scale(${sc})" fill="none" stroke="#ffffff" stroke-width="21" stroke-linecap="round" stroke-linejoin="round">${letters}</g>`;
  return wrap(256, 256, pageBase(id) + `<defs><linearGradient id="${id}or" x1="0" x2="1"><stop offset="0" stop-color="#ffb52e"/><stop offset="1" stop-color="#e2560e"/></linearGradient></defs><rect x="231" y="676" width="594" height="204" fill="url(#${id}or)"/>` + g + place(icon('small'), 372, 250, 312, 72, id + 'c'), '0 0 1024 1024');
}
export function diskIcon() {
  const id = 'k' + (uid++);
  return wrap(1024, 1024, `<defs><linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbfcff"/><stop offset=".6" stop-color="#e3e9f4"/><stop offset="1" stop-color="#c4cfe2"/></linearGradient><filter id="${id}s" x="-20%" y="-100%" width="140%" height="300%"><feGaussianBlur stdDeviation="22"/></filter><radialGradient id="${id}led"><stop offset="0" stop-color="#ffffff"/><stop offset=".4" stop-color="#5cf2ff"/><stop offset="1" stop-color="#5cf2ff" stop-opacity="0"/></radialGradient></defs>
<ellipse cx="512" cy="772" rx="400" ry="40" fill="#061650" opacity=".35" filter="url(#${id}s)"/>
<rect x="112" y="330" width="800" height="420" rx="84" fill="url(#${id}b)" stroke="#b3bfd6" stroke-width="5"/>
<rect x="140" y="348" width="744" height="34" rx="17" fill="#ffffff" opacity=".75"/>
${place(icon('small'), 172, 390, 300, 66, id + 'c')}
<rect x="530" y="582" width="250" height="16" rx="8" fill="#c0cbe0"/>
<circle cx="832" cy="590" r="28" fill="url(#${id}led)"/>`);
}
const glyphDefs = (id, h) => `<defs><linearGradient id="${id}g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${h}"><stop offset="0" stop-color="#2fd0ff"/><stop offset="1" stop-color="#1557e0"/></linearGradient><linearGradient id="${id}o" gradientUnits="userSpaceOnUse" x1="0" y1="${h * .45}" x2="0" y2="${h}"><stop offset="0" stop-color="#ffd23f"/><stop offset="1" stop-color="#f47a12"/></linearGradient></defs>`;
const badge = (id, k) => `<circle cx="${12 * k}" cy="${11 * k}" r="${4 * k}" fill="url(#${id}o)"/><rect x="${11 * k}" y="${9 * k}" width="${2 * k}" height="${4 * k}" fill="#fff"/><rect x="${10 * k}" y="${10 * k}" width="${4 * k}" height="${2 * k}" fill="#fff"/>`;
export function newTab(sz) {
  const k = sz / 16, id = 'nt' + (uid++);
  return wrap(sz, sz, glyphDefs(id, sz) + `<rect x="${1 * k}" y="${2 * k}" width="${7 * k}" height="${4 * k}" rx="${1.5 * k}" fill="url(#${id}g)"/><rect x="${1 * k}" y="${4 * k}" width="${13 * k}" height="${10 * k}" rx="${2 * k}" fill="url(#${id}g)"/><rect x="${3 * k}" y="${7 * k}" width="${5 * k}" height="${1 * k}" rx="${0.5 * k}" fill="#fff" opacity=".85"/><rect x="${3 * k}" y="${9 * k}" width="${3 * k}" height="${1 * k}" rx="${0.5 * k}" fill="#fff" opacity=".6"/>` + badge(id, k));
}
export function newWindow(sz) {
  const k = sz / 16, id = 'nw' + (uid++);
  return wrap(sz, sz, glyphDefs(id, sz) + `<rect x="${1 * k}" y="${2 * k}" width="${13 * k}" height="${12 * k}" rx="${2 * k}" fill="url(#${id}g)"/><rect x="${3 * k}" y="${6 * k}" width="${6 * k}" height="${6 * k}" rx="${0.75 * k}" fill="#ffffff" opacity=".9"/><circle cx="${3.5 * k}" cy="${4 * k}" r="${0.75 * k}" fill="#ffffff" opacity=".9"/><circle cx="${5.5 * k}" cy="${4 * k}" r="${0.75 * k}" fill="#ffffff" opacity=".6"/>` + badge(id, k));
}
function starDots(w, h, n, seed, scale = 1, avoid) {
  let s = seed; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  let o = '';
  for (let i = 0; i < n; i++) {
    const x = r() * w, y = r() * h, big = r() < .08, rad = (big ? 1.6 + r() * 1.4 : 0.5 + Math.pow(r(), 2) * 1.2) * scale, warm = r() < .18, op = 0.4 + 0.6 * r();
    if (avoid && avoid(x, y)) continue;
    o += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad.toFixed(2)}" fill="${warm ? '#fff1c2' : '#dceaff'}" opacity="${op.toFixed(2)}"/>`;
  }
  return o;
}
const night = (id, w, h, cx = '50%', cy = '38%') => `<defs><radialGradient id="${id}n" cx="${cx}" cy="${cy}" r="80%"><stop offset="0" stop-color="#13328f"/><stop offset="1" stop-color="#060a2e"/></radialGradient></defs><rect width="${w}" height="${h}" fill="url(#${id}n)"/>`;
export const DMG_TEXT = 'Drop Sval in Applications to get started';
// 2x pixels. Composition sits in the top-left 1440x880 (the 720x440 pt window); the rest is bleed.
export const DMG_SIZE = { w: 1680, h: 1120, windowW: 1440, windowH: 880 };
export const DMG_COPY = { text: DMG_TEXT, x: 720, y: 772, size: 40, weight: 600, color: '#13328F', font: "Figtree, 'Helvetica Neue', Helvetica, Arial, sans-serif" };
const HZ = { y: 548, sc: 3.4 }; HZ.R = 401 * HZ.sc;
export const dmgHorizonY = x => HZ.y + HZ.R - Math.sqrt(HZ.R * HZ.R - (x - 720) ** 2);
export function dmgBackground({ text = true } = {}) {
  const id = 'g' + (uid++), W = DMG_SIZE.w, H = DMG_SIZE.h, cy = HZ.y + HZ.R, c = DMG_COPY;
  const sky = `<defs><radialGradient id="${id}sky" gradientUnits="userSpaceOnUse" cx="720" cy="380" r="1150"><stop offset="0" stop-color="#13328f"/><stop offset="1" stop-color="#060a2e"/></radialGradient><linearGradient id="${id}land" gradientUnits="userSpaceOnUse" x1="0" y1="${HZ.y}" x2="0" y2="${H}"><stop offset="0" stop-color="#f2fcff"/><stop offset=".5" stop-color="#e2f2fc"/><stop offset="1" stop-color="#d2e6f6"/></linearGradient><clipPath id="${id}mc"><circle cx="720" cy="${cy}" r="${HZ.R}"/></clipPath><filter id="${id}hz" filterUnits="userSpaceOnUse" x="-200" y="300" width="${W + 400}" height="${H}"><feGaussianBlur stdDeviation="24"/></filter><linearGradient id="${id}ar" gradientUnits="userSpaceOnUse" x1="560" y1="0" x2="900" y2="0"><stop offset="0" stop-color="#fff36b"/><stop offset="1" stop-color="#f47a12"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#${id}sky)"/>`;
  const stars = starDots(W, H, 330, 99, 2, (x, y) => y > dmgHorizonY(x) - 36 || Math.hypot(x - 360, y - 440) < 190 || Math.hypot(x - 1080, y - 440) < 190);
  const planet = `<circle cx="720" cy="${cy}" r="${HZ.R + 14}" fill="#5ff2e0" opacity=".5" filter="url(#${id}hz)"/><g transform="translate(${720 - 512 * HZ.sc} ${HZ.y - 111 * HZ.sc}) scale(${HZ.sc})">${strip(icon('full', false, { unplated: true, noLetter: true, moon: 'auroraLight' }))}</g>`;
  const arrow = `<path d="M560 470 Q720 392 868 456" fill="none" stroke="url(#${id}ar)" stroke-width="14" stroke-linecap="round"/><path d="M0 -24 L40 0 L0 24 Z" transform="translate(868 456) rotate(23.5)" fill="#f47a12" stroke="#f47a12" stroke-width="8" stroke-linejoin="round"/>`;
  const t = text ? `<text x="${c.x}" y="${c.y}" text-anchor="middle" font-family="${c.font}" font-size="${c.size}" font-weight="${c.weight}" fill="${c.color}">${c.text}</text>` : '';
  return wrap(W, H, sky + stars + planet + arrow + t);
}
export function wizHeader(rtl = false) {
  const id = 'h' + (uid++), x = rtl ? 8 : 98;
  return wrap(150, 57, `<defs><linearGradient id="${id}g" x1="${rtl ? 1 : 0}" x2="${rtl ? 0 : 1}"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eef3ff"/></linearGradient></defs><rect width="150" height="57" fill="url(#${id}g)"/>` + place(icon('small'), x, 6.5, 44, 10, id + 'c'));
}
export function wizWatermark() {
  const id = 'w' + (uid++);
  return wrap(164, 314, night(id, 164, 314, '50%', '30%') + starDots(164, 314, 70, 7, 0.8, (x, y) => (x > 18 && x < 146 && y > 50 && y < 178)) + place(icon('full', false, { unplated: true }), 26, 58, 112, 25, id + 'c') + wordmarkG(WM_DARK, 82, 232, 34));
}
export function stubBg() {
  const id = 's' + (uid++), W = 1344, H = 822;
  return wrap(W, H, night(id, W, H, '50%', '35%') + starDots(W, H, 260, 31, 2, (x, y) => Math.hypot(x - 672, y - 280) < 210) + place(icon('full', false, { unplated: true }), 532, 140, 280, 62, id + 'c'));
}
export function aboutBg() {
  const id = 'a' + (uid++);
  return wrap(300, 236, night(id, 300, 236, '30%', '40%') + starDots(300, 236, 70, 13, 0.8) + `<defs><linearGradient id="${id}r" x1="0" x2="1"><stop offset="0" stop-color="#b8fff4" stop-opacity="0"/><stop offset=".5" stop-color="#5ff2e0"/><stop offset="1" stop-color="#5cf2ff"/></linearGradient></defs><path d="M-20 214 Q150 150 330 196" fill="none" stroke="url(#${id}r)" stroke-width="6" stroke-linecap="round" opacity=".85"/>`);
}
export function wideTile() {
  const id = 't' + (uid++);
  return wrap(620, 300, night(id, 620, 300, '35%', '45%') + starDots(620, 300, 90, 5, 1, (x, y) => (x > 50 && x < 290 && y > 30 && y < 270) || (x > 320 && x < 560 && y > 90 && y < 210)) + place(icon('full', false, { unplated: true }), 60, 40, 220, 48, id + 'c') + wordmarkG(WM_DARK, 440, 150, 96));
}
