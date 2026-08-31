# Próximos passos

Lembrete do que ficou faltando. Na ordem em que faz sentido atacar.

---

## 0. Ligar o projeto no laptop

```bash
git clone https://github.com/conradosmn/valida-lista.git
cd valida-lista
cp web/config.example.js web/config.js
```

Falta preencher no `web/config.js`:

- `SUPABASE_ANON_KEY` — painel do Supabase, **Project Settings → API →
  Legacy anon, service_role API keys → `anon public`**

O resto já vem preenchido: URL do projeto, URL da função e
`FOLHAS_SIMULTANEAS: 3`.

Para rodar:

```bash
python -m http.server 8080
# abre http://localhost:8080/web/index.html
```

Para testar no celular, troque `localhost` pelo IP da máquina.

---

## 1. Decidir onde publicar  ← a decisão que trava as outras

Não é escolha de hospedagem, é escolha de segurança.

### Opção A — Cloudflare Pages (recomendado)

- Publica de repositório **privado**, de graça.
- Aceita domínio próprio, que é o subdomínio que você quer.
- Você fecha o código sem pagar nada.

Passos: dash.cloudflare.com → Workers & Pages → Create → Pages →
Connect to Git → escolhe o `valida-lista`. Build command: nenhum.
Output directory: `web`.

O `config.js` não está no Git. Duas saídas: commitar ele num repositório
privado (aceitável, já que é privado), ou gerar no build.

### Opção B — GitHub Pages

Exige repositório **público** no plano gratuito. Aí a anon key fica
exposta e o passo 2 vira obrigatório antes de publicar, não depois.

---

## 2. Fechar o acesso à tabela `cadastros`

Hoje qualquer um com a anon key **lê, grava e apaga** os cadastros. São
nome, telefone e seção eleitoral de pessoas reais — dado pessoal sob a
LGPD.

Isso foi decidido quando o repositório seria privado. Se for para o ar
sem login, deixa de ser risco teórico.

O caminho: ativar o login por e-mail no Supabase (Authentication →
Providers), cadastrar a equipe, e trocar as policies de `anon` para
`authenticated` no `supabase/schema.sql`. É uma tela de login a mais no
site.

Enquanto o site não estiver publicado, ninguém tem a chave.

---

## 3. Travar a função no domínio

Depois que o subdomínio existir, cadastrar no painel do Supabase em
**Edge Functions → Secrets**:

```
ORIGENS_PERMITIDAS = https://seu-subdominio.seudominio.com.br
```

Impede que outro site chame a função e gaste seu crédito do Gemini.
Não protege o Supabase — CORS só vale para navegador.

---

## Se algo estiver lento ou falhando

**Leitura demorando ou dando erro:** provavelmente é congestionamento do
Gemini, que varia ao longo do dia. Reordene os modelos no secret
`GEMINI_MODELOS` colocando na frente o que estiver respondendo. Não
precisa republicar a função.

```
GEMINI_MODELOS = gemini-3.5-flash,gemini-3.7-flash,gemini-3.6-flash
```

**Erro 429:** limite de taxa. Baixe `FOLHAS_SIMULTANEAS` no
`config.js` para 1 ou 2.

**Testar se a função está de pé:**

```bash
curl -X POST https://mqvkgvyvsbzeixvuwwgs.supabase.co/functions/v1/ocr \
  -H "Authorization: Bearer SUA_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"imagem":"","tipo":"image/jpeg"}'
# resposta esperada: {"erro":"Nenhuma imagem foi enviada."}
```

---

## Ideias que ficaram para depois

- Corrigir um cadastro na própria tela, em vez de refazer a lista toda.
- Painel simples listando as lideranças e quantos cadastros cada uma tem.
- Exportar no formato do `template_importacao.csv` para subir no CRM.
