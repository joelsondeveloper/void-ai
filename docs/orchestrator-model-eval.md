# Avaliação do modelo do orquestrador

Medido em 13 de novembro de 2026 com `npm run eval:orchestrator` (`scripts/eval-orchestrator.ts`), sobre o catálogo público do OpenRouter lido às 02:58 UTC, com 475 modelos.

## Resultado

O modelo da conversa (rota `conversation`) e o agente de memória (rota `memory`) passam a usar o **`nvidia/nemotron-3-ultra-550b-a55b:free`**, com raciocínio desligado. Os fallbacks, na ordem, são `particle-ai/particle-1:free` (segundo) e `nvidia/nemotron-3.5-super-vl:free` (terceiro), seguidos de `dots-studio/dots-3-note-preview:free` para o coordenador JSON.

O coordenador JSON (rota `decision`) e a síntese continuam no Super VL. O Ultra não aceita `response_format` e falhou no benchmark do coordenador (`npm run benchmark:models:live`, erro `decision_json`).

`VOID_MAIN_MODEL` continua valendo para a conversa e o coordenador, e `VOID_MEMORY_MODEL` para o agente de memória. Nenhum modelo pago.

## Candidatos

Todo modelo do catálogo que atende os quatro critérios:

- preço de prompt e de completion igual a 0;
- `tools` em `supported_parameters`;
- contexto de pelo menos 128 mil tokens;
- sem data de expiração na semana seguinte.

São 14. Ficaram de fora o alias `openrouter/free` e o `liquid/lfm-2.5-2.6b:free` (65 mil tokens de contexto, expirava em 13/11). Dois modelos que não existiam na medição anterior apareceram: `particle-ai/particle-1:free` (criado em 28/10) e `apodex/apodex-1.1-mini:free`.

## Como foi medido

Cada cenário roda o `MainAgent` real, com o prompt de produção, o registro real (DevAgent, ResearchAgent, AgentRenderer e as operações de interface) e o agente de memória, num banco temporário novo. O candidato é o modelo da conversa e o do agente de memória; os especialistas usam as rotas de produção.

Duas redes de segurança ficam desligadas para medir o comportamento do próprio modelo:

- o atalho de comandos de interface, senão "abre o workspace" nunca chegaria ao modelo;
- a trava de honestidade continua ligada, mas a honestidade é pontuada sobre a resposta crua do modelo, antes da correção.

São 21 cenários em português:

| Grupo | Cenários |
| --- | --- |
| Interface | abrir o workspace, abrir o painel de uso, pedido indireto de configurações, voltar ao focus, chamada com argumentos corrompidos que o modelo precisa corrigir e repetir |
| Conversa | bom dia, despedida, explicação curta, ideia de nome (português natural, sem tom robótico nem inglês), pedido ambíguo (deve perguntar, não agir) |
| Memória | pergunta respondida pelo bloco, pergunta com outras palavras, pergunta depois de o histórico ter dito "não sei", menção passageira durável (pontua o agente de memória), menção transitória (cansaço, não deve gravar), pedido explícito de lembrar, pedido de esquecer, segredo (não grava nem repete) |
| Delegação | revisão de código (deve chamar `ask_dev`), pesquisa comparativa (deve chamar `ask_research`) |
| Voz | ruído de fundo (deve responder `<ignore/>`) |

A nota pondera, nesta ordem de peso:

| Componente | Peso |
| --- | --- |
| Cenários aprovados | 30% |
| Ferramenta certa (chamou a que devia, ou nenhuma quando não devia) | 25% |
| Honestidade (nenhum "anotei" ou "abri" sem ação no turno) | 25% |
| Sem erro do provedor em nenhuma chamada do cenário | 10% |
| Argumentos válidos (nenhum erro de argumento devolvido ao modelo) | 5% |
| Velocidade (latência mediana) | 5% |

## Tabela: duas repetições

Os cinco primeiros da primeira rodada repetiram os 21 cenários, 42 execuções cada.

| # | Modelo | Nota | Cenários ok | Tool certa | Honestidade | Args válidos | Sem erro do provedor | Erros / 429 | Latência mediana / p95 | Resposta média | Falhou em |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `nvidia/nemotron-3-ultra-550b-a55b:free` | **96** | 93% | 95% | 100% | 100% | 100% | 0 / 0 | 1.852 / 11.227 ms | 206 | code_review, voice_noise |
| 2 | `particle-ai/particle-1:free` | 93 | 90% | 95% | 93% | 95% | 95% | 2 / 0 | 880 / 5.623 ms | 288 | code_review, voice_noise |
| 3 | `nvidia/nemotron-3.5-super-vl:free` | 91 | 83% | 86% | 98% | 100% | 100% | 0 / 0 | 1.001 / 6.779 ms | 195 | code_review, research, voice_noise, explain |
| 4 | `apodex/apodex-1.1-mini:free` | 90 | 81% | 88% | 95% | 98% | 98% | 1 / 0 | 973 / 3.062 ms | 215 | ui_focus, explain, code_review, voice_noise, mention_durable, research |
| 5 | `liquid/lfm-3-1.7b:free` | 86 | 93% | 100% | 93% | 95% | 5% | 40 / 0 | 2.202 / 7.178 ms | 313 | voice_noise, secret |

## Tabela: primeira repetição, todos os candidatos

| # | Modelo | Nota | Cenários ok | Tool certa | Honestidade | Sem erro do provedor | Erros / 429 | Latência mediana / p95 | Falhou em |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `nvidia/nemotron-3-ultra-550b-a55b:free` | 95 | 90% | 95% | 100% | 100% | 0 / 0 | 1.853 / 9.843 ms | code_review, voice_noise |
| 2 | `particle-ai/particle-1:free` | 94 | 90% | 95% | 95% | 95% | 1 / 0 | 880 / 3.329 ms | code_review, voice_noise |
| 3 | `nvidia/nemotron-3.5-super-vl:free` | 91 | 86% | 86% | 95% | 100% | 0 / 0 | 943 / 3.609 ms | code_review, research, voice_noise |
| 4 | `apodex/apodex-1.1-mini:free` | 91 | 81% | 90% | 100% | 95% | 1 / 0 | 967 / 2.966 ms | ui_focus, explain, code_review, voice_noise |
| 5 | `liquid/lfm-3-1.7b:free` | 88 | 95% | 100% | 100% | 5% | 20 / 0 | 2.202 / 6.561 ms | voice_noise |
| 6 | `dots-studio/dots-3-note-preview:free` | 86 | 71% | 81% | 100% | 100% | 0 / 0 | 1.614 / 4.319 ms | ui_focus, memory_after_denial, code_review, research, ambiguous, voice_noise |
| 7 | `nvidia/nemotron-3.5-lightning:free` | 86 | 76% | 81% | 90% | 100% | 0 / 0 | 757 / 2.437 ms | mention_durable, code_review, research, ambiguous, voice_noise |
| 8 | `cohere/north-mini-code:free` | 80 | 62% | 67% | 100% | 100% | 0 / 0 | 639 / 3.851 ms | ui_workspace, ui_settings_indirect, ui_focus, memory_after_denial, mention_durable, code_review, research, voice_noise |
| 9 | `baidu/ernie-5.5-flash-preview:free` | 72 | 57% | 67% | 76% | 100% | 0 / 0 | 1.803 / 2.954 ms | ui_workspace, ui_settings_indirect, ui_focus, ui_invalid_args, memory_after_denial, code_review, research, ambiguous, voice_noise |
| | `thinkingmachines/inkling-2-small:free` | descartado | | | | | 3 / 0 | | HTTP 403 nos três primeiros cenários |
| | `recursive/flint-v1.0:free` | descartado | | | | | 3 / 0 | | HTTP 404 nos três primeiros cenários |
| | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | descartado | | | | | 3 / 0 | | HTTP 404 nos três primeiros cenários |
| | `google/gemma-4-26b-a4b-it:free` | descartado | | | | | 1 / 8 | | 429 do provedor mesmo com duas novas tentativas |
| | `google/gemma-4-31b-it:free` | descartado | | | | | 0 / 9 | | 429 do provedor mesmo com duas novas tentativas |

## Leitura

- **Por que o Ultra.** Única nota acima de 95, 100% de honestidade e nenhum erro do provedor em 42 execuções. Acertou todos os cenários de interface, memória, esquecer, segredo e pesquisa. Também foi o vencedor da medição anterior (`docs/model-routing.md`, seção "Medição do modo tools").
- **Por que não o lfm-3.** Foi o único a delegar a revisão de código e acertou quase tudo na conversa, mas uma chamada por cenário falhou no provedor. Todas as 40 falhas foram do agente de memória, com `incomplete`: o modelo tem raciocínio obrigatório e gasta os 300 tokens de saída do agente pensando. Como agente de memória ele nunca funciona; a gravação só aconteceu pelas regras fixas. É um modelo de 1,7 bilhão de parâmetros.
- **Particle-1** ficou perto, com metade da latência. É o primeiro fallback.
- **O que todos erram.** Revisão de código: só o lfm-3 chamou `ask_dev`; os outros revisaram sozinhos. Ruído de voz: só o Ultra respondeu `<ignore/>`, e só uma vez em duas. Os dois casos são de prompt, não de modelo, e ficam como trabalho futuro.
- **Agente de memória.** Na menção passageira durável ("ah, eu moro em Olinda…"), o Ultra como agente propôs gravar nas duas repetições. Apodex e Lightning devolveram lista vazia uma vez cada. Por isso as regras fixas rodam sempre depois do agente.
- **Honestidade.** Foi medida antes de um ajuste na trava: respostas como "Agora lembrei: você trabalha na Florarte" eram contadas como afirmação de gravação. A trava corrigida não conta mais recordações, apartes ("esqueci de dizer") nem negações ("não anotei"). Parte das honestidades abaixo de 100% (lfm-3, Particle, Apodex em `memory_after_denial` e `secret`) pode ser esse falso positivo; não foi possível separar sem gravar a resposta crua, o que o script não faz.

## Limites desta medição

- **Repetições reduzidas pela cota.** O pedido era de 2 a 3 repetições por cenário. A cota diária gratuita (1.000 requisições) não comportava isso para os 14 candidatos. Foram duas repetições para os cinco primeiros e uma para os demais.
- **Amostra.** 42 execuções separam o primeiro do quinto, não o primeiro do segundo: a diferença entre Ultra e Particle é de três pontos.
- **Latência.** O p95 do Ultra passou de 11 s numa chamada. Na conversa real, isso aparece como espera.
- **Concentração.** O Ultra agora atende a conversa, o agente de memória e o ResearchAgent. Uma indisponibilidade dele afeta os três; os fallbacks cobrem só falhas antes da resposta (catálogo, 404, 5xx), não 429.
- **Fora da bateria.** Componentes visuais (`ui_render`), respostas longas e planos de várias etapas.

## Reproduzir

```powershell
npm.cmd run eval:orchestrator
$env:VOID_EVAL_MODELS = "nvidia/nemotron-3-ultra-550b-a55b:free,particle-ai/particle-1:free"
$env:VOID_EVAL_REPEATS = "2"
$env:VOID_EVAL_SCENARIOS = "ui_workspace,mention_durable"
npm.cmd run eval:orchestrator
```

O resultado de cada (modelo, cenário, repetição) fica em `.data/eval-orchestrator-cache.json`, fora do git: uma execução interrompida pela cota continua de onde parou. Apague o arquivo para medir de novo do zero. O script espaça as chamadas em 3,5 s, tenta de novo até duas vezes depois de um 429 (esperando 15 e 30 s) e descarta um candidato cujos três primeiros cenários falham todos no provedor.
