'use strict';

// Janela simples por cima do painel (desfocado) que mostra o ganhador do sorteio.
(function () {
  const reduzirMovimento = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const CSS = `
  .sh-dlg { border: 0; padding: 0; background: transparent; max-width: none; max-height: none; }
  .sh-dlg::backdrop { background: rgba(1, 10, 45, .55); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
  .sh-caixa { width: min(460px, calc(100vw - 32px)); background: #fff; color: #0f172a; border-radius: 18px;
    padding: 28px 24px 22px; text-align: center; font-family: Inter, system-ui, sans-serif; box-shadow: 0 30px 80px rgba(0, 0, 0, .35); }
  .sh-sub { color: #64748b; font-size: .85rem; margin: 0 0 18px; }
  .sh-rotulo { text-transform: uppercase; letter-spacing: .1em; font-weight: 700; font-size: .75rem; color: #64748b; }
  .sh-codigo { font-size: clamp(2.6rem, 11vw, 3.6rem); font-weight: 800; color: #011250; line-height: 1.2; font-variant-numeric: tabular-nums; }
  .sh-dlg.girando .sh-codigo { opacity: .45; }
  .sh-nome { font-size: 1.35rem; font-weight: 700; min-height: 1.4em; margin-top: 6px; }
  .sh-info { color: #64748b; font-size: .9rem; margin-top: 4px; min-height: 1.3em; }
  .sh-erro { color: #b91c1c; font-weight: 600; }
  .sh-botoes { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-top: 22px; }
  .sh-botoes button { font: inherit; font-weight: 700; border-radius: 10px; padding: 11px 20px; cursor: pointer; border: 1px solid #d5dbe5; background: #fff; color: #0f172a; }
  .sh-botoes .prim { background: #0a1a80; border-color: #0a1a80; color: #fff; }
  .sh-botoes button:disabled { opacity: .5; cursor: not-allowed; }
  `;

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
      <div class="sh-caixa">
        <p class="sh-sub"></p>
        <div class="sh-rotulo">Código sorteado</div>
        <div class="sh-codigo" aria-live="polite"></div>
        <div class="sh-nome" aria-live="polite"></div>
        <div class="sh-info"></div>
        <div class="sh-botoes"><button type="button" class="sh-fechar">Fechar</button><button type="button" class="prim sh-outro">Sortear outro</button></div>
      </div>`;
    document.body.append(dlg);
    dlg.querySelector('.sh-fechar').onclick = () => { if (!dlg.classList.contains('girando')) dlg.close(); };
    dlg.addEventListener('cancel', (e) => { if (dlg.classList.contains('girando')) e.preventDefault(); });
  }

  const espera = (ms) => new Promise((r) => setTimeout(r, ms));

  // opcoes: { subtitulo, codigos: [ 'VW-0001', … ], sortear: () => Promise<{ codigo, nome, info }>, podeOutro: () => bool }
  async function rodar(opcoes) {
    montar();
    const $ = (s) => dlg.querySelector(s);
    $('.sh-sub').textContent = opcoes.subtitulo || '';
    $('.sh-nome').textContent = 'Sorteando…';
    $('.sh-nome').classList.remove('sh-erro');
    $('.sh-info').textContent = '';
    $('.sh-outro').disabled = true;
    $('.sh-fechar').disabled = true;
    dlg.classList.add('girando');
    if (!dlg.open) dlg.showModal();

    const pedido = opcoes.sortear().catch((e) => ({ erro: e.message }));
    // Troca rápida de códigos por um instante, só para dar suspense.
    const codigos = opcoes.codigos.length ? opcoes.codigos : ['—'];
    const fim = performance.now() + (reduzirMovimento ? 300 : 1500);
    while (performance.now() < fim) {
      $('.sh-codigo').textContent = codigos[Math.floor(Math.random() * codigos.length)];
      await espera(70);
    }
    const r = await pedido;
    dlg.classList.remove('girando');
    $('.sh-fechar').disabled = false;

    if (r.erro) {
      $('.sh-codigo').textContent = '—';
      $('.sh-nome').textContent = r.erro;
      $('.sh-nome').classList.add('sh-erro');
      return r;
    }
    $('.sh-codigo').textContent = r.codigo;
    $('.sh-nome').textContent = r.nome;
    $('.sh-info').textContent = r.info || '';
    $('.sh-outro').disabled = !(opcoes.podeOutro && opcoes.podeOutro());
    $('.sh-fechar').focus();
    return r;
  }

  function aoSortearOutro(fn) {
    montar();
    dlg.querySelector('.sh-outro').onclick = fn;
  }

  window.ShowSorteio = { rodar, aoSortearOutro };
})();
