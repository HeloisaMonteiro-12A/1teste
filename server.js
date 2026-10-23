// ===================================================================
// SERVIDOR DO MONITOR DE CRISE
// Recebe dados do ESP32 e mostra um painel no navegador
// ===================================================================
const express = require("express");
const os = require("os");

const app = express();
// Na hospedagem (Render etc.) a porta vem da variável PORT; no seu PC usa 3000
const PORTA = process.env.PORT || 3000;

app.use(express.json());

// -------------------------------------------------------------------
// ESTADO EM MEMÓRIA (zera quando o servidor reinicia)
// -------------------------------------------------------------------
let ultimaLeitura = null;      // { batimentos, aceleracao, recebidoEm }
const historico = [];          // últimas leituras para o gráfico
const alertas = [];            // todos os alertas recebidos
let alertaAtivo = null;        // alerta ainda não reconhecido no painel

const MAX_HISTORICO = 60;
const SEGUNDOS_PARA_OFFLINE = 10;

function horaAgora() {
  return new Date().toLocaleTimeString("pt-BR");
}

function numeroOuNull(valor) {
  return typeof valor === "number" && Number.isFinite(valor) ? valor : null;
}

// -------------------------------------------------------------------
// ROTA: TELEMETRIA (ESP32 manda a cada 2 segundos)
// -------------------------------------------------------------------
app.post("/api/dados", (req, res) => {
  const batimentos = numeroOuNull(req.body.batimentos); // pode vir null
  const aceleracao = numeroOuNull(req.body.aceleracao);

  if (aceleracao === null) {
    return res.status(400).json({ erro: "Campo 'aceleracao' ausente ou inválido" });
  }

  ultimaLeitura = { batimentos, aceleracao, recebidoEm: Date.now() };
  historico.push(ultimaLeitura);
  if (historico.length > MAX_HISTORICO) historico.shift();

  console.log(
    `[${horaAgora()}] Dados: BPM=${batimentos ?? "calculando"} | Aceleração=${aceleracao.toFixed(2)} m/s²`
  );
  res.json({ ok: true });
});

// -------------------------------------------------------------------
// ROTA: ALERTA DE EMERGÊNCIA (queda ou botão de pânico)
// -------------------------------------------------------------------
app.post("/api/alerta", (req, res) => {
  const alerta = {
    id: Date.now(),
    tipo: String(req.body.tipo || "EMERGENCIA"),
    mensagem: String(req.body.mensagem || "Alerta sem descrição"),
    batimentos: numeroOuNull(req.body.batimentos),
    aceleracao: numeroOuNull(req.body.aceleracao),
    recebidoEm: Date.now(),
  };

  alertas.unshift(alerta);
  alertaAtivo = alerta;

  // \x07 faz o terminal apitar; as cores destacam o alerta no console
  console.log("\x07\x1b[41m\x1b[37m");
  console.log(`  🚨 ALERTA [${horaAgora()}]: ${alerta.mensagem}`);
  console.log(
    `  BPM: ${alerta.batimentos ?? "sem leitura"} | Aceleração: ${alerta.aceleracao ?? "-"} m/s²`
  );
  console.log("\x1b[0m");

  // Aqui é o lugar para avisar alguém: e-mail, Telegram, WhatsApp etc.

  res.json({ ok: true });
});

// -------------------------------------------------------------------
// ROTAS DO PAINEL
// -------------------------------------------------------------------
app.get("/api/status", (req, res) => {
  const online =
    ultimaLeitura !== null &&
    Date.now() - ultimaLeitura.recebidoEm < SEGUNDOS_PARA_OFFLINE * 1000;

  res.json({ ultimaLeitura, online, historico, alertas: alertas.slice(0, 20), alertaAtivo });
});

app.post("/api/alerta/reconhecer", (req, res) => {
  alertaAtivo = null;
  res.json({ ok: true });
});

app.get("/", (req, res) => res.send(PAINEL_HTML));

// -------------------------------------------------------------------
// INICIALIZAÇÃO: mostra os IPs para colocar no código do ESP32
// -------------------------------------------------------------------
app.listen(PORTA, "0.0.0.0", () => {
  console.log("\nServidor do monitor rodando!\n");
  console.log("Use um destes endereços no código do ESP32 (serverDados e serverAlerta):");

  for (const [nome, interfaces] of Object.entries(os.networkInterfaces())) {
    for (const i of interfaces) {
      if (i.family === "IPv4" && !i.internal) {
        console.log(`  ${nome}: http://${i.address}:${PORTA}/api/dados`);
      }
    }
  }
  console.log(`\nPainel no navegador: http://localhost:${PORTA}\n`);
});

// ===================================================================
// PAINEL HTML
// ===================================================================
const PAINEL_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Monitor de crise</title>
<style>
  :root {
    --fundo: #EEF3F2;
    --superficie: #FFFFFF;
    --tinta: #18302E;
    --suave: #5E7472;
    --linha: #D3DEDC;
    --calmo: #2C7A70;
    --perigo: #B42332;
    --perigo-fundo: #FBE7E9;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fundo: #101B1A;
      --superficie: #182624;
      --tinta: #E4EEEC;
      --suave: #93A8A5;
      --linha: #2A3B39;
      --calmo: #5FC2B3;
      --perigo: #FF6B78;
      --perigo-fundo: #3A1418;
      color-scheme: dark;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--fundo);
    color: var(--tinta);
    font-family: "Atkinson Hyperlegible", "Segoe UI", Roboto, system-ui, sans-serif;
    line-height: 1.5;
  }
  main { max-width: 760px; margin: 0 auto; padding: 24px 20px 48px; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  h1 { font-size: 1.25rem; margin: 0; font-weight: 600; }
  .conexao { display: flex; align-items: center; gap: 8px; color: var(--suave); font-size: 0.95rem; }
  .ponto { width: 10px; height: 10px; border-radius: 50%; background: var(--suave); }
  .online .ponto { background: var(--calmo); }

  .alerta {
    display: none;
    margin-top: 20px;
    padding: 20px;
    border: 2px solid var(--perigo);
    background: var(--perigo-fundo);
    border-radius: 6px;
  }
  .alerta.visivel { display: block; }
  .alerta h2 { margin: 0 0 4px; color: var(--perigo); font-size: 1.3rem; }
  .alerta p { margin: 0 0 14px; }
  button {
    font: inherit;
    padding: 10px 18px;
    border-radius: 4px;
    border: 2px solid currentColor;
    background: transparent;
    color: var(--tinta);
    cursor: pointer;
  }
  .alerta button { background: var(--perigo); border-color: var(--perigo); color: #fff; }
  button:focus-visible { outline: 3px solid var(--calmo); outline-offset: 2px; }

  .coracao {
    margin-top: 28px;
    padding: 28px 24px 20px;
    background: var(--superficie);
    border-radius: 6px;
  }
  .bpm { display: flex; align-items: baseline; gap: 10px; }
  .bpm strong { font-size: clamp(4rem, 16vw, 7rem); line-height: 1; font-weight: 700; font-variant-numeric: tabular-nums; }
  .bpm span { color: var(--suave); font-size: 1.1rem; }
  .pulso { display: inline-block; color: var(--perigo); font-size: 2rem; }
  .batendo { animation: bater var(--intervalo, 1s) ease-in-out infinite; }
  @keyframes bater { 0%, 100% { transform: scale(1); } 15% { transform: scale(1.25); } 30% { transform: scale(1); } }
  @media (prefers-reduced-motion: reduce) { .batendo { animation: none; } }
  svg { width: 100%; height: 80px; margin-top: 16px; display: block; }
  polyline { fill: none; stroke: var(--calmo); stroke-width: 2.5; stroke-linejoin: round; }

  .linha-info { display: flex; gap: 32px; flex-wrap: wrap; margin-top: 16px; color: var(--suave); }
  .linha-info b { color: var(--tinta); font-weight: 600; }

  h3 { font-size: 1rem; margin: 36px 0 8px; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: 12px 0; border-bottom: 1px solid var(--linha); display: flex; justify-content: space-between; gap: 16px; }
  li time { color: var(--suave); white-space: nowrap; }
  .vazio { color: var(--suave); }
</style>
</head>
<body>
<main>
  <header>
    <h1>Monitor de crise</h1>
    <div class="conexao" id="conexao"><span class="ponto"></span><span id="textoConexao">Aguardando o dispositivo</span></div>
  </header>

  <section class="alerta" id="caixaAlerta" role="alert">
    <h2 id="tituloAlerta">Alerta de emergência</h2>
    <p id="detalheAlerta"></p>
    <button id="reconhecer">Estou ciente</button>
  </section>

  <section class="coracao">
    <div class="bpm">
      <span class="pulso" id="pulso">♥</span>
      <strong id="bpm">--</strong>
      <span>batimentos por minuto</span>
    </div>
    <svg viewBox="0 0 600 80" preserveAspectRatio="none" aria-hidden="true"><polyline id="grafico" points=""/></svg>
    <div class="linha-info">
      <div>Aceleração <b id="acel">--</b></div>
      <div>Última leitura <b id="ultima">--</b></div>
    </div>
  </section>

  <p><button id="ativarSom">Ativar som de alerta</button></p>

  <h3>Histórico de alertas</h3>
  <ul id="listaAlertas"><li class="vazio">Nenhum alerta até agora.</li></ul>
</main>

<script>
  let audio = null;
  let ultimoAlertaTocado = null;

  document.getElementById("ativarSom").onclick = (e) => {
    audio = new (window.AudioContext || window.webkitAudioContext)();
    e.target.textContent = "Som de alerta ativado";
    e.target.disabled = true;
  };

  function apitar() {
    if (!audio) return;
    for (let i = 0; i < 3; i++) {
      const osc = audio.createOscillator();
      const ganho = audio.createGain();
      osc.frequency.value = 880;
      osc.connect(ganho); ganho.connect(audio.destination);
      const t = audio.currentTime + i * 0.35;
      ganho.gain.setValueAtTime(0.3, t);
      osc.start(t); osc.stop(t + 0.2);
    }
  }

  document.getElementById("reconhecer").onclick = async () => {
    await fetch("/api/alerta/reconhecer", { method: "POST" });
    atualizar();
  };

  const hora = (ms) => new Date(ms).toLocaleTimeString("pt-BR");

  async function atualizar() {
    let s;
    try {
      s = await (await fetch("/api/status")).json();
    } catch {
      document.getElementById("textoConexao").textContent = "Servidor fora do ar";
      return;
    }

    const conexao = document.getElementById("conexao");
    conexao.classList.toggle("online", s.online);
    document.getElementById("textoConexao").textContent =
      s.online ? "Dispositivo conectado" : (s.ultimaLeitura ? "Sem sinal do dispositivo" : "Aguardando o dispositivo");

    const pulso = document.getElementById("pulso");
    if (s.ultimaLeitura) {
      const bpm = s.ultimaLeitura.batimentos;
      document.getElementById("bpm").textContent = bpm ?? "--";
      document.getElementById("acel").textContent = s.ultimaLeitura.aceleracao.toFixed(1) + " m/s²";
      document.getElementById("ultima").textContent = hora(s.ultimaLeitura.recebidoEm);
      // o coração pisca no ritmo real dos batimentos
      if (bpm && s.online) {
        pulso.style.setProperty("--intervalo", (60 / bpm) + "s");
        pulso.classList.add("batendo");
      } else {
        pulso.classList.remove("batendo");
      }
    }

    // gráfico dos batimentos
    const valores = s.historico.map(h => h.batimentos).filter(v => v !== null);
    if (valores.length > 1) {
      const min = Math.min(...valores) - 5, max = Math.max(...valores) + 5;
      const pontos = valores.map((v, i) =>
        (i / (valores.length - 1)) * 600 + "," + (80 - ((v - min) / (max - min)) * 80)
      ).join(" ");
      document.getElementById("grafico").setAttribute("points", pontos);
    }

    // alerta ativo
    const caixa = document.getElementById("caixaAlerta");
    if (s.alertaAtivo) {
      caixa.classList.add("visivel");
      document.getElementById("detalheAlerta").textContent =
        s.alertaAtivo.mensagem + " Recebido às " + hora(s.alertaAtivo.recebidoEm) +
        (s.alertaAtivo.batimentos ? ", com " + s.alertaAtivo.batimentos + " bpm." : ".");
      if (ultimoAlertaTocado !== s.alertaAtivo.id) {
        ultimoAlertaTocado = s.alertaAtivo.id;
        apitar();
      }
    } else {
      caixa.classList.remove("visivel");
    }

    // lista de alertas
    const lista = document.getElementById("listaAlertas");
    lista.innerHTML = "";
    if (!s.alertas.length) {
      lista.innerHTML = '<li class="vazio">Nenhum alerta até agora.</li>';
    } else {
      for (const a of s.alertas) {
        const li = document.createElement("li");
        const msg = document.createElement("span");
        msg.textContent = a.mensagem;
        const t = document.createElement("time");
        t.textContent = hora(a.recebidoEm);
        li.append(msg, t);
        lista.append(li);
      }
    }
  }

  atualizar();
  setInterval(atualizar, 1000);
</script>
</body>
</html>`;
