# Modo de conversa com tool calling

O MainAgent tem dois modos de conversa. O padrão continua sendo o coordenador em JSON estrito (`decision`). O modo `tools` troca esse envelope por uma conversa em texto livre com tool calling nativo.

## Como ativar

```bash
VOID_CONVERSATION_MODE=tools npm run chat:void:live
VOID_CONVERSATION_MODE=tools npm run dev:web:live
```

Em integrações TypeScript, a opção `conversationMode: "tools"` do MainAgent tem precedência sobre a variável. Sem nenhuma das duas, nada muda. No modo `tools` a persona padrão passa a ser `void-v2` e a janela de histórico, 10 turnos de até 6.000 caracteres (`historyTurns` ainda tem precedência). `VOID_PERSONA` continua valendo.

## Fluxo de um turno

```
usuário → VOID (texto livre, streaming, persona void-v2)
            ├─ responde direto                       → 1 chamada
            ├─ chama ask_dev / ask_research / ...    → especialista roda via AgentRuntime.execute
            └─ chama ferramentas de interface        → operações registradas (ex.: ui.render)
            ← o resultado volta ao mesmo contexto e o VOID escreve a resposta final na própria voz
```

- **Quem decide delegar é o modelo**, pela descrição de cada tool. Não existe mais `mode: delegate`, plano com DAG nem etapa de síntese separada.
- **Várias tool calls na mesma resposta rodam em paralelo.** No máximo 4 por volta; as extras recebem um erro explicando o limite, porque todo id de chamada precisa de resposta.
- **Falhas voltam ao modelo como resultado** (`Erro: ...`), e ele pode se recuperar ou explicar ao usuário. Argumentos inválidos e ferramentas inexistentes seguem o mesmo caminho. Mensagens de erro inesperadas viram um texto genérico, sem expor detalhes internos. Cancelamento, ao contrário, interrompe o turno.
- **A última chamada sempre é feita sem ferramentas** (`tool_choice: "none"`), então o turno termina em texto. Se o modelo insistir em pedir ferramentas depois disso, o erro é `tool_loop_exhausted`.
- Durante o streaming, o rascunho mostra "Consultando Dev Agent…" enquanto o especialista trabalha. A UI e a API não mudam.

## Tools expostas

| Origem | Nome | Observação |
| --- | --- | --- |
| Cada agente executável autorizado | `ask_<id>` (`dev-agent` vira `ask_dev`, `agent-renderer` vira `ask_renderer`) | Só aparece se a sessão tiver ao menos uma capacidade do agente. O parâmetro é `task` (até 6.000 caracteres). O especialista não vê a conversa. |
| Operações registradas para o `main-agent` | `ui_render` etc. | Os argumentos passam por `accepts` antes de executar. Exige a opção `tool` do MainAgent. |

Os especialistas só existem como tools quando a opção `specialist` do MainAgent é informada (o runtime web e o terminal já a informam).

## Orçamento

O limite de chamadas do esforço (`low` = 5) vale para o turno todo: conversa, especialistas e geração de interface saem do mesmo saldo. Uma chamada fica sempre reservada para a resposta final. Com `calls: 2`, por exemplo, o especialista não chega a rodar: o modelo recebe o erro de orçamento e responde sozinho.

## Fallback

Se o catálogo do OpenRouter não listar `tools` em `supported_parameters` do modelo, o provider falha com o código `tools_unsupported` antes de enviar qualquer requisição. Uma recusa do endpoint já durante a chamada (HTTP 4xx/5xx) não é tratada como falta de suporte e segue como falha comum. O MainAgent então responde pelo caminho antigo (`decision`), sem que o usuário veja o erro. Qualquer outra falha é reportada normalmente.

## Voz

Em transcrições de voz, o modelo responde exatamente `<ignore/>` para ruído de fundo. Essa resposta não aparece na tela nem é gravada no histórico, equivalente ao `{"mode":"ignore"}` do modo antigo.

## Limites conhecidos

- **Governança.** As chamadas de conversa passam por `planRequest` (autorização de modelo gratuito, concorrência, limites de saída), mas os especialistas executam direto pelo `AgentRuntime`, sem checkpoint, pausa ou aprovação. Esses turnos não aparecem como execuções no painel.
- **Os especialistas continuam sem ferramentas próprias.** `DevAgent` e `ResearchAgent` ainda são um prompt sobre um modelo, com limite de 180 palavras. O formato novo está pronto para recebê-las, mas elas não existem.
- **Modelos gratuitos.** As rotas LIVE continuam restritas a modelos `:free`, e nem todos suportam tools. Antes de adotar o modo, confira `supported_parameters` no catálogo e rode prompts reais.
- **Fora desta fase:** jobs assíncronos (`start_job`, `check_job`, `cancel_job`) sobre o `PlanExecutor`, e memória persistente entre sessões.
