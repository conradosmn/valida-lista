// =====================================================================
// MODELO de configuração do Confere Lista
//
// Copie para web/config.js e preencha. O config.js real NAO vai para o
// Git (veja .gitignore) porque carrega a anon key do Supabase.
//
// ATENÇÃO: tudo neste arquivo vai para o navegador de quem abrir o site.
//
// NÃO coloque GEMINI_API_KEY aqui em produção. Sua conta do Gemini é
// paga: uma chave vazada vira fatura sem teto, e bots varrem repositórios
// atrás disso. Use OCR_URL apontando para a Edge Function, que guarda a
// chave no servidor.
//
// GEMINI_API_KEY existe só para teste local rápido. Se usar, apague antes
// de publicar.
// =====================================================================

window.CONFIG = {

  // ---- Supabase --------------------------------------------------
  // Painel > Project Settings > API. A anon key é pública por natureza:
  // quem protege os dados é o RLS, não o segredo da chave.
  SUPABASE_URL:      "https://mqvkgvyvsbzeixvuwwgs.supabase.co",
  SUPABASE_ANON_KEY: "COLE_AQUI_SUA_ANON_KEY",

  // ---- Leitura das fotos ------------------------------------------
  // A leitura das fotos passa pela Edge Function, que guarda a chave do
  // Gemini no servidor. Nada de chave aqui.
  OCR_URL: "https://mqvkgvyvsbzeixvuwwgs.supabase.co/functions/v1/ocr",

  // Só para teste local sem a função. Deixe vazio.
  GEMINI_API_KEY: "",
  GEMINI_MODELO: "gemini-3.7-flash",

  // ---- Comportamento ----------------------------------------------
  // Lado maior da foto ao enviar. Menor = mais barato e mais rápido;
  // maior = lê letra pequena melhor. 1500 é um bom meio-termo.
  LADO_MAXIMO: 1500,

  // Quantas folhas ler ao mesmo tempo.
  //   1  -> camada gratuita do Gemini (~10 req/min): evita o erro 429
  //   3  -> camada paga (150+ req/min): três folhas em ~20 segundos
  FOLHAS_SIMULTANEAS: 3,

  // Municípios da base. Zona fora desta lista vira "conferir manualmente"
  // em vez de erro — é gente que vota em outra cidade.
  MUNICIPIO: "Teresina",
};
