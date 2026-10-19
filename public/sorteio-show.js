'use strict';

// Tela de sorteio em cima do painel: estrada com Fusca e Kombi, placa Mercosul girando os códigos,
// rufar de tambor, buzina e confete na revelação. Sem bibliotecas; o som é gerado pelo próprio
// navegador (Web Audio), sem arquivos de áudio.
(function () {
  const reduzirMovimento = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const CSS = `
  .sh-dlg { border: 0; padding: 0; width: 100vw; height: 100dvh; max-width: none; max-height: none; background: transparent; overflow: hidden; }
  .sh-dlg::backdrop { background: rgba(1, 10, 45, .62); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
  .sh-dlg[open] { display: grid; place-items: center; }
  .sh-palco {
    position: relative; width: min(980px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); overflow: auto;
    border-radius: 22px; color: #fff; text-align: center; font-family: Inter, system-ui, sans-serif;
    background: radial-gradient(120% 90% at 50% 0%, #1b3fc0 0%, #0a1a80 38%, #011250 75%);
    box-shadow: 0 40px 120px rgba(0, 0, 0, .55); padding: 22px 22px 26px;
  }
  .sh-topo { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .sh-marca { display: flex; align-items: center; gap: 12px; text-align: left; }
  .sh-marca img { width: 44px; height: 44px; border-radius: 50%; box-shadow: 0 0 0 3px rgba(255,255,255,.2); }
  .sh-marca strong { display: block; font-size: 1.05rem; }
  .sh-marca span { font-size: .85rem; opacity: .75; }
  .sh-som, .sh-x { background: rgba(255,255,255,.12); border: 0; color: #fff; width: 42px; height: 42px; border-radius: 50%; font-size: 1.15rem; cursor: pointer; }
  .sh-som:hover, .sh-x:hover { background: rgba(255,255,255,.22); }
  .sh-acoes-topo { display: flex; gap: 8px; }
  .sh-status { margin: 18px 0 10px; font-size: clamp(1rem, 2.6vw, 1.25rem); font-weight: 700; letter-spacing: .02em; min-height: 1.6em; }

  /* Estrada */
  .sh-estrada { position: relative; height: 150px; margin: 6px -22px 20px; overflow: hidden;
    background: linear-gradient(#2b2f3a, #20232c); border-top: 4px solid #c9ced8; border-bottom: 4px solid #c9ced8; }
  .sh-faixa { position: absolute; left: 0; right: 0; top: 50%; height: 6px; margin-top: -3px;
    background: repeating-linear-gradient(90deg, #f5d000 0 46px, transparent 46px 92px); animation: sh-faixa .5s linear infinite; }
  .sh-dlg.devagar .sh-faixa { animation-duration: 1.6s; }
  .sh-dlg.parado .sh-faixa { animation-play-state: paused; }
  @keyframes sh-faixa { to { background-position: -92px 0; } }
  .sh-carro { position: absolute; bottom: 6px; width: 170px; animation: sh-passa linear infinite; }
  .sh-carro.c1 { animation-duration: 2.4s; bottom: 72px; width: 130px; }
  .sh-carro.c2 { animation-duration: 3.4s; animation-delay: -1.6s; }
  .sh-dlg.devagar .sh-carro { animation-duration: 6s; }
  .sh-dlg.parado .sh-carro { animation-play-state: paused; }
  .sh-carro .roda { transform-box: fill-box; transform-origin: center; animation: sh-gira .35s linear infinite; }
  .sh-dlg.parado .sh-carro .roda { animation-play-state: paused; }
  @keyframes sh-passa { from { left: -200px; } to { left: 100%; } }
  @keyframes sh-gira { to { transform: rotate(360deg); } }

  /* Placa Mercosul */
  .sh-placa { display: inline-block; background: #fff; color: #111; border-radius: 14px; border: 4px solid #111;
    min-width: min(520px, 100%); max-width: 100%; box-shadow: 0 16px 50px rgba(0,0,0,.35); overflow: hidden; transition: transform .25s, box-shadow .25s; }
  .sh-placa .faixa { background: #003399; color: #fff; display: flex; align-items: center; justify-content: space-between;
    padding: 6px 14px; font-weight: 800; font-size: .95rem; letter-spacing: .25em; }
  .sh-placa .faixa .bandeira { width: 26px; height: 18px; border-radius: 2px; background: linear-gradient(#009c3b 0 0) ; position: relative; }
  .sh-placa .faixa .bandeira::after { content: ''; position: absolute; inset: 3px 5px; background: #ffdf00; clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%); }
  .sh-placa .codigo { font-family: "Arial Narrow", "Roboto Condensed", Inter, sans-serif; font-weight: 800;
    font-size: clamp(3rem, 12vw, 6.4rem); letter-spacing: .06em; padding: 8px 20px 12px; line-height: 1.05; font-variant-numeric: tabular-nums; }
  .sh-dlg.girando .sh-placa .codigo { filter: blur(.6px); }
  .sh-dlg.revelado .sh-placa { transform: scale(1.06); box-shadow: 0 0 0 6px #ffd400, 0 0 60px rgba(255, 212, 0, .55), 0 16px 50px rgba(0,0,0,.35); }
  .sh-vencedor { margin-top: 18px; min-height: 5.2em; }
  .sh-vencedor .nome { font-size: clamp(1.5rem, 4.6vw, 2.4rem); font-weight: 800; }
  .sh-vencedor .info { opacity: .8; margin-top: 6px; font-size: .95rem; }
  .sh-vencedor .erro { color: #ffd1d1; font-weight: 700; }
  .sh-botoes { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-top: 14px; }
  .sh-botoes button { font: inherit; font-weight: 700; border-radius: 12px; padding: 12px 22px; cursor: pointer; border: 0; }
  .sh-botoes .prim { background: #fff; color: #011250; }
  .sh-botoes .sec { background: rgba(255,255,255,.14); color: #fff; }
  .sh-botoes button:disabled { opacity: .5; cursor: not-allowed; }
  .sh-confete { position: absolute; inset: 0; pointer-events: none; }
  @media (prefers-reduced-motion: reduce) { .sh-carro, .sh-carro .roda, .sh-faixa { animation: none !important; } .sh-carro.c1 { left: 8%; } .sh-carro.c2 { left: 55%; } }
  @media (max-width: 600px) { .sh-estrada { height: 116px; } .sh-carro { width: 128px; } .sh-carro.c1 { width: 100px; bottom: 56px; } }
  `;

  // Fusca e Kombi estilizados (silhuetas genéricas desenhadas aqui).
  const FUSCA = (cor) => `
  <svg viewBox="0 0 200 92" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M12 70 C10 54 22 46 40 44 C52 18 80 8 104 8 C132 8 154 22 166 44 C182 46 192 54 190 70 Z" fill="${cor}"/>
    <path d="M58 44 C66 26 82 17 100 17 L100 44 Z M108 44 L108 17 C126 18 142 28 150 44 Z" fill="#cfe3ff" opacity=".9"/>
    <rect x="12" y="64" width="178" height="6" rx="3" fill="#d9dde5"/>
    <circle cx="183" cy="56" r="4" fill="#ffe680"/>
    <g class="roda"><circle cx="52" cy="72" r="16" fill="#15171c"/><circle cx="52" cy="72" r="7" fill="#c9ced8"/><rect x="50" y="58" width="4" height="28" fill="#15171c"/></g>
    <g class="roda"><circle cx="152" cy="72" r="16" fill="#15171c"/><circle cx="152" cy="72" r="7" fill="#c9ced8"/><rect x="150" y="58" width="4" height="28" fill="#15171c"/></g>
  </svg>`;
  const KOMBI = (cor) => `
  <svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M10 80 L10 30 C10 16 20 8 36 8 L170 8 C184 8 192 18 194 34 L196 80 Z" fill="#f4f1e8"/>
    <path d="M10 52 L196 52 L196 80 L10 80 Z" fill="${cor}"/>
    <path d="M160 52 L178 30 L196 52 Z" fill="${cor}"/>
    <rect x="24" y="18" width="30" height="22" rx="4" fill="#cfe3ff"/><rect x="62" y="18" width="30" height="22" rx="4" fill="#cfe3ff"/>
    <rect x="100" y="18" width="30" height="22" rx="4" fill="#cfe3ff"/><rect x="140" y="16" width="44" height="24" rx="6" fill="#cfe3ff"/>
    <circle cx="188" cy="60" r="4" fill="#ffe680"/>
    <g class="roda"><circle cx="46" cy="82" r="15" fill="#15171c"/><circle cx="46" cy="82" r="6" fill="#c9ced8"/><rect x="44" y="69" width="4" height="26" fill="#15171c"/></g>
    <g class="roda"><circle cx="158" cy="82" r="15" fill="#15171c"/><circle cx="158" cy="82" r="6" fill="#c9ced8"/><rect x="156" y="69" width="4" height="26" fill="#15171c"/></g>
  </svg>`;

  // ---------- som ----------
  let ctx = null;
  let mudo = (() => { try { return localStorage.getItem('sorteio-mudo') === '1'; } catch { return false; } })();
  const audio = () => {
    if (mudo) return null;
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  };
  function tique() {
    const a = audio(); if (!a) return;
    const o = a.createOscillator(), g = a.createGain();
    o.type = 'square'; o.frequency.value = 1300;
    g.gain.setValueAtTime(.06, a.currentTime); g.gain.exponentialRampToValueAtTime(.0001, a.currentTime + .04);
    o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + .05);
  }
  let tambor = null;
  function rufarTambor(seg) {
    const a = audio(); if (!a) return;
    const buf = a.createBuffer(1, a.sampleRate * seg, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t = i / a.sampleRate;
      // Ruído em batidas rápidas (~18 por segundo), crescendo até o fim.
      d[i] = (Math.random() * 2 - 1) * (0.35 + 0.65 * (t / seg)) * (0.55 + 0.45 * Math.abs(Math.sin(Math.PI * 18 * t)));
    }
    const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    src.buffer = buf; f.type = 'bandpass'; f.frequency.value = 180; f.Q.value = .7; g.gain.value = .55;
    src.connect(f).connect(g).connect(a.destination); src.start();
    tambor = src;
  }
  function pararTambor() { try { tambor && tambor.stop(); } catch {} tambor = null; }
  function buzina() {
    const a = audio(); if (!a) return;
    const toque = (inicio, dur) => {
      for (const freq of [370, 466]) { // duas notas juntas, como a buzina dupla de carro
        const o = a.createOscillator(), f = a.createBiquadFilter(), g = a.createGain();
        o.type = 'sawtooth'; o.frequency.value = freq; f.type = 'lowpass'; f.frequency.value = 1800;
        g.gain.setValueAtTime(0, a.currentTime + inicio);
        g.gain.linearRampToValueAtTime(.12, a.currentTime + inicio + .02);
        g.gain.setValueAtTime(.12, a.currentTime + inicio + dur - .04);
        g.gain.linearRampToValueAtTime(0, a.currentTime + inicio + dur);
        o.connect(f).connect(g).connect(a.destination); o.start(a.currentTime + inicio); o.stop(a.currentTime + inicio + dur + .05);
      }
    };
    toque(0, .22); toque(.32, .5);
  }
  function fanfarra() {
    const a = audio(); if (!a) return;
    [523, 659, 784, 1047].forEach((freq, i) => {
      const o = a.createOscillator(), g = a.createGain();
      o.type = 'triangle'; o.frequency.value = freq;
      const t = a.currentTime + .9 + i * .11;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.09, t + .02); g.gain.exponentialRampToValueAtTime(.0001, t + .7);
      o.connect(g).connect(a.destination); o.start(t); o.stop(t + .75);
    });
  }

  // ---------- confete ----------
  function confete(canvas) {
    const c = canvas.getContext('2d');
    const r = canvas.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    canvas.width = r.width * dpr; canvas.height = r.height * dpr; c.scale(dpr, dpr);
    const cores = ['#ffffff', '#8aa0ff', '#00b0f0', '#ffd400', '#1b3fc0', '#e8edff'];
    const n = reduzirMovimento ? 60 : 260;
    const ps = Array.from({ length: n }, (_, i) => {
      const lado = i % 2 ? 1 : -1;
      return {
        x: r.width / 2 + lado * r.width * .32, y: r.height * .42,
        vx: -lado * (2 + Math.random() * 7) + (Math.random() - .5) * 3, vy: -(6 + Math.random() * 9),
        w: 6 + Math.random() * 7, h: 9 + Math.random() * 9, rot: Math.random() * 6, vr: (Math.random() - .5) * .35,
        cor: cores[i % cores.length], circulo: Math.random() < .25,
      };
    });
    const inicio = performance.now();
    (function quadro(t) {
      const passou = t - inicio;
      c.clearRect(0, 0, r.width, r.height);
      for (const p of ps) {
        p.vy += .22; p.vx *= .992; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        c.save(); c.translate(p.x, p.y); c.rotate(p.rot); c.globalAlpha = Math.max(0, 1 - passou / 4200);
        c.fillStyle = p.cor;
        if (p.circulo) { c.beginPath(); c.arc(0, 0, p.w / 2, 0, Math.PI * 2); c.fill(); }
        else c.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot * 2)) + 2);
        c.restore();
      }
      if (passou < 4300) requestAnimationFrame(quadro); else c.clearRect(0, 0, r.width, r.height);
    })(inicio);
  }

  // ---------- montagem ----------
  let dlg;
  function montar() {
    if (dlg) return;
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.append(st);
    dlg = document.createElement('dialog');
    dlg.className = 'sh-dlg';
    dlg.setAttribute('aria-label', 'Sorteio');
    dlg.innerHTML = `
      <div class="sh-palco">
        <canvas class="sh-confete"></canvas>
        <div class="sh-topo">
          <div class="sh-marca"><img src="/qr-logo.png" alt=""><div><strong>Sorteio de brindes</strong><span class="sh-sub"></span></div></div>
          <div class="sh-acoes-topo"><button class="sh-som" type="button" title="Som"></button><button class="sh-x" type="button" title="Fechar" aria-label="Fechar">✕</button></div>
        </div>
        <div class="sh-status" aria-live="polite"></div>
        <div class="sh-estrada" aria-hidden="true">
          <div class="sh-faixa"></div>
          <div class="sh-carro c1">${KOMBI('#0a1a80')}</div>
          <div class="sh-carro c2">${FUSCA('#00b0f0')}</div>
        </div>
        <div class="sh-placa"><div class="faixa"><span class="bandeira"></span>BRASIL<span style="width:26px"></span></div><div class="codigo">VW-0000</div></div>
        <div class="sh-vencedor" aria-live="polite"></div>
        <div class="sh-botoes"><button type="button" class="prim sh-outro">Sortear outro</button><button type="button" class="sec sh-fechar">Fechar</button></div>
      </div>`;
    document.body.append(dlg);
    const $ = (s) => dlg.querySelector(s);
    const somRotulo = () => { $('.sh-som').textContent = mudo ? '🔇' : '🔊'; $('.sh-som').setAttribute('aria-label', mudo ? 'Ligar som' : 'Desligar som'); };
    somRotulo();
    $('.sh-som').onclick = () => {
      mudo = !mudo;
      try { localStorage.setItem('sorteio-mudo', mudo ? '1' : '0'); } catch {}
      if (mudo) pararTambor();
      somRotulo();
    };
    const fechar = () => { if (!dlg.classList.contains('girando')) dlg.close(); };
    $('.sh-x').onclick = fechar;
    $('.sh-fechar').onclick = fechar;
    dlg.addEventListener('cancel', (e) => { if (dlg.classList.contains('girando')) e.preventDefault(); });
  }

  const espera = (ms) => new Promise((r) => setTimeout(r, ms));

  // opcoes: { subtitulo, codigos: [ 'VW-0001', … ], sortear: () => Promise<{ codigo, nome, info } | { erro }>, podeOutro: () => bool }
  async function rodar(opcoes) {
    montar();
    const $ = (s) => dlg.querySelector(s);
    $('.sh-sub').textContent = opcoes.subtitulo || '';
    $('.sh-vencedor').replaceChildren();
    $('.sh-outro').disabled = true;
    $('.sh-fechar').disabled = true;
    $('.sh-x').disabled = true;
    dlg.classList.remove('revelado', 'parado', 'devagar');
    dlg.classList.add('girando');
    if (!dlg.open) dlg.showModal();
    $('.sh-status').textContent = 'Acelerando…';

    const duracao = reduzirMovimento ? 1200 : 5200;
    rufarTambor(duracao / 1000 + .2);
    const pedido = opcoes.sortear().catch((e) => ({ erro: e.message }));
    const codigos = opcoes.codigos.length ? opcoes.codigos : ['VW-0000'];
    const inicio = performance.now();
    let intervalo = 45;
    // Roleta: troca rápida no começo e vai desacelerando (curva suave) até parar.
    while (performance.now() - inicio < duracao) {
      const prog = (performance.now() - inicio) / duracao;
      if (prog > .55) { dlg.classList.add('devagar'); $('.sh-status').textContent = 'Reduzindo…'; }
      $('.sh-placa .codigo').textContent = codigos[Math.floor(Math.random() * codigos.length)];
      tique();
      intervalo = 45 + 420 * prog ** 2.4;
      await espera(intervalo);
    }
    const r = await pedido;
    pararTambor();
    dlg.classList.remove('girando');
    dlg.classList.add('devagar');
    $('.sh-fechar').disabled = false;
    $('.sh-x').disabled = false;

    if (r.erro) {
      $('.sh-status').textContent = 'Não foi possível sortear';
      $('.sh-placa .codigo').textContent = '—';
      dlg.classList.replace('devagar', 'parado');
      const e = document.createElement('div'); e.className = 'erro'; e.textContent = r.erro;
      $('.sh-vencedor').replaceChildren(e);
      return r;
    }
    $('.sh-placa .codigo').textContent = r.codigo;
    dlg.classList.add('revelado');
    $('.sh-status').textContent = '🏁 Temos um ganhador!';
    const nome = document.createElement('div'); nome.className = 'nome'; nome.textContent = r.nome;
    const info = document.createElement('div'); info.className = 'info'; info.textContent = r.info || '';
    $('.sh-vencedor').replaceChildren(nome, info);
    buzina();
    fanfarra();
    confete($('.sh-confete'));
    $('.sh-outro').disabled = !(opcoes.podeOutro && opcoes.podeOutro());
    return r;
  }

  function aoSortearOutro(fn) {
    montar();
    dlg.querySelector('.sh-outro').onclick = fn;
  }

  window.ShowSorteio = { rodar, aoSortearOutro };
})();
