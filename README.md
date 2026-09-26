# yper-api

Backend compartilhado dos três frontends: **helake** (pedidos), **movix** (estoque e notas) e **yper** (treinos e nutrição).

Stack: Node 20 + Fastify 5 + Mongoose (MongoDB Atlas). Sem framework de deploy — é um processo Node comum, roda em Render, Railway, Fly, VPS ou local.

---

## Rodando local

```bash
yarn install
cp .env.example .env     # preencha MONGODB_URI e JWT_SECRET
yarn dev                 # http://localhost:4000
```

`yarn dev` usa `node --watch`, então reinicia sozinho ao salvar.

### Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `MONGODB_URI` | sim | Connection string do Atlas, **sem** o nome do banco no final |
| `MONGODB_DB` | não | Banco usado dentro do cluster (padrão `yper`) |
| `JWT_SECRET` | sim | Segredo de assinatura dos tokens. Gere com `openssl rand -base64 48` |
| `CORS_ORIGINS` | não | Origens liberadas, separadas por vírgula. Vazio libera tudo — use só em dev |
| `PORT` | não | Porta HTTP (padrão `4000`) |

---

## Banco local (Docker)

```bash
yarn db:up      # sobe um mongo:7 em localhost:27017 (docker compose)
yarn db:logs    # acompanha o log
yarn db:down    # derruba o container
```

Aponte o `.env` para `MONGODB_URI=mongodb://localhost:27017` (já é o padrão do `.env.example`). O primeiro acesso
cria o admin pela tela de setup, igual em produção. Credenciais de produção ficam só nas variáveis de ambiente
do Render — nunca neste banco local.

---

## Migrando a base que já existe

A base do helake de antes da separação continua servindo, mas precisa de dois cuidados.

**O banco.** O código antigo usava o banco que estivesse na `MONGODB_URI`. Este aqui sobrescreve com `MONGODB_DB` (padrão `yper`). Se o banco antigo tinha outro nome, coloque esse nome em `MONGODB_DB` — senão a API conecta num banco vazio e parece que os dados sumiram.

**Os usuários.** Contas criadas antes do login compartilhado não têm o campo `apps`. Sem ele o token sai sem nenhum app liberado e toda rota responde `403`.

O script resolve as duas coisas:

```bash
yarn migrate --dry-run   # lista as coleções do banco e o que seria alterado
yarn migrate             # aplica
```

Rode o `--dry-run` primeiro: a contagem por coleção confirma se `MONGODB_DB` está apontando para o banco certo. O script é idempotente — rodar de novo não faz nada.

---

## Testes

```bash
yarn test            # CORS + API de ponta a ponta
yarn test:cors       # só a borda: CORS, parsing de corpo, 404
yarn test:boot       # sobe o server.js de verdade, em modo dev e em modo produção
yarn test:contract   # confere se toda rota chamada pelos frontends existe aqui
yarn test:migrate    # confere o script de migração
yarn test:all        # todos os testes acima
yarn test:coverage   # todos com cobertura (mínimo 85%, relatório HTML em coverage/)
```

`yarn test` sobe um MongoDB em memória, levanta a API numa porta aleatória e exercita os três domínios: autenticação, reserva e baixa de estoque do helake, movimentações e notas do movix, macros e isolamento por usuário do yper.

`yarn test:cors` cobre o que acontece antes das rotas e não precisa de banco. O caso que mais importa ali é o preflight: o navegador só deixa um `PUT` ou `DELETE` sair se a resposta do `OPTIONS` listar o método, e o padrão do `@fastify/cors` é apenas `GET,HEAD,POST`. Os métodos estão declarados explicitamente em [src/app.js](src/app.js) — esse teste existe para ninguém remover sem perceber.

`yarn test:boot` roda o `server.js` como processo separado nas duas configurações de log. Em produção o pino escreve JSON puro; fora dela usa o `pino-pretty`, que é devDependency e pode não estar instalado no servidor — daí o servidor verificar se o pacote existe antes de pedir o transport.

`yarn test:contract` lê os fontes de `helake/`, `movix/` e `yper/`, extrai cada chamada `api.get/post/put/del` e verifica que a rota existe — pega quebra de contrato antes do deploy. Precisa das três pastas ao lado de `api/`; num clone isolado do backend ele pula essa parte.

Nenhum deles precisa de banco nem de `.env`.

---

## Organização do código

```
api/
├── server.js               # carrega .env, conecta no mongo, listen, shutdown
└── src/
    ├── app.js              # buildApp(): CORS, parser de corpo, error handler, registro dos domínios
    ├── config/db.js        # conexão única e reaproveitada
    ├── hooks/auth.js       # requireAuth e requireApp, usados como onRequest
    ├── lib/
    │   ├── crud.js         # fábrica de plugin com o REST padrão de um model
    │   └── errors.js       # httpError, errorHandler, notFoundHandler
    ├── models/{helake,movix,yper}/
    ├── services/           # regras que não pertencem a uma rota só (estoque, macros)
    └── routes/{helake,movix,yper}/
```

Cada domínio é um plugin Fastify que declara os hooks de autenticação uma vez e registra seus sub-plugins com prefixo:

```js
export default async function helakeRoutes(fastify) {
  fastify.addHook('onRequest', requireAuth);
  fastify.addHook('onRequest', requireApp('helake'));
  fastify.register(customers, { prefix: '/customers' });
  // ...
}
```

`buildApp()` devolve a instância **antes** dos plugins terminarem de registrar — o Fastify resolve isso no `listen()` ou num `await app.ready()`. Por isso os testes dão `await app.listen(...)` antes de mandar a primeira requisição.

O `crudRoutes(Model, options)` em [src/lib/crud.js](src/lib/crud.js) cobre o REST repetitivo. Quando a listagem precisa de agregação, passe `list`; quando a exclusão ou a edição tem regra, passe `beforeDelete` ou `beforeUpdate` — eles viram `preHandler` da rota. Diferente de um router do Express, aqui **não dá para declarar a mesma rota duas vezes** e deixar uma cair na outra, então a customização entra por essas opções.

---

## Autenticação

Uma única coleção `users` atende os três apps. O campo `apps` diz quais o usuário pode acessar, e esse valor viaja dentro do JWT.

O primeiro usuário é criado por `POST /auth/setup`, que só funciona enquanto a base estiver vazia. Daí em diante, novos usuários saem de `POST /auth/users`, que exige estar logado.

Todas as rotas fora de `/health` e `/auth` exigem o header:

```
Authorization: Bearer <token>
```

Sem token → `401`. Com token, mas sem o app liberado → `403`.

---

## Rotas

### Público

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/health` | Healthcheck usado pelo Render |
| `GET` | `/auth/status` | Diz se a base já tem algum usuário |
| `POST` | `/auth/setup` | Cria o primeiro usuário e devolve o token |
| `POST` | `/auth/login` | `{ email, password, app? }` → `{ user, token }` |

### Autenticado

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/auth/me` | Usuário do token |
| `GET` `POST` | `/auth/users` | Lista e cria usuários |

### `/helake` — pedidos

`customers`, `ingredients`, `recipes`, `orders` seguem REST completo (`GET`, `POST`, `GET/:id`, `PUT/:id`, `DELETE/:id`). Além disso:

- `GET /helake/customers` — inclui `totalOrders`, `totalSpent` e `lastOrder` agregados dos pedidos.
- `GET /helake/ingredients` — inclui `reserved` e `projectedStock`.
- `GET /helake/recipes` — inclui `ingredientCost`, `infraCost`, `totalCost`, `suggestedPrice` e `margin`.
- `GET` `PUT` `/helake/settings` — documento único de configuração.
- `GET /helake/dashboard` — pedidos ativos, faturamento do mês, prazos dos próximos 7 dias e alertas de estoque.

**Regra de estoque.** Um pedido em `new` apenas *reserva* ingredientes: o saldo real não muda, mas `projectedStock` cai. Ao passar para `in_production` o estoque é debitado de fato. Voltar de `in_production` para `cancelled` devolve. Apagar um pedido em produção também devolve.

Ingrediente usado por alguma receita, receita com pedidos e cliente com pedidos retornam `409` no `DELETE` em vez de deixar referência órfã.

### `/movix` — estoque e notas

- `suppliers`, `products`, `invoices` — REST completo.
- `GET /movix/products` — inclui `belowMinimum` e `stockValue`.
- `GET /movix/products/:id/movements` — extrato do produto.
- `GET` `POST` `/movix/movements` — histórico e lançamento.
- `POST /movix/invoices/:id/confirm` — confirma a nota e gera um movimento por item.
- `POST /movix/invoices/:id/cancel` — cancela e estorna os movimentos gerados.
- `GET /movix/dashboard` — valor em estoque, itens abaixo do mínimo, compras e vendas do mês.

**Movimentos são imutáveis.** `PUT` e `DELETE` em `/movix/movements/:id` retornam `405`. Para corrigir um saldo, lance um movimento do tipo `adjustment` — nele `quantity` é o **novo saldo**, e a API grava a diferença em `delta`. Todo movimento congela o saldo resultante em `balanceAfter`, então o extrato não depende do estado atual do produto.

**Notas.** O `totalAmount` é sempre recalculado a partir dos itens; o valor enviado pelo cliente é ignorado. Só nota em `draft` aceita `PUT` e `DELETE` — confirmada, o caminho é cancelar.

### `/yper` — treinos e nutrição

Tudo aqui é **escopado por usuário**: cada um só enxerga os próprios dados.

- `exercises`, `workouts`, `logs`, `foods`, `meals`, `measurements` — REST completo.
- `GET /yper/logs?from=&to=&limit=` — histórico; cada log traz `totalVolume` (soma de reps × carga).
- `GET /yper/meals?date=YYYY-MM-DD` ou `?from=&to=` — refeições com `totals` de macros por refeição e do período.
- `GET` `PUT` `/yper/profile` — metas diárias de calorias e macros.
- `GET /yper/dashboard` — consumido × meta do dia, treinos da semana, treino de hoje e última medição.

**Macros.** O alimento guarda os valores de uma porção (`servingSize` + `servingUnit`). O item da refeição informa a quantidade na mesma unidade, e a API aplica o fator `quantity / servingSize`.

---

## Formato de erro

Toda falha responde JSON com a chave `error`:

```json
{ "error": "Validation failed", "fields": { "unit": "Path `unit` is required." } }
```

| Status | Quando |
|---|---|
| `400` | Validação do Mongoose ou id malformado |
| `401` | Sem token ou token inválido/expirado |
| `403` | Token válido, mas sem acesso ao app |
| `404` | Registro ou rota inexistente |
| `405` | Operação não permitida (movimento de estoque é imutável) |
| `409` | Valor duplicado ou exclusão que quebraria uma referência |

---

## Deploy no Render (free)

1. Suba o repositório para o GitHub.
2. No Render: **New → Web Service**, aponte para o repo. O [render.yaml](render.yaml) já define build, start e healthcheck.
3. Preencha as variáveis marcadas como `sync: false`:
   - `MONGODB_URI` — a connection string do Atlas.
   - `CORS_ORIGINS` — as três URLs da Vercel separadas por vírgula, por exemplo
     `https://helake.vercel.app,https://movix.vercel.app,https://yper.vercel.app`.

   `JWT_SECRET` é gerado pelo próprio Render.
4. No Atlas, em **Network Access**, libere `0.0.0.0/0` — o Render free não tem IP fixo de saída.
5. Com a API no ar, rode o setup uma vez:

   ```bash
   curl -X POST https://<sua-api>.onrender.com/auth/setup \
     -H "Content-Type: application/json" \
     -d '{"name":"Pedro","email":"voce@email.com","password":"sua-senha"}'
   ```

### O plano free hiberna

Sem tráfego por 15 minutos, o Render derruba a instância e a próxima requisição leva ~50s para responder. Duas saídas:

- Um cron externo (o [cron-job.org](https://cron-job.org) é gratuito) batendo em `/health` a cada 10 minutos.
- Uma tela de loading nos frontends que tolere a primeira chamada lenta.

Vale saber que manter a instância sempre acordada consome as horas gratuitas do mês mais rápido.
