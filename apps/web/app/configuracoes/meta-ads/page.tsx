import { redirect } from "next/navigation";

/** A página passou para a faixa do Cardápio (26/11/2026): o endereço antigo continua valendo. */
export default function Page() {
  redirect("/cardapio/meta-ads");
}
