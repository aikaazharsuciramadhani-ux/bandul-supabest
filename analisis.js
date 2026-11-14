/*
  analisis.js -- port JavaScript dari bandul_analisis.py (projek Arduino).
  Rumus dan urutan perhitungan sengaja dibuat sama persis supaya hasil web = hasil aplikasi desktop.
  Tanpa dependensi; bisa dipakai di browser (window.Bandul) maupun Node (require).
*/
(function (root) {
  'use strict';

  const DUA_PANGKAT_32 = 4294967296;
  const G_ACUAN = 9.78;

  // ------------------------------------------------------------ statistik kecil
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const mean = (a) => sum(a) / a.length;
  const median = (a) => {
    const s = a.slice().sort((x, y) => x - y);
    const n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  };
  const std1 = (a) => {               // simpangan baku sampel (ddof = 1)
    const m = mean(a);
    return Math.sqrt(sum(a.map((v) => (v - m) ** 2)) / (a.length - 1));
  };
  // Regresi linear kuadrat terkecil y = a + b x  (sama dengan np.polyfit(x, y, 1))
  function polyfit1(x, y) {
    const mx = mean(x), my = mean(y);
    let sxy = 0, sxx = 0;
    for (let i = 0; i < x.length; i++) {
      sxy += (x[i] - mx) * (y[i] - my);
      sxx += (x[i] - mx) ** 2;
    }
    const b = sxy / sxx;
    return { b, a: my - b * mx };
  }

  // ------------------------------------------------------------ CSV (format sama dengan aplikasi desktop)
  function bacaCSV(teks) {
    const meta = {}, tm = [], tk = [];
    for (const baris of teks.split(/\r?\n/)) {
      const b = baris.trim();
      if (!b) continue;
      if (b.startsWith('#')) {
        const i = b.indexOf('=');
        if (i > 0) {
          const nilai = parseFloat(b.slice(i + 1));
          if (Number.isFinite(nilai)) meta[b.slice(1, i).trim()] = nilai;
        }
        continue;
      }
      const bagian = b.split(',');
      if (bagian.length !== 2) continue;
      const m = parseInt(bagian[0], 10), k = parseInt(bagian[1], 10);
      if (!Number.isFinite(m) || !Number.isFinite(k)) continue;   // baris judul kolom
      tm.push(m); tk.push(k);
    }
    return { meta, tm, tk };
  }

  function tulisCSV(meta, tm, tk) {
    let s = '';
    if (meta.panjang_m != null) s += `# panjang_m=${meta.panjang_m}\n`;
    if (meta.lebar_m != null) s += `# lebar_penghalang_m=${meta.lebar_m}\n`;
    if (meta.jari_jari_m) s += `# jari_jari_penghalang_m=${meta.jari_jari_m}\n`;
    if (meta.massa_g) s += `# massa_g=${meta.massa_g}\n`;
    s += 't_masuk_us,t_keluar_us\n';
    for (let i = 0; i < tm.length; i++) s += `${Math.round(tm[i])},${Math.round(tk[i])}\n`;
    return s;
  }

  // ------------------------------------------------------------ waktu
  // Hilangkan efek micros() Arduino Uno yang berputar ke 0 (untuk CSV lama). Data ESP32 sudah
  // relatif dan tidak pernah turun, jadi langkah ini tidak mengubah apa pun untuknya.
  function bukaPutaranMicros(tm, tk) {
    const n = tm.length;
    const kejadian = new Array(2 * n);
    for (let i = 0; i < n; i++) { kejadian[2 * i] = tm[i]; kejadian[2 * i + 1] = tk[i]; }
    const total = [0];
    let akum = 0;
    for (let i = 1; i < kejadian.length; i++) {
      let d = kejadian[i] - kejadian[i - 1];
      if (d < 0) d += DUA_PANGKAT_32;
      akum += d;
      total.push(akum);
    }
    const tm_s = [], tk_s = [];
    for (let i = 0; i < n; i++) { tm_s.push(total[2 * i] / 1e6); tk_s.push(total[2 * i + 1] / 1e6); }
    return { tm_s, tk_s };
  }

  // ------------------------------------------------------------ periode
  const periodeTiapLewatan = (tt) => tt.slice(2).map((v, i) => v - tt[i]);

  function saringPeriode(Ti, toleransi = 0.2) {
    if (Ti.length === 0) return { T: [], topeng: [] };
    const med = median(Ti);
    const topeng = Ti.map((v) => Math.abs(v - med) <= toleransi * med);
    return { T: Ti.filter((_, i) => topeng[i]), topeng };
  }

  function periodeRegresi(tt) {
    const gr = [];
    for (const par of [0, 1]) {
      const y = tt.filter((_, i) => i % 2 === par);
      if (y.length >= 3) gr.push(polyfit1(y.map((_, i) => i), y).b);
    }
    return gr.length ? mean(gr) : NaN;
  }

  // ------------------------------------------------------------ fisika
  const gDariT = (L, T) => 4 * Math.PI ** 2 * L / T ** 2;

  function sudutDariKecepatan(v, L, g) {
    return v.map((vi) => {
      const c = Math.min(1, Math.max(-1, 1 - vi ** 2 / (2 * g * L)));
      return Math.acos(c);
    });
  }

  function redaman(tt, v) {
    const x = [], y = [];
    for (let i = 0; i < v.length; i++) if (v[i] > 0) { x.push(tt[i]); y.push(Math.log(v[i])); }
    if (x.length < 3) return { gamma: NaN, v0: NaN, r2: NaN };
    const { b, a } = polyfit1(x, y);
    const ym = mean(y);
    let ssRes = 0, ssTot = 0;
    for (let i = 0; i < x.length; i++) { ssRes += (y[i] - (a + b * x[i])) ** 2; ssTot += (y[i] - ym) ** 2; }
    return { gamma: -b, v0: Math.exp(a), r2: ssTot > 0 ? 1 - ssRes / ssTot : NaN };
  }

  // ------------------------------------------------------------ satu rekaman
  // L: panjang tali (m), w: lebar penghalang (m), tm/tk: mikrodetik, R: jari-jari penghalang (m, opsional)
  function analisisRekaman(L, w, tmUs, tkUs, opsi = {}) {
    const dL = opsi.dL ?? 0.002, toleransiT = opsi.toleransiT ?? 0.2;
    const R = opsi.R ? opsi.R : L;
    const buka = bukaPutaranMicros(tmUs, tkUs);
    const tm = [], tk = [], dt = [];
    for (let i = 0; i < buka.tm_s.length; i++) {
      const d = buka.tk_s[i] - buka.tm_s[i];
      if (d > 0) { tm.push(buka.tm_s[i]); tk.push(buka.tk_s[i]); dt.push(d); }
    }
    if (dt.length < 5) throw new Error('Data terlalu sedikit: minimal 5 lewatan yang valid.');

    const tt = tm.map((v, i) => (v + tk[i]) / 2);
    const vBeban = dt.map((d) => (w / d) * L / R);

    const Ti = periodeTiapLewatan(tt);
    const sar = saringPeriode(Ti, toleransiT);
    const T = mean(sar.T);
    const s = sar.T.length > 1 ? std1(sar.T) : 0;
    const dT = s / Math.sqrt(sar.T.length);
    const g = gDariT(L, T);
    const dg = g * Math.sqrt((dL / L) ** 2 + (2 * dT / T) ** 2);

    const theta = sudutDariKecepatan(vBeban, L, g);
    const T0 = T / (1 + mean(theta.map((x) => x * x)) / 16);
    const gKoreksi = gDariT(L, T0);
    const red = redaman(tt, vBeban);

    return {
      L, w, R, n_lewatan: tt.length,
      T, s_T: s, dT, T_regresi: periodeRegresi(tt),
      n_T_dibuang: Ti.length - sar.T.length,
      g, dg, g_koreksi: gKoreksi,
      theta_rata_deg: Math.sqrt(mean(theta.map((x) => x * x))) * 180 / Math.PI,
      v_maks: Math.max(...vBeban),
      gamma: red.gamma, v0: red.v0, r2_gamma: red.r2,
      t_setengah: red.gamma > 0 ? Math.LN2 / red.gamma : Infinity,
      t_tengah: tt, v: vBeban, T_i: Ti, T_i_terpakai: sar.topeng,
    };
  }

  // ------------------------------------------------------------ banyak percobaan
  function regresiT2L(Lm, T) {
    const n = Lm.length;
    const rentang = Math.max(...Lm) - Math.min(...Lm);
    if (n < 3 || rentang === 0) throw new Error('Butuh minimal 3 percobaan dengan panjang tali berbeda.');
    const T2 = T.map((t) => t * t);
    const { b, a } = polyfit1(Lm, T2);
    const res = T2.map((y, i) => y - (a + b * Lm[i]));
    const s2 = sum(res.map((r) => r * r)) / (n - 2);
    const mx = mean(Lm);
    const sxx = sum(Lm.map((x) => (x - mx) ** 2));
    const sb = Math.sqrt(s2 / sxx);
    const sa = Math.sqrt(s2 * (1 / n + mx ** 2 / sxx));
    const my = mean(T2);
    const ssTot = sum(T2.map((y) => (y - my) ** 2));
    const g = 4 * Math.PI ** 2 / b;
    return {
      gradien: b, d_gradien: sb, intersep: a, d_intersep: sa,
      g, dg: g * sb / b, r2: ssTot > 0 ? 1 - sum(res.map((r) => r * r)) / ssTot : NaN, n,
    };
  }

  function regresiTm(mG, T, Lm) {
    const n = mG.length;
    const nMassa = new Set(mG.map((v) => v.toFixed(6))).size;
    if (nMassa < 3) throw new Error('Butuh minimal 3 percobaan dengan massa beban berbeda.');
    let faktor = mG.map(() => 1), LAcuan = NaN, dinormalkan = false;
    if (Lm) {
      LAcuan = mean(Lm);
      if (Math.max(...Lm) - Math.min(...Lm) > 1e-9) { faktor = Lm.map((l) => Math.sqrt(LAcuan / l)); dinormalkan = true; }
    }
    const Tn = T.map((t, i) => t * faktor[i]);
    const { b, a } = polyfit1(mG, Tn);
    const res = Tn.map((y, i) => y - (a + b * mG[i]));
    const s2 = sum(res.map((r) => r * r)) / (n - 2);
    const mx = mean(mG);
    const sxx = sum(mG.map((x) => (x - mx) ** 2));
    const sb = Math.sqrt(s2 / sxx);
    const my = mean(Tn);
    const ssTot = sum(Tn.map((y) => (y - my) ** 2));
    const tGrad = sb > 0 ? b / sb : (b === 0 ? 0 : Math.sign(b) * Infinity);
    return {
      gradien: b, d_gradien: sb, intersep: a, n, n_massa: nMassa,
      r2: ssTot > 0 ? 1 - sum(res.map((r) => r * r)) / ssTot : NaN,
      T_rata: my, t_gradien: tGrad, L_acuan: LAcuan, dinormalkan,
      perubahan_persen: b * (Math.max(...mG) - Math.min(...mG)) / my * 100,
      T_norm: Tn,
    };
  }

  // Penilaian g terhadap g acuan, ambang sama dengan kesesuaian_teori.py (2% dan 5%).
  function nilaiG(g, gAcuan) {
    const sel = (g - gAcuan) / gAcuan * 100;
    const a = Math.abs(sel);
    const status = a <= 2 ? 'sesuai' : a <= 5 ? 'cukup' : 'tidak';
    const label = { sesuai: 'SESUAI', cukup: 'CUKUP SESUAI', tidak: 'BELUM SESUAI' }[status];
    return { selisih_persen: sel, status, label };
  }

  const api = {
    G_ACUAN, bacaCSV, tulisCSV, bukaPutaranMicros, analisisRekaman, regresiT2L, regresiTm, nilaiG,
    periodeTiapLewatan, saringPeriode, periodeRegresi, gDariT, polyfit1,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Bandul = api;
})(typeof window !== 'undefined' ? window : globalThis);
