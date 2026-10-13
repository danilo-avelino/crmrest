/** Complementos escolhidos num item do pedido, um por linha, abaixo do nome do item. */
export function ItemOptions({ options }: { options: string[] }) {
  // Durante um deploy o painel novo pode falar com a API antiga, que ainda não manda os complementos.
  if (!options?.length) return null;
  return (
    <span className="block text-[11px] leading-snug text-ink-3">
      {options.map((option, index) => (
        <span key={index} className="block">
          {option}
        </span>
      ))}
    </span>
  );
}
