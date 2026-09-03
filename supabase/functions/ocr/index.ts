// =====================================================================
// Edge Function: ocr
//
// Recebe a foto de uma página de lista e devolve as linhas transcritas.
// A chave do Gemini vive aqui, no servidor do Supabase, e nunca chega ao
// navegador — é a única razão desta função existir.
//
// Publicar pelo painel: Edge Functions > Deploy a new function > Via Editor,
// nome "ocr", e cola este arquivo. Depois, na aba Secrets, cadastre
// GEMINI_API_KEY. Pela linha de comando seria:
//
//   supabase functions deploy ocr
//   supabase secrets set GEMINI_API_KEY=...
//   supabase secrets set ORIGENS_PERMITIDAS="https://confere.seudominio.com.br"
//
// GEMINI_API_KEY_PAGA é opcional: uma segunda chave (de um projeto COM
// billing) usada só como reserva, quando a chave principal (pensada pra
// ficar no tier grátis) estourar o limite de requisições. Sem essa
// variável, o comportamento é o de sempre.
//
//   supabase secrets set GEMINI_API_KEY_PAGA=...
//
// Deixe a verificação de JWT LIGADA (o padrão). O site manda a anon key
// no cabeçalho Authorization, que já satisfaz a verificação — e assim
// quem não tem a chave nem chega a gastar seu crédito do Gemini.
//
// Conferir os modelos disponíveis para a sua chave:
//   curl "https://generativelanguage.googleapis.com/v1beta/models?key=SUA_CHAVE"
// =====================================================================

// Modelos em ordem de preferência. Quando o primeiro devolve 5xx
// (sobrecarga do lado do Google, que acontece), cai para o seguinte em
// vez de devolver erro — a folha é lida do mesmo jeito.
const MODELOS = (Deno.env.get("GEMINI_MODELOS") ??
  "gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash")
  .split(",").map((m) => m.trim()).filter(Boolean);

// Quanto esperar cada modelo antes de tentar o próximo.
const PRAZO_MODELO = Number(Deno.env.get("PRAZO_MODELO_MS") ?? 35000);

// Só estes endereços podem chamar a função pelo navegador. Não é uma
// muralha (CORS só vale para navegador), mas impede que um site de
// terceiro gaste o seu crédito.
const ORIGENS = (Deno.env.get("ORIGENS_PERMITIDAS") ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function cors(origem: string | null): Record<string, string> {
  const liberada =
    origem && (ORIGENS.length === 0 || ORIGENS.includes(origem)) ? origem : "";
  return {
    "Access-Control-Allow-Origin": liberada || "null",
    "Access-Control-Allow-Headers": "authorization, content-type, apikey",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

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
- Esta ficha normalmente NÃO tem título de eleitor. Só preencha "titulo" se houver mesmo um número de título escrito no quadro.
- Campo em branco ou que você não consiga ler com certeza: null. Prefira null a chutar — um número errado causa mais estrago do que um campo vazio.
- Ignore os rótulos impressos do formulário e qualquer anotação fora dos quadros.

Transcreva todos os quadros que tenham pelo menos um nome legível.`;

// Força a resposta a sair no formato certo, sem depender de o modelo
// obedecer à instrução em texto.
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
      titulo:    { type: "STRING", nullable: true },
    },
    required: ["nome"],
  },
};

Deno.serve(async (req) => {
  const origem = req.headers.get("origin");
  const cabecalhos = { ...cors(origem), "Content-Type": "application/json" };

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origem) });

  if (req.method !== "POST") {
    return json({ erro: "Use POST." }, 405, cabecalhos);
  }
  if (origem && ORIGENS.length > 0 && !ORIGENS.includes(origem)) {
    return json({ erro: "Origem não autorizada." }, 403, cabecalhos);
  }

  const CHAVES = [
    Deno.env.get("GEMINI_API_KEY") ?? "",
    Deno.env.get("GEMINI_API_KEY_PAGA") ?? "",
  ].filter(Boolean);
  if (!CHAVES.length) {
    return json({ erro: "A função está sem a chave do Gemini configurada." }, 500, cabecalhos);
  }

  let corpo: { imagem?: string; tipo?: string };
  try {
    corpo = await req.json();
  } catch {
    return json({ erro: "Corpo da requisição inválido." }, 400, cabecalhos);
  }

  const imagem = corpo.imagem ?? "";
  const tipo = corpo.tipo ?? "image/jpeg";

  if (!imagem) return json({ erro: "Nenhuma imagem foi enviada." }, 400, cabecalhos);
  if (imagem.length > 7_000_000) {
    return json({ erro: "Imagem grande demais. Reduza antes de enviar." }, 413, cabecalhos);
  }
  if (!["image/jpeg", "image/png", "image/webp", "image/heic"].includes(tipo)) {
    return json({ erro: "Formato não aceito. Envie JPEG, PNG ou WebP." }, 415, cabecalhos);
  }

  const corpoGemini = JSON.stringify({
    systemInstruction: { parts: [{ text: INSTRUCOES }] },
    contents: [{
      role: "user",
      parts: [
        { inline_data: { mime_type: tipo, data: imagem } },
        { text: "Transcreva esta página." },
      ],
    }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: ESQUEMA,
      temperature: 0,
    },
  });

  try {
    // resposta do Gemini: forma livre, lida com acesso opcional abaixo
    // deno-lint-ignore no-explicit-any
    let dados: any = null;
    let usado = "";
    let ultimoStatus = 0;

    // Testa os modelos com a chave atual (sobrecarga/freio de taxa); só
    // quando TODOS falham é que passa pra próxima chave — assim
    // aproveita ao máximo o tier grátis antes de gastar da paga.
    porChave:
    for (const chave of CHAVES) {
      for (const modelo of MODELOS) {
        let r: Response;
        try {
          r = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-goog-api-key": chave },
              body: corpoGemini,
              // Prazo por modelo: quando um está congestionado ele demora
              // mais de um minuto só para falhar. Sem este corte, a espera
              // dos modelos se soma e a leitura passa de dois minutos.
              signal: AbortSignal.timeout(PRAZO_MODELO),
            },
          );
        } catch (e) {
          console.error("gemini", modelo, "sem resposta", String(e).slice(0, 200));
          ultimoStatus = 504;
          continue;
        }

        if (r.ok) { dados = await r.json(); usado = modelo; break porChave; }

        const detalhe = await r.text();
        console.error("gemini", modelo, r.status, detalhe.slice(0, 400));
        ultimoStatus = r.status;

        // Sobrecarga ou freio de taxa: vale tentar o próximo modelo (e,
        // esgotados os modelos, a próxima chave).
        if (r.status >= 500 || r.status === 429) continue;

        // Chave recusada: repetir com outro modelo não resolve, mas a
        // próxima chave (se houver) pode funcionar.
        if (r.status === 403) continue porChave;

        const msg = r.status === 400 ? "O Gemini recusou a requisição. Confira o nome do modelo."
          : "Não consegui ler esta página.";
        return json({ erro: msg }, r.status, cabecalhos);
      }
    }

    if (!dados) {
      const msg = ultimoStatus === 429
        ? "Muitas leituras seguidas. Espere um pouco."
        : ultimoStatus === 403
        ? "A chave do Gemini foi recusada."
        : ultimoStatus === 504
        ? "O Gemini demorou demais para responder. Tente de novo."
        : "O Gemini está sobrecarregado. Tente de novo.";
      return json({ erro: msg }, ultimoStatus === 403 ? 500 : (ultimoStatus || 502), cabecalhos);
    }

    const bloqueio = dados?.promptFeedback?.blockReason;
    if (bloqueio) {
      return json({ erro: "A leitura desta imagem foi bloqueada." }, 422, cabecalhos);
    }

    const texto = (dados?.candidates?.[0]?.content?.parts ?? [])
      .map((p: { text?: string }) => p.text ?? "")
      .join("");

    const linhas = extrairJson(texto);
    if (!linhas) {
      return json(
        { erro: "A transcrição não voltou em formato de lista.", bruto: texto.slice(0, 500) },
        502, cabecalhos,
      );
    }

    const uso = dados?.usageMetadata ?? {};
    return json({
      linhas,
      modelo: usado,
      uso: { entrada: uso.promptTokenCount, saida: uso.candidatesTokenCount },
    }, 200, cabecalhos);

  } catch (e) {
    console.error(e);
    return json({ erro: "Não consegui falar com o Gemini." }, 502, cabecalhos);
  }
});

function json(corpo: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(corpo), { status, headers });
}

// Com responseSchema a resposta já vem limpa, mas aceita também cerca de
// código e texto em volta — sai mais barato do que uma releitura.
function extrairJson(texto: string): unknown[] | null {
  const tentativas = [texto];

  const cerca = texto.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (cerca) tentativas.push(cerca[1]);

  const i = texto.indexOf("[");
  const f = texto.lastIndexOf("]");
  if (i !== -1 && f > i) tentativas.push(texto.slice(i, f + 1));

  for (const t of tentativas) {
    try {
      const v = JSON.parse(t.trim());
      if (Array.isArray(v)) return v;
    } catch { /* tenta a próxima forma */ }
  }
  return null;
}
