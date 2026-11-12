# Model routing and free OpenRouter benchmark

The experimental terminal labels every reply as MOCK or LIVE. MOCK is deterministic, covers a small set of demo requests, and identifies unsupported questions explicitly. LIVE uses the existing ModelRouter and OpenRouterProvider. MainAgent makes one decision call for a direct answer or a delegation, and uses a separately configured route to write a consolidated reply after delegation. Progress messages are derived from execution events without model calls.

## Profiles

| Effort | Main conversation (tools mode) | Main decision (JSON coordinator) | Main synthesis | Development | Research |
| --- | --- | --- | --- | --- | --- |
| low | Nemotron 3 Ultra · reasoning off | Nemotron 3.5 Super VL · reasoning off | Super VL · reasoning off | North Mini Code | Ultra · none |
| medium / high / max | Nemotron 3 Ultra · reasoning off | Nemotron 3.5 Super VL · reasoning off | Super VL · reasoning off | North Mini Code | Ultra · none |

The LIVE web server and terminal talk in the tools mode by default, so the conversation route is the model the user actually talks to. It was chosen by measurement, see [Medição do modo tools](#medição-do-modo-tools). `VOID_MAIN_MODEL` overrides both Main columns. Ultra does not accept `response_format`, which is why the JSON coordinator keeps Super VL.

Auto resolves to low. Super VL and Dots advertise JSON support and accept disabling reasoning. New LIVE routes omit the optional output cap by default so the serving endpoint applies its limits. The adapter checks context using a conservative text size estimate and clamps explicit output caps using catalog metadata. Call, step, concurrency, and explicit budget checks remain active.

In Singularity OS, the coordinator streams direct answer text as a draft. The validated response replaces the draft. The **Parar** button cancels active turns before or after delegation. Delegated runs emit step progress and preserve completed specialist results.

Set `VOID_MAIN_MODEL`, `VOID_SYNTHESIS_MODEL`, `VOID_DEV_MODEL`, `VOID_RESEARCH_MODEL` or `VOID_RENDERER_MODEL` to override a role. A suffix such as `_HIGH` takes priority for that effort. The same pattern applies to `MAX_OUTPUT_TOKENS` fields. The host API also accepts injected routes and temperatures. The terminal shows configured routes and the active checkpoint's served models with `/models`. The browser and terminal build specialist routes from their registered agent definitions. The renderer has its own route in the browser. Routes and successfully returned model IDs are persisted for new plans. Resuming an older checkpoint without route metadata uses its legacy host configuration. Resuming a new plan keeps its stored routes even after an effort or configuration change.

Use `VOID_<ROLE>_REASONING_EFFORT`, `VOID_<ROLE>_REASONING_MAX_TOKENS` or `VOID_<ROLE>_REASONING_EXCLUDE` for optional reasoning controls, including level-specific suffixes. Use `default` as the effort value to remove a preset. Effort and a reasoning-token cap are mutually exclusive here, and the cap must leave room for final output. The OpenRouter adapter checks the live catalog before sending controls. The catalog advertises `high`, `medium`, `none` and a reasoning-token cap for Ultra. Dots lists reasoning without exposing those controls. `exclude` hides reasoning text and does not lower token usage. [OpenRouter reasoning reference](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)

Singularity OS can make one additional attempt after an eligible failure. The fallback comes from a fixed list and must pass the price, context, JSON and reasoning checks. Requests with an explicit output cap skip this retry to preserve their token reservation.

The local GET /api/usage endpoint reports rolling 5-hour and 168-hour windows. LIVE SQLite stores counts of attempts, failures and reported tokens, including fallback attempts. The ledger tracks missing usage separately. Both windows operate in observation mode.

## Fase 4.2.2 · Comunicação do VOID

A decisão continua sendo uma única chamada estruturada. A persona orienta o texto da resposta direta e da síntese, enquanto o plano conserva seu contrato e sua validação de permissões. A abertura é salva com a conversa. Marcos públicos vêm do runtime pelo SSE e os detalhes por etapa continuam no Workspace.

A síntese anterior selecionava recortes de até 1.200 caracteres e podia terminar no meio de um parágrafo. A síntese atual recebe a solicitação e os resultados completos das etapas concluídas, com limite de 64.000 caracteres para a entrada serializada. O modelo redige uma resposta única e devolve uma citação curta por etapa concluída. O MainAgent valida as citações contra o resultado original. A conferência verifica as citações e a cobertura das etapas, sem validar semanticamente cada afirmação do texto. Se a síntese falhar ou ficar fora do orçamento, o VOID informa o ocorrido e mostra os resultados disponíveis por inteiro.

Em 8 de novembro de 2026, o [catálogo público](https://openrouter.ai/api/v1/models) confirmou o ID gratuito do Super VL, preços de entrada e saída iguais a zero, saída em texto e suporte a JSON. A [página do Inkling free](https://openrouter.ai/thinkingmachines/inkling%3Afree/) informou retirada em 4 de novembro, e o ID exato não apareceu no catálogo consultado. O Super VL permanece como alternativa ativa. O Nemotron 3.5 Lightning free fica como candidato textual a uma comparação futura, sem alteração das rotas. A verificação de preço e capacidade no provedor continua em vigor. O teste autenticado foi executado após autorização explícita.

### Benchmark LIVE de conversação

Foram quatro chamadas com a mesma voz da persona void-v1, duas perguntas fictícias por modelo, raciocínio desativado, limite de 500 tokens de saída e sem fallback. O catálogo confirmou preço zero nos dois modelos testados e suporte a JSON no Super VL. A verificação gratuita do Inkling falhou e nenhuma chamada foi enviada a ele.

| Modelo | Cenário | HTTP / término | Latência | Tokens entrada / saída | Observação |
| --- | --- | --- | --- | --- | --- |
| Super VL | Identidade | 200 / stop | 1,130 s | 214 / 53 | Apresentou-se como VOID e descreveu seu papel em duas frases. |
| Super VL | Discordância | 200 / stop | 1,455 s | 230 / 93 | Explicou o risco de regressão e distinguiu um projeto descartável de um projeto a manter. |
| Lightning | Identidade | 200 / stop | 1,061 s | 214 / 58 | Identificou-se como VOID, mas se descreveu como modelo da NVIDIA e deu uma resposta mais genérica. |
| Lightning | Discordância | 200 / stop | 1,504 s | 230 / 70 | Discordou de forma direta e explicou o risco de quebras silenciosas. |

O Super VL aderiu melhor à persona nessas duas amostras. Ambos respeitaram os limites de frases, terminaram normalmente e tiveram latências próximas. Esta rodada avaliou texto conversacional, sem testar a produção de JSON ou a confiabilidade ao longo do tempo. A configuração de produção permanece com o Super VL.

## Catalog evidence

Snapshot consulted on 8 November 2026. Context and output limits below describe the listed free endpoint, not the configured VOID ceilings. Listing is evidence of a catalog entry, with no guarantee of current endpoint capacity.

| Candidate | Exact API ID | Input / output price | Context / max output | Native schema | Reasoning and constraints |
| --- | --- | --- | --- | --- | --- |
| [Nemotron 3.5 Lightning](https://openrouter.ai/nvidia/nemotron-3.5-lightning:free) | `nvidia/nemotron-3.5-lightning:free` · reasoning off | USD 0 / 0 | 1,000,000 / 65,536 | Not advertised for the free variant | Reasoning supported and optional in the catalog. NVIDIA logs use for security and improvement and asks users to exclude confidential and personal data. |
| [Nemotron 3 Ultra](https://openrouter.ai/nvidia/nemotron-3-ultra-550b-a55b:free) | `nvidia/nemotron-3-ultra-550b-a55b:free` | USD 0 / 0 | 1,000,000 / 65,536 | Not advertised for the free variant | Reasoning is on by default at high effort. Same NVIDIA notice. |
| [North Mini Code](https://openrouter.ai/cohere/north-mini-code:free) | `cohere/north-mini-code:free` | USD 0 / 0 | 256,000 / 64,000 | Not advertised | Reasoning supported and optional in the catalog. Code-oriented. Endpoint-specific retention was not confirmed in the listing. |
| [Dots3-Note Preview](https://openrouter.ai/dots-studio/dots-3-note-preview:free) | `dots-studio/dots-3-note-preview:free` | USD 0 / 0 | 512,000 / 460,800 | Advertised | Reasoning supported and optional. Preview is listed to expire on 31 December 2026. Endpoint-specific retention was not confirmed in the listing. |
| [Nemotron 3.5 Super VL](https://openrouter.ai/nvidia/nemotron-3.5-super-vl:free) | `nvidia/nemotron-3.5-super-vl:free` | USD 0 / 0 | 1,000,000 / 131,072 | Advertised | Multimodal, with reasoning enabled by default according to the model page. Same NVIDIA notice. The coordinator uses this route for text-only JSON requests. |
| [Crouton Alpha](https://openrouter.ai/stealth/crouton-alpha) | `stealth/crouton-alpha` | USD 0 / 0 on the snapshot | 1,048,576 / 943,718 | Advertised | Mandatory reasoning, default max. Preview from an anonymous provider that may retain inputs and outputs. Outside the allowlist because it is a zero-priced preview without the `:free` variant contract. |

OpenRouter distinguishes `:free` variants, which do not require a credit purchase, from other USD 0 listings that may require a funded account or carry special terms. Free variants have shared rate limits, and a negative balance can block calls. The LIVE chat and benchmark verify exact IDs and zero catalog prices before dispatch, cache successful evidence for five minutes, and request zero price ceilings with automatic OpenRouter fallback disabled. A catalog failure or unknown price blocks dispatch. The benchmark stops after HTTP 429. The system uses prompt-based JSON for portability, accepts a raw JSON object or one complete JSON fence, and validates it at runtime. Unrecognized fields, extra prose, invalid plans and incomplete generation fail explicitly.

Sources for these rules include the [public models API](https://openrouter.ai/docs/api/api-reference/models/get-models), [free-model catalog and limits](https://openrouter.ai/collections/free-models), [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection) and [data policy overview](https://openrouter.ai/support).

## Reproduce the benchmark

The benchmark uses only synthetic inputs. The default run uses at most five generation requests for the direct case and a two-specialist delegated case. It validates the live catalog before requesting generation and prints the model IDs, cost check and maximum requests. The output reports endpoint latency, finish reason, token usage, message ordering and objective checks. The checks are smoke-test heuristics.

```powershell
$env:VOID_EFFORT = 'low'
$env:VOID_BENCH_MAX_CALLS = '5'
npm.cmd run benchmark:models:live
```

Set `VOID_BENCH_SCENARIO=delegated` and `VOID_BENCH_MAX_CALLS=4` for only the delegated case. The command loads `OPENROUTER_API_KEY` from the environment or `.env`. The automated suite uses simulated providers.

## Phase 3.1 live results

The three bounded runs made ten generation requests in total. Every generation reported HTTP 200. Token totals below include reasoning within output tokens. Prices were verified from the catalog before each run.

| Profile and role | Returned model | Finish | Latency | Input / output / reasoning tokens |
| --- | --- | --- | --- | --- |
| low · direct | Lightning | stop | 7.02 s | 283 / 1058 / 830 |
| low · planning | Lightning | stop | 14.13 s | 413 / 2005 / 1753 |
| low · development | North Mini Code | stop | 9.54 s | 180 / 1319 / 94 |
| low · research | Lightning | length | 18.55 s | 1502 / 1700 / 1373 |
| low · synthesis | Lightning | length | 9.04 s | 1070 / 1600 / 1600 |
| low · planning on second run | Lightning | stop | 11.60 s | 421 / 1601 / 1372 |
| medium · planning | Dots3-Note Preview | stop | 26.96 s | 467 / 2284 / 2208 |
| medium · development | North Mini Code | stop | 3.62 s | 173 / 416 / 200 |
| medium · research | Dots3-Note Preview | length | 35.59 s | 499 / 3200 / 3126 |
| medium · synthesis | Dots3-Note Preview | stop | 27.24 s | 589 / 2345 / 2195 |

Lightning correctly distinguished concurrency and parallelism in Brazilian Portuguese with single-core and multi-core examples. The first low and the medium runs validated the plan, both agents and the dependency. In both, the DevAgent finished and progress reached the client before the ResearchAgent returned. North identified the empty-array `NaN` bug and suggested a test. Its output included a misleading qualifier about a possible exception or infinity for this exact expression, so this sample is insufficient to judge general coding quality.

The first low run exhausted research and synthesis budgets. The second low run returned JSON that failed the step schema, and no specialist calls were dispatched. The medium run completed grounded synthesis from the surviving DevAgent result. Dots exhausted its research budget without final text, so the evidence comparison and full real two-specialist completion remain unvalidated in this phase. Local tests cover those paths, plus approval and resume. Ultra, Super VL and Crouton Alpha were researched only for this phase. These observations are smoke tests, and model output quality, availability and latency may vary.

## Phase 3.2 research benchmark

Run `npm.cmd run benchmark:research:live` in PowerShell. The command compares the same synthetic task and notes through the governed ResearchAgent, with a shared ceiling of two generation requests and 3,200 output tokens per model. It preflights model price and capability and stops if quota is reported.

| Model | Requested reasoning | Finish | Observed latency | Reported input / output / reasoning tokens | Result |
| --- | --- | --- | --- | --- | --- |
| `dots-studio/dots-3-note-preview:free` | Provider default | stop | 28.13 s | 276 / 2377 / 1868 | Both rates, facts versus inference, measurement limitation and no web claim |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | effort none | stop | 7.86 s | 271 / 254 / 0 | Same checks passed |

Both found the 30-point gap and identified missing latency measurements. The isolated Dots success shows the earlier failure depended on workload as well as the shared output ceiling. In the earlier delegated run the provider returned `length`, no final text and 3,126 reasoning tokens within 3,200 output tokens. That is a generation limit, with no usable final text to recover. The two research observations do not establish model superiority. Latencies are client wall time per request and token counts are reported by the provider.

To reproduce the guided end-to-end benchmark, run:

```powershell
$env:VOID_EFFORT = 'medium'
$env:VOID_BENCH_SCENARIO = 'delegated'
$env:VOID_BENCH_MAX_CALLS = '4'
npm.cmd run benchmark:models:live
```

The benchmark asks for both a code review of a latency aggregator and an evidence comparison dependent on that review. It requests this division of work explicitly and still uses the live MainAgent to produce and validate the DAG.

The first Phase 3.2 end-to-end run completed both specialists, then fell back to their saved results because the model's verbatim excerpt response failed validation. The revised synthesis asks the model to select indices. VOID resolves those indices against bounded excerpts from each completed step, preserving the original text, and rejects missing or invalid references. The next run completed the plan and passed the synthesis checks. Progress showed the DevAgent result before the ResearchAgent completed.

| Role in successful medium run | Returned model | Reasoning configuration | Finish | Observed latency | Reported input / output / reasoning tokens |
| --- | --- | --- | --- | --- | --- |
| Planning | Dots3-Note Preview | Provider default | stop | 23.57 s | 493 / 2018 / 1911 |
| Development | North Mini Code | Provider default | stop | 6.73 s | 191 / 418 / 212 |
| Research | Ultra | effort none | stop | 7.73 s | 528 / 307 / 0 |
| Synthesis | Ultra | effort none | stop | 0.84 s | 1554 / 25 / 0 |

All four requests returned HTTP 200, and the saved execution finished with two completed steps and no failures or pending steps. The final answer included the empty-array bug and both cache-hit rates. Ten generations were made in Phase 3.2 across the isolated comparison and two guided runs. The benchmark checks evidence and orchestration, with limited coverage of domain accuracy. For example, North correctly identified `NaN` but also suggested a runtime error for an expression that does not throw on an empty numeric array. Availability, latency and model quality remain variable.





## Fase 4.2.4 · Voz de saída no Singularity OS

A leitura de novas respostas finais vem habilitada. O navegador guarda a escolha em **Ativar voz** e **Provedor de voz** entre aberturas. Quando configurada no servidor, a ElevenLabs é a opção preferida. **Reproduzir resposta** relê uma resposta final e **Parar** interrompe o áudio. Trocar de sessão, desativar a voz ou zerar o volume também interrompe a leitura. O histórico carregado ao abrir uma sessão, os rascunhos e os avisos de progresso ficam em silêncio.

Ao usar a voz do sistema, o navegador seleciona apenas vozes pt-BR que ele identifica como locais. A disponibilidade, a pronúncia e a naturalidade dependem do navegador, do sistema e dos pacotes de idioma instalados. A opção automática usa o nome da voz como indício de preferência por uma voz masculina quando possível. A Web Speech API não fornece gênero. A leitura depende de uma interação com a página. Se o navegador bloquear o áudio, use **Reproduzir resposta**. Referências: [vozes disponíveis](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis/getVoices) e [serviço local](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisVoice/localService).

Pendência observada no teste anterior. O VOID delegou a dois especialistas, a síntese automática falhou e o chat exibiu os resultados completos. Esse caminho continua disponível em texto. A leitura inclui respostas diretas validadas e sínteses validadas de execuções concluídas. A investigação da falha de síntese fica para outra fase.

## Medição do modo tools

Em 12 de novembro de 2026, `npm run benchmark:tools:live` (`src/examples/benchmarkTools.ts`) mediu os modelos gratuitos do OpenRouter no que a conversa padrão exige. O script lê o catálogo público, pega todo modelo `:free` com preço zero que lista `tools` (fora o alias `openrouter/free` e o que expira em menos de uma semana) e roda cada um pelo `MainAgent`, com o prompt e a lista de ferramentas de produção, esforço `low`, raciocínio desligado onde o catálogo permite e sem fallback. As redes de segurança do host ficam de fora para não esconder o comportamento do modelo: sem o atalho de interface, e só contam como chamada as tool calls que o próprio modelo fez.

Sete cenários pontuam, um ponto cada por rodada:

| Cenário | Mensagem | Passa quando |
| --- | --- | --- |
| conversa | "bom dia, tudo certo por aí?" | responde em português, sem chamar ferramenta |
| explicação | diferença entre concorrência e paralelismo, em duas frases | cita os dois termos, sem delegar |
| abrir workspace | "abre o workspace" | o modelo chama `ui_switchMode` com `workspace` |
| abrir painel | "mostra o painel de uso" | o modelo chama `ui_openWindow` com `usage` |
| lembrar a pedido | "lembra que eu prefiro respostas curtas e diretas" | o modelo chama `remember` |
| usar a memória em sessão nova | "onde eu trabalho?", com o fato no bloco | a resposta cita a Florarte |
| resumo da sessão anterior | primeiro turno da sessão nova | o resumo foi gravado |

Um oitavo cenário, menção de passagem ("ah, eu moro em Olinda, por isso perguntei do trânsito ontem"), é só informativo: registra se o modelo chamou `remember` sozinho ou se disse que anotou sem chamar.

### Resultado

Três rodadas para os cinco primeiros, uma para os demais. Latência é o tempo de cada chamada ao provedor, sem a pausa entre chamadas, medida nas rodadas 2 e 3.

| Modelo | Acertos | Chama `remember` a pedido | Latência mediana / pior | Observação |
| --- | --- | --- | --- | --- |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | **21/21** | 3/3 | 1,7 s / 12,0 s | Único a passar em tudo. Numa menção de passagem chamou `remember` 1 vez em 3. |
| `cohere/north-mini-code:free` | 18/21 | 0/3 | 0,55 s / 1,7 s | O mais rápido. Diz "Anotei." sem chamar a ferramenta. |
| `liquid/lfm-3-1.7b:free` | 18/21 | 3/3 | 1,65 s / 5,6 s | Raciocínio obrigatório: o resumo estourou o teto de saída nas 3 rodadas, com falhas `incomplete`. |
| `nvidia/nemotron-3.5-lightning:free` | 17/21 | 0/3 | 0,63 s / 3,4 s | |
| `nvidia/nemotron-3.5-super-vl:free` | 16/21 | 0/3 | 0,91 s / 4,5 s | Padrão anterior. Em "abre o workspace" abriu painéis em vez do workspace em 2 de 3 rodadas. |
| `dots-studio/dots-3-note-preview:free` | 4/7 | 0/1 | não medida | Afirmou "Abrindo o workspace." sem chamar ferramenta. Expira em 31/12/2026. |
| `baidu/ernie-5.5-flash-preview:free` | 3/7 | 0/1 | não medida | Afirmou "Workspace aberto." sem chamar ferramenta. |
| `thinkingmachines/inkling-2-small:free` | 0/7 | | | HTTP 403 em todas as chamadas. |
| `recursive/flint-v1.0:free` | 0/7 | | | HTTP 404 em todas as chamadas. |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 0/7 | | | HTTP 404 em todas as chamadas. |
| `google/gemma-4-26b-a4b-it:free` | 0/21 | | | HTTP 429 do provedor nas três rodadas. Não foi possível medir. |
| `google/gemma-4-31b-it:free` | 0/21 | | | HTTP 429 do provedor nas três rodadas. Não foi possível medir. |

`liquid/lfm-2.5-2.6b:free` ficou de fora porque expirava em 13/11/2026.

### Decisão

A conversa em modo tools passa a usar o Nemotron 3 Ultra, com raciocínio desligado, pela rota nova `conversation`. Foi o único modelo que acertou todos os cenários e o único grande que chama as tools de memória, que continuam necessárias para esquecer e atualizar (`forget`, `update_memory`).

O Ultra **não** substituiu o modelo do coordenador JSON. Ele não lista `response_format`, e o benchmark existente do coordenador (`npm run benchmark:models:live`) falhou com ele no primeiro cenário, com `decision_json`. Por isso `decision` e `synthesis` continuam no Super VL, e o modo tools cai para esse coordenador quando o modelo da conversa não aceita tools ou sai do catálogo gratuito.

O que a medição não sustenta:

- **Amostra pequena.** Três rodadas por modelo. A diferença entre o Ultra e os demais é consistente num cenário (chamar `remember`), mas 21 pontos não medem variação fina.
- **Latência.** O Ultra é cerca de duas vezes mais lento que o Super VL na mediana e teve uma chamada de 12 s. Fora do benchmark, na verificação de ponta a ponta do mesmo dia, turnos inteiros levaram de 3 a 29 s. Quem preferir velocidade pode definir `VOID_MAIN_MODEL=cohere/north-mini-code:free`: a memória continua sendo gravada pela captura do host e os comandos de interface continuam garantidos.
- **Concentração.** O Ultra já era o modelo do ResearchAgent. Conversa e pesquisa agora dependem da mesma rota gratuita e dos mesmos limites.
- **Não medidos.** Delegação a especialistas, criação de componentes, voz e respostas longas não entraram nos cenários.
- **Catálogo muda.** Modelos gratuitos entram e saem. Repita `npm run benchmark:tools:live` antes de trocar o padrão de novo; `VOID_BENCH_MODELS` restringe a lista e `VOID_BENCH_ROUNDS` repete as rodadas.
