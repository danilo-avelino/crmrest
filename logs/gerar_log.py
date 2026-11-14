"""Gera o log das conversas do Dish Desk de um dia (produção, só leitura).

Uso:  python -I logs/gerar_log.py 2026-11-12   (um dia)
      python -I logs/gerar_log.py              (todos os dias que faltam até ontem, no máximo 14)
Saída: logs/dishdesk-conversas-AAAA-MM-DD.md; o histórico de execuções fica em logs/gerar_log.log.
Roda todo dia pela tarefa "Dish Desk - log de conversas" do Agendador de Tarefas do Windows.
Usa o psql do container comanda-postgres-1 (liga o container se estiver parado; o Docker
Desktop precisa estar aberto) e a linha "Senha do banco=" do .env da raiz.
"""
import csv, io, os, subprocess, sys, traceback
from collections import defaultdict
from datetime import date, datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGS = os.path.join(ROOT, "logs")
NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
CONN = "host=aws-0-us-east-1.pooler.supabase.com port=5432 user=postgres.ooffbemelkhyjypzodex dbname=postgres sslmode=require"

CANAL = {"WHATSAPP": "WhatsApp", "IFOOD": "iFood", "INSTAGRAM": "Instagram", "CARDAPIO_WEB": "Cardápio Web"}
MIDIA = {"AUDIO": "áudio", "IMAGE": "imagem", "VIDEO": "vídeo", "STICKER": "figurinha", "DOCUMENT": "documento"}
PEDIDO = {"PLACED": "recebido", "CONFIRMED": "confirmado", "PREPARING": "em preparo", "READY": "pronto",
          "DISPATCHED": "saiu para entrega", "DELIVERED": "entregue", "CANCELED": "cancelado"}
STATUS = {"OPEN": "aberta", "PENDING": "pendente", "RESOLVED": "resolvida"}


def registrar(msg):
    with open(os.path.join(LOGS, "gerar_log.log"), "a", encoding="utf-8") as f:
        f.write(f"{datetime.now():%Y-%m-%d %H:%M} {msg}\n")


def senha():
    for line in open(os.path.join(ROOT, ".env"), encoding="utf-8"):
        if line.startswith("Senha do banco="):
            return line.split("=", 1)[1].strip()
    raise RuntimeError("Faltou 'Senha do banco=' no .env")


def query(sql):
    env = dict(os.environ, MSYS_NO_PATHCONV="1")
    cmd = ["docker", "exec", "-i", "-e", "PGPASSWORD=" + senha(), "-e", "PGOPTIONS=-c default_transaction_read_only=on",
           "comanda-postgres-1", "psql", CONN, "-v", "ON_ERROR_STOP=1", "-P", "pager=off", "--csv", "-q"]
    sql = "set timezone='America/Fortaleza';\n" + sql
    out = subprocess.run(cmd, input=sql.encode("utf-8"), capture_output=True, env=env, creationflags=NOWIN)
    if out.returncode:
        raise RuntimeError(out.stderr.decode("utf-8", "replace").strip())
    return list(csv.DictReader(io.StringIO(out.stdout.decode("utf-8"))))


def corpo(m):
    t = (m["txt"] or "").strip()
    if m["mtype"] in MIDIA:
        t = f"[{MIDIA[m['mtype']]}]" + (" " + m["cap"].strip() if m["cap"] else "") + (" " + t if t else "")
    return t.replace("\n", "  \n")


def linha(m, entregador):
    h, d = m["h"], m["dir"]
    if d == "INTERNAL":
        if m["ev"] == "conversation_opened":
            return None
        if m["ev"] == "order":
            if not m["ocode"]:
                return f"`{h}` _Pedido vinculado_"
            total = f"R$ {float(m['ototal']):.2f}".replace(".", ",") if m["ototal"] else "R$ ?"
            return f"`{h}` _Pedido #{m['ocode']} · {PEDIDO.get(m['ostatus'], m['ostatus'])} · {total}_"
        return f"`{h}` _Evento ({m['ev'] or 'nota'}): {corpo(m)}_"
    if d == "INBOUND":
        return f"`{h}` **{'Entregador' if entregador else 'Cliente'}:** {corpo(m)}"
    if m["agent"]:
        extra = f" _(escrito: \"{m['orig'].strip()}\"; a IA reescreveu)_" if m["orig"] else ""
        return f"`{h}` **Atendente ({m['agent']}):** {corpo(m)}{extra}"
    if m["fp"] == "true":
        return f"`{h}` **Loja (pelo celular):** {corpo(m)}"
    if m["ai"] == "true":
        return f"`{h}` **IA:** {corpo(m)}"
    if m["auto"]:
        return f"`{h}` **Automação ({m['auto']}):** {corpo(m)}"
    return f"`{h}` **Loja:** {corpo(m)}"


def gerar(dia):
    periodo = f"m.created_at >= '{dia}' and m.created_at < '{dia + timedelta(days=1)}'"
    msgs = query(f"""
select c.id cid, t.name tenant, ch.type::text ch, ct.name contact,
  right(regexp_replace(coalesce(ct.phone,''),'\\D','','g'),4) ph4, array_to_string(ct.tags, ', ') tags,
  c.status::text cstatus, to_char(c.created_at,'DD/MM HH24:MI') copened,
  to_char(m.created_at,'HH24:MI') h, m.direction::text dir, m.type::text mtype, u.name agent,
  m.content->>'text' txt, m.content->>'automation' auto, m.content->>'event' ev, m.content->>'aiReply' ai,
  m.content->>'fromPhone' fp, m.content->>'original' orig, m.content->'media'->>'caption' cap,
  o.display_code ocode, o.status::text ostatus, o.total ototal
from messages m join conversations c on c.id=m.conversation_id join channels ch on ch.id=c.channel_id
  join tenants t on t.id=c.tenant_id join contacts ct on ct.id=c.contact_id
  left join users u on u.id=m.sent_by_user_id
  left join orders o on m.content ? 'orderId' and o.id::text = m.content->>'orderId'
where {periodo}
order by m.created_at, m.id;
""")
    evals = query(f"""
select e.conversation_id cid, to_char(e.created_at,'DD/MM HH24:MI') h, e.resolved, e.satisfied, e.score,
  e.subject, e.issue, e.fault, e.team_reason, e.churn_risk, e.summary
from conversation_evaluations e
where not coalesce(e.legacy,false)
  and e.conversation_id in (select conversation_id from messages m where {periodo})
order by e.created_at;
""")

    convs = defaultdict(list)
    for m in msgs:
        convs[m["cid"]].append(m)
    avals = defaultdict(list)
    for e in evals:
        avals[e["cid"]].append(e)

    def tem_cliente(cid):
        return any(x["dir"] == "INBOUND" for x in convs[cid])

    ids = sorted(convs, key=lambda c: (convs[c][0]["tenant"], convs[c][0]["ch"], not tem_cliente(c), convs[c][0]["h"]))
    com_cliente = [c for c in ids if tem_cliente(c)]

    out = [f"# Conversas do Dish Desk · {dia:%d/%m/%Y}", ""]
    out.append(f"Mensagens de {dia:%d/%m/%Y} (horário de Brasília) em todos os restaurantes, tiradas do banco de produção. "
               f"São {len(ids)} conversas, {len(com_cliente)} delas com mensagem do cliente ou do entregador. "
               "As que só tiveram mensagens automáticas ficam no fim de cada canal. Uma conversa aberta antes do dia mostra só as mensagens do dia. "
               "Do telefone aparecem só os 4 últimos dígitos.")
    out += ["", "**Quem fala:** Cliente / Entregador (mensagem recebida) · IA (resposta da IA) · Automação (mensagem automática, com o nome dela) · "
            "Atendente (enviada pelo painel) · Loja pelo celular (enviada fora do Dish Desk) · Loja (enviada pelo portal do canal). "
            "Em itálico, os eventos internos e os pedidos.", ""]

    out += ["## Resumo", "", "| Restaurante | Canal | Conversas | Com mensagem do cliente | Mensagens |", "|---|---|--:|--:|--:|"]
    resumo = defaultdict(lambda: [0, 0, 0])
    for c in ids:
        r = resumo[(convs[c][0]["tenant"], convs[c][0]["ch"])]
        r[0] += 1
        r[1] += tem_cliente(c)
        r[2] += sum(1 for x in convs[c] if x["ev"] != "conversation_opened")
    for (t, ch), (a, b, n) in sorted(resumo.items()):
        out.append(f"| {t} | {CANAL.get(ch, ch)} | {a} | {b} | {n} |")
    if not ids:
        out.append("| (nenhuma conversa) | | 0 | 0 | 0 |")
    out.append("")

    atual = None
    for c in ids:
        ms = convs[c]
        m0 = ms[0]
        if (m0["tenant"], m0["ch"]) != atual:
            atual = (m0["tenant"], m0["ch"])
            out += [f"## {m0['tenant']} · {CANAL.get(m0['ch'], m0['ch'])}", ""]
        entregador = "Entregador" in (m0["tags"] or "")
        out.append(f"### {m0['contact'] or '(sem nome)'}" + (" · entregador" if entregador else "")
                   + ("" if tem_cliente(c) else " · só automáticas"))
        info = [f"conversa `{c[:8]}`", f"aberta em {m0['copened']}", f"status {STATUS.get(m0['cstatus'], m0['cstatus'])}"]
        if m0["ph4"]:
            info.append(f"tel. final {m0['ph4']}")
        if m0["tags"]:
            info.append(f"tags: {m0['tags']}")
        out += [" · ".join(info), ""]
        for m in ms:
            l = linha(m, entregador)
            if l:
                out.append(l + "  ")
        for e in avals.get(c, []):
            partes = [f"nota {e['score']}", "resolvida" if e["resolved"] == "t" else "não resolvida"]
            if e["satisfied"]:
                partes.append("cliente satisfeito" if e["satisfied"] == "t" else "cliente insatisfeito")
            for k, rot in (("subject", "assunto"), ("issue", "problema"), ("fault", "culpa"), ("team_reason", "motivo da equipe")):
                if e[k]:
                    partes.append(f"{rot}: {e[k]}")
            if e["churn_risk"]:
                partes.append(f"risco de perda {float(e['churn_risk']):.0%}")
            out += ["", f"> **Avaliação da IA ({e['h']}):** " + ", ".join(partes) + (f". {e['summary']}" if e["summary"] else "")]
        out.append("")

    dest = os.path.join(LOGS, f"dishdesk-conversas-{dia}.md")
    with open(dest, "w", encoding="utf-8") as f:
        f.write("\n".join(out))
    registrar(f"ok {dia}: {len(ids)} conversas, {len(msgs)} mensagens, {len(evals)} avaliações")


def dias_pendentes():
    ontem = date.today() - timedelta(days=1)
    return [d for d in (ontem - timedelta(days=i) for i in range(13, -1, -1))
            if not os.path.exists(os.path.join(LOGS, f"dishdesk-conversas-{d}.md"))]


if __name__ == "__main__":
    dias = [date.fromisoformat(sys.argv[1])] if len(sys.argv) > 1 else dias_pendentes()
    if dias:
        subprocess.run(["docker", "start", "comanda-postgres-1"], capture_output=True, creationflags=NOWIN)
    for d in dias:
        try:
            gerar(d)
        except Exception:
            registrar(f"ERRO {d}: " + traceback.format_exc(limit=1).strip().replace("\n", " | "))
