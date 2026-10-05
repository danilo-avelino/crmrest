import type { TenantTx } from "@comanda/database";

export type DeliveryAddress = {
  street: string;
  number?: string | null;
  complement?: string | null;
  district?: string | null;
  city: string;
  state: string;
  zipCode?: string | null;
};

/** Guarda o endereço de entrega de um pedido no cadastro do cliente, sem repetir rua e número já conhecidos. */
export async function rememberAddress(
  tx: TenantTx,
  contact: { id: string; tenantId: string },
  label: string,
  address: DeliveryAddress,
): Promise<void> {
  const known = await tx.contactAddress.findFirst({
    where: { contactId: contact.id, street: address.street, number: address.number ?? null },
    select: { id: true },
  });
  if (known) return;
  await tx.contactAddress.create({ data: { tenantId: contact.tenantId, contactId: contact.id, label, ...address } });
}
