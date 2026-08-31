# Histórico do projeto

Registro das decisões, dos becos sem saída e do que ficou pendente.
Escrito para retomar o trabalho em outra máquina sem reconstruir o
raciocínio do zero.

---

## O problema

A coordenação recebe fichas de papel preenchidas à mão pelas lideranças,
com apoiadores de Teresina. Conferir zona e seção de cada pessoa contra a
base de locais de votação é trabalho manual e lento. A aplicação
fotografa, transcreve e confere.

---

## Como chegamos na arquitetura atual

O desenho mudou três vezes, sempre por uma restrição nova. Vale registrar
para não refazer o caminho.

**1. Artifact do Claude.** Primeira versão, publicada e funcional. OCR
grátis na conta de quem abre, base embutida na página. Descartada porque
o artifact não alcança o Supabase (sandbox bloqueia rede), tem teto de
5.000 documentos no banco próprio, e exige republicar a cada mudança da
base.

**2. Next.js na Vercel.** Cogitada por dez minutos. Morreu quando ficou
claro que o destino era GitHub Pages, que só serve arquivo estático.

**3. Site estático + Supabase + Edge Function.** O que está no ar.
GitHub Pages não guarda segredo: qualquer chave no JavaScript é pública.
Então a chave do Gemini mora na Edge Function, no servidor do Supabase, e
o site só chama a função.

```
navegador  ──anon key──>  Supabase (locais_votacao, cadastros)
    │
    └──────────────────>  Edge Function "ocr" ──chave secreta──> Gemini
```

---

## Decisões e o porquê

**Título de eleitor virou campo opcional.** A ficha real não tem esse
campo — descoberto só quando as primeiras fotos chegaram, depois de eu já
ter escrito e testado a validação de dígitos do TSE. O código continua
lá, testado, e valida quando o número aparece. Custa nada manter.

**Duplicado usa `NOME|zona|seção`, sem acento e sem caixa.** Sem título,
não existe identificador natural. A pessoa vota sempre na mesma seção, o
que torna a combinação estável. Homônimo em seção diferente não colide.

**Zona e seção entram na chave como número, sem zeros à esquerda.** No
papel a mesma seção aparece ora como `0304`, ora como `304`. Bug
encontrado em teste: as duas formas geravam chaves diferentes e o
duplicado escapava.

**A liderança gravada é a digitada, não a lida da folha.** Escolha do
usuário. Mas o site avisa quando o quadro traz nome diferente do
digitado, porque um lote de fotos pode misturar folhas de lideranças
diferentes — aconteceu no primeiro teste real.

**Campos grudados são separados por força bruta validada.** A leitura às
vezes junta zona + seção + telefone num campo só
(`0010304806190007124`). Em vez de adivinhar onde cortar, o código testa
todas as separações possíveis e aceita apenas a que cai numa seção que
existe de verdade na base — e só quando existe uma única resposta. Se
houver ambiguidade, prefere pedir conferência humana.

**Três camadas contra instabilidade do Gemini.** A função tenta uma lista
de modelos em ordem, com prazo de 35s cada; o site tenta de novo com
espera crescente (4s, 10s, 20s). Nenhuma folha se perdeu nos testes,
mesmo com dois modelos fora do ar.

**PDF pela impressão do navegador, sem biblioteca.** Sai exatamente o que
está na tela e funciona no celular. A folha de estilo força cores claras,
esconde os controles e impede que um cartão parta entre páginas.

---

## Bugs encontrados e corrigidos

| Bug | Sintoma | Causa |
|---|---|---|
| Chave com zeros à esquerda | duplicado não era detectado | `chaveDe` usava a string crua |
| Gravação recusada | `23505 duplicate key`, lote inteiro perdido | faltava `on_conflict=chave` no PostgREST |
| Anel de progresso adiantado | marcava 71% com 1 de 2 folhas | estimativa linear chegava a 90% por folha |
| Texto vazando o cartão | JSON de erro estourava a caixa | faltava `overflow-wrap` |
| Botão duplicado | "Tirar foto" e "Galeria" abriam a câmera | o seletor nativo já oferece as duas |

Um falso alarme que vale registrar: o texto do Supabase parecia
corrompido (`AGÃNCIA`), mas era só o console do Windows imprimindo
errado. Os bytes estavam corretos em UTF-8. Conferir os bytes antes de
reimportar 1.930 linhas evitou um estrago.

---

## Estado atual

Funciona de ponta a ponta, testado no celular com fichas reais.

- Base: 1.930 seções, 5 zonas de Teresina, lida do Supabase.
- Leitura: 3 folhas em paralelo em ~27 segundos.
- Custo medido: R$ 0,025 por folha.
- Testes: 24 casos, `node teste.js`.

Validação contra dado real: as 29 zonas/seções lidas das três folhas
fotografadas existiam todas na base.

---

## Pendências

**1. Publicar.** O site está só no servidor local.

O GitHub Pages gratuito exige repositório público. Como `config.js` tem a
anon key e a tabela `cadastros` está aberta, repositório público expõe
dados pessoais de eleitores. Duas saídas:

- **Cloudflare Pages** (recomendado): gratuito, publica de repositório
  **privado**, aceita domínio próprio. Resolve sem custo.
- **GitHub Pages**: repositório público. Aí é obrigatório fechar o RLS
  com autenticação antes.

O `config.js` está no `.gitignore` e existe um `config.example.js`. Seja
qual for o caminho, o `config.js` real precisa ser gerado no deploy a
partir dos secrets.

**2. Fechar o acesso à tabela `cadastros`.** Hoje qualquer um com a anon
key lê, escreve e apaga. A decisão de deixar aberto foi tomada quando o
repositório seria privado. Mudou. O caminho é login do Supabase e trocar
as policies de `anon` para `authenticated`.

**3. `ORIGENS_PERMITIDAS`.** Depois que o domínio existir, cadastrar como
secret da função para impedir que outro site gaste o crédito do Gemini.
Não protege o Supabase — CORS só vale para navegador.

**4. Botão "Refazer a lista de fulano".** Apagar e regravar os cadastros
de uma liderança. Hoje, se alguém entrou com seção errada, não há como
corrigir pela tela: rodar de novo cria um segundo registro e o errado
fica. As policies já permitem apagar.

---

## Limitações conhecidas

- Nome transcrito com erro gera chave diferente, e o duplicado passa. É o
  custo de não ter título de eleitor no papel.
- Apelido contra nome completo não cruza. "Chicunda" e "Francisco" são
  pessoas diferentes para o sistema.
- Quem foi cadastrado com seção errada não é encontrado como duplicado.
- O congestionamento do Gemini varia ao longo do dia. Se o modelo da
  frente ficar lento, reordenar `GEMINI_MODELOS` resolve sem republicar.
