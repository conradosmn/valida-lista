/* =====================================================================
   Confere Lista — lógica da página
   Site estático: nada aqui roda em servidor além da Edge Function de OCR.
   ===================================================================== */
"use strict";

const CFG = window.CONFIG || {};
const SB = {
  url: (CFG.SUPABASE_URL || "").replace(/\/+$/, ""),
  key: CFG.SUPABASE_ANON_KEY || "",
};

/* ---------------------------------------------------------------------
   SUPABASE
   ------------------------------------------------------------------- */
function sbHeaders(extra) {
  return Object.assign({
    "apikey": SB.key,
    "Authorization": "Bearer " + SB.key,
    "Content-Type": "application/json",
  }, extra || {});
}

async function sbGet(caminho, headers) {
  const r = await fetch(SB.url + "/rest/v1/" + caminho, { headers: sbHeaders(headers) });
  if (!r.ok) throw new Error("Supabase " + r.status + ": " + (await r.text()).slice(0, 200));
  return r.json();
}

/* A base tem quase 2 mil linhas e o PostgREST devolve no máximo mil por
   vez, então busca em páginas até acabar. Roda uma vez por sessão. */
async function carregarLocais() {
  const mapa = new Map();
  const passo = 1000;
  for (let inicio = 0; ; inicio += passo) {
    const linhas = await sbGet(
      "locais_votacao?select=zona,secao,local_votacao,endereco,bairro,eleitores&order=id",
      { "Range-Unit": "items", "Range": inicio + "-" + (inicio + passo - 1) },
    );
    for (const L of linhas) mapa.set(L.zona + ":" + L.secao, L);
    if (linhas.length < passo) break;
    if (inicio > 50000) break;   // trava de segurança
  }
  return mapa;
}

/* Zonas que existem na base — serve para separar "seção não existe"
   (erro real) de "vota em outra cidade" (conferir manualmente). */
function zonasConhecidas(mapa) {
  const s = new Set();
  for (const k of mapa.keys()) s.add(Number(k.split(":")[0]));
  return s;
}

/* ---------------------------------------------------------------------
   TÍTULO DE ELEITOR — regra do TSE
   12 dígitos: 8 sequenciais + 2 da UF (01..28) + 2 verificadores.
   Cada dígito é o RESTO da divisão por 11; resto maior que 9 vira 0.
   Exceção de SP (01) e MG (02): resto 0 vira 1.
   ------------------------------------------------------------------- */
const UF = {
  "01":"SP","02":"MG","03":"RJ","04":"RS","05":"BA","06":"PR","07":"CE","08":"PE",
  "09":"SC","10":"GO","11":"MA","12":"PB","13":"PA","14":"ES","15":"PI","16":"RN",
  "17":"AL","18":"MT","19":"MS","20":"DF","21":"SE","22":"AM","23":"RO","24":"AC",
  "25":"AP","26":"RR","27":"TO","28":"ZZ",
};

function validarTitulo(raw) {
  const d = String(raw == null ? "" : raw).replace(/\D/g, "");
  if (d.length < 5 || d.length > 12) return { ok:false, motivo:"número com quantidade de dígitos fora do padrão" };
  const n = d.padStart(12, "0");

  const cod = n.slice(8, 10);
  if (!UF[cod]) return { ok:false, motivo:"código de estado inexistente no número" };
  const spmg = cod === "01" || cod === "02";

  let s = 0;
  for (let i = 0; i < 8; i++) s += Number(n[i]) * (i + 2);
  let r = s % 11;
  let dv1 = r > 9 ? 0 : r;
  if (r === 0 && spmg) dv1 = 1;
  if (dv1 !== Number(n[10])) return { ok:false, motivo:"dígito verificador não confere" };

  const s2 = Number(n[8]) * 7 + Number(n[9]) * 8 + dv1 * 9;
  const r2 = s2 % 11;
  let dv2 = r2 > 9 ? 0 : r2;
  if (r2 === 0 && spmg) dv2 = 1;
  if (dv2 !== Number(n[11])) return { ok:false, motivo:"dígito verificador não confere" };

  return { ok:true, uf:UF[cod], numero:n };
}

/* ---------------------------------------------------------------------
   CONFERÊNCIA DE UM REGISTRO
   ------------------------------------------------------------------- */
const RANK = { ok:0, incompleto:1, fora:2, erro:3 };
let LOCAIS = null;
let ZONAS = null;

/* Normaliza o nome para comparação: sem acento, sem pontuação, caixa
   alta, espaços colapsados. "José  da Silva" e "JOSE DA SILVA" viram a
   mesma coisa. */
function normalizarNome(s) {
  return String(s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* Identidade da pessoa. O formulário de papel não tem título, então
   quem identifica é o nome somado à seção onde ela vota — que é estável,
   porque a pessoa vota sempre no mesmo lugar.

   Zona e seção entram como número, sem os zeros à esquerda: no papel a
   mesma seção aparece ora como "0304", ora como "304", e as duas formas
   precisam gerar a mesma chave, senão o duplicado escapa. */
function soNumero(v) {
  const n = parseInt(String(v == null ? "" : v).replace(/\D/g, ""), 10);
  return Number.isFinite(n) ? String(n) : "";
}

function chaveDe(nome, zona, secao) {
  return normalizarNome(nome) + "|" + soNumero(zona) + "|" + soNumero(secao);
}

/* A leitura às vezes gruda zona + seção + telefone num campo só
   ("0010304806190007124"). Em vez de adivinhar onde cortar, testa todas
   as separações possíveis e aceita SÓ a que cai numa seção que existe de
   verdade na base — e só quando existe uma única resposta. Se houver
   ambiguidade, prefere não mexer: melhor pedir conferência humana do que
   inventar um local de votação. */
function separarCampos(zon, sec, tel) {
  const direto = { zona: zon, secao: sec, telefone: tel, recuperado: false };
  if (zon && sec && LOCAIS.has(parseInt(zon, 10) + ":" + parseInt(sec, 10))) return direto;

  const juntos = String(zon || "") + String(sec || "");
  if (juntos.length < 4 || juntos.length > 24) return direto;

  const achados = new Map();
  for (let a = 1; a <= 3; a++) {
    for (let b = 1; b <= 4; b++) {
      if (a + b > juntos.length) continue;
      const z = juntos.slice(0, a);
      const s = juntos.slice(a, a + b);
      const resto = juntos.slice(a + b);
      // o que sobra tem que ser vazio ou parecer telefone
      if (resto && (resto.length < 8 || resto.length > 12)) continue;
      const zi = parseInt(z, 10), si = parseInt(s, 10);
      if (!LOCAIS.has(zi + ":" + si)) continue;
      achados.set(zi + ":" + si, { zona: z, secao: s, telefone: tel || resto, recuperado: true });
    }
  }
  return achados.size === 1 ? [...achados.values()][0] : direto;
}

function conferir(reg) {
  const problemas = [];
  let status = "ok";
  const piora = (s) => { if (RANK[s] > RANK[status]) status = s; };

  const nome = (reg.nome || "").trim();
  const endereco = (reg.endereco || "").trim();
  const tit  = (reg.titulo   || "").replace(/\D/g, "");
  const sep  = separarCampos(
    (reg.zona     || "").replace(/\D/g, ""),
    (reg.secao    || "").replace(/\D/g, ""),
    (reg.telefone || "").replace(/\D/g, ""),
  );
  const zon = sep.zona, sec = sep.secao, tel = sep.telefone;

  if (sep.recuperado) {
    problemas.push("Zona, seção e telefone vieram grudados na leitura; separei em " +
                   "zona " + parseInt(zon, 10) + " e seção " + parseInt(sec, 10) +
                   ", que existe na base. Confira na folha.");
    piora("fora");
  }

  if (!nome) {
    problemas.push("Não consegui ler o nome deste quadro.");
    piora("incompleto");
  }

  /* Título é opcional: esta ficha normalmente não tem o campo. Só entra
     na conta quando vem preenchido. */
  let uf = null;
  if (tit) {
    const v = validarTitulo(tit);
    if (!v.ok) { problemas.push("Título inválido — " + v.motivo + "."); piora("erro"); }
    else uf = v.uf;
  }

  let local = null, localCor = "warn", localMsg = "";

  if (!zon || !sec) {
    localMsg = "Zona e seção não foram preenchidas";
    problemas.push("Sem zona e seção não dá para achar o local de votação.");
    piora("incompleto");
  } else {
    const z = parseInt(zon, 10), s = parseInt(sec, 10);
    const achado = LOCAIS.get(z + ":" + s);
    if (achado) {
      local = achado;
      localCor = "ok";
    } else if (!ZONAS.has(z)) {
      localMsg = "Zona " + z + " não é de " + (CFG.MUNICIPIO || "Teresina");
      problemas.push("Conferir se a pessoa vota em outro município.");
      piora("fora");
    } else {
      localCor = "bad";
      localMsg = "Local de votação não existe";
      problemas.push("A zona " + z + " não tem seção " + s + ".");
      piora("erro");
    }
  }

  if (uf && uf !== "PI" && status !== "erro") {
    problemas.push("Título emitido em " + uf + ", não no Piauí.");
    piora("fora");
  }

  return {
    nome: nome || "(nome não identificado)",
    titulo: tit, zona: zon, secao: sec, telefone: tel, endereco,
    chave: chaveDe(nome, zon, sec),
    status, problemas, local, localCor, localMsg,
    dup: null,
  };
}

/* ---------------------------------------------------------------------
   ARQUIVOS — tudo vira JPEG no canvas.
   Isso também resolve HEIC do iPhone, que o Safari decodifica.
   ------------------------------------------------------------------- */
const LADO = CFG.LADO_MAXIMO || 1500;
let ANEXOS = [];
let idSeq = 0;

function bytesLegiveis(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return Math.round(n / 1024) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

function imagemDeBlob(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("imagem ilegível")); };
    img.src = url;
  });
}

function paraJpeg(canvas) {
  return new Promise((res) => canvas.toBlob((b) => res(b), "image/jpeg", 0.85));
}

async function normalizarImagem(file) {
  const img = await imagemDeBlob(file);
  const escala = Math.min(1, LADO / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width  = Math.max(1, Math.round(img.width  * escala));
  c.height = Math.max(1, Math.round(img.height * escala));
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return paraJpeg(c);
}

async function paginasDePdf(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const out = [];
  // Teto pra não travar o navegador com um PDF gigante — a leitura em
  // lote junta fichas de várias lideranças, então precisa de folga.
  const lidas = Math.min(pdf.numPages, 30);
  for (let p = 1; p <= lidas; p++) {
    const page = await pdf.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const escala = Math.min(2.2, LADO / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale: escala });
    const c = document.createElement("canvas");
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    out.push(await paraJpeg(c));
  }
  return { paginas: out, total: pdf.numPages, lidas };
}

function base64De(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(",")[1]);
    fr.onerror = () => rej(new Error("não consegui ler o arquivo"));
    fr.readAsDataURL(blob);
  });
}

/* ---------------------------------------------------------------------
   LEITURA DA FOTO
   Com OCR_URL preenchido, chama a Edge Function e a chave fica no
   servidor. Sem ela, fala direto com o Gemini — só para teste local.
   ------------------------------------------------------------------- */
const INSTRUCOES =
`Você transcreve fichas de apoiadores preenchidas à mão por lideranças políticas em Teresina, Piauí.

A folha é dividida em QUADROS, normalmente dois por linha. Cada quadro é UMA pessoa. Dentro do quadro, à esquerda, ficam os campos rotulados LIDERANÇA, ZONA, SEÇÃO e TELEFONE; à direita, o campo NOME.

Leia todos os quadros, de cima para baixo e da esquerda para a direita.

Regras de transcrição:
- Copie exatamente o que está escrito. Não corrija, não complete e não invente nenhum número.
- RASURA: vale o valor CORRIGIDO, nunca o que está riscado. Se o nome inteiro do quadro estiver riscado, pule o quadro.
- ZONA e SEÇÃO costumam vir com zeros à esquerda (001, 0304). Devolva como está escrito.
- ZONA e SEÇÃO são campos separados. Nunca junte um no outro.
- TELEFONE: apenas os dígitos.
- ENDEREÇO: copie como está escrito, incluindo bairro se vier no mesmo campo ou logo abaixo.
- Esta ficha normalmente NÃO tem título de eleitor. Só preencha "titulo" se houver mesmo um número de título escrito no quadro.
- Campo em branco ou que você não consiga ler com certeza: null. Prefira null a chutar — um número errado causa mais estrago do que um campo vazio.
- Ignore os rótulos impressos do formulário e qualquer anotação fora dos quadros.

Transcreva todos os quadros que tenham pelo menos um nome legível.`;

const ESQUEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      nome:      { type: "STRING", nullable: true },
      lideranca: { type: "STRING", nullable: true },
      zona:      { type: "STRING", nullable: true },
      secao:     { type: "STRING", nullable: true },
      telefone:  { type: "STRING", nullable: true },
      endereco:  { type: "STRING", nullable: true },
      titulo:    { type: "STRING", nullable: true },
    },
    required: ["nome"],
  },
};

/* Junta o "Parar" do usuário com um prazo máximo, para uma folha
   travada não segurar a análise inteira para sempre. */
const PRAZO = 150000;
function comPrazo(signal, ms) {
  try {
    if (AbortSignal.any && AbortSignal.timeout) {
      return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
    }
  } catch { /* navegador antigo: segue só com o sinal do usuário */ }
  return signal;
}

async function transcrever(blob, signal) {
  const imagem = await base64De(blob);

  if (CFG.OCR_URL) {
    let r;
    try {
      r = await fetch(CFG.OCR_URL, {
        method: "POST", signal: comPrazo(signal, PRAZO),
        headers: sbHeaders(),
        body: JSON.stringify({ imagem, tipo: "image/jpeg" }),
      });
    } catch (e) {
      // Se quem cancelou foi o prazo, não é o usuário: vira aviso, não parada.
      if (e.name === "TimeoutError" || (e.name === "AbortError" && !signal.aborted)) {
        throw new Error("a leitura demorou demais; tente com a foto mais nítida");
      }
      if (e.name === "AbortError") throw e;
      throw new Error("não consegui falar com o servidor de leitura");
    }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(d.erro || "não consegui ler esta página");
      // 429 é freio de taxa: dá para esperar e tentar de novo, ao
      // contrário de um erro de conteúdo, que repetir não resolve.
      if (r.status === 429) err.freio = true;
      if (r.status >= 500) err.instavel = true;
      throw err;
    }
    return { linhas: Array.isArray(d.linhas) ? d.linhas : [], uso: d.uso || null };
  }

  if (!CFG.GEMINI_API_KEY || CFG.GEMINI_API_KEY.startsWith("COLE_")) {
    throw new Error("O site está sem a leitura de fotos configurada.");
  }

  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
              (CFG.GEMINI_MODELO || "gemini-3.7-flash") + ":generateContent";
  const r = await fetch(url, {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", "x-goog-api-key": CFG.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: INSTRUCOES }] },
      contents: [{ role: "user", parts: [
        { inline_data: { mime_type: "image/jpeg", data: imagem } },
        { text: "Transcreva esta página." },
      ] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: ESQUEMA, temperature: 0 },
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    console.error("gemini", r.status, t.slice(0, 300));
    throw new Error(r.status === 429 ? "muitas leituras seguidas, espere um pouco"
                  : r.status === 403 ? "a chave do Gemini foi recusada"
                  : "não consegui ler esta página");
  }
  const d = await r.json();
  const texto = (d?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  const uso = d?.usageMetadata
    ? { entrada: d.usageMetadata.promptTokenCount, saida: d.usageMetadata.candidatesTokenCount }
    : null;
  try {
    const v = JSON.parse(texto);
    return { linhas: Array.isArray(v) ? v : [], uso };
  } catch {
    const i = texto.indexOf("["), f = texto.lastIndexOf("]");
    if (i !== -1 && f > i) { try { return { linhas: JSON.parse(texto.slice(i, f + 1)), uso }; } catch {} }
    throw new Error("a transcrição veio embaralhada");
  }
}

/* ---------------------------------------------------------------------
   DUPLICADOS — quem já está numa lista de outra liderança
   ------------------------------------------------------------------- */
async function buscarDuplicados(chaves, liderancaAtual) {
  if (!chaves.length) return new Map();
  const mapa = new Map();
  // Em blocos, para a URL não estourar.
  for (let i = 0; i < chaves.length; i += 40) {
    const bloco = chaves.slice(i, i + 40);
    const lista = "(" + bloco.map((c) => '"' + c.replace(/"/g, "") + '"').join(",") + ")";
    const linhas = await sbGet(
      "cadastros?select=chave,nome,lideranca,criado_em&chave=in." + encodeURIComponent(lista),
    );
    for (const L of linhas) {
      if (L.lideranca !== liderancaAtual) mapa.set(L.chave, L);
    }
  }
  return mapa;
}

/* Apaga tudo o que uma liderança tem gravado. Serve ao botão de refazer,
   quando a leitura anterior entrou errada e não há como corrigir linha a
   linha pela tela. */
async function apagarLista(lideranca) {
  const r = await fetch(
    SB.url + "/rest/v1/cadastros?lideranca=eq." + encodeURIComponent(lideranca),
    { method: "DELETE", headers: sbHeaders({ "Prefer": "return=minimal" }) },
  );
  if (!r.ok) {
    const bruto = await r.text();
    console.error("exclusao", r.status, bruto);
    throw new Error("o banco recusou a exclusão (código " + r.status + ").");
  }
}

async function registrar(res, lideranca) {
  // Só grava quem tem nome e seção — sem isso a chave não identifica
  // ninguém, e gravaria lixo que atrapalha a conferência das próximas.
  const vistos = new Set();
  const novos = [];
  for (const r of res) {
    if (r.dup) continue;
    if (!r.zona || !r.secao) continue;
    if (r.nome === "(nome não identificado)") continue;
    if (vistos.has(r.chave)) continue;   // repetido dentro do próprio lote
    vistos.add(r.chave);
    novos.push({
      chave: r.chave,
      nome: r.nome,
      zona: parseInt(r.zona, 10),
      secao: parseInt(r.secao, 10),
      telefone: r.telefone || null,
      endereco: r.endereco || null,
      titulo: r.titulo || null,
      lideranca,
    });
  }
  if (!novos.length) return 0;

  /* on_conflict=chave é obrigatório: sem ele o PostgREST só ignora
     conflito na chave primária (o id), e o nosso índice único é na
     coluna `chave`. Faltando isso, uma única pessoa já cadastrada
     derruba a gravação do lote inteiro. */
  const r = await fetch(SB.url + "/rest/v1/cadastros?on_conflict=chave", {
    method: "POST",
    headers: sbHeaders({ "Prefer": "resolution=ignore-duplicates,return=minimal" }),
    body: JSON.stringify(novos),
  });
  if (!r.ok) {
    const bruto = await r.text();
    console.error("gravacao", r.status, bruto);
    throw new Error("o banco recusou a gravação (código " + r.status + "). Veja o console para o detalhe.");
  }
  return novos.length;
}

/* ---------------------------------------------------------------------
   TELA — anexos
   ------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const elArquivos = $("lista-arquivos");
const bAnalisar = $("b-analisar");

// Nome confirmado da liderança da leitura atual — vem da tela de
// confirmação (após ler as fichas), não é mais digitado antes.
let LIDER = "";

function desenharArquivos() {
  elArquivos.replaceChildren();
  for (const a of ANEXOS) {
    const li = document.createElement("div");
    li.className = "file";

    if (a.url) {
      const im = document.createElement("img");
      im.className = "thumb"; im.src = a.url; im.alt = "";
      li.append(im);
    } else {
      const d = document.createElement("div");
      d.className = "thumb doc"; d.textContent = "PDF";
      li.append(d);
    }

    const nm = document.createElement("div");
    nm.className = "nm";
    const b = document.createElement("b"); b.textContent = a.nome;
    const sp = document.createElement("span"); sp.textContent = bytesLegiveis(a.file.size);
    nm.append(b, sp); li.append(nm);

    const x = document.createElement("button");
    x.className = "rm"; x.type = "button"; x.textContent = "×";
    x.setAttribute("aria-label", "Remover " + a.nome);
    x.onclick = () => {
      if (a.url) URL.revokeObjectURL(a.url);
      ANEXOS = ANEXOS.filter((o) => o.id !== a.id);
      desenharArquivos(); revisarForm();
    };
    li.append(x);
    elArquivos.append(li);
  }
}

function adicionar(files) {
  for (const f of files) {
    const ehPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
    ANEXOS.push({
      id: ++idSeq, file: f,
      nome: f.name || (ehPdf ? "documento.pdf" : "foto.jpg"),
      tipo: ehPdf ? "pdf" : "img",
      url: ehPdf ? null : URL.createObjectURL(f),
    });
  }
  desenharArquivos(); revisarForm();
}

/* Um botão só: o seletor do próprio celular já oferece câmera, galeria e
   arquivos. Dois botões duplicavam a opção de tirar foto. */
$("b-arquivo").onclick = () => $("in-arquivo").click();
$("in-arquivo").onchange = (e) => { adicionar(e.target.files); e.target.value = ""; };

function revisarForm() {
  bAnalisar.disabled = !(ANEXOS.length > 0 && LOCAIS);
  bAnalisar.textContent = ANEXOS.length
    ? "Analisar " + ANEXOS.length + (ANEXOS.length === 1 ? " arquivo" : " arquivos")
    : "Analisar lista";
}

function aviso(alvo, classe, html) {
  const el = $(alvo);
  el.replaceChildren();
  if (!html) return;
  const d = document.createElement("div");
  d.className = "note " + classe;
  d.innerHTML = html;
  el.append(d);
}

/* ---------------------------------------------------------------------
   IMPORTAR LISTA JÁ DIGITADA — CSV, Excel ou Word, sem passar pelo OCR.
   Cada formato só precisa virar {cabecalho, linhas}; dali em diante é o
   mesmo mapeamento de colunas e o mesmo fluxo de confirmação/análise
   que a leitura de foto usa.
   ------------------------------------------------------------------- */

// Separador ; é comum em CSV exportado de planilha no padrão brasileiro
// (a vírgula ali é decimal). Decide pelo que aparece mais na 1ª linha.
function dividirCsv(texto) {
  const primeiraLinha = texto.slice(0, texto.indexOf("\n") + 1 || texto.length);
  const nPontoVirgula = (primeiraLinha.match(/;/g) || []).length;
  const nVirgula = (primeiraLinha.match(/,/g) || []).length;
  const sep = nPontoVirgula > nVirgula ? ";" : ",";

  const linhas = [];
  let campo = "", linha = [], dentroAspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (dentroAspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; } else dentroAspas = false;
      } else campo += c;
    } else if (c === '"') {
      dentroAspas = true;
    } else if (c === sep) {
      linha.push(campo); campo = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      linha.push(campo); campo = "";
      linhas.push(linha); linha = [];
    } else {
      campo += c;
    }
  }
  if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas.filter((l) => l.some((c) => c.trim()));
}

async function lerCsv(file) {
  const linhas = dividirCsv(await file.text());
  return { cabecalho: linhas[0] || [], linhas: linhas.slice(1) };
}

async function lerXlsx(file) {
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const linhas = XLSX.utils
    .sheet_to_json(ws, { header: 1, defval: "", blankrows: false })
    .map((l) => l.map((c) => String(c)));
  return { cabecalho: linhas[0] || [], linhas: linhas.slice(1) };
}

// Só a primeira tabela do documento — é para onde a lista digitada vai
// normalmente; texto solto fora de tabela é ignorado.
async function lerDocx(file) {
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
  const tabela = new DOMParser().parseFromString(html, "text/html").querySelector("table");
  if (!tabela) throw new Error("não encontrei uma tabela no documento.");
  const linhas = [...tabela.querySelectorAll("tr")].map(
    (tr) => [...tr.querySelectorAll("td,th")].map((c) => c.textContent.trim()),
  );
  return { cabecalho: linhas[0] || [], linhas: linhas.slice(1) };
}

// Nome da coluna → campo interno. Comparado sem acento/maiúscula (via
// normalizarNome), tolerante a alguns sinônimos comuns de planilha.
const ALIAS_COLUNA = {
  nome:      ["NOME", "NOME COMPLETO"],
  lideranca: ["LIDERANCA", "LIDER", "NOME DA LIDERANCA"],
  zona:      ["ZONA", "ZONA ELEITORAL", "ZONA DO TITULO", "ZONA DE VOTACAO"],
  secao:     ["SECAO", "SECAO ELEITORAL", "SECAO DO TITULO", "SECAO DE VOTACAO"],
  telefone:  ["TELEFONE", "TEL", "CELULAR", "WHATSAPP", "FONE"],
  titulo:    ["TITULO", "TITULO DE ELEITOR", "TITULO ELEITORAL", "NUMERO DO TITULO"],
  endereco:  ["ENDERECO", "ENDERECO COMPLETO", "RUA", "LOGRADOURO"],
};

function mapearColunas(cabecalho) {
  const normalizados = cabecalho.map((c) => normalizarNome(c));
  const mapa = {};
  for (const [campo, alias] of Object.entries(ALIAS_COLUNA)) {
    const i = normalizados.findIndex((c) => alias.includes(c));
    if (i !== -1) mapa[campo] = i;
  }
  return mapa;
}

function linhasParaBrutos(cabecalho, linhas) {
  const mapa = mapearColunas(cabecalho);
  if (mapa.nome == null) {
    throw new Error('não encontrei uma coluna de nome no arquivo (ex.: "Nome").');
  }
  const pega = (linha, campo) => (mapa[campo] == null ? "" : String(linha[mapa[campo]] ?? "").trim());
  return linhas
    .filter((l) => pega(l, "nome"))
    .map((l) => ({
      nome: pega(l, "nome"), lideranca: pega(l, "lideranca"),
      zona: pega(l, "zona"), secao: pega(l, "secao"),
      telefone: pega(l, "telefone"), titulo: pega(l, "titulo"), endereco: pega(l, "endereco"),
    }));
}

$("b-importar").onclick = () => $("in-importar").click();
$("in-importar").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  aviso("aviso-form", "", "");

  const ext = (file.name.split(".").pop() || "").toLowerCase();
  try {
    if (!LOCAIS) throw new Error("a base de locais de votação ainda não carregou — aguarde um instante e tente de novo.");

    let dados;
    if (ext === "csv") dados = await lerCsv(file);
    else if (ext === "xlsx" || ext === "xls") dados = await lerXlsx(file);
    else if (ext === "docx") dados = await lerDocx(file);
    else throw new Error("formato não reconhecido — use CSV, Excel (.xlsx) ou Word (.docx).");

    const brutos = linhasParaBrutos(dados.cabecalho, dados.linhas);
    if (!brutos.length) throw new Error("não encontrei nenhuma linha com o nome preenchido.");

    mostrarConfirmacaoLideranca(brutos, [], $("in-modo-lote").checked);
  } catch (err) {
    aviso("aviso-form", "bad", "<b>Não consegui importar o arquivo.</b><br>" + escapar(err.message));
  }
};

/* ---------------------------------------------------------------------
   CARGA INICIAL
   ------------------------------------------------------------------- */
(async () => {
  if (!SB.url || !SB.key || SB.key.startsWith("COLE_")) {
    aviso("aviso-form", "bad", "<b>O site está sem configuração.</b><br>Preencha o arquivo <code>config.js</code>.");
    $("foot-n").textContent = "não configurada";
    return;
  }
  try {
    LOCAIS = await carregarLocais();
    ZONAS = zonasConhecidas(LOCAIS);
    $("foot-n").textContent =
      LOCAIS.size.toLocaleString("pt-BR") + " seções em " +
      [...ZONAS].sort((a, b) => a - b).length + " zonas";
    revisarForm();
  } catch (e) {
    console.error(e);
    aviso("aviso-form", "bad",
      "<b>Não consegui carregar a base de locais de votação.</b><br>" +
      "Confira a conexão e as permissões do Supabase.");
    $("foot-n").textContent = "indisponível";
  }
})();

/* ---------------------------------------------------------------------
   ANÁLISE
   ------------------------------------------------------------------- */
const anel = $("anel"), elPct = $("pct"), elAgora = $("agora");
const CIRC = 2 * Math.PI * 52;
let ABORT = null;
let ULTIMO = null;

function progresso(f) {
  const p = Math.max(0, Math.min(1, f));
  anel.setAttribute("stroke-dashoffset", String(CIRC * (1 - p)));
  elPct.textContent = Math.round(p * 100);
}

function trocarTela(qual) {
  for (const t of ["form", "run", "confirmar", "lote", "res"]) $("tela-" + t).hidden = (t !== qual);
  if (qual !== "res") document.title = "Confere Lista";
  window.scrollTo({ top: 0 });
}

$("b-parar").onclick = () => { if (ABORT) ABORT.abort(); };

async function analisar(opcoes) {
  const refazer = !!(opcoes && opcoes.refazer);
  const lideranca = refazer ? LIDER : "";
  ABORT = new AbortController();
  trocarTela("run");
  progresso(0);
  for (const f of ["ocr", "conf", "dup"]) {
    $("fl-" + f).style.width = "0%";
    $("fase-" + f).classList.remove("done");
    $("st-" + f).textContent = "aguardando";
  }

  /* Refazer: apaga o que esta lideranca já tem gravado, para a nova
     leitura substituir em vez de conviver com o registro torto. */
  if (refazer) {
    elAgora.textContent = "Apagando os cadastros anteriores de " + lideranca + "…";
    try {
      await apagarLista(lideranca);
    } catch (e) {
      trocarTela("res");
      aviso("res-topo", "bad",
        "<b>Não consegui apagar os cadastros anteriores.</b><br>" + escapar(e.message));
      return;
    }
  }

  /* preparar páginas */
  elAgora.textContent = "Preparando os arquivos…";
  const paginas = [], avisos = [];
  for (const a of ANEXOS) {
    try {
      if (a.tipo === "pdf") {
        const r = await paginasDePdf(a.file);
        r.paginas.forEach((b, i) => paginas.push({ blob: b, rotulo: a.nome + " — página " + (i + 1) }));
        if (r.total > r.lidas) avisos.push(a.nome + " tem " + r.total + " páginas; foram lidas as " + r.lidas + " primeiras.");
      } else {
        paginas.push({ blob: await normalizarImagem(a.file), rotulo: a.nome });
      }
    } catch {
      avisos.push("Não consegui abrir " + a.nome + ". Tente enviar em JPG ou PNG.");
    }
    if (ABORT.signal.aborted) return trocarTela("form");
  }

  if (!paginas.length) {
    trocarTela("form");
    aviso("aviso-form", "bad", "<b>Nenhum arquivo pôde ser aberto.</b><br>" + avisos.join("<br>"));
    return;
  }

  /* --- transcrição, várias folhas ao mesmo tempo ---
     Cada folha leva dezenas de segundos no Gemini. Em fila, três folhas
     passariam de dois minutos com o anel parado no zero. Rodando em
     paralelo e animando o progresso de cada uma, a espera cai e a tela
     mostra que está viva. */
  const brutos = [];
  const inicio = Date.now();
  const emAndamento = new Map();   // índice -> quando começou a leitura
  const esperandoAte = new Map();  // índice -> quando a pausa termina
  let concluidas = 0;
  // Gasto de token por folha, só pra depurar consumo — a Edge Function já
  // devolve isso, aqui só junta e mostra no console.
  const usoTotal = { entrada: 0, saida: 0 };

  /* Sem progresso real da API, cada folha em leitura avança sozinha por
     uma curva que desacelera: rápido no começo, devagar perto do fim, e
     nunca passa de 60% do peso da folha. Antes eu deixava chegar a 90%,
     e o anel marcava 71% com só uma de duas folhas prontas — parecia
     quebrado. Melhor ficar atrás da realidade do que na frente. */
  const ticker = setInterval(() => {
    const agora = Date.now();
    let parcial = 0;
    for (const t0 of emAndamento.values()) {
      parcial += 0.6 * (1 - Math.exp(-(agora - t0) / 30000));
    }
    const f = (concluidas + parcial) / paginas.length;
    $("fl-ocr").style.width = (Math.min(1, f) * 100) + "%";
    progresso(Math.min(0.99, f) * 0.75);

    const seg = Math.round((agora - inicio) / 1000);
    if (esperandoAte.size) {
      const falta = Math.max(0, Math.round((Math.max(...esperandoAte.values()) - agora) / 1000));
      elAgora.textContent = "O Gemini pediu uma pausa. Tentando de novo em " + falta + "s…";
    } else {
      const n = emAndamento.size;
      elAgora.textContent = n <= 1
        ? "Lendo a folha… " + seg + "s"
        : "Lendo " + n + " folhas ao mesmo tempo… " + seg + "s";
    }
  }, 400);

  async function lerPagina(i) {
    const pg = paginas[i];
    emAndamento.set(i, Date.now());
    try {
      /* Instabilidade e limite de taxa são passageiros: espera e tenta
         de novo, com pausa maior a cada vez. Erro de conteúdo não entra
         aqui — repetir não resolveria e só gastaria crédito. */
      const ESPERAS = [4000, 10000, 20000];
      let linhas, uso, tentativa = 0;
      for (;;) {
        try {
          ({ linhas, uso } = await transcrever(pg.blob, ABORT.signal));
          break;
        } catch (e1) {
          const valeTentar = (e1.freio || e1.instavel || /demorou/i.test(e1.message))
                             && e1.name !== "AbortError";
          if (!valeTentar || tentativa >= ESPERAS.length) throw e1;
          const espera = ESPERAS[tentativa++];
          esperandoAte.set(i, Date.now() + espera);
          await new Promise((r) => setTimeout(r, espera));
          esperandoAte.delete(i);
          if (ABORT.signal.aborted) throw e1;
          emAndamento.set(i, Date.now());
        }
      }
      if (uso) {
        usoTotal.entrada += uso.entrada || 0;
        usoTotal.saida += uso.saida || 0;
        console.log("token — " + pg.rotulo, uso);
      }
      for (const L of linhas) {
        if (L && typeof L === "object") {
          brutos.push({
            nome:      L.nome      == null ? "" : String(L.nome),
            lideranca: L.lideranca == null ? "" : String(L.lideranca),
            titulo:    L.titulo    == null ? "" : String(L.titulo),
            zona:      L.zona      == null ? "" : String(L.zona),
            secao:     L.secao     == null ? "" : String(L.secao),
            telefone:  L.telefone  == null ? "" : String(L.telefone),
            endereco:  L.endereco  == null ? "" : String(L.endereco),
          });
        }
      }
    } catch (e) {
      if (e.name === "AbortError") throw e;
      avisos.push("Folha " + (i + 1) + ": " + e.message);
    } finally {
      emAndamento.delete(i);
      concluidas++;
      $("st-ocr").textContent = concluidas + " de " + paginas.length;
    }
  }

  // Vem do config.js: 1 na camada gratuita do Gemini, 3 na paga.
  const CONCORRENCIA = Math.max(1, Math.min(4, CFG.FOLHAS_SIMULTANEAS || 1));
  let proxima = 0;
  const trabalhadores = Array.from(
    { length: Math.min(CONCORRENCIA, paginas.length) },
    async () => { while (proxima < paginas.length) await lerPagina(proxima++); },
  );

  try {
    await Promise.all(trabalhadores);
  } catch (e) {
    clearInterval(ticker);
    if (e && e.name === "AbortError") { trocarTela("form"); return; }
    avisos.push("A leitura falhou: " + e.message);
  }
  clearInterval(ticker);
  if (usoTotal.entrada || usoTotal.saida) {
    console.log(
      "token — total da leitura (" + paginas.length + (paginas.length === 1 ? " folha" : " folhas") + "):",
      usoTotal,
    );
  }

  $("fl-ocr").style.width = "100%";
  $("fase-ocr").classList.add("done");
  $("st-ocr").textContent = brutos.length + (brutos.length === 1 ? " linha" : " linhas");
  progresso(0.75);

  if (refazer) {
    await finalizarLeitura(lideranca, brutos, avisos);
  } else {
    mostrarConfirmacaoLideranca(brutos, avisos, $("in-modo-lote").checked);
  }
}

/* Nova lista: em vez de pedir o nome antes de ler (letra à mão raramente
   bate igual com o que seria digitado), agrupa pelo nome que cada quadro
   trouxe e sugere. Normalmente dá um grupo só (o fluxo de sempre). Quando
   o envio junta fotos de lideranças diferentes (leitura em lote), vira
   um grupo por liderança, cada um confirmado e gravado separadamente. */
let PENDENTE = null;

// Habilita (ou desabilita de volta) o campo de nome de uma ficha solta
// junto com o checkbox — o campo fica ao lado, mas só digitável quando
// o usuário marca que vai conferir aquela ficha.
function alternarFicha(chk, inp, li) {
  li.classList.toggle("conferida", chk.checked);
  inp.disabled = !chk.checked;
  if (chk.checked) inp.focus();
}

function mostrarConfirmacaoLideranca(brutos, avisos, modoLote) {
  const nomeados = new Map(); // chave normalizada -> { raw, itens }
  const semNome = [];
  for (const b of brutos) {
    const raw = (b.lideranca || "").trim();
    if (!raw) { semNome.push(b); continue; }
    const chave = normalizarNome(raw);
    const g = nomeados.get(chave);
    if (g) g.itens.push(b); else nomeados.set(chave, { raw, itens: [b] });
  }
  const grupos = [...nomeados.values()].sort((a, b) => b.itens.length - a.itens.length);

  let intro;
  // Fora do modo lote, é sempre uma lista só — o OCR lê o nome da
  // liderança diferente de folha pra folha, e sem o switch isso empurrava
  // toda leitura pro modo lote (e pro ZIP) mesmo sendo uma pessoa só.
  if (!modoLote || grupos.length <= 1) {
    // Um nome só (ou nenhum): as fichas sem nome legível entram juntas,
    // exatamente como antes.
    const raw = grupos[0] ? grupos[0].raw : "";
    const n = grupos[0] ? grupos[0].itens.length : 0;
    const info = !grupos[0]
      ? "Nenhuma ficha trouxe o nome da liderança legível. Digite abaixo."
      : n === brutos.length ? "Todas as fichas trazem esse nome."
      : n + " de " + brutos.length + " ficha" + (brutos.length === 1 ? "" : "s") + " trazem esse nome.";
    PENDENTE = { grupos: [{ raw, itens: brutos, info }], avisos, unico: true };
    intro = "";
  } else {
    // Leitura em lote: um grupo por liderança encontrada nas fotos.
    if (semNome.length) grupos.push({ raw: "", itens: semNome, semNomeLegivel: true });
    for (const g of grupos) {
      g.info = g.semNomeLegivel
        ? g.itens.length + " ficha" + (g.itens.length === 1 ? "" : "s") + " sem nome de liderança legível — confira os nomes abaixo e digite manualmente."
        : g.itens.length + " ficha" + (g.itens.length === 1 ? "" : "s");
    }
    PENDENTE = { grupos, avisos, unico: false };
    intro = grupos.length + " lideranças diferentes nas fotos enviadas. Confirme o nome de cada uma.";
  }

  $("confirmar-intro").textContent = intro;
  const cont = $("confirmar-lista");
  cont.replaceChildren();
  for (const g of PENDENTE.grupos) {
    const row = document.createElement("div");
    row.className = "field";

    // Grupo sem nome de liderança legível: uma liderança só pra 40
    // fichas diferentes ficava errado. Em vez de um nome pro bloco
    // inteiro, cada ficha ganha seu próprio campo — o usuário confere
    // com a folha original e digita a liderança dela, marcando o
    // checkbox pra não perder onde parou. No fim, quem ficar com o
    // mesmo nome digitado se junta (mesma lógica dos grupos normais).
    if (g.semNomeLegivel) {
      const hint = document.createElement("p");
      hint.className = "hint"; hint.textContent = g.info;
      row.append(hint);

      const det = document.createElement("details");
      det.className = "fichas"; det.open = true;
      const sum = document.createElement("summary");
      sum.textContent = "Fichas sem liderança (" + g.itens.length + ")";
      const ul = document.createElement("ul");
      for (const b of g.itens) {
        const li = document.createElement("li");
        li.className = "ficha-solta";

        const nm = document.createElement("span");
        nm.className = "nm";
        const nome = (b.nome || "").trim() || "(nome não identificado)";
        const zona = (b.zona || "").trim(), secao = (b.secao || "").trim();
        nm.textContent = nome + (zona || secao ? " — zona " + (zona || "—") + " · seção " + (secao || "—") : "");

        const row2 = document.createElement("div");
        row2.className = "row2";
        const chk = document.createElement("input");
        chk.type = "checkbox"; chk.setAttribute("aria-label", "Conferido: " + nome);
        const inp = document.createElement("input");
        inp.type = "text"; inp.autocomplete = "off";
        inp.placeholder = "Liderança desta ficha";
        inp.itens = [b];
        inp.disabled = true;
        inp.chk = chk; inp.li = li;
        chk.onchange = () => alternarFicha(chk, inp, li);
        row2.append(chk, inp);

        li.append(nm, row2);
        ul.append(li);
      }
      det.append(sum, ul);
      row.append(det);
      cont.append(row);
      continue;
    }

    const linha = document.createElement("div");
    linha.className = "row2";
    const inp = document.createElement("input");
    inp.type = "text"; inp.autocomplete = "off";
    inp.placeholder = "Nome da liderança"; inp.value = g.raw;
    inp.itens = g.itens;
    // Marca visual de "já conferi esta lista" — útil quando o lote traz
    // muitas lideranças e é fácil perder onde parou de revisar os nomes.
    // Liga nos dois sentidos com os checkboxes de cada nome, abaixo:
    // marcar todos os nomes marca este, e marcar este marca todos eles.
    const marcacoes = [];
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.setAttribute("aria-label", "Conferido: " + (g.raw || "esta liderança"));
    chk.onchange = () => {
      row.classList.toggle("conferida", chk.checked);
      for (const c of marcacoes) {
        c.checked = chk.checked;
        c.closest("li").classList.toggle("conferida", chk.checked);
      }
    };
    linha.append(inp, chk);
    const hint = document.createElement("p");
    hint.className = "hint"; hint.textContent = g.info;
    row.append(linha, hint);

    // Pra reconhecer de quem é o grupo comparando com a folha original,
    // com um checkbox por nome. Quando todos ficam marcados, o checkbox
    // da liderança marca sozinho — conferir nome a nome também conta
    // como "conferi essa lista inteira".
    if (g.itens.length) {
      const det = document.createElement("details");
      det.className = "fichas";
      const sum = document.createElement("summary");
      sum.textContent = "Ver nomes das fichas (" + g.itens.length + ")";
      const ul = document.createElement("ul");
      for (const b of g.itens) {
        const li = document.createElement("li");
        li.className = "nome-check";
        const nome = (b.nome || "").trim() || "(nome não identificado)";
        const zona = (b.zona || "").trim(), secao = (b.secao || "").trim();
        const c = document.createElement("input");
        c.type = "checkbox"; c.setAttribute("aria-label", "Conferido: " + nome);
        const nm = document.createElement("span");
        nm.className = "nm";
        nm.textContent = nome + (zona || secao ? " — zona " + (zona || "—") + " · seção " + (secao || "—") : "");
        c.onchange = () => {
          li.classList.toggle("conferida", c.checked);
          const todas = marcacoes.every((x) => x.checked);
          chk.checked = todas;
          row.classList.toggle("conferida", todas);
        };
        marcacoes.push(c);
        li.append(c, nm);
        ul.append(li);
      }
      det.append(sum, ul);
      row.append(det);
    }

    cont.append(row);
  }

  trocarTela("confirmar");
  const primeiro = cont.querySelector("input[type=text]:not(:disabled)");
  if (primeiro) primeiro.focus();
}

$("b-confirmar-lider").onclick = async () => {
  if (!PENDENTE) return;
  // Cada campo de texto carrega os itens que ele representa (um grupo
  // inteiro, ou uma ficha solta) — não dá mais pra confiar no índice,
  // já que o grupo "sem liderança" vira um campo por ficha.
  const inputs = [...$("confirmar-lista").querySelectorAll("input[type=text]")];
  for (const el of inputs) {
    if (el.value.trim()) continue;
    // Ficha solta ainda desabilitada (checkbox não marcado): habilita o
    // campo antes de focar, senão o foco não pega num input desabilitado.
    if (el.disabled && el.chk) { el.chk.checked = true; alternarFicha(el.chk, el, el.li); }
    el.focus();
    el.scrollIntoView({ block: "center" });
    return;
  }

  const brutosGrupos = inputs.map((el) => ({ lideranca: el.value.trim(), itens: el.itens }));
  const { avisos, unico } = PENDENTE;
  PENDENTE = null;
  trocarTela("run");

  if (unico) {
    await finalizarLeitura(brutosGrupos[0].lideranca, brutosGrupos[0].itens, avisos);
    return;
  }

  // O OCR pode ler o nome da mesma liderança diferente em folhas
  // diferentes, gerando grupos separados. Se o usuário corrigiu para o
  // mesmo nome aqui, junta num grupo só antes de gerar as listas.
  const grupos = [];
  const porNome = new Map();
  for (const g of brutosGrupos) {
    const chave = normalizarNome(g.lideranca);
    const existente = porNome.get(chave);
    if (existente) existente.itens.push(...g.itens);
    else { const novo = { lideranca: g.lideranca, itens: [...g.itens] }; porNome.set(chave, novo); grupos.push(novo); }
  }

  const resultados = [];
  for (let i = 0; i < grupos.length; i++) {
    elAgora.textContent = "Conferindo " + grupos[i].lideranca + " (" + (i + 1) + " de " + grupos.length + ")…";
    progresso(i / grupos.length);
    resultados.push(await processarGrupo(grupos[i].lideranca, grupos[i].itens));
  }
  progresso(1);
  mostrarResumoLote(resultados, avisos);
};

$("b-cancelar-lider").onclick = () => {
  PENDENTE = null;
  trocarTela("form");
};

/* Versão enxuta de finalizarLeitura para o processamento em lote: sem as
   barras de fase (elas são pensadas para uma lista só) e sem navegar pra
   tela de resultado — quem chama decide o que fazer com o retorno. */
async function processarGrupo(lideranca, brutos) {
  const res = brutos.map((b) => conferir(b));
  try {
    const chaves = [...new Set(
      res.filter((r) => r.zona && r.secao && r.nome !== "(nome não identificado)")
         .map((r) => r.chave),
    )];
    const dups = await buscarDuplicados(chaves, lideranca);
    for (const r of res) {
      const d = dups.get(r.chave);
      if (d) {
        r.dup = d.lideranca;
        if (RANK["fora"] > RANK[r.status]) r.status = "fora";
        r.problemas.push("Já cadastrado na lista de " + d.lideranca + ".");
      }
    }
    await registrar(res, lideranca);
  } catch (e) {
    console.error(e);
  }
  return { lideranca, res };
}

let ULTIMO_LOTE = null;

function mostrarResumoLote(resultados, avisos) {
  trocarTela("lote");
  ULTIMO_LOTE = resultados;

  const topo = $("lote-topo");
  topo.replaceChildren();
  const h2 = document.createElement("h2");
  h2.textContent = resultados.length + " listas processadas";
  topo.append(h2);
  if (avisos && avisos.length) {
    const d = document.createElement("div"); d.className = "note warn";
    d.innerHTML = "<b>Avisos da leitura</b><br>" + avisos.map(escapar).join("<br>");
    topo.append(d);
  }

  const lista = $("lote-lista");
  lista.replaceChildren();
  for (const { lideranca, res } of resultados) {
    const nOk = res.filter((r) => r.status === "ok").length;
    const nBad = res.filter((r) => r.status === "erro").length;
    const nWarn = res.length - nOk - nBad;

    // Botão em vez de div: dá pra abrir a lista de só essa liderança
    // (cartões coloridos e "Exportar PDF" individuais), sem precisar do ZIP.
    const row = document.createElement("button"); row.type = "button"; row.className = "card click";
    row.onclick = () => mostrarResultado(res, [], lideranca, true);
    const hd = document.createElement("div"); hd.className = "hd";
    const nm = document.createElement("div"); nm.className = "nome"; nm.textContent = lideranca;
    hd.append(nm); row.append(hd);

    const dd = document.createElement("div"); dd.className = "dados";
    const info = document.createElement("span");
    info.textContent = res.length + " cadastros · " + nOk + " conferem · " + nBad + " com problema · " + nWarn + " a verificar";
    dd.append(info); row.append(dd);

    const hint = document.createElement("p"); hint.className = "hint";
    hint.textContent = "Toque para abrir e exportar só esta lista";
    row.append(hint);

    lista.append(row);
  }
}

$("b-lote-zip").onclick = () => { if (ULTIMO_LOTE) baixarZipLote(ULTIMO_LOTE); };
$("b-lote-voltar").onclick = () => trocarTela("lote");

$("b-lote-nova").onclick = () => {
  ULTIMO_LOTE = null;
  for (const a of ANEXOS) if (a.url) URL.revokeObjectURL(a.url);
  ANEXOS = []; LIDER = "";
  desenharArquivos();
  revisarForm();
  trocarTela("form");
};

async function finalizarLeitura(lideranca, brutos, avisos) {
  LIDER = lideranca;

  /* conferência local */
  elAgora.textContent = "Conferindo na base de locais de votação…";
  const res = brutos.map((b) => conferir(b));
  $("fl-conf").style.width = "100%";
  $("fase-conf").classList.add("done");
  $("st-conf").textContent = res.length + (res.length === 1 ? " conferida" : " conferidas");
  progresso(0.85);

  /* duplicados */
  elAgora.textContent = "Cruzando com as listas já cadastradas…";
  let gravados = 0;
  try {
    const chaves = [...new Set(
      res.filter((r) => r.zona && r.secao && r.nome !== "(nome não identificado)")
         .map((r) => r.chave),
    )];
    const dups = await buscarDuplicados(chaves, lideranca);
    for (const r of res) {
      const d = dups.get(r.chave);
      if (d) {
        r.dup = d.lideranca;
        if (RANK["fora"] > RANK[r.status]) r.status = "fora";
        r.problemas.push("Já cadastrado na lista de " + d.lideranca + ".");
      }
    }
    gravados = await registrar(res, lideranca);
    $("st-dup").textContent = gravados + (gravados === 1 ? " novo" : " novos");
  } catch (e) {
    console.error(e);
    avisos.push("Não consegui cruzar com as outras listas: " + e.message);
    $("st-dup").textContent = "falhou";
  }
  $("fl-dup").style.width = "100%";
  $("fase-dup").classList.add("done");
  progresso(1);
  await new Promise((r) => setTimeout(r, 300));

  mostrarResultado(res, avisos, lideranca);
}

bAnalisar.onclick = () => analisar({});

/* ---------------------------------------------------------------------
   RESULTADO
   ------------------------------------------------------------------- */
const PILL = { ok:"Confere", erro:"Problema", fora:"Verificar", incompleto:"Incompleto" };
const COR  = { ok:"ok", erro:"bad", fora:"warn", incompleto:"warn" };
const GRUPOS = [
  { chave:"erro",       titulo:"Precisam de correção" },
  { chave:"fora",       titulo:"Conferir manualmente" },
  { chave:"incompleto", titulo:"Faltou preencher" },
];

function formatarTitulo(t) {
  if (!t) return "sem título";
  const n = t.padStart(12, "0");
  return n.slice(0, 4) + " " + n.slice(4, 8) + " " + n.slice(8, 12);
}

function formatarTelefone(t) {
  const d = String(t || "").replace(/\D/g, "");
  if (d.length === 11) return "(" + d.slice(0,2) + ") " + d.slice(2,7) + "-" + d.slice(7);
  if (d.length === 10) return "(" + d.slice(0,2) + ") " + d.slice(2,6) + "-" + d.slice(6);
  if (d.length === 9)  return d.slice(0,5) + "-" + d.slice(5);
  if (d.length === 8)  return d.slice(0,4) + "-" + d.slice(4);
  return d;
}

function escapar(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
}

function mostrarResultado(res, avisos, lideranca, veioDoLote) {
  trocarTela("res");
  ULTIMO = { res, lideranca };
  const topo = $("res-topo"), cards = $("res-cards"), saida = $("res-saida");
  topo.replaceChildren(); cards.replaceChildren(); saida.replaceChildren();

  // Vindo do resumo do lote: "Refazer leitura" apagaria e releria as
  // fotos do lote inteiro como se fossem só desta liderança, então some
  // com esse botão e mostra um jeito de voltar pro resumo em vez dele.
  $("b-refazer").hidden = !!veioDoLote;
  $("b-lote-voltar").hidden = !veioDoLote;

  const nOk  = res.filter((r) => r.status === "ok").length;
  const nBad = res.filter((r) => r.status === "erro").length;
  const nWarn = res.length - nOk - nBad;

  // Nome sugerido pelo navegador ao salvar como PDF (Ctrl+P > Salvar).
  document.title = "Export_" + lideranca;

  /* Cabeçalho que só aparece no PDF — a folha impressa sai do contexto
     da tela, então precisa dizer de quem é a lista e de quando. */
  const cab = $("cabecalho-impressao");
  cab.replaceChildren();
  const h2 = document.createElement("h2");
  h2.textContent = "Lista de " + lideranca;
  const pp = document.createElement("p");
  pp.textContent =
    "Conferida em " + new Date().toLocaleString("pt-BR", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    }) +
    " · " + res.length + (res.length === 1 ? " cadastro" : " cadastros") +
    " · " + nOk + " conferem, " + nBad + " com problema, " + nWarn + " a verificar" +
    " · Teresina PI";
  cab.append(h2, pp);

  const sum = document.createElement("div");
  sum.className = "summary";
  for (const [cls, n, rot] of [["ok",nOk,"Confere"],["bad",nBad,"Problema"],["warn",nWarn,"Verificar"]]) {
    const d = document.createElement("div"); d.className = "stat " + cls;
    const b = document.createElement("b"); b.textContent = n;
    const s = document.createElement("span"); s.textContent = rot;
    d.append(b, s); sum.append(d);
  }
  topo.append(sum);

  if (!res.length) {
    const d = document.createElement("div"); d.className = "note warn";
    d.innerHTML = "<b>Não consegui ler nenhum nome nas fotos.</b><br>Tente fotografar mais de perto, com a folha reta e boa luz.";
    topo.append(d);
  }
  if (avisos.length) {
    const d = document.createElement("div"); d.className = "note warn";
    d.innerHTML = "<b>Avisos da leitura</b><br>" + avisos.map(escapar).join("<br>");
    topo.append(d);
  }

  if (res.length) {
    const hd = document.createElement("div");
    hd.className = "grouphd";
    hd.append(document.createTextNode(res.length + (res.length === 1 ? " cadastro" : " cadastros")));
    cards.append(hd);
    for (const r of res) cards.append(cartao(r));
  }

  const pendentes = res.filter((r) => r.status !== "ok");
  if (pendentes.length) saida.append(blocoTexto(pendentes, res, lideranca));
}

function cartao(r) {
  const c = document.createElement("div");
  c.className = "card " + COR[r.status];

  const hd = document.createElement("div"); hd.className = "hd";
  const nm = document.createElement("div"); nm.className = "nome"; nm.textContent = r.nome;
  const pl = document.createElement("span"); pl.className = "pill " + COR[r.status];
  pl.textContent = r.dup ? "Duplicado" : PILL[r.status];
  hd.append(nm, pl); c.append(hd);

  const dd = document.createElement("div"); dd.className = "dados";
  const z = document.createElement("span");
  z.textContent = "Zona " + (r.zona || "—") + " · Seção " + (r.secao || "—");
  dd.append(z);
  if (r.telefone) {
    const tf = document.createElement("span");
    tf.textContent = formatarTelefone(r.telefone);
    dd.append(tf);
  }
  if (r.endereco) {
    const en = document.createElement("span");
    en.textContent = r.endereco;
    dd.append(en);
  }
  if (r.titulo) {
    const t = document.createElement("span");
    t.textContent = "Título " + formatarTitulo(r.titulo);
    dd.append(t);
  }
  c.append(dd);

  const lo = document.createElement("div");
  lo.className = "local " + r.localCor;
  const rot = document.createElement("span"); rot.className = "rot"; rot.textContent = "Local de votação";
  lo.append(rot);
  if (r.local) {
    const b = document.createElement("b"); b.textContent = r.local.local_votacao;
    const s = document.createElement("span"); s.textContent = r.local.bairro + " · " + r.local.endereco;
    const e = document.createElement("div"); e.className = "el";
    e.textContent = Number(r.local.eleitores).toLocaleString("pt-BR") + " eleitores nesta seção";
    lo.append(b, s, e);
  } else {
    const b = document.createElement("b"); b.textContent = r.localMsg;
    lo.append(b);
  }
  c.append(lo);

  if (r.dup) {
    const d = document.createElement("div"); d.className = "dup";
    const b = document.createElement("b"); b.textContent = "Já está na lista de " + r.dup;
    d.append(b); c.append(d);
  }

  if (r.problemas.length) {
    const ul = document.createElement("ul"); ul.className = "probs";
    for (const p of r.problemas) { const li = document.createElement("li"); li.append(document.createTextNode(p)); ul.append(li); }
    c.append(ul);
  }
  return c;
}

function montarTexto(pendentes, todos, lideranca) {
  const hoje = new Date().toLocaleDateString("pt-BR");
  const nOk = todos.filter((r) => r.status === "ok").length;
  const L = [];
  L.push("*Lista de " + lideranca + " — pendências*");
  L.push("Conferida em " + hoje);
  L.push("");
  L.push(todos.length + " cadastros · " + nOk + " conferem · " + pendentes.length + " precisam de atenção");
  L.push("");

  let i = 0;
  for (const g of GRUPOS) {
    const doGrupo = pendentes.filter((r) => r.status === g.chave);
    if (!doGrupo.length) continue;
    L.push("*" + g.titulo.toUpperCase() + "*");
    for (const r of doGrupo) {
      i++;
      L.push(i + ". " + r.nome);
      let linha = "   Zona " + (r.zona || "—") + " · Seção " + (r.secao || "—");
      if (r.telefone) linha += " · " + formatarTelefone(r.telefone);
      L.push(linha);
      if (r.endereco) L.push("   " + r.endereco);
      for (const p of r.problemas) L.push("   - " + p);
    }
    L.push("");
  }
  return L.join("\n").trim();
}

function blocoTexto(pendentes, todos, lideranca) {
  const box = document.createElement("div");
  box.className = "out";
  const hd = document.createElement("div");
  hd.className = "grouphd";
  hd.append(document.createTextNode("Mandar para a liderança"));
  const ta = document.createElement("textarea");
  ta.className = "msg"; ta.id = "msg-saida"; ta.readOnly = true;
  ta.value = montarTexto(pendentes, todos, lideranca);
  ta.setAttribute("aria-label", "Mensagem com as pendências");
  box.append(hd, ta);
  return box;
}

/* ---- os botões do fim ---- */
$("b-exportar").onclick = () => {
  const ta = $("msg-saida");
  if (!ta) {
    estado($("b-exportar"), "Nenhuma pendência", "Exportar pendências");
    return;
  }
  copiar(ta);
  const w = window.open("https://wa.me/?text=" + encodeURIComponent(ta.value), "_blank", "noopener");
  estado($("b-exportar"), w ? "Aberto no WhatsApp" : "Copiado — cole no WhatsApp", "Exportar pendências");
};

/* PDF pela impressão do navegador: sai exatamente o que está na tela,
   e o próprio aparelho oferece "Salvar como PDF". Sem biblioteca. */
$("b-pdf").onclick = () => {
  if (!ULTIMO) return;
  window.print();
};

/* ---------------------------------------------------------------------
   PDF EM LOTE — um arquivo por liderança, dentro de um ZIP.
   Aqui sim usa biblioteca (jsPDF + JSZip): não dá pra abrir N caixas de
   impressão do navegador sem clique em cada uma. Desenhado à mão em vez
   de fotografar a tela (html2canvas) — sai mais leve e com texto
   selecionável, ao custo de não copiar o CSS pixel a pixel.
   ------------------------------------------------------------------- */
function gerarPdfLista(lideranca, res) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const margem = 14, direita = 210 - margem, largura = direita - margem;
  let y = margem;

  const nOk = res.filter((r) => r.status === "ok").length;
  const nBad = res.filter((r) => r.status === "erro").length;
  const nWarn = res.length - nOk - nBad;
  const hoje = new Date().toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(20);
  doc.text("Lista de " + lideranca, margem, y); y += 7;
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(100);
  doc.text(
    "Conferida em " + hoje + " · " + res.length + " cadastros · " +
    nOk + " conferem, " + nBad + " com problema, " + nWarn + " a verificar · Teresina PI",
    margem, y,
  );
  y += 8;
  doc.setDrawColor(210); doc.line(margem, y, direita, y); y += 6;

  const PILL = { ok: "CONFERE", erro: "PROBLEMA", fora: "VERIFICAR", incompleto: "INCOMPLETO" };
  // Mesmas cores da borda/pill dos cartões na tela (--ok/--bad/--warn em
  // impressão), pra o PDF do lote não sair todo em preto e cinza.
  const CORPDF = { ok: [20, 96, 63], erro: [142, 42, 25], fora: [116, 75, 14], incompleto: [116, 75, 14] };
  const CORLOCAL = { ok: [20, 96, 63], bad: [142, 42, 25], warn: [116, 75, 14] };
  const precisa = (altura) => { if (y + altura > 297 - margem) { doc.addPage(); y = margem; } };

  for (const r of res) {
    const enderecoLinhas = r.local ? doc.splitTextToSize(r.local.bairro + " · " + r.local.endereco, largura) : [];
    const enderecoPessoaLinhas = r.endereco ? doc.splitTextToSize(r.endereco, largura) : [];
    const probLinhas = r.problemas.flatMap((p) => doc.splitTextToSize("• " + p, largura - 2));
    const alturaEstimada = 18 + enderecoLinhas.length * 3.6 + enderecoPessoaLinhas.length * 3.6 +
      probLinhas.length * 3.6 + (r.dup ? 4.5 : 0);
    precisa(alturaEstimada);
    const corStatus = CORPDF[r.status] || CORPDF.incompleto;
    const yTopo = y;

    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(20);
    doc.text(r.nome, margem, y);
    doc.setFontSize(8); doc.setTextColor(...corStatus);
    doc.text(r.dup ? "DUPLICADO" : PILL[r.status], direita, y, { align: "right" });
    y += 5;

    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(20);
    let linha1 = "Zona " + (r.zona || "—") + " · Seção " + (r.secao || "—");
    if (r.telefone) linha1 += "   " + formatarTelefone(r.telefone);
    if (r.titulo) linha1 += "   Título " + formatarTitulo(r.titulo);
    doc.text(linha1, margem, y); y += 5;

    if (enderecoPessoaLinhas.length) {
      doc.setTextColor(80);
      doc.text(enderecoPessoaLinhas, margem, y); y += enderecoPessoaLinhas.length * 3.6 + 1;
    }

    doc.setFont("helvetica", "bold"); doc.setFontSize(7.5); doc.setTextColor(130);
    doc.text("LOCAL DE VOTAÇÃO", margem, y); y += 3.8;

    const corLocal = CORLOCAL[r.localCor] || [20, 20, 20];
    if (r.local) {
      doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(...corLocal);
      doc.text(r.local.local_votacao, margem, y); y += 4;
      doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(20);
      doc.text(enderecoLinhas, margem, y); y += enderecoLinhas.length * 3.6;
      doc.setTextColor(140);
      doc.text(Number(r.local.eleitores).toLocaleString("pt-BR") + " eleitores nesta seção", margem, y); y += 4.5;
    } else {
      doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(...corLocal);
      doc.text(r.localMsg, margem, y); y += 5;
    }

    if (r.dup) {
      doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(...CORPDF.fora);
      doc.text("Já está na lista de " + r.dup, margem, y); y += 4.5;
    }

    if (probLinhas.length) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(60);
      doc.text(probLinhas, margem, y); y += probLinhas.length * 3.6;
    }

    doc.setFillColor(...corStatus);
    doc.rect(margem - 4, yTopo - 4, 1, y - yTopo, "F");

    y += 3;
    doc.setDrawColor(225); doc.line(margem, y, direita, y);
    y += 5;
  }

  return doc;
}

// Reaproveita normalizarNome (já tira acento e reduz a letras/números/
// espaço) em vez de reinventar a limpeza de caracteres para arquivo.
function nomeArquivoSeguro(s) {
  return normalizarNome(s).replace(/ /g, "-") || "sem-nome";
}

async function baixarZipLote(resultados) {
  const zip = new window.JSZip();
  for (const { lideranca, res } of resultados) {
    const doc = gerarPdfLista(lideranca, res);
    zip.file("Export_" + nomeArquivoSeguro(lideranca) + ".pdf", doc.output("arraybuffer"));
  }
  const blob = await zip.generateAsync({ type: "blob" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "confere-lista-" + new Date().toISOString().slice(0, 10) + ".zip";
  a.click();
  URL.revokeObjectURL(a.href);
}

$("b-refazer").onclick = () => {
  if (!ULTIMO) return;
  const lider = ULTIMO.lideranca;
  if (!ANEXOS.length) {
    estado($("b-refazer"), "As fotos já foram limpas", "Refazer leitura");
    return;
  }
  const pergunta = "Refazer a lista de " + lider + "? Os cadastros já gravados "
    + "no nome dele serão apagados e as mesmas fotos serão lidas de novo. "
    + "Isso consome uma nova leitura.";
  if (window.confirm(pergunta)) analisar({ refazer: true });
};

$("b-nova").onclick = () => {
  for (const a of ANEXOS) if (a.url) URL.revokeObjectURL(a.url);
  ANEXOS = []; ULTIMO = null; LIDER = "";
  desenharArquivos();
  aviso("aviso-form", "", "");
  revisarForm();
  trocarTela("form");
};

function copiar(ta) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ta.value).catch(() => selecionar(ta));
      return;
    }
  } catch { /* cai no seletor */ }
  selecionar(ta);
}

function selecionar(ta) {
  ta.removeAttribute("readonly");
  ta.focus(); ta.setSelectionRange(0, ta.value.length);
  try { document.execCommand("copy"); } catch {}
  ta.setAttribute("readonly", "");
}

function estado(btn, txt, volta) {
  btn.textContent = txt;
  setTimeout(() => { btn.textContent = volta; }, 1800);
}

/* ---- pdf.js ---- */
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}
