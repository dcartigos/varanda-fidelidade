# Como colocar o backend no ar

Passo a passo. Nenhuma etapa aqui exige programar — é criar tabelas, subir arquivos e colar variáveis.

**Regra que vale em tudo abaixo:** chave de API e service_role só existem como variável de ambiente no Vercel. Nunca em arquivo do repositório, nunca em HTML, nunca em conversa.

---

## Passo 1 — Criar as tabelas no Supabase

1. Abra o Supabase, projeto **varanda-fidelidade**
2. Menu **SQL Editor** → **New query**
3. Cole todo o conteúdo de `sql/01_tabelas.sql`
4. **Run**

Deve criar 6 tabelas: `envios_idempotencia`, `envios`, `eventos_whatsapp`, `status_mensagens`, `mensagens_recebidas`, `bloqueios_marketing`.

Todas ficam com RLS ligado e sem políticas — de propósito. Isso significa que a chave pública do Supabase não acessa nada. Só o backend acessa, com a `service_role`.

---

## Passo 2 — Pegar as credenciais do Supabase

No Supabase: **Project Settings** → **API**

- **Project URL** → vira `SUPABASE_URL`
- **service_role** (a secreta, não a `anon`) → vira `SUPABASE_SERVICE_ROLE_KEY`

⚠️ A `service_role` ignora todas as regras de segurança do banco. Ela é a chave-mestra. Se vazar, alguém lê e apaga a base de clientes.

---

## Passo 3 — Inventar dois segredos nossos

Você cria, guarda no gerenciador de senhas e não compartilha:

- **`APP_TOKEN`** — senha que o nosso painel usa para falar com o backend. Sem ela, qualquer pessoa que descobrisse a URL poderia mandar mensagem em nome do Varanda.
- **`WEBHOOK_TOKEN`** — vai na URL do webhook. Impede que alguém invente eventos falsos e suje o banco.

Use algo longo e aleatório para cada (30+ caracteres). O gerador do seu gerenciador de senhas serve.

---

## Passo 4 — Subir os arquivos para o GitHub

No repositório `dcartigos/varanda-fidelidade` (o mesmo da política de privacidade):

1. **Add file** → **Upload files**
2. Arraste a pasta `backend-varanda` inteira
3. **Commit changes**

O repositório vai ficar com a política de privacidade servida pelo GitHub Pages **e** o backend numa subpasta. Não conflitam.

---

## Passo 5 — Criar o projeto no Vercel

1. Vercel → **Add New** → **Project**
2. Importar o repositório `dcartigos/varanda-fidelidade`
3. Em **Root Directory**, aponte para **`backend-varanda`** ← importante
4. Framework Preset: **Other**
5. **Deploy**

---

## Passo 6 — Colar as variáveis de ambiente

No projeto do Vercel: **Settings** → **Environment Variables**. Marque os três ambientes (Production, Preview, Development).

| Nome | Valor |
|---|---|
| `YCLOUD_API_KEY` | a chave do console da YCloud (Developers → Api Key → ícone de olho) |
| `APP_TOKEN` | o segredo que você criou no passo 3 |
| `WEBHOOK_TOKEN` | o outro segredo do passo 3 |
| `SUPABASE_URL` | Project URL do passo 2 |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role do passo 2 |
| `NUMERO_ORIGEM` | `+554420900707` |

Depois de salvar, **Deployments** → no último → **Redeploy**. Variável nova só vale depois de um novo deploy.

---

## Passo 7 — Registrar o webhook na YCloud

No console da YCloud: **Developers** → **Webhooks** → adicionar endpoint.

URL (troque pelo domínio que o Vercel te deu e pelo seu `WEBHOOK_TOKEN`):

```
https://SEU-PROJETO.vercel.app/api/webhook?t=SEU_WEBHOOK_TOKEN
```

Eventos a assinar:

- `whatsappMessage.updated` — status: sent, delivered, read, failed
- `whatsappInboundMessage.received` — cliente mandou mensagem
- `whatsapp.smb.message.echoes` — mensagem digitada pela equipe no app (Coexistence)
- `whatsappPhoneNumber.updated` — mudança no número, inclusive cair para Offline

O último é o que vai nos avisar quando a conexão do Coexistence cair — o problema que apareceu em 14/08 e que fazia o envio parar sem aviso.

---

## Passo 8 — Testar

### Teste do envio

Abra o WhatsApp do seu celular e mande qualquer coisa para o 2090 (isso abre a janela de 24h). Depois, num terminal:

```bash
curl -X POST https://SEU-PROJETO.vercel.app/api/enviar \
  -H "Content-Type: application/json" \
  -H "x-varanda-token: SEU_APP_TOKEN" \
  -d '{"telefone":"999691829","texto":"Teste pelo nosso backend.","chave":"teste-manual-1","forcar":true}'
```

Resposta esperada: `{"aceito":true, ...}` — e note que ela diz explicitamente que **aceito não é entregue**.

### Teste da idempotência

Rode o mesmo comando **de novo**, sem mudar nada. Deve responder:

```json
{"ignorado": true, "motivo": "Esta mensagem já foi enviada antes..."}
```

E o seu celular **não** deve receber a segunda mensagem. Essa é a trava que impede duplicar quando a rotina roda duas vezes.

### Teste do webhook (teste D)

Responda pelo WhatsApp Business, no celular. Depois, no Supabase:

```sql
select tipo, recebido_em from eventos_whatsapp order by recebido_em desc limit 10;
select status, telefone_e164, erro_codigo, categoria_preco, preco
from status_mensagens order by registrado_em desc limit 10;
```

Se aparecerem linhas, o teste D passou e o sistema finalmente sabe a verdade sobre cada mensagem.

### Teste do SAIR

Do seu celular pessoal, mande **SAIR** para o 2090. Depois:

```sql
select * from bloqueios_marketing;
```

Seu número deve estar lá. Para desfazer o teste: `delete from bloqueios_marketing where telefone_e164 = '+5544999691829';`

---

## O que este backend faz de propósito

**Não diz "entregue" quando não sabe.** A resposta é `aceito`, com aviso explícito de que o status real vem pelo webhook. Em 14/08 eu declarei uma mensagem como entregue baseado no `200 accepted` da API — ela tinha falhado com erro 131047. O backend foi escrito para não repetir esse engano.

**Bloqueia domingo e depois das 18h**, e avisa fora da faixa de 11h às 15h. Para testes existe `"forcar": true`.

**Não duplica.** Com `chave`, a segunda tentativa é ignorada.

**Respeita o SAIR de verdade** — grava no banco e o bloqueio passa a valer para marketing. Saldo de pontos é finalidade diferente, com consentimento próprio, e continua.

**Guarda o evento cru** antes de interpretar, para não perder informação que a gente ainda não sabe que vai precisar.

---

## Ainda falta (não está aqui)

- Corrigir o gatilho da aba 1 para **"quem veio hoje"** — hoje ele compara saldo de pontos, o que erra quando o cliente resgata (180 + 20 − 100 = 100 parece perda, mas o cliente visitou)
- Criar os templates **utility** (saldo) e **marketing** (campanha) no WhatsApp Manager e mandar para aprovação
- Ligar o painel a este backend, no lugar de qualquer chamada direta
- Alerta quando o número cair para Offline
