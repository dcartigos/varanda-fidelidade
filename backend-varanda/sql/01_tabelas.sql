-- ============================================================
-- Varanda Fidelidade — tabelas do backend de WhatsApp
-- Rodar no Supabase: projeto varanda-fidelidade > SQL Editor > New query > Run
-- Pode rodar mais de uma vez sem problema (tudo é "if not exists").
-- ============================================================


-- 1) Chaves de idempotência ------------------------------------------------
-- É a trava que impede mandar a mesma mensagem duas vezes para o mesmo cliente.
-- A chave recomendada é: telefone|data|tipo_mensagem
-- exemplo: 5544999691829|2026-08-14|pontos
create table if not exists envios_idempotencia (
  chave       text primary key,
  ycloud_id   text,
  criado_em   timestamptz not null default now()
);


-- 2) Todo envio que o sistema tentou ---------------------------------------
-- Grava inclusive as falhas. status_inicial NÃO é entrega — é só o que a
-- YCloud respondeu na hora. A verdade sobre entrega está em status_mensagens.
create table if not exists envios (
  id                  bigint generated always as identity primary key,
  telefone_e164       text not null,
  tipo                text not null,             -- 'texto_livre' | 'template'
  template            text,
  conteudo            text,
  chave_idempotencia  text,
  ycloud_id           text,
  wamid               text,
  status_inicial      text,                      -- accepted | erro
  http_status         integer,
  resposta            jsonb,
  criado_em           timestamptz not null default now()
);

create index if not exists envios_telefone_idx on envios (telefone_e164);
create index if not exists envios_ycloud_idx   on envios (ycloud_id);
create index if not exists envios_criado_idx   on envios (criado_em desc);


-- 3) Eventos crus do webhook ------------------------------------------------
-- Guardamos o JSON inteiro antes de interpretar. Se amanhã precisarmos de um
-- campo que hoje ignoramos, ele está aqui.
create table if not exists eventos_whatsapp (
  id              bigint generated always as identity primary key,
  tipo            text,
  ycloud_event_id text,
  payload         jsonb,
  recebido_em     timestamptz not null default now()
);

create index if not exists eventos_tipo_idx     on eventos_whatsapp (tipo);
create index if not exists eventos_recebido_idx on eventos_whatsapp (recebido_em desc);


-- 4) Status real das mensagens que mandamos --------------------------------
-- Aqui mora a verdade: sent, delivered, read, failed — e o custo real.
create table if not exists status_mensagens (
  id                  bigint generated always as identity primary key,
  ycloud_id           text,
  wamid               text,
  chave_idempotencia  text,
  telefone_e164       text,
  status              text,
  erro_codigo         text,
  erro_mensagem       text,
  preco               numeric(12,6),
  moeda               text,
  categoria_preco     text,                      -- service | utility | marketing
  enviado_em          timestamptz,
  entregue_em         timestamptz,
  lido_em             timestamptz,
  registrado_em       timestamptz not null default now()
);

create index if not exists status_ycloud_idx   on status_mensagens (ycloud_id);
create index if not exists status_telefone_idx on status_mensagens (telefone_e164);
create index if not exists status_status_idx   on status_mensagens (status);


-- 5) Mensagens que o cliente mandou ----------------------------------------
-- Cada mensagem de entrada abre a janela de 24h, dentro da qual responder é grátis.
create table if not exists mensagens_recebidas (
  id             bigint generated always as identity primary key,
  wamid          text,
  telefone_e164  text,
  tipo_conteudo  text,
  texto          text,
  recebido_em    timestamptz,
  payload        jsonb,
  registrado_em  timestamptz not null default now()
);

create index if not exists recebidas_telefone_idx on mensagens_recebidas (telefone_e164);
create index if not exists recebidas_data_idx     on mensagens_recebidas (recebido_em desc);


-- 6) Opt-out de marketing (LGPD) -------------------------------------------
-- Quando o cliente manda SAIR, entra aqui e nunca mais recebe promoção.
-- Mensagem de saldo de pontos (utility) é outra finalidade e tem consentimento
-- separado — por isso o bloqueio é só de marketing.
create table if not exists bloqueios_marketing (
  telefone_e164  text primary key,
  motivo         text,
  texto_original text,
  criado_em      timestamptz not null default now()
);


-- ============================================================
-- Segurança: RLS ligado e SEM políticas.
-- Consequência: a chave pública (anon) não lê nem escreve nada.
-- Só o backend no Vercel, usando a service_role, tem acesso.
-- É exatamente o que queremos — o navegador nunca fala com o banco.
-- ============================================================
alter table envios_idempotencia enable row level security;
alter table envios              enable row level security;
alter table eventos_whatsapp    enable row level security;
alter table status_mensagens    enable row level security;
alter table mensagens_recebidas enable row level security;
alter table bloqueios_marketing enable row level security;
