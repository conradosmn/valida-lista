/* Testes da lógica de conferência, rodando contra a base real.
   Extrai as funções do próprio app.js — testa o código que vai pro ar,
   não uma cópia.   Rode com:  node teste.js                            */
const fs = require("fs");

const src = fs.readFileSync(__dirname + "/app.js", "utf8");
const bloco = src.slice(
  src.indexOf("const UF ="),
  src.indexOf("/* ------", src.indexOf("function conferir")),
);

const CFG = { MUNICIPIO: "Teresina" };

// base a partir do CSV original (cp1252)
const csv = fs.readFileSync(__dirname + "/../Piaui.csv", "latin1").split(/\r?\n/).slice(1);
const m = new Map();
for (const l of csv) {
  const c = l.split(";");
  if (c.length < 6) continue;
  m.set(parseInt(c[0], 10) + ":" + parseInt(c[1], 10), {
    local_votacao: c[2], endereco: c[3], bairro: c[4], eleitores: +c[5],
  });
}
const z = new Set([...m.keys()].map((k) => +k.split(":")[0]));

// um eval só, para as declarações `let` do bloco ficarem no mesmo escopo
const fn = eval(bloco + "\nLOCAIS = m; ZONAS = z; ({conferir, validarTitulo, chaveDe, normalizarNome, separarCampos});");

function gerarTitulo(uf) {
  let s = "";
  for (let i = 0; i < 8; i++) s += Math.floor(Math.random() * 10);
  let a = 0;
  for (let i = 0; i < 8; i++) a += +s[i] * (i + 2);
  let r = a % 11, d1 = r > 9 ? 0 : r;
  if (r === 0 && (uf === "01" || uf === "02")) d1 = 1;
  const b = +uf[0] * 7 + +uf[1] * 8 + d1 * 9;
  const r2 = b % 11;
  let d2 = r2 > 9 ? 0 : r2;
  if (r2 === 0 && (uf === "01" || uf === "02")) d2 = 1;
  return s + uf + d1 + d2;
}

let falhas = 0;
function caso(rot, esperado, reg) {
  const r = fn.conferir(reg);
  const ok = r.status === esperado;
  if (!ok) falhas++;
  console.log(
    (ok ? "  " : "XX"), rot.padEnd(30), "|", r.status.padEnd(10), "|",
    (r.local ? r.local.local_votacao.slice(0, 30) : r.localMsg),
  );
}

console.log("base:", m.size, "seções | zonas", [...z].sort((a, b) => a - b).join(", "));
console.log();
console.log("--- ficha real (sem título, que é o caso normal) ---");

// Valores lidos das três folhas que o coordenador fotografou.
caso("Mercia Soares — z1 s304",     "ok",         { nome:"MERCIA SOARES DA SILVA", zona:"001", secao:"0304", telefone:"86190007124", lideranca:"Erica" });
caso("Joana Garces — z1 s148",      "ok",         { nome:"JOANA GARCES DE OLIVEIRA", zona:"001", secao:"0148", lideranca:"Erica" });
caso("Karyni Lemos — z63 s348",     "ok",         { nome:"KARYNI LEMOS CARREIRO", zona:"063", secao:"348", lideranca:"Erica" });
caso("zeros à esquerda z001 s0497", "ok",         { nome:"SUELEN GARCES DA SILVA", zona:"001", secao:"0497", lideranca:"Erica" });

console.log();
console.log("--- problemas que a tela precisa pegar ---");
caso("seção inexistente na zona",   "erro",       { nome:"ANA",   zona:"1",  secao:"9999", lideranca:"Erica" });
caso("zona de outro município",     "fora",       { nome:"PEDRO", zona:"12", secao:"50",   lideranca:"Erica" });
caso("sem zona e seção",            "incompleto", { nome:"RITA",  zona:"",   secao:"",     lideranca:"Erica" });
caso("nome não lido",               "incompleto", { nome:"",      zona:"1",  secao:"148",  lideranca:"Erica" });

console.log();
console.log("--- título, agora opcional ---");
const tPI = gerarTitulo("15");
caso("sem título (normal)",         "ok",         { nome:"JOSE",  zona:"1", secao:"148", lideranca:"Erica" });
caso("título válido do PI",         "ok",         { nome:"JOSE",  zona:"1", secao:"148", titulo:tPI, lideranca:"Erica" });
caso("título com dígito trocado",   "erro",       { nome:"CARLA", zona:"1", secao:"148", titulo:tPI.slice(0,11)+((+tPI[11]+1)%10), lideranca:"Erica" });
caso("título de outro estado",      "fora",       { nome:"LUCAS", zona:"1", secao:"148", titulo:gerarTitulo("01"), lideranca:"Erica" });

console.log();
console.log("--- chave de duplicado ---");
const pares = [
  ["mesma pessoa, grafia diferente", "José da Silva|1|148",  "JOSE DA SILVA|1|148",  true],
  ["acento e espaço extra",          "Mércia  Soares|1|304", "MERCIA SOARES|1|304",  true],
  ["zeros à esquerda x sem zeros",   "Mercia Soares|001|0304","MERCIA SOARES|1|304", true],
  ["seção com zero, zona sem",       "Joana Garces|1|0148",  "JOANA GARCES|001|148", true],
  ["homônimo em outra seção",        "Maria Silva|1|148",    "Maria Silva|1|304",    false],
  ["homônimo em outra zona",         "Maria Silva|1|148",    "Maria Silva|2|148",    false],
];
for (const [rot, a, b, deveIgualar] of pares) {
  const [na, za, sa] = a.split("|"), [nb, zb, sb] = b.split("|");
  const igual = fn.chaveDe(na, za, sa) === fn.chaveDe(nb, zb, sb);
  const ok = igual === deveIgualar;
  if (!ok) falhas++;
  console.log((ok ? "  " : "XX"), rot.padEnd(30), "|", igual ? "mesma chave" : "chaves distintas");
}

console.log();
console.log("--- campos grudados na leitura ---");
const grudados = [
  ["zona+seção+telefone juntos", "0010304806190007124", "", "1|304"],
  ["zona+seção juntos",          "0010304",             "", "1|304"],
  ["ambíguo, não mexe",          "11148",               "", null],
  ["seção inexistente, não mexe","0019999",             "", null],
  ["curto demais, não mexe",     "12",                  "", null],
];
for (const [rot, zz, ss, esperado] of grudados) {
  const s = fn.separarCampos(zz, ss, "");
  const obtido = s.recuperado ? parseInt(s.zona,10) + "|" + parseInt(s.secao,10) : null;
  const ok = obtido === esperado;
  if (!ok) falhas++;
  console.log((ok ? "  " : "XX"), rot.padEnd(30), "|",
    s.recuperado ? "separou em z" + parseInt(s.zona,10) + " s" + parseInt(s.secao,10) : "deixou intacto");
}

// varredura estatística do validador de título
let round = 0;
for (const cod of ["01", "02", "15", "20", "28"]) {
  for (let i = 0; i < 3000; i++) if (!fn.validarTitulo(gerarTitulo(cod)).ok) round++;
}
let aceitos = 0; const total = 100000;
for (let i = 0; i < total; i++) {
  let n = "";
  for (let j = 0; j < 12; j++) n += Math.floor(Math.random() * 10);
  if (fn.validarTitulo(n).ok) aceitos++;
}
if (round) falhas++;

console.log();
console.log("round-trip de títulos gerados (15 mil):", round === 0 ? "0 falhas" : round + " FALHAS");
console.log("aleatórios aceitos:", (100 * aceitos / total).toFixed(3) + "%  (esperado ~0,23%)");
console.log();
console.log(falhas === 0 ? "TUDO CERTO" : falhas + " FALHAS");
process.exit(falhas === 0 ? 0 : 1);
