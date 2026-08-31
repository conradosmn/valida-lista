# Confere Lista

Transcreve fotos de fichas de apoiadores preenchidas à mão e confere
zona e seção contra a base de locais de votação de Teresina (PI).
Aponta ainda quem já está cadastrado na lista de outra liderança.

Site estático: HTML, CSS e JavaScript puros. Sem build, sem framework.

## Como funciona

1. O coordenador digita o nome da liderança e anexa as fotos das folhas
   (câmera, galeria ou PDF escaneado).
2. Cada folha vai para a Edge Function `ocr`, que chama o Gemini e
   devolve os quadros transcritos em JSON.
3. O site confere zona e seção contra `locais_votacao` e mostra o local
   em verde, ou o problema em vermelho.
4. Grava em `cadastros` e avisa quem já aparece na lista de outra
   liderança.

## Estrutura

```
web/                     o site — é esta pasta que vai para o ar
  index.html             tela e estilos, incluindo a folha de impressão
  app.js                 toda a lógica
  config.js              NÃO versionado: chaves e ajustes
  config.example.js      modelo para criar o config.js
  teste.js               testes; rode com `node teste.js`
supabase/
  schema.sql             tabelas e políticas de acesso
  functions/ocr/         a função que fala com o Gemini
Piaui.csv                base original do TSE (os testes leem daqui)
HISTORICO.md             decisões do projeto e o que ficou pendente
```

## Rodando local

```bash
cp web/config.example.js web/config.js   # e preencha a anon key
python -m http.server 8080
# abra http://localhost:8080/web/index.html
```

Para testar no celular na mesma rede, use o IP da máquina no lugar de
`localhost`.

## Testes

```bash
cd web && node teste.js
```

São 24 casos rodando contra a base real do CSV: validação de zona e
seção, chave de duplicado, campos grudados na leitura e o dígito
verificador do título.

## Configuração do Supabase

- `schema.sql` no SQL Editor cria as tabelas e libera as políticas.
- Edge Function `ocr`: cole `supabase/functions/ocr/index.ts` no painel.
- Secrets da função:
  - `GEMINI_API_KEY` — obrigatório
  - `GEMINI_MODELOS` — ordem de tentativa, separada por vírgula
  - `ORIGENS_PERMITIDAS` — trava a função no seu domínio
  - `PRAZO_MODELO_MS` — quanto esperar cada modelo (padrão 35000)

## Custo

Cerca de **R$ 0,025 por folha** com o Gemini Flash. Uma lista de três
folhas sai por R$ 0,08; mil páginas, R$ 25.
