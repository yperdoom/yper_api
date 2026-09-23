import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const mongo = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'smoke';
process.env.JWT_SECRET = 'smoke-secret';

const { connectDB } = await import('../src/config/db.js');
const { buildApp } = await import('../src/app.js');
await connectDB();

// Logger so no nivel de erro: um 500 inesperado aparece, o resto fica limpo.
const app = buildApp({ logger: { level: 'error' } });
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${app.server.address().port}`;

let token = null;
let failures = 0;

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label} ->`, JSON.stringify(detail));
  }
}

// ---------------- auth ----------------
console.log('\n[auth]');
const setup = await call('POST', '/auth/setup', { name: 'Pedro', email: 'Pedro@Test.com', password: 'secret123' });
check('setup cria o primeiro usuario', setup.status === 201 && !!setup.body.token, setup);
token = setup.body.token;
check('email normalizado para minusculo', setup.body.user?.email === 'pedro@test.com', setup.body.user);
check('usuario nasce com os 3 apps', setup.body.user?.apps?.length === 3, setup.body.user);

const setupAgain = await call('POST', '/auth/setup', { email: 'x@y.z', password: 'a' });
check('segundo setup bloqueado', setupAgain.status === 403, setupAgain);

const badLogin = await call('POST', '/auth/login', { email: 'pedro@test.com', password: 'errada' });
check('senha errada -> 401', badLogin.status === 401, badLogin);

const login = await call('POST', '/auth/login', { email: 'pedro@test.com', password: 'secret123', app: 'helake' });
check('login ok', login.status === 200 && !!login.body.token, login);
check('login nao vaza a senha', login.body.user?.password === undefined, login.body.user);

const me = await call('GET', '/auth/me');
check('GET /auth/me', me.status === 200 && me.body.user.email === 'pedro@test.com', me);

const restricted = await call('POST', '/auth/users', { email: 'so-movix@test.com', password: 'abc12345', apps: ['movix'] });
check('cria usuario restrito a um app', restricted.status === 201 && restricted.body.user.apps.length === 1, restricted);

const restrictedLogin = await call('POST', '/auth/login', { email: 'so-movix@test.com', password: 'abc12345', app: 'helake' });
check('login em app sem acesso -> 403', restrictedLogin.status === 403, restrictedLogin);

// ---------------- helake ----------------
console.log('\n[helake]');
const customer = await call('POST', '/helake/customers', { name: 'Maria', phone: '48999' });
check('cria cliente', customer.status === 201, customer);
const customerId = customer.body.customer?._id;

const flour = await call('POST', '/helake/ingredients', { name: 'Farinha', unit: 'kg', costPerUnit: 5, currentStock: 10, minimumStock: 2 });
check('cria ingrediente', flour.status === 201, flour);
const flourId = flour.body.ingredient?._id;

const badIngredient = await call('POST', '/helake/ingredients', { name: 'Sem unidade', costPerUnit: 1 });
check('ingrediente sem unidade -> 400', badIngredient.status === 400, badIngredient);

const recipe = await call('POST', '/helake/recipes', {
  name: 'Bolo', category: 'Cakes', yield: 1, laborCost: 10, sellingPrice: 100,
  ingredients: [{ ingredient: flourId, quantity: 2 }],
});
check('cria receita', recipe.status === 201, recipe);
const recipeId = recipe.body.recipe?._id;

const recipes = await call('GET', '/helake/recipes');
const cake = recipes.body.recipes?.[0];
// 2kg x 5 = 10 de ingrediente; infra padrao 15% = 1.5; mao de obra 10 -> total 21.5
check('custo calculado na listagem', cake?.ingredientCost === 10 && cake?.totalCost === 21.5, cake);
check('margem calculada', Math.round(cake?.margin) === 79, cake?.margin);

const order = await call('POST', '/helake/orders', { customer: customerId, recipe: recipeId, quantity: 3, deliveryDate: new Date().toISOString(), paidPrice: 300 });
check('cria pedido', order.status === 201, order);
const orderId = order.body.order?._id;

const afterOrder = await call('GET', '/helake/ingredients');
const flourNow = afterOrder.body.ingredients?.[0];
check('pedido novo reserva 6kg (2 x 3)', flourNow?.reserved === 6, flourNow);
check('estoque projetado = 4', flourNow?.projectedStock === 4, flourNow);
check('estoque real continua 10', flourNow?.currentStock === 10, flourNow);

const toProduction = await call('PUT', `/helake/orders/${orderId}`, { status: 'in_production' });
check('pedido -> producao', toProduction.status === 200, toProduction);

const afterProduction = await call('GET', '/helake/ingredients');
const flourProduced = afterProduction.body.ingredients?.[0];
check('producao debita estoque para 4', flourProduced?.currentStock === 4, flourProduced);
check('reserva zera ao sair de "new"', flourProduced?.reserved === 0, flourProduced);

const cancel = await call('PUT', `/helake/orders/${orderId}`, { status: 'cancelled' });
check('pedido -> cancelado', cancel.status === 200, cancel);
const afterCancel = await call('GET', '/helake/ingredients');
check('cancelamento devolve estoque para 10', afterCancel.body.ingredients?.[0]?.currentStock === 10, afterCancel.body.ingredients?.[0]);

const delIngredient = await call('DELETE', `/helake/ingredients/${flourId}`);
check('ingrediente usado em receita -> 409', delIngredient.status === 409, delIngredient);

const delCustomer = await call('DELETE', `/helake/customers/${customerId}`);
check('cliente com pedido -> 409', delCustomer.status === 409, delCustomer);

const customersList = await call('GET', '/helake/customers');
check('cliente traz stats (cancelado nao conta)', customersList.body.customers?.[0]?.totalOrders === 0, customersList.body.customers?.[0]);

const settings = await call('PUT', '/helake/settings', { businessName: 'Helake', defaultMargin: 60 });
check('settings salvo', settings.status === 200 && settings.body.settings.defaultMargin === 60, settings);

const dash = await call('GET', '/helake/dashboard');
check('dashboard responde', dash.status === 200 && 'ingredientAlerts' in dash.body, dash.status);

check('apaga pedido', (await call('DELETE', `/helake/orders/${orderId}`)).status === 200);
await call('DELETE', `/helake/recipes/${recipeId}`);
check('ingrediente livre pode ser apagado', (await call('DELETE', `/helake/ingredients/${flourId}`)).status === 200);

check('id inexistente -> 404', (await call('GET', '/helake/customers/000000000000000000000000')).status === 404);
check('id invalido -> 400', (await call('GET', '/helake/customers/abc')).status === 400);

// ---------------- movix ----------------
console.log('\n[movix]');
const supplier = await call('POST', '/movix/suppliers', { name: 'Atacadao', document: '00.000.000/0001-00' });
check('cria fornecedor', supplier.status === 201, supplier);
const supplierId = supplier.body.supplier?._id;

const product = await call('POST', '/movix/products', { name: 'Caixa 20x20', sku: 'cx20', unit: 'un', costPrice: 2, salePrice: 5, minimumStock: 100, supplier: supplierId });
check('cria produto', product.status === 201, product);
check('sku normalizado para maiusculo', product.body.product?.sku === 'CX20', product.body.product);
const productId = product.body.product?._id;

const dupSku = await call('POST', '/movix/products', { name: 'Outra', sku: 'CX20', unit: 'un' });
check('sku duplicado -> 409', dupSku.status === 409, dupSku);

const noSku1 = await call('POST', '/movix/products', { name: 'Sem sku A', unit: 'un' });
const noSku2 = await call('POST', '/movix/products', { name: 'Sem sku B', unit: 'un' });
check('sku vazio nao conflita', noSku1.status === 201 && noSku2.status === 201, { noSku1, noSku2 });

const movIn = await call('POST', '/movix/movements', { product: productId, type: 'in', quantity: 100, unitCost: 2, reason: 'compra' });
check('entrada de 100', movIn.status === 201 && movIn.body.movement.balanceAfter === 100, movIn);

const movOut = await call('POST', '/movix/movements', { product: productId, type: 'out', quantity: 30 });
check('saida de 30 -> saldo 70', movOut.body.movement?.balanceAfter === 70, movOut);
check('saida grava delta negativo', movOut.body.movement?.delta === -30, movOut.body.movement);

const movAdj = await call('POST', '/movix/movements', { product: productId, type: 'adjustment', quantity: 65, reason: 'contagem' });
check('ajuste para 65 gera delta -5', movAdj.body.movement?.delta === -5 && movAdj.body.movement?.balanceAfter === 65, movAdj);

const immutable = await call('DELETE', `/movix/movements/${movIn.body.movement._id}`);
check('movimento e imutavel -> 405', immutable.status === 405, immutable);

const productsList = await call('GET', '/movix/products');
const box = productsList.body.products?.find((p) => p._id === productId);
check('produto abaixo do minimo sinalizado', box?.belowMinimum === true && box?.currentStock === 65, box);
check('valor de estoque calculado', box?.stockValue === 130, box);

const delProduct = await call('DELETE', `/movix/products/${productId}`);
check('produto com historico -> 409', delProduct.status === 409, delProduct);

const invoice = await call('POST', '/movix/invoices', {
  number: '1234', series: '1', type: 'in', supplier: supplierId,
  issueDate: new Date().toISOString(),
  items: [{ product: productId, quantity: 10, unitPrice: 3 }],
  totalAmount: 999999,
});
check('cria nota', invoice.status === 201, invoice);
check('total recalculado dos itens (ignora o enviado)', invoice.body.invoice?.totalAmount === 30, invoice.body.invoice);
const invoiceId = invoice.body.invoice?._id;

const dupInvoice = await call('POST', '/movix/invoices', { number: '1234', series: '1', type: 'in', issueDate: new Date().toISOString() });
check('nota duplicada (numero/serie/tipo) -> 409', dupInvoice.status === 409, dupInvoice);

const confirm = await call('POST', `/movix/invoices/${invoiceId}/confirm`);
check('confirma nota', confirm.status === 200 && confirm.body.invoice.status === 'confirmed', confirm);

const afterConfirm = await call('GET', '/movix/products');
check('nota de entrada soma no estoque (65 -> 75)', afterConfirm.body.products?.find((p) => p._id === productId)?.currentStock === 75, afterConfirm.body.products?.[0]);

const reconfirm = await call('POST', `/movix/invoices/${invoiceId}/confirm`);
check('reconfirmar -> 409', reconfirm.status === 409, reconfirm);

const editConfirmed = await call('PUT', `/movix/invoices/${invoiceId}`, { notes: 'nope' });
check('nota confirmada nao pode ser editada -> 409', editConfirmed.status === 409, editConfirmed);

const cancelInvoice = await call('POST', `/movix/invoices/${invoiceId}/cancel`);
check('cancela nota', cancelInvoice.status === 200, cancelInvoice);

const afterCancelInvoice = await call('GET', '/movix/products');
check('cancelamento estorna o estoque (75 -> 65)', afterCancelInvoice.body.products?.find((p) => p._id === productId)?.currentStock === 65, afterCancelInvoice.body.products?.[0]);

const statement = await call('GET', `/movix/products/${productId}/movements`);
check('extrato do produto tem 5 movimentos', statement.body.movements?.length === 5, statement.body.movements?.length);

const movixDash = await call('GET', '/movix/dashboard');
check('dashboard movix responde', movixDash.status === 200 && typeof movixDash.body.stockValue === 'number', movixDash.status);

// ---------------- yper ----------------
console.log('\n[yper]');
const exercise = await call('POST', '/yper/exercises', { name: 'Supino reto', muscleGroup: 'Peito', equipment: 'Barra' });
check('cria exercicio', exercise.status === 201, exercise);
const exerciseId = exercise.body.exercise?._id;

const dupExercise = await call('POST', '/yper/exercises', { name: 'Supino reto', muscleGroup: 'Peito' });
check('exercicio duplicado do mesmo usuario -> 409', dupExercise.status === 409, dupExercise);

const workout = await call('POST', '/yper/workouts', {
  name: 'Treino A', focus: 'Peito e triceps', weekdays: [1, 4],
  items: [{ exercise: exerciseId, sets: 4, reps: '8-12', weight: 60 }],
});
check('cria treino', workout.status === 201, workout);
const workoutId = workout.body.workout?._id;

const log = await call('POST', '/yper/logs', {
  workout: workoutId, date: new Date().toISOString(), durationMinutes: 55,
  entries: [{ exercise: exerciseId, sets: [{ reps: 10, weight: 60 }, { reps: 8, weight: 65 }] }],
});
check('registra treino', log.status === 201, log);

const logs = await call('GET', '/yper/logs');
check('volume total calculado (10x60 + 8x65 = 1120)', logs.body.logs?.[0]?.totalVolume === 1120, logs.body.logs?.[0]?.totalVolume);

const food = await call('POST', '/yper/foods', { name: 'Peito de frango', servingSize: 100, servingUnit: 'g', calories: 165, protein: 31, carbs: 0, fat: 3.6 });
check('cria alimento', food.status === 201, food);
const foodId = food.body.food?._id;

const meal = await call('POST', '/yper/meals', { type: 'lunch', date: new Date().toISOString(), items: [{ food: foodId, quantity: 200 }] });
check('cria refeicao', meal.status === 201, meal);

const meals = await call('GET', '/yper/meals');
check('macros de 200g = 2x a porcao (330 kcal, 62 prot)', meals.body.meals?.[0]?.totals?.calories === 330 && meals.body.meals?.[0]?.totals?.protein === 62, meals.body.meals?.[0]?.totals);
check('totais do dia somados', meals.body.totals?.calories === 330, meals.body.totals);

const mealsOtherDay = await call('GET', '/yper/meals?date=2020-01-01');
check('filtro por data funciona', mealsOtherDay.body.meals?.length === 0, mealsOtherDay.body.meals?.length);

const profile = await call('PUT', '/yper/profile', { dailyCalories: 2500, proteinTarget: 180 });
check('perfil salvo', profile.status === 200 && profile.body.profile.dailyCalories === 2500, profile);

await call('POST', '/yper/measurements', { weightKg: 82.5, bodyFatPercentage: 16 });

const yperDash = await call('GET', '/yper/dashboard');
check('dashboard yper: consumido', yperDash.body.consumed?.calories === 330, yperDash.body.consumed);
check('dashboard yper: restante (2500 - 330)', yperDash.body.remaining?.calories === 2170, yperDash.body.remaining);
check('dashboard yper: ultima medicao', yperDash.body.lastMeasurement?.weightKg === 82.5, yperDash.body.lastMeasurement);

// isolamento por usuario
const otherToken = (await call('POST', '/auth/users', { email: 'outro@test.com', password: 'abc12345' })).body.user;
const otherLogin = await call('POST', '/auth/login', { email: 'outro@test.com', password: 'abc12345' });
const mainToken = token;
token = otherLogin.body.token;
const otherExercises = await call('GET', '/yper/exercises');
check('outro usuario nao ve os exercicios do primeiro', otherExercises.body.exercises?.length === 0, otherExercises.body.exercises?.length);
const stealAttempt = await call('GET', `/yper/exercises/${exerciseId}`);
check('outro usuario nao acessa exercicio por id -> 404', stealAttempt.status === 404, stealAttempt);
const sharedProducts = await call('GET', '/movix/products');
check('dados do movix sao compartilhados (nao sao por usuario)', sharedProducts.body.products?.length === 3, sharedProducts.body.products?.length);
token = mainToken;

await app.close();
await mongoose.disconnect();
await mongo.stop();

console.log(failures === 0 ? '\nTODOS OS TESTES PASSARAM' : `\n${failures} FALHA(S)`);
process.exit(failures === 0 ? 0 : 1);
