#!/usr/bin/env python3
"""Extrai os indicadores de uso em producao do Driva Ops Agent para o TCC.

Somente leitura sobre a aplicacao: le results/<id>/ (run.json, ticket.json,
engineering-action.json, remediation.json, diagnosis.md, cs-comment.md) e
state/approvals.json. Nao altera nenhum desses arquivos. Grava apenas os
arquivos de saida na pasta indicada por --saida.

Uso (na raiz da aplicacao, por exemplo /app dentro do conteiner):
    python3 extrair_indicadores_tcc.py --desde 2026-08-01 --ate 2026-10-31 --gh --amostra 20

Opcoes:
    --results DIR   diretorio dos artefatos (padrao: ./results)
    --state DIR     diretorio do estado (padrao: ./state)
    --desde DATA    considera execucoes iniciadas a partir da data (AAAA-MM-DD)
    --ate DATA      considera execucoes iniciadas ate a data, inclusive
    --gh            consulta o estado de cada PR (MERGED, CLOSED, OPEN) com o gh CLI
    --amostra N     sorteia N diagnosticos para a avaliacao com especialistas
    --saida DIR     pasta dos arquivos gerados (padrao: ./tcc_saida)

Arquivos gerados em --saida:
    indicadores.json            todos os numeros, para o TCC
    fontes_por_diagnostico.csv  fontes consultadas em cada diagnostico (para auditoria)
    amostra/                    um arquivo por diagnostico sorteado (USO INTERNO, pode
                                conter dados de clientes; nao enviar para fora da empresa)
    avaliacao_especialistas.csv planilha para os avaliadores preencherem
"""
import argparse
import csv
import json
import random
import re
import statistics
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

CLASSIFICACOES = ["bug", "mal_entendido", "mal_entendido_com_oportunidade", "inconclusivo"]
DECISOES = ["CORRECTION_REQUIRED", "IMPROVEMENT_RECOMMENDED", "NO_CODE_ACTION",
            "INSUFFICIENT_EVIDENCE", "ALREADY_FIXED"]
ROTULOS_CLASSIFICACAO = {
    "bug": "Classificação: bug",
    "mal_entendido": "Classificação: mal-entendido",
    "mal_entendido_com_oportunidade": "Classificação: mal-entendido com oportunidade",
    "inconclusivo": "Classificação: inconclusivo",
}
ROTULOS_DECISAO = {
    "CORRECTION_REQUIRED": "Decisão: correção necessária",
    "IMPROVEMENT_RECOMMENDED": "Decisão: melhoria recomendada",
    "NO_CODE_ACTION": "Decisão: sem ação de código",
    "INSUFFICIENT_EVIDENCE": "Decisão: evidência insuficiente",
    "ALREADY_FIXED": "Decisão: já corrigido",
}
STATUS_COM_PR = {"PR_OPENED", "MULTIPLE_PRS_OPENED"}

# Classificacao heuristica, por palavras-chave, das linhas da secao "Fontes consultadas".
CATEGORIAS_FONTE = [
    ("Bancos de dados", r"\b(banco|bancos|postgres\w*|mongo\w*|mysql|tabelas?|cole[cç](ão|ões|ao|oes)|collections?|query|queries|sql|db)\b"),
    ("Registros e rastros", r"\b(clickstack|logs?|traces?|otel|opentelemetry|hyperdx|spans?|registros de execu)"),
    ("Sessões do cliente", r"(client[ _-]?sessions?|sess(ão|ões|ao|oes) do cliente|\brum\b|replay|navegador|browser)"),
    ("Código-fonte", r"(c[oó]digo|\.tsx?\b|\.jsx?\b|\.py\b|\.go\b|\bsrc/|arquivo|fun[cç][aã]o|componente|handler|controller)"),
    ("Histórico git e PRs", r"(\bgit\b|commits?\b|pull requests?|\bprs?\b|\bpr #|blame|hist[oó]rico de (mudan|commit))"),
    ("Métricas e Kubernetes", r"(kubernetes|\bk8s\b|\bpods?\b|m[eé]tricas?|metrics|prometheus|grafana)"),
    ("Ticket e anexos", r"(\btickets?\b|anexos?|imagem|imagens|screenshot|coment[aá]rios? do ticket)"),
]
SECOES = (r"(evid[eê]ncias|fontes indispon|causa|conclus|pr[oó]ximos passos|linha do tempo|timeline|resumo|"
    r"cadeia causal|escopo|hip[oó]teses|lacunas|confian[cç]a|impacto|a[cç][aã]o)")
FIM_DE_SECAO = re.compile(r"^\s*(#{1,6}\s|\d+\.\s+\*\*|\*\*\s*" + SECOES + ")", re.I)


def ler_json(caminho):
    try:
        return json.loads(Path(caminho).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def ler_texto(caminho):
    try:
        return Path(caminho).read_text(encoding="utf-8")
    except OSError:
        return ""


def data_iso(valor):
    if not isinstance(valor, str) or not valor:
        return None
    try:
        return datetime.fromisoformat(valor.replace("Z", "+00:00"))
    except ValueError:
        return None


def no_periodo(inicio, desde, ate):
    if inicio is None:
        return desde is None and ate is None
    if desde and inicio < desde:
        return False
    if ate and inicio >= ate:
        return False
    return True


def pct(parte, total):
    return f"{100 * parte / total:.1f}".replace(".", ",") if total else "-"


def estado_pr(url):
    try:
        saida = subprocess.run(["gh", "pr", "view", url, "--json", "state"],
                               capture_output=True, text=True, timeout=60)
        if saida.returncode == 0:
            return json.loads(saida.stdout).get("state")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    return None


def secao(texto, titulo):
    """Retorna as linhas da secao cujo rotulo contem `titulo` (ex.: 'Fontes consultadas')."""
    linhas = texto.splitlines()
    for i, linha in enumerate(linhas):
        if titulo.lower() in linha.lower():
            resto = linha.split(":", 1)[1].strip() if ":" in linha else ""
            corpo = [resto] if resto and resto != "**" else []
            for prox in linhas[i + 1:]:
                if FIM_DE_SECAO.match(prox) and titulo.lower() not in prox.lower():
                    break
                corpo.append(prox)
            return "\n".join(corpo).strip()
    return None


def categorias(texto):
    if not texto:
        return set()
    return {nome for nome, padrao in CATEGORIAS_FONTE if re.search(padrao, texto, re.I)}


def tabela(linhas):
    largura = max(len(l[0]) for l in linhas)
    print(f"{'Indicador'.ljust(largura)} | Valor | Percentual (%)")
    for nome, valor, perc in linhas:
        print(f"{nome.ljust(largura)} | {valor} | {perc}")
    print()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--results", default="results")
    p.add_argument("--state", default="state")
    p.add_argument("--desde")
    p.add_argument("--ate")
    p.add_argument("--gh", action="store_true")
    p.add_argument("--amostra", type=int, default=0)
    p.add_argument("--saida", default="tcc_saida")
    a = p.parse_args()

    desde = datetime.fromisoformat(a.desde).replace(tzinfo=timezone.utc) if a.desde else None
    ate = (datetime.fromisoformat(a.ate).replace(tzinfo=timezone.utc) + timedelta(days=1)) if a.ate else None
    saida = Path(a.saida)
    saida.mkdir(parents=True, exist_ok=True)

    tickets, incidentes = [], []
    for run_path in sorted(Path(a.results).glob("*/run.json")):
        pasta = run_path.parent
        run = ler_json(run_path) or {}
        inicio = data_iso(run.get("started_at"))
        if not no_periodo(inicio, desde, ate):
            continue
        ticket = ler_json(pasta / "ticket.json") or {}
        item = {
            "id": pasta.name, "pasta": pasta, "run": run, "ticket": ticket,
            "inicio": inicio, "fim": data_iso(run.get("finished_at")),
            "acao": ler_json(pasta / "engineering-action.json") or {},
            "remediacao": ler_json(pasta / "remediation.json") or {},
        }
        (incidentes if ticket.get("task_type") == "incident" else tickets).append(item)

    sucesso = [t for t in tickets if t["run"].get("status") in ("diagnosed", "success") and t["run"].get("classification")]
    erros = [t for t in tickets if t["run"].get("status") == "error"]
    total_exec = len(sucesso) + len(erros)
    ids_sucesso = {t["id"] for t in sucesso}

    # 1. Indicadores de uso (Tabela 8)
    classif = {c: sum(1 for t in sucesso if t["run"].get("classification") == c) for c in CLASSIFICACOES}
    decisoes = {d: sum(1 for t in sucesso if t["acao"].get("decision") == d) for d in DECISOES}
    vetores = sum(1 for t in sucesso if t["run"].get("vector_updated_in_clickup") is True)
    duracoes = [(t["fim"] - t["inicio"]).total_seconds() / 60 for t in sucesso if t["inicio"] and t["fim"]]

    aprovacoes = ler_json(Path(a.state) / "approvals.json") or {}
    registros = [r for r in aprovacoes.values() if isinstance(r, dict) and str(r.get("taskId")) in ids_sucesso]
    aprovados = sum(1 for r in registros if r.get("status") == "approved")
    assumidos = sum(1 for r in registros if r.get("assumedAt"))
    com_card = len({str(r.get("taskId")) for r in registros})

    com_pr = [t for t in sucesso if t["remediacao"].get("status") in STATUS_COM_PR]
    urls = sorted({pr.get("url") for t in com_pr for pr in (t["remediacao"].get("pull_requests") or [])
                   if isinstance(pr, dict) and pr.get("url")})
    estados = {url: estado_pr(url) for url in urls} if a.gh else {}
    integrados = sum(1 for s in estados.values() if s == "MERGED")

    inicios = [t["inicio"] for t in tickets if t["inicio"]]
    periodo = f"{min(inicios):%d/%m/%Y} a {max(inicios):%d/%m/%Y}" if inicios else "-"
    uso = [
        ("Período de observação", periodo, "-"),
        ("Tickets diagnosticados com sucesso", len(sucesso), "-"),
        ("Execuções de diagnóstico com erro", len(erros), pct(len(erros), total_exec)),
    ]
    uso += [(ROTULOS_CLASSIFICACAO[c], classif[c], pct(classif[c], len(sucesso))) for c in CLASSIFICACOES]
    uso += [(ROTULOS_DECISAO[d], decisoes[d], pct(decisoes[d], len(sucesso))) for d in DECISOES]
    uso += [
        ("Vetores corrigidos pelo agente no ClickUp", vetores, pct(vetores, len(sucesso))),
        ("Duração mediana do diagnóstico (min)",
         f"{statistics.median(duracoes):.1f}".replace(".", ",") if duracoes else "-", "-"),
        ("Comentários ao atendimento aprovados", aprovados, pct(aprovados, com_card)),
        ("Tickets assumidos pelo card", assumidos, pct(assumidos, com_card)),
        ("Remediações com pull request aberto", len(com_pr), pct(len(com_pr), len(sucesso))),
        ("Pull requests integrados pelos revisores",
         integrados if a.gh else "use --gh", pct(integrados, len(urls)) if a.gh else "-"),
    ]
    print("=== 1. INDICADORES DE USO (Tabela 8) ===")
    tabela(uso)
    print(f"Bases: {len(sucesso)} tickets com sucesso; {com_card} tickets com card de aprovação; "
          f"{len(urls)} PRs distintos. Incidentes do Grafana no período (fora da tabela): {len(incidentes)}\n")

    # 2. Fontes consultadas por diagnostico
    sem_secao = 0
    contagem = {nome: 0 for nome, _ in CATEGORIAS_FONTE}
    indisponiveis = {nome: 0 for nome, _ in CATEGORIAS_FONTE}
    com_indisponivel = 0
    qtd_tipos = []
    with open(saida / "fontes_por_diagnostico.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["ticket", "classificacao", "decisao", "confianca"]
                   + [n for n, _ in CATEGORIAS_FONTE] + ["fontes_indisponiveis", "trecho_fontes_consultadas"])
        for t in sucesso:
            diag = ler_texto(t["pasta"] / "diagnosis.md")
            consultadas = secao(diag, "Fontes consultadas")
            faltaram = secao(diag, "Fontes indisponíveis")
            cats = categorias(consultadas)
            if consultadas is None:
                sem_secao += 1
            else:
                qtd_tipos.append(len(cats))
            for c in cats:
                contagem[c] += 1
            cats_ind = categorias(faltaram)
            if faltaram:
                com_indisponivel += 1
            for c in cats_ind:
                indisponiveis[c] += 1
            w.writerow([t["id"], t["run"].get("classification"), t["acao"].get("decision"), t["acao"].get("confidence")]
                       + ["sim" if n in cats else "" for n, _ in CATEGORIAS_FONTE]
                       + ["; ".join(sorted(cats_ind)), (consultadas or "")[:500].replace("\n", " ")])
    base = len(sucesso) - sem_secao
    fontes = [(f"Fonte consultada: {n.lower()}", contagem[n], pct(contagem[n], base)) for n, _ in CATEGORIAS_FONTE]
    fontes += [
        ("Tipos de fonte por diagnóstico (mediana)",
         f"{statistics.median(qtd_tipos):.1f}".replace(".", ",") if qtd_tipos else "-", "-"),
        ("Diagnósticos com fonte indisponível registrada", com_indisponivel, pct(com_indisponivel, base)),
        ("Diagnósticos sem a seção de fontes reconhecida", sem_secao, pct(sem_secao, len(sucesso))),
    ]
    print("=== 2. FONTES CONSULTADAS NOS DIAGNÓSTICOS ===")
    tabela(fontes)
    print(f"Base: {base} diagnósticos com a seção 'Fontes consultadas'. Classificação por palavras-chave; "
          f"confira por amostragem em {saida / 'fontes_por_diagnostico.csv'}.\n")

    # 3. Amostra para avaliacao com especialistas
    if a.amostra:
        sorteados = random.Random(2026).sample(sucesso, min(a.amostra, len(sucesso)))
        pasta_amostra = saida / "amostra"
        pasta_amostra.mkdir(exist_ok=True)
        with open(saida / "avaliacao_especialistas.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["codigo", "ticket", "link", "avaliador",
                        "causa_raiz (correta | parcialmente correta | incorreta | nao sei avaliar)",
                        "evidencias_verificaveis (1 a 5)", "utilidade_para_engenharia (1 a 5)",
                        "comentario_ao_atendimento_adequado (1 a 5)", "tempo_economizado_estimado_min",
                        "observacoes"])
            for n, t in enumerate(sorted(sorteados, key=lambda x: x["id"]), start=1):
                codigo = f"D{n:02d}"
                link = t["ticket"].get("url") or ""
                conteudo = [f"# {codigo} - ticket {t['id']}", "",
                            f"Link: {link}",
                            f"Classificação: {t['run'].get('classification')}",
                            f"Decisão: {t['acao'].get('decision')} (confiança: {t['acao'].get('confidence')})", "",
                            "## Diagnóstico técnico", "", ler_texto(t["pasta"] / "diagnosis.md"), "",
                            "## Comentário para o atendimento", "", ler_texto(t["pasta"] / "cs-comment.md")]
                (pasta_amostra / f"{codigo}.md").write_text("\n".join(conteudo), encoding="utf-8")
                w.writerow([codigo, t["id"], link, "", "", "", "", "", "", ""])
        print(f"=== 3. AMOSTRA PARA AVALIAÇÃO ===\n{len(sorteados)} diagnósticos sorteados em {pasta_amostra}/ "
              f"e planilha em {saida / 'avaliacao_especialistas.csv'}.")
        print("Cada avaliador lê os arquivos da amostra e preenche uma cópia da planilha. "
              "A pasta amostra/ é de uso interno: não envie para fora da empresa.\n")

    (saida / "indicadores.json").write_text(json.dumps({
        "uso": [{"indicador": n, "valor": v, "percentual": p} for n, v, p in uso],
        "fontes": [{"indicador": n, "valor": v, "percentual": p} for n, v, p in fontes],
        "incidentes_no_periodo": len(incidentes),
        "pull_requests": estados or urls,
    }, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    print(f"Arquivos gerados em {saida}/")


if __name__ == "__main__":
    main()
