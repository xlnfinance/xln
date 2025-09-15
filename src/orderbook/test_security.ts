#!/usr/bin/env bun
// Test demonstrating critical security vulnerability in original orderbook

import { resetBook, newOrder, cancel, getCounters } from "./lob_core";

console.log("🔴 ДЕМОНСТРАЦИЯ КРИТИЧЕСКОЙ УЯЗВИМОСТИ В ORDERBOOK");
console.log("=" .repeat(60));

// Initialize orderbook
const params = {
  tick: 1,
  pmin: 0,
  pmax: 1_000_000,
  maxOrders: 100,
  stpPolicy: 0 as const
};

resetBook(params);

console.log("\n📝 Шаг 1: Alice (owner=1) создаёт ордер на покупку");
// Using small order IDs that fit in orderId2Idx array
newOrder(1, 10, 0, 50000, 100, 0, false, false);
console.log("   ✓ Order ID 10 создан владельцем Alice (owner=1)");

console.log("\n📝 Шаг 2: Bob (owner=2) создаёт ордер на продажу");  
newOrder(2, 11, 1, 51000, 50, 0, false, false);
console.log("   ✓ Order ID 11 создан владельцем Bob (owner=2)");

const beforeCancel = getCounters();
console.log(`\n📊 Состояние до атаки:`);
console.log(`   Активных ордеров (ACK): ${beforeCancel.evAck}`);
console.log(`   Отменённых: ${beforeCancel.evCanceled}`);

console.log("\n🚨 АТАКА: Bob (owner=2) пытается отменить ордер Alice (ID=10)!");
console.log("   Вызов: cancel(owner=2, orderId=10)");

// THIS SHOULD NOT WORK - Bob is not the owner of order 10!
// But in the vulnerable version, it will succeed
cancel(2, 10);  // Bob cancelling Alice's order!

const afterCancel = getCounters();

console.log("\n🔍 Результат:");
if (afterCancel.evCanceled > beforeCancel.evCanceled) {
  console.log("   ❌ КРИТИЧЕСКАЯ УЯЗВИМОСТЬ: Bob успешно отменил ордер Alice!");
  console.log("   ❌ Любой пользователь может отменить ЛЮБОЙ ордер!");
  console.log("   ❌ Это позволяет:");
  console.log("      • Манипулировать рынком");
  console.log("      • DoS атаки на трейдеров");
  console.log("      • Фронтраннинг через отмену чужих ордеров");
} else if (afterCancel.evReject > beforeCancel.evReject) {
  console.log("   ✅ Атака отклонена - проверка владельца работает");
} else {
  console.log("   ⚠️  Неожиданное поведение");
}

console.log("\n" + "=".repeat(60));
console.log("💡 РЕШЕНИЕ: Добавить проверку владельца в cancel():");
console.log(`
  if (orderOwner[idx] !== owner) {
    emitREJECT(owner, orderId, 'not authorized');
    return;
  }
`);

console.log("\n📈 Другие найденные проблемы:");
console.log("  1. Integer overflow в расчётах");
console.log("  2. Отсутствие FOK (Fill-Or-Kill)");
console.log("  3. Утечки памяти через неочищенные поля");
console.log("  4. Race conditions при параллельном доступе");
console.log("  5. Отсутствие лимитов на размеры ордеров");

console.log("\n✅ Рекомендация: Использовать lob_core_secure.ts с исправлениями");
