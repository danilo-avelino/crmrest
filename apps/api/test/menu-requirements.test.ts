import { describe, it } from "vitest";

// Requisitos "não reproduzir" do cardápio (docs/cardapio-ia/PLANO.md, seção 3).
// R2, R6, R7 e R11 já estão cobertos em menu-pricing.test.ts e menu-delivery.test.ts.
// R3 e R12 em packages/shared/test/menu-checkout.test.ts e apps/web/components/public-checkout/checkout.test.tsx;
// R10 (salvos só depois do código, com rótulo) em checkout.test.tsx e apps/web/lib/public-checkout.test.ts.
// R15 ("na retirada" no pagamento da retirada) em apps/web/lib/public-order.test.ts.
// Ao cobrir um requisito, apagar o todo daqui e escrever o teste no arquivo da tarefa.
describe("cardápio: requisitos pendentes", () => {
  it.todo("R5 ordem do cardápio configurável, com destaques e a categoria principal primeiro (F2-08)");
  it.todo("R8 campo de cupom visível sem identificação (F3-06; coberto em apps/web/lib/bag.test.ts)");
  it.todo("R14 QR, copia e cola, valor e validade logo depois de enviar; no WhatsApp, o código em mensagem separada (F6-04, F6-05)");
  it.todo("R16 permissão de notificação só depois do 1º pedido; logout com confirmação (F3-09)");
});
