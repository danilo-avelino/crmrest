/** Loja indisponível (W20): link errado, cardápio desligado e assinatura suspensa dão a mesma tela, sem dizer o motivo. */
export default function MenuUnavailable() {
  return (
    <main className="flex flex-1 flex-col items-center px-6 pt-30 text-center">
      <div className="flex size-16 items-center justify-center rounded-full border border-rule bg-surface">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="text-ink-2" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5M8.5 11h5" />
        </svg>
      </div>
      <h1 className="mt-3 mb-0 font-heading text-[22px] leading-tight font-bold">Não achamos esta loja</h1>
      <p className="mt-3 mb-0 max-w-72.5 text-ink-2">O endereço pode ter mudado ou ter sido digitado errado.</p>
      <p className="mt-3 mb-0 text-[12px] text-ink-3">Confira o link que você recebeu ou peça um novo para a loja.</p>
      <p className="mt-auto pt-10 pb-5 text-[12px] text-ink-3">
        Feito com <span className="font-semibold text-ink-2">Dish Desk</span>
      </p>
    </main>
  );
}
