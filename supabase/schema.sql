-- =====================================================================
-- Confere Lista — estrutura no Supabase
-- Rode no SQL Editor do painel: Database > SQL Editor > New query.
-- Pode rodar mais de uma vez sem quebrar nada.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. LOCAIS DE VOTAÇÃO — liberar leitura
--
-- A tabela já existe e está populada. Estes dados são públicos (o TSE
-- divulga), então leitura liberada e escrita fechada.
-- ---------------------------------------------------------------------

alter table public.locais_votacao enable row level security;

drop policy if exists "locais: leitura publica" on public.locais_votacao;
create policy "locais: leitura publica"
  on public.locais_votacao
  for select
  to anon, authenticated
  using (true);

-- Ninguém escreve pelo navegador. Alterar a base é pelo painel ou por
-- uma chave service_role, que nunca sai do servidor.


-- ---------------------------------------------------------------------
-- 2. CADASTROS — o que já foi transcrito, para achar duplicados
--
-- O formulário de papel NÃO tem título de eleitor: os campos são
-- liderança, zona, seção, telefone e nome. Então quem identifica a
-- pessoa é a coluna `chave`, montada pelo site como
--
--     NOME SEM ACENTO EM MAIUSCULA|zona|secao
--
-- Mesma pessoa vota sempre na mesma seção, o que torna a combinação
-- estável. `titulo` fica para os formulários que tiverem o campo.
--
-- A tabela é recriada aqui porque a versão anterior usava o título como
-- chave única. Ela está vazia, então nada se perde.
-- ---------------------------------------------------------------------

drop table if exists public.cadastros;

create table public.cadastros (
  id         bigint generated always as identity primary key,
  chave      text        not null,
  nome       text        not null,
  zona       integer,
  secao      integer,
  telefone   text,
  titulo     text,
  lideranca  text        not null,
  criado_em  timestamptz not null default now()
);

-- É esta restrição que faz a detecção de duplicado funcionar: a segunda
-- tentativa de gravar a mesma pessoa é recusada, e o site avisa em qual
-- lista ela já está.
create unique index cadastros_chave_key on public.cadastros (chave);

-- Buscar tudo de uma liderança (para revisar ou refazer uma lista).
create index cadastros_lideranca_idx on public.cadastros (lideranca);

alter table public.cadastros enable row level security;

drop policy if exists "cadastros: leitura" on public.cadastros;
create policy "cadastros: leitura"
  on public.cadastros
  for select to anon, authenticated using (true);

drop policy if exists "cadastros: inserir" on public.cadastros;
create policy "cadastros: inserir"
  on public.cadastros
  for insert to anon, authenticated with check (true);

-- Apagar é permitido para o coordenador refazer uma lista inteira.
drop policy if exists "cadastros: apagar" on public.cadastros;
create policy "cadastros: apagar"
  on public.cadastros
  for delete to anon, authenticated using (true);


-- ---------------------------------------------------------------------
-- 3. CONFERÊNCIA — rode e veja o resultado
-- ---------------------------------------------------------------------

select
  (select count(*) from public.locais_votacao) as locais_votacao,
  (select count(*) from public.cadastros)      as cadastros;
